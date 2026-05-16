import os from 'node:os';
import path from 'node:path';

export const COPILOT_HOME_ENV = 'COPILOT_HOME';
export const COPILOT_SESSION_DIR_ENV = 'COPILOT_SESSION_STATE_DIR';
export const DEFAULT_COPILOT_DIR = path.join(os.homedir(), '.copilot');
export const DEFAULT_SESSION_SUBDIR = 'session-state';
// Each session lives in its own directory: <session-id>/events.jsonl
export const SESSION_GLOB = '*/events.jsonl';
export const WORKSPACE_FILE = 'workspace.yaml';

export const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
export const DEFAULT_PRECISION = 2;

export const MILLION = 1_000_000;
