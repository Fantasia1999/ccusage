import type {
	ModelUsage,
	PricingSource,
	SessionReportRow,
	SessionUsageSummary,
	TokenUsageEvent,
} from './_types.ts';
import { compareStrings } from '@ccusage/internal/sort';
import { isWithinRange, toDateKey } from './date-utils.ts';
import { addUsage, calculateCostUSD, createEmptyUsage } from './token-utils.ts';

export type SessionReportOptions = {
	timezone?: string;
	since?: string;
	until?: string;
	pricingSource: PricingSource;
};

function createSummary(
	sessionId: string,
	directory: string,
	initialTimestamp: string,
): SessionUsageSummary {
	return {
		sessionId,
		directory,
		firstTimestamp: initialTimestamp,
		lastTimestamp: initialTimestamp,
		...createEmptyUsage(),
		costUSD: 0,
		models: new Map(),
	};
}

export async function buildSessionReport(
	events: TokenUsageEvent[],
	options: SessionReportOptions,
): Promise<SessionReportRow[]> {
	const { timezone, since, until, pricingSource } = options;
	const summaries = new Map<string, SessionUsageSummary>();

	for (const event of events) {
		const sessionId = event.sessionId?.trim();
		if (sessionId == null || sessionId === '') {
			continue;
		}
		const modelName = event.model?.trim();
		if (modelName == null || modelName === '') {
			continue;
		}
		const dateKey = toDateKey(event.timestamp, timezone);
		if (!isWithinRange(dateKey, since, until)) {
			continue;
		}
		const summary =
			summaries.get(sessionId) ?? createSummary(sessionId, event.directory, event.timestamp);
		if (!summaries.has(sessionId)) {
			summaries.set(sessionId, summary);
		}
		addUsage(summary, event);
		if (event.timestamp > summary.lastTimestamp) {
			summary.lastTimestamp = event.timestamp;
		}
		if (event.directory !== '' && summary.directory === '') {
			summary.directory = event.directory;
		}

		const modelUsage: ModelUsage = summary.models.get(modelName) ?? { ...createEmptyUsage() };
		if (!summary.models.has(modelName)) {
			summary.models.set(modelName, modelUsage);
		}
		addUsage(modelUsage, event);
		if (event.isIncomplete === true) {
			modelUsage.isIncomplete = true;
		}
	}

	if (summaries.size === 0) {
		return [];
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

	const sortedSummaries = Array.from(summaries.values()).sort((a, b) =>
		compareStrings(a.lastTimestamp, b.lastTimestamp),
	);

	const rows: SessionReportRow[] = [];
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
			sessionId: summary.sessionId,
			lastActivity: summary.lastTimestamp,
			sessionFile: summary.sessionId,
			directory: summary.directory,
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
