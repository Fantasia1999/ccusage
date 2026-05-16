import { sort } from 'fast-sort';

export type UsageGroup = {
	inputTokens: number;
	cachedInputTokens: number;
	cacheCreationInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
};

export function splitUsageTokens(usage: UsageGroup): {
	inputTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	outputTokens: number;
} {
	const cacheReadTokens = Math.min(usage.cachedInputTokens, usage.inputTokens);
	const inputTokens = Math.max(usage.inputTokens - cacheReadTokens, 0);
	const outputTokens = Math.max(usage.outputTokens, 0);
	const rawReasoning = usage.reasoningOutputTokens ?? 0;
	const reasoningTokens = Math.max(0, rawReasoning);
	const cacheWriteTokens = Math.max(0, usage.cacheCreationInputTokens);

	return {
		inputTokens,
		reasoningTokens,
		cacheReadTokens,
		cacheWriteTokens,
		outputTokens,
	};
}

export function formatModelsList(
	models: Record<string, { totalTokens: number; isIncomplete?: boolean }>,
): string[] {
	return sort(Object.entries(models))
		.asc(([model]) => model)
		.map(([model, data]) => (data.isIncomplete === true ? `${model} (incomplete)` : model));
}
