import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import type { ModelPricing, PricingSource } from './_types.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { Result } from '@praha/byethrow';
import { MILLION } from './_consts.ts';
import { prefetchCopilotPricing } from './_macro.ts' with { type: 'macro' };
import { logger } from './logger.ts';

const COPILOT_PROVIDER_PREFIXES = [
	'anthropic/',
	'claude-',
	'openai/',
	'azure/',
	'openrouter/openai/',
	'openrouter/anthropic/',
];

/**
 * GitHub Copilot uses its own version aliases (e.g. `claude-opus-4.7`,
 * `gpt-5.5`) that may not match LiteLLM's catalogue keys. Map them onto the
 * closest known LiteLLM model so the USD column is meaningful.
 *
 * The mapping is best-effort and intentionally conservative — when no alias
 * matches, we fall back to zero pricing and the Premium request column
 * remains the authoritative cost signal.
 */
const COPILOT_MODEL_ALIASES_MAP = new Map<string, string>([
	// Claude
	['claude-opus-4.7', 'claude-opus-4-1'],
	['claude-opus-4.5', 'claude-opus-4-1'],
	['claude-opus-4.1', 'claude-opus-4-1'],
	['claude-opus-4', 'claude-opus-4'],
	['claude-sonnet-4.6', 'claude-sonnet-4-5'],
	['claude-sonnet-4.5', 'claude-sonnet-4-5'],
	['claude-sonnet-4', 'claude-sonnet-4'],
	['claude-haiku-4.5', 'claude-haiku-4-5'],
	['claude-haiku-4', 'claude-haiku-4-5'],
	['claude-3.7-sonnet', 'claude-3-7-sonnet-latest'],
	['claude-3.5-sonnet', 'claude-3-5-sonnet-latest'],
	['claude-3.5-haiku', 'claude-3-5-haiku-latest'],
	// OpenAI / Copilot rebrands
	['gpt-5.5', 'gpt-5'],
	['gpt-5.4', 'gpt-5'],
	['gpt-5.4-mini', 'gpt-5-mini'],
	['gpt-5.3-codex', 'gpt-5'],
	['gpt-5.2-codex', 'gpt-5'],
	['gpt-5.2', 'gpt-5'],
	['gpt-5-mini', 'gpt-5-mini'],
	['gpt-5', 'gpt-5'],
	['gpt-4.1', 'gpt-4.1'],
	['gpt-4o', 'gpt-4o'],
	['o1', 'o1'],
	['o3', 'o3'],
	['o3-mini', 'o3-mini'],
	['o4-mini', 'o4-mini'],
]);

const FREE_MODEL_PRICING = {
	inputCostPerMToken: 0,
	cachedInputCostPerMToken: 0,
	cacheCreationInputCostPerMToken: 0,
	outputCostPerMToken: 0,
} as const satisfies ModelPricing;

function hasNonZeroTokenPricing(pricing: LiteLLMModelPricing): boolean {
	return (
		(pricing.input_cost_per_token ?? 0) > 0 ||
		(pricing.output_cost_per_token ?? 0) > 0 ||
		(pricing.cache_read_input_token_cost ?? 0) > 0
	);
}

function toPerMillion(value: number | undefined, fallback?: number): number {
	const perToken = value ?? fallback ?? 0;
	return perToken * MILLION;
}

function convert(pricing: LiteLLMModelPricing): ModelPricing {
	return {
		inputCostPerMToken: toPerMillion(pricing.input_cost_per_token),
		cachedInputCostPerMToken: toPerMillion(
			pricing.cache_read_input_token_cost,
			pricing.input_cost_per_token,
		),
		cacheCreationInputCostPerMToken: toPerMillion(
			pricing.cache_creation_input_token_cost,
			pricing.input_cost_per_token,
		),
		outputCostPerMToken: toPerMillion(pricing.output_cost_per_token),
	};
}

