import type { TokenUsageEvent } from './_types.ts';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { compareStrings } from '@ccusage/internal/sort';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import { glob } from 'tinyglobby';
import * as v from 'valibot';
import {
	COPILOT_HOME_ENV,
	COPILOT_SESSION_DIR_ENV,
	DEFAULT_COPILOT_DIR,
	DEFAULT_SESSION_SUBDIR,
	SESSION_GLOB,
	WORKSPACE_FILE,
} from './_consts.ts';
import { logger } from './logger.ts';

function ensureNumber(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

const usageSchema = v.object({
	inputTokens: v.optional(v.unknown()),
	outputTokens: v.optional(v.unknown()),
	cacheReadTokens: v.optional(v.unknown()),
	cacheWriteTokens: v.optional(v.unknown()),
	reasoningTokens: v.optional(v.unknown()),
});

const requestsSchema = v.object({
	count: v.optional(v.unknown()),
	cost: v.optional(v.unknown()),
});

const modelMetricEntrySchema = v.object({
	usage: v.optional(usageSchema),
	requests: v.optional(requestsSchema),
});

const shutdownDataSchema = v.object({
	modelMetrics: v.optional(v.record(v.string(), modelMetricEntrySchema)),
});

const assistantMessageDataSchema = v.object({
	model: v.optional(v.unknown()),
	outputTokens: v.optional(v.unknown()),
});

const entrySchema = v.object({
	type: v.string(),
	data: v.optional(v.unknown()),
	timestamp: v.optional(v.string()),
});

export type LoadOptions = {
	sessionDirs?: string[];
	includeIncomplete?: boolean;
};

export type LoadResult = {
	events: TokenUsageEvent[];
	missingDirectories: string[];
};

function resolveDefaultSessionDir(): string {
	const explicit = process.env[COPILOT_SESSION_DIR_ENV]?.trim();
	if (explicit != null && explicit !== '') {
		return path.resolve(explicit);
	}
	const home = process.env[COPILOT_HOME_ENV]?.trim();
	const base = home != null && home !== '' ? path.resolve(home) : DEFAULT_COPILOT_DIR;
	return path.join(base, DEFAULT_SESSION_SUBDIR);
}

/**
 * Lightweight workspace.yaml parser. We only need a handful of top-level
 * scalar keys (`cwd`, `name`, `created_at`, `updated_at`), so we avoid pulling
 * in a full YAML dependency.
 */
function parseWorkspaceYaml(content: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === '' || line.startsWith('#')) {
			continue;
		}
		const colon = line.indexOf(':');
		if (colon === -1) {
			continue;
		}
		const key = line.slice(0, colon).trim();
		if (!/^[\w-]+$/.test(key)) {
			continue;
		}
		let value = line.slice(colon + 1).trim();
		const hashIndex = value.indexOf('#');
		if (hashIndex >= 0 && !value.startsWith('"') && !value.startsWith("'")) {
			value = value.slice(0, hashIndex).trim();
		}
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		result[key] = value;
	}
	return result;
}

async function readDirectoryForSession(sessionDir: string): Promise<string> {
	const workspacePath = path.join(sessionDir, WORKSPACE_FILE);
	const readResult = await Result.try({
		try: readFile(workspacePath, 'utf8'),
		catch: (error) => error,
	});
	if (Result.isFailure(readResult)) {
		return '';
	}
	const parsed = parseWorkspaceYaml(readResult.value);
	return parsed.cwd ?? '';
}

/**
 * Load Copilot CLI token usage events from `events.jsonl` files.
 *
 * Authoritative usage lives in `session.shutdown` events; the last one wins
 * per (session, model). When a session has no shutdown event (interrupted /
 * still active), we optionally fall back to summing
 * `assistant.message.data.outputTokens` and mark the event `isIncomplete`.
 */
