import { CccError, errorToMessage, isCancelledError, isCccTimeoutError, isMissingCcc, runCcc } from "./ccc.js";
import { combineOutputs } from "./output.js";
import type { RunOptions } from "./types.js";

export type CocoIndexActivityUnknownReason = "timeout" | "exit-error" | "parse-error" | "spawn-error";

export type CocoIndexActivity =
	| { kind: "indexing"; source: "internal" | "ccc-status"; message: string; rawStatus?: string }
	| { kind: "idle"; source: "ccc-status"; rawStatus: string }
	| { kind: "unknown"; source: "ccc-status"; reason: CocoIndexActivityUnknownReason; message: string; rawStatus?: string };

export async function getCocoIndexActivity(root: string, options: RunOptions): Promise<CocoIndexActivity> {
	try {
		const run = await runCcc(root, ["status"], options);
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
		if (isCancelledError(error, options.signal)) throw error;
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