export type CopilotPricingSourceOptions = {
	offline?: boolean;
	offlineLoader?: () => Promise<Record<string, LiteLLMModelPricing>>;
};

const PREFETCHED_COPILOT_PRICING = prefetchCopilotPricing();

export class CopilotPricingSource implements PricingSource, Disposable {
	private readonly fetcher: LiteLLMPricingFetcher;
	private readonly warned = new Set<string>();

	constructor(options: CopilotPricingSourceOptions = {}) {
		this.fetcher = new LiteLLMPricingFetcher({
			offline: options.offline ?? false,
			offlineLoader: options.offlineLoader ?? (async () => PREFETCHED_COPILOT_PRICING),
			logger,
			providerPrefixes: COPILOT_PROVIDER_PREFIXES,
		});
	}

	[Symbol.dispose](): void {
		this.fetcher[Symbol.dispose]();
	}

	async getPricing(model: string): Promise<ModelPricing> {
		const directLookup = await this.fetcher.getModelPricing(model);
		if (Result.isFailure(directLookup)) {
			throw directLookup.error;
		}

		let pricing = directLookup.value;
		const alias = COPILOT_MODEL_ALIASES_MAP.get(model);
		if (alias != null && (pricing == null || !hasNonZeroTokenPricing(pricing))) {
			const aliasLookup = await this.fetcher.getModelPricing(alias);
			if (Result.isFailure(aliasLookup)) {
				throw aliasLookup.error;
			}
			if (aliasLookup.value != null && hasNonZeroTokenPricing(aliasLookup.value)) {
				pricing = aliasLookup.value;
			}
		}

		if (pricing == null || !hasNonZeroTokenPricing(pricing)) {
			if (!this.warned.has(model)) {
				this.warned.add(model);
				logger.debug(
					`No LiteLLM pricing match for Copilot model "${model}"; reporting $0 USD (Premium request column is authoritative).`,
				);
			}
			return FREE_MODEL_PRICING;
		}

		return convert(pricing);
	}
}

if (import.meta.vitest != null) {
	describe('CopilotPricingSource', () => {
		it('resolves a Copilot alias to LiteLLM pricing', async () => {
			using source = new CopilotPricingSource({
				offline: true,
				offlineLoader: async () => ({
					'claude-opus-4-1': {
						input_cost_per_token: 1.5e-5,
						output_cost_per_token: 7.5e-5,
						cache_read_input_token_cost: 1.5e-6,
						cache_creation_input_token_cost: 1.875e-5,
					},
				}),
			});

			const pricing = await source.getPricing('claude-opus-4.7');
			expect(pricing.inputCostPerMToken).toBeCloseTo(15);
			expect(pricing.outputCostPerMToken).toBeCloseTo(75);
			expect(pricing.cachedInputCostPerMToken).toBeCloseTo(1.5);
			expect(pricing.cacheCreationInputCostPerMToken).toBeCloseTo(18.75);
		});

		it('returns zero pricing for unknown models', async () => {
			using source = new CopilotPricingSource({
				offline: true,
				offlineLoader: async () => ({}),
			});
			const pricing = await source.getPricing('totally-fake-model');
			expect(pricing.inputCostPerMToken).toBe(0);
			expect(pricing.outputCostPerMToken).toBe(0);
		});

		it('falls back to input price when cache rates are missing', async () => {
			using source = new CopilotPricingSource({
				offline: true,
				offlineLoader: async () => ({
					'gpt-5': {
						input_cost_per_token: 1.25e-6,
						output_cost_per_token: 1e-5,
					},
				}),
			});

			const pricing = await source.getPricing('gpt-5.5');
			expect(pricing.inputCostPerMToken).toBeCloseTo(1.25);
			expect(pricing.cachedInputCostPerMToken).toBeCloseTo(1.25);
			expect(pricing.cacheCreationInputCostPerMToken).toBeCloseTo(1.25);
		});
	});
}
