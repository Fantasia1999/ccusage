import process from 'node:process';
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
import { DEFAULT_TIMEZONE } from '../_consts.ts';
import { sharedArgs } from '../_shared-args.ts';
import { formatModelsList, splitUsageTokens } from '../command-utils.ts';
import { loadTokenUsageEvents } from '../data-loader.ts';
import { formatDisplayDate, normalizeFilterDate, toDateKey } from '../date-utils.ts';
import { log, logger } from '../logger.ts';
import { CopilotPricingSource } from '../pricing.ts';
import { buildSessionReport } from '../session-report.ts';

const TABLE_COLUMN_COUNT = 12;

export const sessionCommand = define({
	name: 'session',
	description: 'Show Copilot CLI token usage grouped by session',
	args: sharedArgs,
	async run(ctx) {
		const jsonOutput = Boolean(ctx.values.json);
		if (jsonOutput) {
			logger.level = 0;
		}

		let since: string | undefined;
		let until: string | undefined;
		try {
			since = normalizeFilterDate(ctx.values.since);
			until = normalizeFilterDate(ctx.values.until);
		} catch (error) {
			logger.error(String(error));
			process.exit(1);
		}

		const { events, missingDirectories } = await loadTokenUsageEvents({
			includeIncomplete: ctx.values.includeIncomplete,
		});
		for (const missing of missingDirectories) {
			logger.warn(`Copilot session directory not found: ${missing}`);
		}

		if (events.length === 0) {
			log(
				jsonOutput
					? JSON.stringify({ sessions: [], totals: null })
					: 'No Copilot usage data found.',
			);
			return;
		}

		const pricingSource = new CopilotPricingSource({ offline: ctx.values.offline });
		try {
			const rows = await buildSessionReport(events, {
				pricingSource,
				timezone: ctx.values.timezone,
				since,
				until,
			});

			if (rows.length === 0) {
				log(
					jsonOutput
						? JSON.stringify({ sessions: [], totals: null })
						: 'No Copilot usage data found for provided filters.',
				);
				return;
			}

			const totals = rows.reduce(
				(acc, row) => {
					acc.inputTokens += row.inputTokens;
					acc.cachedInputTokens += row.cachedInputTokens;
					acc.cacheCreationInputTokens += row.cacheCreationInputTokens;
					acc.outputTokens += row.outputTokens;
					acc.reasoningOutputTokens += row.reasoningOutputTokens;
					acc.totalTokens += row.totalTokens;
					acc.premiumRequests += row.premiumRequests;
					acc.costUSD += row.costUSD;
					return acc;
				},
				{
					inputTokens: 0,
					cachedInputTokens: 0,
					cacheCreationInputTokens: 0,
					outputTokens: 0,
					reasoningOutputTokens: 0,
					totalTokens: 0,
					premiumRequests: 0,
					costUSD: 0,
				},
			);

			if (jsonOutput) {
				log(JSON.stringify({ sessions: rows, totals }, null, 2));
				return;
			}

			logger.box(
				`Copilot Token Usage Report - Sessions (Timezone: ${ctx.values.timezone ?? DEFAULT_TIMEZONE})`,
			);

			const table = new ResponsiveTable({
				head: [
					'Date',
					'Directory',
					'Session',
					'Models',
					'Input',
					'Output',
					'Reasoning',
					'Cache Read',
					'Cache Write',
					'Total Tokens',
					'Premium',
					'Cost (USD)',
				],
				colAligns: [
					'left',
					'left',
					'left',
					'left',
					'right',
					'right',
					'right',
					'right',
					'right',
					'right',
					'right',
					'right',
				],
				compactHead: ['Date', 'Session', 'Input', 'Output', 'Premium', 'Cost (USD)'],
				compactColAligns: ['left', 'left', 'right', 'right', 'right', 'right'],
				compactThreshold: 130,
				forceCompact: ctx.values.compact,
				style: { head: ['cyan'] },
				dateFormatter: (dateStr: string) => formatDateCompact(dateStr),
			});

			const displayTotals = {
				inputTokens: 0,
				outputTokens: 0,
				reasoningTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 0,
				premiumRequests: 0,
				costUSD: 0,
			};

			for (const row of rows) {
				const split = splitUsageTokens(row);
				displayTotals.inputTokens += split.inputTokens;
				displayTotals.outputTokens += split.outputTokens;
				displayTotals.reasoningTokens += split.reasoningTokens;
				displayTotals.cacheReadTokens += split.cacheReadTokens;
				displayTotals.cacheWriteTokens += split.cacheWriteTokens;
				displayTotals.totalTokens += row.totalTokens;
				displayTotals.premiumRequests += row.premiumRequests;
				displayTotals.costUSD += row.costUSD;

				const dateKey = toDateKey(row.lastActivity, ctx.values.timezone);
				const displayDate = formatDisplayDate(dateKey);
				const directoryDisplay = row.directory === '' ? '-' : row.directory;
				const shortSession =
					row.sessionId.length > 8 ? `…${row.sessionId.slice(-8)}` : row.sessionId;

				table.push([
					displayDate,
					directoryDisplay,
					shortSession,
					formatModelsDisplayMultiline(formatModelsList(row.models)),
					formatNumber(split.inputTokens),
					formatNumber(split.outputTokens),
					formatNumber(split.reasoningTokens),
					formatNumber(split.cacheReadTokens),
					formatNumber(split.cacheWriteTokens),
					formatNumber(row.totalTokens),
					formatNumber(row.premiumRequests),
					formatCurrency(row.costUSD),
				]);
			}

			addEmptySeparatorRow(table, TABLE_COLUMN_COUNT);
			table.push([
				'',
				'',
				pc.yellow('Total'),
				'',
				pc.yellow(formatNumber(displayTotals.inputTokens)),
				pc.yellow(formatNumber(displayTotals.outputTokens)),
				pc.yellow(formatNumber(displayTotals.reasoningTokens)),
				pc.yellow(formatNumber(displayTotals.cacheReadTokens)),
				pc.yellow(formatNumber(displayTotals.cacheWriteTokens)),
				pc.yellow(formatNumber(displayTotals.totalTokens)),
				pc.yellow(formatNumber(displayTotals.premiumRequests)),
				pc.yellow(formatCurrency(displayTotals.costUSD)),
			]);

			log(table.toString());
			log(
				pc.dim(
					'Premium = Copilot premium request units (authoritative quota). Cost (USD) is approximate, derived from LiteLLM pricing.',
				),
			);

			if (table.isCompactMode()) {
				logger.info('\nRunning in Compact Mode');
				logger.info(
					'Expand terminal width to see directories, cache metrics, total tokens, and last activity',
				);
			}
		} finally {
			pricingSource[Symbol.dispose]();
		}
	},
});
