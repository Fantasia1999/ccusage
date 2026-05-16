import type {
	ModelUsage,
	MonthlyReportRow,
	MonthlyUsageSummary,
	PricingSource,
	TokenUsageEvent,
} from './_types.ts';
import { compareStrings } from '@ccusage/internal/sort';
import { formatDisplayMonth, isWithinRange, toDateKey, toMonthKey } from './date-utils.ts';
import { addUsage, calculateCostUSD, createEmptyUsage } from './token-utils.ts';

export type MonthlyReportOptions = {
	timezone?: string;
	since?: string;
	until?: string;
	pricingSource: PricingSource;
};

function createSummary(month: string, initialTimestamp: string): MonthlyUsageSummary {
	return {
		month,
		firstTimestamp: initialTimestamp,
		...createEmptyUsage(),
		costUSD: 0,
		models: new Map(),
	};
}

export async function buildMonthlyReport(
	events: TokenUsageEvent[],
	options: MonthlyReportOptions,
): Promise<MonthlyReportRow[]> {
	const { timezone, since, until, pricingSource } = options;
	const summaries = new Map<string, MonthlyUsageSummary>();

	for (const event of events) {
		const modelName = event.model?.trim();
		if (modelName == null || modelName === '') {
			continue;
		}
		const dateKey = toDateKey(event.timestamp, timezone);
		if (!isWithinRange(dateKey, since, until)) {
			continue;
		}
		const monthKey = toMonthKey(event.timestamp, timezone);
		const summary = summaries.get(monthKey) ?? createSummary(monthKey, event.timestamp);
		if (!summaries.has(monthKey)) {
			summaries.set(monthKey, summary);
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

	const rows: MonthlyReportRow[] = [];
	const sortedSummaries = Array.from(summaries.values()).sort((a, b) =>
		compareStrings(a.month, b.month),
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
			month: formatDisplayMonth(summary.month),
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
