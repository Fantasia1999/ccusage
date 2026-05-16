import type {
	ModelPricing,
	ModelUsage,
	PricingSource,
	TokenUsageEvent,
	WeeklyReportRow,
	WeeklyUsageSummary,
} from './_types.ts';
import { compareStrings } from '@ccusage/internal/sort';
import { formatDisplayWeek, isWithinRange, toDateKey, toWeekKey } from './date-utils.ts';
import { addUsage, calculateCostUSD, createEmptyUsage } from './token-utils.ts';

export type WeeklyReportOptions = {
	timezone?: string;
	since?: string;
	until?: string;
	pricingSource: PricingSource;
};

function createSummary(week: string, initialTimestamp: string): WeeklyUsageSummary {
	return {
		week,
		firstTimestamp: initialTimestamp,
		...createEmptyUsage(),
		costUSD: 0,
		models: new Map(),
	};
}

export async function buildWeeklyReport(
	events: TokenUsageEvent[],
	options: WeeklyReportOptions,
): Promise<WeeklyReportRow[]> {
	const { timezone, since, until, pricingSource } = options;
	const summaries = new Map<string, WeeklyUsageSummary>();

	for (const event of events) {
		const modelName = event.model?.trim();
		if (modelName == null || modelName === '') {
			continue;
		}
		const dateKey = toDateKey(event.timestamp, timezone);
		if (!isWithinRange(dateKey, since, until)) {
			continue;
		}
		const weekKey = toWeekKey(event.timestamp, timezone);
		const summary = summaries.get(weekKey) ?? createSummary(weekKey, event.timestamp);
		if (!summaries.has(weekKey)) {
			summaries.set(weekKey, summary);
		}
		addUsage(summary, event);
		const modelUsage: ModelUsage = summary.models.get(modelName) ?? { ...createEmptyUsage() };
		if (!summary.models.has(modelName)) {
			summary.models.set(modelName, modelUsage);
		}
		addUsage(modelUsage, event);
		if (event.isIncomplete === true) {
			modelUsage.isIncomplete = true;
		}
	}

	const uniqueModels = new Set<string>();
	for (const summary of summaries.values()) {
		for (const modelName of summary.models.keys()) {
			uniqueModels.add(modelName);
		}
	}

	const modelPricing = new Map<string, Awaited<ReturnType<PricingSource['getPricing']>>>();
	for (const modelName of uniqueModels) {
		modelPricing.set(modelName, await pricingSource.getPricing(modelName));
	}

	const rows: WeeklyReportRow[] = [];
	const sortedSummaries = Array.from(summaries.values()).sort((a, b) =>
		compareStrings(a.week, b.week),
	);

	for (const summary of sortedSummaries) {
		let cost = 0;
		for (const [modelName, usage] of summary.models) {
			const pricing = modelPricing.get(modelName);
			if (pricing == null) {
				continue;
			}
			cost += calculateCostUSD(usage, pricing);
		}
		summary.costUSD = cost;

		const rowModels: Record<string, ModelUsage> = {};
		for (const [modelName, usage] of summary.models) {
			rowModels[modelName] = { ...usage };
		}

		rows.push({
			week: formatDisplayWeek(summary.week),
			inputTokens: summary.inputTokens,
			cachedInputTokens: summary.cachedInputTokens,
			cacheCreationInputTokens: summary.cacheCreationInputTokens,
			outputTokens: summary.outputTokens,
			reasoningOutputTokens: summary.reasoningOutputTokens,
			totalTokens: summary.totalTokens,
			premiumRequests: summary.premiumRequests,
			costUSD: cost,
			models: rowModels,
		});
	}

	return rows;
}

if (import.meta.vitest != null) {
	describe('buildWeeklyReport', () => {
		it('aggregates Copilot events by week and calculates costs', async () => {
			const pricing = new Map([
				[
					'claude-sonnet-4-20250514',
					{
						inputCostPerMToken: 3,
						cachedInputCostPerMToken: 0.3,
						cacheCreationInputCostPerMToken: 3.75,
						outputCostPerMToken: 15,
					},
				],
			]);
			const stubPricingSource: PricingSource = {
				async getPricing(model: string): Promise<ModelPricing> {
					const value = pricing.get(model);
					if (value == null) {
						throw new Error(`Missing pricing for ${model}`);
					}
					return value;
				},
			};
			const report = await buildWeeklyReport(
				[
					{
						sessionId: 'session-1',
						directory: '/repo',
						timestamp: '2025-09-11T03:00:00.000Z',
						model: 'claude-sonnet-4-20250514',
						inputTokens: 1_000,
						cachedInputTokens: 200,
						cacheCreationInputTokens: 300,
						outputTokens: 500,
						reasoningOutputTokens: 50,
						totalTokens: 1_500,
						premiumRequests: 1,
					},
					{
						sessionId: 'session-1',
						directory: '/repo',
						timestamp: '2025-09-12T05:00:00.000Z',
						model: 'claude-sonnet-4-20250514',
						inputTokens: 400,
						cachedInputTokens: 100,
						cacheCreationInputTokens: 0,
						outputTokens: 200,
						reasoningOutputTokens: 0,
						totalTokens: 600,
						premiumRequests: 2,
					},
				],
				{
					pricingSource: stubPricingSource,
					since: '2025-09-11',
					until: '2025-09-12',
				},
			);

			expect(report).toHaveLength(1);
			const first = report[0]!;
			expect(first.week).toContain('2025');
			expect(first.inputTokens).toBe(1_400);
			expect(first.cachedInputTokens).toBe(300);
			expect(first.cacheCreationInputTokens).toBe(300);
			expect(first.outputTokens).toBe(700);
			expect(first.reasoningOutputTokens).toBe(50);
			expect(first.premiumRequests).toBe(3);
			const expectedCost =
				(1_100 / 1_000_000) * 3 +
				(300 / 1_000_000) * 0.3 +
				(300 / 1_000_000) * 3.75 +
				(700 / 1_000_000) * 15;
			expect(first.costUSD).toBeCloseTo(expectedCost, 10);
		});
	});
}
