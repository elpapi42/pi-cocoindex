export type TruncationMode = "head" | "tail";

export type IndexStatus = "idle" | "running" | "succeeded" | "failed";

export interface ProjectIndexState {
	status: IndexStatus;
	promise?: Promise<void>;
	controller?: AbortController;
	reason?: string;
	startedAt?: number;
	finishedAt?: number;
	lastSucceededAt?: number;
	lastError?: string;
	lastFailureAt?: number;
}

export interface RunResult {
	command: string;
	cwd: string;
	stdout: string;
	stderr: string;
}

export interface RunOptions {
	signal?: AbortSignal;
	timeoutMs: number;
}

export interface SearchMatch {
	rank: number;
	score: number;
	path: string;
	startLine?: number;
	endLine?: number;
	language?: string;
}

export type BackgroundIndexStartStatus = "not-started" | "started" | "already-running" | "skipped-cooldown" | "disposed";

export interface SearchDetails {
	status: "ok" | "indexing";
	command?: string;
	cwd: string;
	projectRoot: string;
	query: string;
	limit: number;
	path?: string;
	backgroundIndex: BackgroundIndexStartStatus;
	truncated: boolean;
	matches: SearchMatch[];
	message?: string;
	retryable?: boolean;
}

export type NotifyLevel = "info" | "warning" | "error";
export type LifecycleNotifier = (message: string, level?: NotifyLevel) => void;

export interface StartIndexOptions {
	force?: boolean;
	notify?: LifecycleNotifier;
}
