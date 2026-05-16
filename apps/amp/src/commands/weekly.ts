import type { TokenUsageEvent } from '../_types.ts';
import { compareStrings } from '@ccusage/internal/sort';
import {
	addEmptySeparatorRow,
	formatCurrency,
	formatDateCompact,
	formatModelsDisplayMultiline,
	formatNumber,
	ResponsiveTable,
} from '@ccusage/terminal/table';
import { define } from 'gunshi';
import pc from 'picocolors';
import { loadAmpUsageEvents } from '../data-loader.ts';
import { AmpPricingSource } from '../pricing.ts';

const TABLE_COLUMN_COUNT = 9;

function toWeekKey(timestamp: string): string {
	const date = new Date(timestamp);
	const day = date.getUTCDay();
	date.setUTCDate(date.getUTCDate() - day);
	return date.toISOString().slice(0, 10);
}

function groupByWeek(events: TokenUsageEvent[]): Map<string, TokenUsageEvent[]> {
	const grouped = new Map<string, TokenUsageEvent[]>();
	for (const event of events) {
		const week = toWeekKey(event.timestamp);
		const existing = grouped.get(week);
		if (existing != null) {
			existing.push(event);
		} else {
			grouped.set(week, [event]);
		}
	}
	return grouped;
}

export const weeklyCommand = define({
	name: 'weekly',
	description: 'Show Amp token usage grouped by week',
	args: {
		json: {
			type: 'boolean',
			short: 'j',
			description: 'Output in JSON format',
		},
		compact: {
			type: 'boolean',
			description: 'Force compact table mode',
		},
	},
	async run(ctx) {
		const jsonOutput = Boolean(ctx.values.json);

		const { events } = await loadAmpUsageEvents();

		if (events.length === 0) {
			const output = jsonOutput
				? JSON.stringify({ weekly: [], totals: null })
				: 'No Amp usage data found.';
			// eslint-disable-next-line no-console
			console.log(output);
			return;
		}

		using pricingSource = new AmpPricingSource({ offline: false });

		const eventsByWeek = groupByWeek(events);

		const weeklyData: Array<{
			week: string;
			inputTokens: number;
			outputTokens: number;
			cacheCreationTokens: number;
			cacheReadTokens: number;
			totalTokens: number;
			credits: number;
			totalCost: number;
			modelsUsed: string[];
		}> = [];

		for (const [week, weekEvents] of eventsByWeek) {
			let inputTokens = 0;
			let outputTokens = 0;
			let cacheCreationTokens = 0;
			let cacheReadTokens = 0;
			let credits = 0;
			let totalCost = 0;
			const modelsSet = new Set<string>();

			for (const event of weekEvents) {
				inputTokens += event.inputTokens;
				outputTokens += event.outputTokens;
				cacheCreationTokens += event.cacheCreationInputTokens;
				cacheReadTokens += event.cacheReadInputTokens;
				credits += event.credits;

				const cost = await pricingSource.calculateCost(event.model, {
					inputTokens: event.inputTokens,
					outputTokens: event.outputTokens,
					cacheCreationInputTokens: event.cacheCreationInputTokens,
					cacheReadInputTokens: event.cacheReadInputTokens,
				});
				totalCost += cost;
				modelsSet.add(event.model);
			}

			const totalTokens = inputTokens + outputTokens;

			weeklyData.push({
				week,
				inputTokens,
				outputTokens,
				cacheCreationTokens,
				cacheReadTokens,
				totalTokens,
				credits,
				totalCost,
				modelsUsed: Array.from(modelsSet),
			});
		}

		weeklyData.sort((a, b) => compareStrings(a.week, b.week));

		const totals = {
			inputTokens: weeklyData.reduce((sum, d) => sum + d.inputTokens, 0),
			outputTokens: weeklyData.reduce((sum, d) => sum + d.outputTokens, 0),
			cacheCreationTokens: weeklyData.reduce((sum, d) => sum + d.cacheCreationTokens, 0),
			cacheReadTokens: weeklyData.reduce((sum, d) => sum + d.cacheReadTokens, 0),
			totalTokens: weeklyData.reduce((sum, d) => sum + d.totalTokens, 0),
			credits: weeklyData.reduce((sum, d) => sum + d.credits, 0),
			totalCost: weeklyData.reduce((sum, d) => sum + d.totalCost, 0),
		};

		if (jsonOutput) {
			// eslint-disable-next-line no-console
			console.log(
				JSON.stringify(
					{
						weekly: weeklyData,
						totals,
					},
					null,
					2,
				),
			);
			return;
		}

		// eslint-disable-next-line no-console
		console.log('\n📊 Amp Token Usage Report - Weekly\n');

		const table: ResponsiveTable = new ResponsiveTable({
			head: [
				'Week',
				'Models',
				'Input',
				'Output',
				'Cache Create',
				'Cache Read',
				'Total Tokens',
				'Credits',
				'Cost (USD)',
			],
			colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
			compactHead: ['Week', 'Models', 'Input', 'Output', 'Credits', 'Cost (USD)'],
			compactColAligns: ['left', 'left', 'right', 'right', 'right', 'right'],
			compactThreshold: 100,
			forceCompact: Boolean(ctx.values.compact),
			style: { head: ['cyan'] },
			dateFormatter: (dateStr: string) => formatDateCompact(dateStr),
		});

		for (const data of weeklyData) {
			table.push([
				data.week,
				formatModelsDisplayMultiline(data.modelsUsed),
				formatNumber(data.inputTokens),
				formatNumber(data.outputTokens),
				formatNumber(data.cacheCreationTokens),
				formatNumber(data.cacheReadTokens),
				formatNumber(data.totalTokens),
				data.credits.toFixed(2),
				formatCurrency(data.totalCost),
			]);
		}

		addEmptySeparatorRow(table, TABLE_COLUMN_COUNT);
		table.push([
			pc.yellow('Total'),
			'',
			pc.yellow(formatNumber(totals.inputTokens)),
			pc.yellow(formatNumber(totals.outputTokens)),
			pc.yellow(formatNumber(totals.cacheCreationTokens)),
			pc.yellow(formatNumber(totals.cacheReadTokens)),
			pc.yellow(formatNumber(totals.totalTokens)),
			pc.yellow(totals.credits.toFixed(2)),
			pc.yellow(formatCurrency(totals.totalCost)),
		]);

		// eslint-disable-next-line no-console
		console.log(table.toString());

		if (table.isCompactMode()) {
			// eslint-disable-next-line no-console
			console.log('\nRunning in Compact Mode');
			// eslint-disable-next-line no-console
			console.log('Expand terminal width to see cache metrics and total tokens');
		}
	},
});
