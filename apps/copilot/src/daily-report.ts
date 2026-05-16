import type {
	DailyReportRow,
	DailyUsageSummary,
	ModelUsage,
	PricingSource,
	TokenUsageEvent,
} from './_types.ts';
import { compareStrings } from '@ccusage/internal/sort';
import { formatDisplayDate, isWithinRange, toDateKey } from './date-utils.ts';
import { addUsage, calculateCostUSD, createEmptyUsage } from './token-utils.ts';

export type DailyReportOptions = {
	timezone?: string;
	since?: string;
	until?: string;
	pricingSource: PricingSource;
};

function createSummary(date: string, initialTimestamp: string): DailyUsageSummary {
	return {
		date,
		firstTimestamp: initialTimestamp,
		...createEmptyUsage(),
		costUSD: 0,
		models: new Map(),
	};
}

export async function buildDailyReport(
	events: TokenUsageEvent[],
	options: DailyReportOptions,
): Promise<DailyReportRow[]> {
	const { timezone, since, until, pricingSource } = options;
	const summaries = new Map<string, DailyUsageSummary>();

	for (const event of events) {
		const modelName = event.model?.trim();
		if (modelName == null || modelName === '') {
			continue;
		}
		const dateKey = toDateKey(event.timestamp, timezone);
		if (!isWithinRange(dateKey, since, until)) {
			continue;
		}
		const summary = summaries.get(dateKey) ?? createSummary(dateKey, event.timestamp);
		if (!summaries.has(dateKey)) {
			summaries.set(dateKey, summary);
		}
		addUsage(summary, event);

		const modelUsage: ModelUsage = summary.models.get(modelName) ?? {
			...createEmptyUsage(),
		};
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

	const rows: DailyReportRow[] = [];
	const sortedSummaries = Array.from(summaries.values()).sort((a, b) =>
		compareStrings(a.date, b.date),
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
			date: formatDisplayDate(summary.date),
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
	describe('buildDailyReport', () => {
		it('aggregates events by day and calculates costs', async () => {
			const pricingSource: PricingSource = {
				async getPricing(model: string) {
					if (model === 'claude-opus-4.7') {
						return {
							inputCostPerMToken: 15,
							cachedInputCostPerMToken: 1.5,
							cacheCreationInputCostPerMToken: 18.75,
							outputCostPerMToken: 75,
						};
					}
					return {
						inputCostPerMToken: 0,
						cachedInputCostPerMToken: 0,
						cacheCreationInputCostPerMToken: 0,
						outputCostPerMToken: 0,
					};
				},
			};

			const report = await buildDailyReport(
				[
					{
						sessionId: 's1',
						directory: '',
						timestamp: '2026-05-16T06:00:00.000Z',
						model: 'claude-opus-4.7',
						inputTokens: 1_000,
						cachedInputTokens: 800,
						cacheCreationInputTokens: 50,
						outputTokens: 200,
						reasoningOutputTokens: 0,
						totalTokens: 1_200,
						premiumRequests: 15,
					},
				],
				{ pricingSource },
			);

			expect(report).toHaveLength(1);
			expect(report[0]!.premiumRequests).toBe(15);
			// (1000-800)/1M*15 + 800/1M*1.5 + 50/1M*18.75 + 200/1M*75
			const expected =
				(200 / 1_000_000) * 15 +
				(800 / 1_000_000) * 1.5 +
				(50 / 1_000_000) * 18.75 +
				(200 / 1_000_000) * 75;
			expect(report[0]!.costUSD).toBeCloseTo(expected, 10);
		});
	});
}
