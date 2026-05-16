import type { ModelPricing, TokenUsageDelta } from './_types.ts';
import { formatCurrency, formatTokens } from '@ccusage/internal/format';
import { MILLION } from './_consts.ts';

export function createEmptyUsage(): TokenUsageDelta {
	return {
		inputTokens: 0,
		cachedInputTokens: 0,
		cacheCreationInputTokens: 0,
		outputTokens: 0,
		reasoningOutputTokens: 0,
		totalTokens: 0,
		premiumRequests: 0,
	};
}

export function addUsage(target: TokenUsageDelta, delta: TokenUsageDelta): void {
	target.inputTokens += delta.inputTokens;
	target.cachedInputTokens += delta.cachedInputTokens;
	target.cacheCreationInputTokens += delta.cacheCreationInputTokens;
	target.outputTokens += delta.outputTokens;
	target.reasoningOutputTokens += delta.reasoningOutputTokens;
	target.totalTokens += delta.totalTokens;
	target.premiumRequests += delta.premiumRequests;
}

function nonCachedInputTokens(usage: TokenUsageDelta): number {
	const nonCached = usage.inputTokens - usage.cachedInputTokens;
	return nonCached > 0 ? nonCached : 0;
}

/**
 * Calculate the cost in USD for token usage based on model pricing.
 *
 * For Copilot the upstream `inputTokens` already includes cache-read tokens,
 * so we subtract `cachedInputTokens` before applying the input rate, mirroring
 * the convention used by the Codex and main ccusage CLIs.
 *
 * Cache-write tokens are charged at the cache-creation rate when LiteLLM
 * publishes one (e.g. Anthropic models); otherwise they fall back to the
 * input rate inside `CopilotPricingSource`.
 *
 * Reasoning tokens are reported separately by Copilot and stay informational
 * here. The USD estimate follows LiteLLM's input/output rates and avoids
 * adding reasoning as a standalone line without an explicit pricing source.
 */
export function calculateCostUSD(usage: TokenUsageDelta, pricing: ModelPricing): number {
	const nonCachedInput = nonCachedInputTokens(usage);
	const cachedInput =
		usage.cachedInputTokens > usage.inputTokens ? usage.inputTokens : usage.cachedInputTokens;

	const inputCost = (nonCachedInput / MILLION) * pricing.inputCostPerMToken;
	const cachedCost = (cachedInput / MILLION) * pricing.cachedInputCostPerMToken;
	const cacheCreationCost =
		(usage.cacheCreationInputTokens / MILLION) * pricing.cacheCreationInputCostPerMToken;
	const outputCost = (usage.outputTokens / MILLION) * pricing.outputCostPerMToken;

	return inputCost + cachedCost + cacheCreationCost + outputCost;
}

export { formatCurrency, formatTokens };