export async function loadTokenUsageEvents(options: LoadOptions = {}): Promise<LoadResult> {
	const providedDirs =
		options.sessionDirs != null && options.sessionDirs.length > 0
			? options.sessionDirs.map((dir) => path.resolve(dir))
			: undefined;

	const sessionDirs = providedDirs ?? [resolveDefaultSessionDir()];

	const events: TokenUsageEvent[] = [];
	const missingDirectories: string[] = [];

	for (const dir of sessionDirs) {
		const directoryPath = path.resolve(dir);
		const statResult = await Result.try({
			try: stat(directoryPath),
			catch: (error) => error,
		});

		if (Result.isFailure(statResult) || !statResult.value.isDirectory()) {
			missingDirectories.push(directoryPath);
			continue;
		}

		const files = await glob(SESSION_GLOB, {
			cwd: directoryPath,
			absolute: true,
		});

		for (const file of files) {
			const sessionDir = path.dirname(file);
			const sessionId = path.basename(sessionDir);
			const workspaceCwd = await readDirectoryForSession(sessionDir);

			const fileContentResult = await Result.try({
				try: readFile(file, 'utf8'),
				catch: (error) => error,
			});
			if (Result.isFailure(fileContentResult)) {
				logger.debug('Failed to read Copilot session file', fileContentResult.error);
				continue;
			}

			const lines = fileContentResult.value.split(/\r?\n/);

			const latestShutdownByModel = new Map<
				string,
				{
					timestamp: string;
					event: TokenUsageEvent;
				}
			>();

			// Fallback aggregation: per-model output-token sums.
			const fallbackByModel = new Map<string, { outputTokens: number; lastTimestamp: string }>();

			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed === '') {
					continue;
				}

				const parsed = Result.try({
					try: () => JSON.parse(trimmed) as unknown,
					catch: (error) => error,
				})();
				if (Result.isFailure(parsed)) {
					continue;
				}

				const entry = v.safeParse(entrySchema, parsed.value);
				if (!entry.success) {
					continue;
				}

				const { type: entryType, data, timestamp } = entry.output;
				if (timestamp == null) {
					continue;
				}

				if (entryType === 'session.shutdown') {
					const shutdown = v.safeParse(shutdownDataSchema, data ?? {});
					if (!shutdown.success || shutdown.output.modelMetrics == null) {
						continue;
					}

					for (const [model, raw] of Object.entries(shutdown.output.modelMetrics)) {
						const usage = raw.usage ?? {};
						const requests = raw.requests ?? {};
						const inputTokens = ensureNumber(usage.inputTokens);
						const outputTokens = ensureNumber(usage.outputTokens);
						const cacheRead = ensureNumber(usage.cacheReadTokens);
						const cacheWrite = ensureNumber(usage.cacheWriteTokens);
						const reasoning = ensureNumber(usage.reasoningTokens);
						const cost = ensureNumber(requests.cost);

						if (
							inputTokens === 0 &&
							outputTokens === 0 &&
							cacheRead === 0 &&
							cacheWrite === 0 &&
							reasoning === 0 &&
							cost === 0
						) {
							continue;
						}

						const event = {
							sessionId,
							directory: workspaceCwd,
							timestamp,
							model,
							inputTokens,
							cachedInputTokens: cacheRead,
							cacheCreationInputTokens: cacheWrite,
							outputTokens,
							reasoningOutputTokens: reasoning,
							totalTokens: inputTokens + outputTokens,
							premiumRequests: cost,
						};
						const existing = latestShutdownByModel.get(model);
						if (existing == null || timestamp >= existing.timestamp) {
							latestShutdownByModel.set(model, { timestamp, event });
						}
					}
					continue;
				}

				if (entryType === 'assistant.message') {
					const msg = v.safeParse(assistantMessageDataSchema, data ?? {});
					if (!msg.success) {
						continue;
					}
					const model = typeof msg.output.model === 'string' ? msg.output.model.trim() : '';
					if (model === '') {
						continue;
					}
					const output = ensureNumber(msg.output.outputTokens);
					if (output === 0) {
						continue;
					}
					const existing = fallbackByModel.get(model) ?? {
						outputTokens: 0,
						lastTimestamp: timestamp,
					};
					existing.outputTokens += output;
					if (timestamp > existing.lastTimestamp) {
						existing.lastTimestamp = timestamp;
					}
					fallbackByModel.set(model, existing);
				}
			}

			if (latestShutdownByModel.size > 0) {
				for (const { event } of latestShutdownByModel.values()) {
					events.push(event);
				}
			} else if (options.includeIncomplete === true && fallbackByModel.size > 0) {
				for (const [model, data] of fallbackByModel) {
					events.push({
						sessionId,
						directory: workspaceCwd,
						timestamp: data.lastTimestamp,
						model,
						inputTokens: 0,
						cachedInputTokens: 0,
						cacheCreationInputTokens: 0,
						outputTokens: data.outputTokens,
						reasoningOutputTokens: 0,
						totalTokens: data.outputTokens,
						premiumRequests: 0,
						isIncomplete: true,
					});
				}
			}
		}
	}

	events.sort((a, b) => compareStrings(a.timestamp, b.timestamp));

	return { events, missingDirectories };
}

