import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MAX_BUFFER_BYTES } from "./constants.js";
import { combineOutputs, truncateText } from "./output.js";
import type { RunOptions, RunResult } from "./types.js";

const execFileAsync = promisify(execFile);

export class CccError extends Error {
	readonly command: string;
	readonly cwd: string;
	readonly stdout: string;
	readonly stderr: string;
	readonly code: unknown;
	readonly signal: unknown;
	readonly killed: boolean;
	readonly timedOut: boolean;
	readonly cancelled: boolean;
	readonly causeName?: string;

	constructor(
		message: string,
		fields: {
			command: string;
			cwd: string;
			stdout?: string;
			stderr?: string;
			code?: unknown;
			signal?: unknown;
			killed?: boolean;
			timedOut?: boolean;
			cancelled?: boolean;
			causeName?: string;
		},
	) {
		super(message);
		this.name = "CccError";
		this.command = fields.command;
		this.cwd = fields.cwd;
		this.stdout = fields.stdout ?? "";
		this.stderr = fields.stderr ?? "";
		this.code = fields.code;
		this.signal = fields.signal;
		this.killed = fields.killed ?? false;
		this.timedOut = fields.timedOut ?? false;
		this.cancelled = fields.cancelled ?? false;
		this.causeName = fields.causeName;
	}

	get combinedOutput(): string {
		return combineOutputs(this.stdout, this.stderr || this.message);
	}
}

export async function runCcc(cwd: string, args: string[], options: RunOptions): Promise<RunResult> {
	const command = formatCommand(args);
	try {
		const result = await execFileAsync("ccc", args, {
			cwd,
			timeout: options.timeoutMs,
			maxBuffer: MAX_BUFFER_BYTES,
			signal: options.signal,
			env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
		});
		return { command, cwd, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
	} catch (error: unknown) {
		const err = error as NodeJS.ErrnoException & { stdout?: unknown; stderr?: unknown; code?: unknown; signal?: unknown; killed?: boolean };
		const cancelled = isRawCancellation(err, options.signal);
		const timedOut = !cancelled && isRawTimeout(err);
		throw new CccError(renderRawFailure(err, command), {
			command,
			cwd,
			stdout: String(err.stdout ?? ""),
			stderr: String(err.stderr ?? err.message ?? ""),
			code: err.code,
			signal: err.signal,
			killed: err.killed,
			timedOut,
			cancelled,
			causeName: err.name,
		});
	}
}

export function renderToolFailure(error: unknown, root: string): string {
	if (isMissingCcc(error)) return missingCccMessage();
	const text = error instanceof CccError ? error.combinedOutput : errorToMessage(error);
	if (isUninitializedError(text)) return `CocoIndex is not initialized for ${root}. Run /cc-init to create CocoIndex settings and start background indexing, then retry search.`;
	return error instanceof CccError ? error.message : text;
}

export function renderCommandFailure(error: unknown): string {
	if (isMissingCcc(error)) return missingCccMessage();
	return errorToMessage(error);
}

export function renderRawFailure(error: { code?: unknown; name?: string; stdout?: unknown; stderr?: unknown; message?: string }, command: string): string {
	if (error.code === "ENOENT") return missingCccMessage();
	if (error.name === "AbortError" || error.code === "ABORT_ERR") return `Cancelled: ${command}`;
	const combined = combineOutputs(String(error.stdout ?? ""), String(error.stderr ?? error.message ?? ""));
	const truncated = truncateText(combined || String(error.message ?? "Unknown ccc error."), "tail").text;
	const exitInfo = typeof error.code === "number" ? ` (exit ${error.code})` : "";
	return `${command} failed${exitInfo}.\n\n${truncated}`;
}

export function missingCccMessage(): string {
	return [
		"Semantic search is unavailable because the `ccc` command was not found.",
		"Install CocoIndex Code:",
		"  pipx install 'cocoindex-code[full]'",
		"Then reload Pi or retry.",
	].join("\n");
}

export function isMissingCcc(error: unknown): boolean {
	return error instanceof CccError && error.code === "ENOENT";
}

export function isCancelledError(error: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted) return true;
	if (error instanceof CccError) return error.cancelled;
	if (error instanceof Error && error.name === "AbortError") return true;
	const maybe = error as { code?: unknown; name?: unknown } | undefined;
	return maybe?.code === "ABORT_ERR" || maybe?.name === "AbortError";
}

export function isCccTimeoutError(error: unknown): boolean {
	if (error instanceof CccError) return error.timedOut;
	return isRawTimeout(error as { message?: unknown; signal?: unknown; killed?: boolean } | undefined);
}

export function isRawCancellation(error: { code?: unknown; name?: unknown } | undefined, signal?: AbortSignal): boolean {
	return Boolean(signal?.aborted || error?.name === "AbortError" || error?.code === "ABORT_ERR");
}

export function isRawTimeout(error: { message?: unknown; signal?: unknown; killed?: boolean } | undefined): boolean {
	const message = typeof error?.message === "string" ? error.message : "";
	return Boolean((error?.killed === true && error.signal === "SIGTERM") || /timed?\s*out|timeout/i.test(message));
}

export function isUninitializedError(text: string): boolean {
	return /Not in an initialized project directory/i.test(text);
}

export function errorToMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

export function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
	return JSON.stringify(value);
}

export function formatCommand(args: string[]): string {
	return ["ccc", ...args].map(shellQuote).join(" ");
}
