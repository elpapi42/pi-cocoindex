import { CccError, errorToMessage, isCccTimeoutError, isMissingCcc, runCcc } from "./ccc.js";
import { combineOutputs } from "./output.js";
import type { RunOptions } from "./types.js";

const ACTIVITY_CACHE_TTL_MS = 1_000;

export type CocoIndexActivityUnknownReason = "timeout" | "exit-error" | "parse-error" | "spawn-error";

export type CocoIndexActivity =
	| { kind: "indexing"; source: "internal" | "ccc-status"; message: string; rawStatus?: string }
	| { kind: "idle"; source: "ccc-status"; rawStatus: string }
	| { kind: "unknown"; source: "ccc-status"; reason: CocoIndexActivityUnknownReason; message: string; rawStatus?: string };

interface ActivityCacheEntry {
	promise?: Promise<CocoIndexActivity>;
	result?: CocoIndexActivity;
	checkedAt?: number;
}

const activityCache = new Map<string, ActivityCacheEntry>();

export async function getCocoIndexActivity(root: string, options: RunOptions): Promise<CocoIndexActivity> {
	const key = activityCacheKey(root, options.timeoutMs);
	const now = Date.now();
	const cached = activityCache.get(key);
	if (cached?.result && cached.checkedAt && now - cached.checkedAt <= ACTIVITY_CACHE_TTL_MS) {
		return awaitWithCancellation(cached.result, options.signal);
	}
	if (cached?.promise) return awaitWithCancellation(cached.promise, options.signal);

	const promise = readCocoIndexActivity(root, options.timeoutMs);
	activityCache.set(key, { promise });
	promise.then(
		(result) => {
			const current = activityCache.get(key);
			if (current?.promise === promise) {
				const checkedAt = Date.now();
				activityCache.set(key, { result, checkedAt });
				scheduleActivityCacheEviction(key, result, checkedAt);
			}
		},
		() => {
			const current = activityCache.get(key);
			if (current?.promise === promise) activityCache.delete(key);
		},
	);
	return awaitWithCancellation(promise, options.signal);
}

async function readCocoIndexActivity(root: string, timeoutMs: number): Promise<CocoIndexActivity> {
	try {
		const run = await runCcc(root, ["status"], { timeoutMs });
		const rawStatus = combineOutputs(run.stdout, run.stderr);
		const parsed = parseCccStatusActivity(rawStatus);
		if (parsed === "indexing") {
			return {
				kind: "indexing",
				source: "ccc-status",
				message: "`ccc status` reports indexing is in progress.",
				rawStatus,
			};
		}
		if (parsed === "idle") return { kind: "idle", source: "ccc-status", rawStatus };
		return {
			kind: "unknown",
			source: "ccc-status",
			reason: "parse-error",
			message: "`ccc status` returned output the extension could not classify as idle or indexing.",
			rawStatus,
		};
	} catch (error) {
		if (isMissingCcc(error)) throw error;
		return {
			kind: "unknown",
			source: "ccc-status",
			reason: classifyStatusFailure(error),
			message: errorToMessage(error),
			rawStatus: error instanceof CccError ? error.combinedOutput : undefined,
		};
	}
}

function activityCacheKey(root: string, timeoutMs: number): string {
	return `${root}\0${timeoutMs}`;
}

function scheduleActivityCacheEviction(key: string, result: CocoIndexActivity, checkedAt: number): void {
	const timer = setTimeout(() => {
		const current = activityCache.get(key);
		if (current?.result === result && current.checkedAt === checkedAt) activityCache.delete(key);
	}, ACTIVITY_CACHE_TTL_MS);
	timer.unref?.();
}

function awaitWithCancellation<T>(value: T | Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return Promise.resolve(value);
	if (signal.aborted) return Promise.reject(makeAbortError());
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(makeAbortError());
		signal.addEventListener("abort", onAbort, { once: true });
		Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

function makeAbortError(): Error {
	const error = new Error("Cancelled: ccc status");
	error.name = "AbortError";
	return error;
}

export function parseCccStatusActivity(rawStatus: string): "indexing" | "idle" | "unknown" {
	if (/Indexing\s+in\s+progress/i.test(rawStatus)) return "indexing";
	// Fail closed: only classify status as idle when CocoIndex reports usable index stats.
	// A `Project:` line alone can appear alongside future active/error states we do not parse yet.
	if (/Index\s+stats:/i.test(rawStatus)) return "idle";
	return "unknown";
}

export function classifyStatusFailure(error: unknown): CocoIndexActivityUnknownReason {
	if (isCccTimeoutError(error)) return "timeout";
	if (error instanceof CccError && error.code === "ENOENT") return "spawn-error";
	return "exit-error";
}