if (import.meta.vitest != null) {
	describe('loadTokenUsageEvents', () => {
		it('parses session.shutdown modelMetrics into events', async () => {
			await using fixture = await createFixture({
				'state/abc-123': {
					'events.jsonl': [
						JSON.stringify({
							type: 'session.start',
							timestamp: '2026-05-16T06:00:00.000Z',
							data: { sessionId: 'abc-123' },
						}),
						JSON.stringify({
							type: 'session.shutdown',
							timestamp: '2026-05-16T06:10:00.000Z',
							data: {
								modelMetrics: {
									'claude-opus-4.7': {
										usage: {
											inputTokens: 1_000,
											outputTokens: 200,
											cacheReadTokens: 800,
											cacheWriteTokens: 50,
											reasoningTokens: 40,
										},
										requests: { count: 1, cost: 15 },
									},
								},
							},
						}),
					].join('\n'),
					'workspace.yaml': 'cwd: /home/user/project\nname: "test"\n',
				},
			});

			const { events, missingDirectories } = await loadTokenUsageEvents({
				sessionDirs: [fixture.getPath('state')],
			});

			expect(missingDirectories).toEqual([]);
			expect(events).toHaveLength(1);
			const event = events[0]!;
			expect(event.sessionId).toBe('abc-123');
			expect(event.directory).toBe('/home/user/project');
			expect(event.model).toBe('claude-opus-4.7');
			expect(event.inputTokens).toBe(1_000);
			expect(event.cachedInputTokens).toBe(800);
			expect(event.cacheCreationInputTokens).toBe(50);
			expect(event.outputTokens).toBe(200);
			expect(event.reasoningOutputTokens).toBe(40);
			expect(event.totalTokens).toBe(1_200);
			expect(event.premiumRequests).toBe(15);
		});

		it('keeps the latest shutdown event when duplicates exist', async () => {
			await using fixture = await createFixture({
				'state/dup': {
					'events.jsonl': [
						JSON.stringify({
							type: 'session.shutdown',
							timestamp: '2026-05-16T06:10:00.000Z',
							data: {
								modelMetrics: {
									'gpt-5.5': {
										usage: { inputTokens: 100, outputTokens: 10 },
										requests: { count: 1, cost: 1 },
									},
								},
							},
						}),
						JSON.stringify({
							type: 'session.shutdown',
							timestamp: '2026-05-16T06:20:00.000Z',
							data: {
								modelMetrics: {
									'gpt-5.5': {
										usage: { inputTokens: 300, outputTokens: 30 },
										requests: { count: 3, cost: 3 },
									},
								},
							},
						}),
					].join('\n'),
				},
			});

			const { events } = await loadTokenUsageEvents({
				sessionDirs: [fixture.getPath('state')],
			});
			expect(events).toHaveLength(1);
			expect(events[0]!.inputTokens).toBe(300);
			expect(events[0]!.premiumRequests).toBe(3);
		});

		it('keeps prior model usage when the last shutdown only reports the new model', async () => {
			await using fixture = await createFixture({
				'state/switched': {
					'events.jsonl': [
						JSON.stringify({
							type: 'session.shutdown',
							timestamp: '2026-05-16T06:10:00.000Z',
							data: {
								modelMetrics: {
									'claude-opus-4.7': {
										usage: { inputTokens: 1_000, outputTokens: 100 },
										requests: { count: 4, cost: 15 },
									},
								},
							},
						}),
						JSON.stringify({
							type: 'session.model_change',
							timestamp: '2026-05-16T06:15:00.000Z',
							data: {
								previousModel: 'claude-opus-4.7',
								newModel: 'claude-sonnet-4.6',
							},
						}),
						JSON.stringify({
							type: 'session.shutdown',
							timestamp: '2026-05-16T06:20:00.000Z',
							data: {
								modelMetrics: {
									'claude-opus-4.7': {
										usage: { inputTokens: 0, outputTokens: 0 },
										requests: { count: 0, cost: 0 },
									},
									'claude-sonnet-4.6': {
										usage: { inputTokens: 200, outputTokens: 20 },
										requests: { count: 1, cost: 2 },
									},
								},
							},
						}),
					].join('\n'),
				},
			});

			const { events } = await loadTokenUsageEvents({
				sessionDirs: [fixture.getPath('state')],
			});
			expect(events).toHaveLength(2);
			expect(events.map((event) => event.model).sort()).toEqual([
				'claude-opus-4.7',
				'claude-sonnet-4.6',
			]);
			const opus = events.find((event) => event.model === 'claude-opus-4.7');
			const sonnet = events.find((event) => event.model === 'claude-sonnet-4.6');
			expect(opus?.inputTokens).toBe(1_000);
			expect(opus?.premiumRequests).toBe(15);
			expect(sonnet?.inputTokens).toBe(200);
			expect(sonnet?.premiumRequests).toBe(2);
		});

		it('skips incomplete sessions by default and includes them with --include-incomplete', async () => {
			await using fixture = await createFixture({
				'state/incomplete': {
					'events.jsonl': [
						JSON.stringify({
							type: 'session.start',
							timestamp: '2026-05-16T06:00:00.000Z',
							data: {},
						}),
						JSON.stringify({
							type: 'assistant.message',
							timestamp: '2026-05-16T06:05:00.000Z',
							data: { model: 'claude-sonnet-4.6', outputTokens: 100 },
						}),
						JSON.stringify({
							type: 'assistant.message',
							timestamp: '2026-05-16T06:06:00.000Z',
							data: { model: 'claude-sonnet-4.6', outputTokens: 50 },
						}),
					].join('\n'),
				},
			});

			const skipped = await loadTokenUsageEvents({
				sessionDirs: [fixture.getPath('state')],
			});
			expect(skipped.events).toHaveLength(0);

			const included = await loadTokenUsageEvents({
				sessionDirs: [fixture.getPath('state')],
				includeIncomplete: true,
			});
			expect(included.events).toHaveLength(1);
			expect(included.events[0]!.isIncomplete).toBe(true);
			expect(included.events[0]!.outputTokens).toBe(150);
		});

		it('reports missing directories', async () => {
			const { events, missingDirectories } = await loadTokenUsageEvents({
				sessionDirs: ['/nonexistent-copilot-dir-xyz'],
			});
			expect(events).toEqual([]);
			expect(missingDirectories).toHaveLength(1);
		});
	});
}
