import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getCocoIndexActivity } from "../activity.js";
import { renderToolFailure, runCcc } from "../ccc.js";
import { DEFAULT_LIMIT, MAX_LIMIT, SEARCH_STATUS_TIMEOUT_MS, SEARCH_TIMEOUT_MS } from "../constants.js";
import { combineOutputs, formatSearchIndexNote, truncateText } from "../output.js";
import { isInitialized, resolveProjectRoot } from "../project.js";
import { CocoIndexRuntime } from "../runtime.js";
import type { SearchDetails } from "../types.js";
import { parseCccSearchResults } from "./parse.js";
import { SearchParams } from "./params.js";
import { renderSearchCall, renderSearchResult } from "./render.js";
import { makeIndexingRetryResult, makeUnknownActivityRetryMessage } from "./retry.js";
import path from "node:path";

export function registerSearchTool(pi: ExtensionAPI, runtime: CocoIndexRuntime): void {
	pi.registerTool({
		name: "search",
		label: "Search",
		description: "Semantic code search over the current repository using CocoIndex Code. Finds code by behavior, concept, or responsibility — not by exact string match. Reach for this when describing *what code does* ('where do we handle rate limiting', 'the code that validates auth tokens', 'what's responsible for retries'). The index is maintained automatically in the background.",
		promptSnippet: "search: Semantic code search over the current repository using CocoIndex Code. The index is maintained automatically in the background.",
		promptGuidelines: [
      "Use search for semantic/conceptual questions where you're describing what code does, not searching for an exact string.",
      "For exact strings, symbol names, or every occurrence of a known token, grep is the right tool.",
      "Pattern: search to find the relevant area, then grep within that area for exact matches.",
      "For search.path, use a project-relative path or glob only when the user explicitly names an area or a broader search was too noisy.",
    ],
		parameters: SearchParams,
		renderCall: renderSearchCall,
		renderResult: renderSearchResult,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const root = await resolveProjectRoot(ctx.cwd);
			const query = params.query.trim();
			if (!query) throw new Error("Search query cannot be empty.");
			const limit = normalizeLimit(params.limit);
			const searchPath = normalizeSearchPath(params.path);

			if (!isInitialized(root)) {
				throw new Error(`CocoIndex is not initialized for ${root}. Run /cc-init to create CocoIndex settings and start background indexing, then retry search.`);
			}

			const currentIndexState = runtime.getState(root);
			let backgroundIndex: SearchDetails["backgroundIndex"] = "not-started";
			if (currentIndexState.status === "running") {
				return makeIndexingRetryResult({
					root,
					query,
					limit,
					path: searchPath,
					backgroundIndex: "already-running",
					activity: { kind: "indexing", source: "internal", message: "The Pi extension already has an active CocoIndex indexing job." },
				});
			}

			const activity = await getCocoIndexActivity(root, { signal, timeoutMs: SEARCH_STATUS_TIMEOUT_MS });
			if (activity.kind === "indexing") {
				return makeIndexingRetryResult({ root, query, limit, path: searchPath, backgroundIndex: "already-running", activity });
			}
			if (activity.kind === "unknown") {
				return makeIndexingRetryResult({
					root,
					query,
					limit,
					path: searchPath,
					backgroundIndex: "not-started",
					activity,
					message: makeUnknownActivityRetryMessage({ root, query, limit, path: searchPath, activity }),
				});
			}

			const args = ["search", "--limit", String(limit)];
			if (searchPath) args.push("--path", searchPath);
			args.push(query);

			try {
				const run = await runCcc(root, args, { signal, timeoutMs: SEARCH_TIMEOUT_MS });
				const matches = parseCccSearchResults(run.stdout);
				const combined = combineOutputs(run.stdout, run.stderr) || "No results.";
				const indexState = runtime.getState(root);
				const note = formatSearchIndexNote(backgroundIndex, indexState);
				const truncated = truncateText(`${combined}${note}`, "head");
				return {
					content: [{ type: "text" as const, text: truncated.text }],
					details: {
						command: run.command,
						cwd: run.cwd,
						projectRoot: root,
						query,
						limit,
						path: searchPath,
						status: "ok",
						backgroundIndex,
						truncated: truncated.truncated,
						matches,
					} satisfies SearchDetails,
				};
			} catch (error) {
				throw new Error(renderToolFailure(error, root));
			}
		},
	});
}

function normalizeLimit(value: number | undefined): number {
	if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value)));
}

function normalizeSearchPath(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().replace(/^@+/, "");
	if (!normalized) return undefined;
	if (path.isAbsolute(normalized)) throw new Error("search.path must be project-relative, not absolute.");
	const parts = normalized.split(/[\\/]+/);
	if (parts.includes("..")) throw new Error("search.path cannot contain '..' path traversal.");
	return normalized;
}
