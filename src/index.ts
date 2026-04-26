import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

const execFileAsync = promisify(execFile);

const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const FAILED_INDEX_COOLDOWN_MS = 5 * 60_000;
const COLLAPSED_RESULT_COUNT = 8;
const MAX_QUERY_PREVIEW_CHARS = 96;
const MAX_PATH_PREVIEW_CHARS = 72;

const SEARCH_TIMEOUT_MS = 60_000;
const STATUS_TIMEOUT_MS = 30_000;
const LONG_COMMAND_TIMEOUT_MS = 5 * 60_000;
const INDEX_TIMEOUT_MS = 30 * 60_000;

type TruncationMode = "head" | "tail";

type IndexStatus = "idle" | "running" | "succeeded" | "failed";

interface ProjectIndexState {
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

interface RunResult {
	command: string;
	cwd: string;
	stdout: string;
	stderr: string;
}

interface RunOptions {
	signal?: AbortSignal;
	timeoutMs: number;
}

interface SearchMatch {
	rank: number;
	score: number;
	path: string;
	startLine?: number;
	endLine?: number;
	language?: string;
}

interface SearchDetails {
	command: string;
	cwd: string;
	projectRoot: string;
	query: string;
	limit: number;
	path?: string;
	backgroundIndex: "started" | "already-running" | "skipped-cooldown" | "disposed";
	truncated: boolean;
	matches: SearchMatch[];
}

type NotifyLevel = "info" | "warning" | "error";
type LifecycleNotifier = (message: string, level?: NotifyLevel) => void;

interface NotifyTarget {
	hasUI?: boolean;
	ui?: {
		notify(message: string, level?: NotifyLevel): void;
	};
}

interface ConfirmTarget extends NotifyTarget {
	ui?: NotifyTarget["ui"] & {
		confirm(title: string, message: string): Promise<boolean>;
	};
}

interface StartIndexOptions {
	force?: boolean;
	notify?: LifecycleNotifier;
}

class CccError extends Error {
	readonly command: string;
	readonly cwd: string;
	readonly stdout: string;
	readonly stderr: string;
	readonly code: unknown;

	constructor(message: string, fields: { command: string; cwd: string; stdout?: string; stderr?: string; code?: unknown }) {
		super(message);
		this.name = "CccError";
		this.command = fields.command;
		this.cwd = fields.cwd;
		this.stdout = fields.stdout ?? "";
		this.stderr = fields.stderr ?? "";
		this.code = fields.code;
	}

	get combinedOutput(): string {
		return combineOutputs(this.stdout, this.stderr || this.message);
	}
}

class CocoIndexRuntime {
	private readonly states = new Map<string, ProjectIndexState>();
	private disposed = false;

	getState(root: string): ProjectIndexState {
		let state = this.states.get(root);
		if (!state) {
			state = { status: "idle" };
			this.states.set(root, state);
		}
		return state;
	}

	formatState(root: string): string {
		const state = this.getState(root);
		const cooldownRemaining = getCooldownRemainingMs(state);
		const lines = [
			`CocoIndex status for ${root}:`,
			`- initialized: ${isInitialized(root) ? "yes" : "no"}`,
			`- extension index: ${state.status}`,
		];
		if (state.reason) lines.push(`- current/last reason: ${state.reason}`);
		if (state.startedAt) lines.push(`- started: ${formatAge(state.startedAt)} ago`);
		if (state.finishedAt) lines.push(`- finished: ${formatAge(state.finishedAt)} ago`);
		if (state.lastSucceededAt) lines.push(`- last success: ${formatAge(state.lastSucceededAt)} ago`);
		if (state.lastFailureAt) lines.push(`- last failure: ${formatAge(state.lastFailureAt)} ago`);
		if (cooldownRemaining > 0) lines.push(`- retry cooldown: ${formatDurationMs(cooldownRemaining)} remaining`);
		if (state.lastError) lines.push(`- last error: ${truncateText(state.lastError, "tail", 2_000, 80).text}`);
		return lines.join("\n");
	}

	startIndex(root: string, reason: string, options: StartIndexOptions = {}): { status: "started" | "already-running" | "skipped-cooldown" | "disposed"; state: ProjectIndexState } {
		const state = this.getState(root);
		if (this.disposed) {
			emitLifecycle(options.notify, `index not started (${reason}) for ${root}: extension is shutting down`, "warning");
			return { status: "disposed", state };
		}
		if (state.status === "running" && state.promise) {
			emitLifecycle(options.notify, `index already running for ${root} (current reason: ${state.reason ?? "unknown"}; requested: ${reason})`, "info");
			return { status: "already-running", state };
		}

		const now = Date.now();
		const cooldownRemaining = getCooldownRemainingMs(state, now);
		if (!options.force && cooldownRemaining > 0) {
			emitLifecycle(options.notify, `index not restarted for ${root} (${reason}): last failure is in cooldown for ${formatDurationMs(cooldownRemaining)}. Use /cc-reindex to force.`, "warning");
			return { status: "skipped-cooldown", state };
		}

		const controller = new AbortController();
		state.status = "running";
		state.controller = controller;
		state.reason = reason;
		state.startedAt = now;
		state.finishedAt = undefined;
		state.lastError = undefined;
		emitLifecycle(options.notify, `index started for ${root} (${reason})`, "info");

		let promise!: Promise<void>;
		promise = (async () => {
			let runError: unknown;
			try {
				await runCcc(root, ["index"], { signal: controller.signal, timeoutMs: INDEX_TIMEOUT_MS });
			} catch (error) {
				runError = error;
			}

			if (this.disposed || this.getState(root).promise !== promise) return;

			const finishedAt = Date.now();
			if (runError === undefined) {
				Object.assign(state, {
					status: "succeeded" as const,
					promise: undefined,
					controller: undefined,
					finishedAt,
					lastSucceededAt: finishedAt,
					lastError: undefined,
					lastFailureAt: undefined,
				});
				emitLifecycle(options.notify, `index completed for ${root} (${reason}) in ${formatDurationMs(finishedAt - now)}`, "info");
				return;
			}

			const message = errorToMessage(runError);
			Object.assign(state, {
				status: "failed" as const,
				promise: undefined,
				controller: undefined,
				finishedAt,
				lastError: message,
				lastFailureAt: finishedAt,
			});
			emitLifecycle(options.notify, `index failed for ${root} (${reason}) after ${formatDurationMs(finishedAt - now)}: ${truncateText(message, "tail", 1_500, 40).text}\nRun /cc-status for state or /cc-doctor for diagnostics.`, "warning");
		})();
		state.promise = promise;
		return { status: "started", state };
	}

	abortIndex(root: string, reason = "abort", notify?: LifecycleNotifier): void {
		const state = this.getState(root);
		const wasRunning = state.status === "running";
		const startedAt = state.startedAt;
		state.controller?.abort();
		state.promise = undefined;
		state.controller = undefined;
		state.status = "idle";
		state.reason = undefined;
		state.startedAt = undefined;
		state.finishedAt = undefined;
		if (wasRunning) {
			emitLifecycle(notify, `index aborted for ${root} (${reason}${startedAt ? ` after ${formatDurationMs(Date.now() - startedAt)}` : ""})`, "warning");
		}
	}

	clear(root: string): void {
		this.abortIndex(root);
		this.states.set(root, { status: "idle" });
	}

	shutdown(): void {
		this.disposed = true;
		for (const state of this.states.values()) {
			state.controller?.abort();
			state.promise = undefined;
			state.controller = undefined;
			if (state.status === "running") state.status = "idle";
		}
	}
}

const SearchParams = Type.Object({
	query: Type.String({ description: "Natural-language description of the code, behavior, concept, or responsibility to find." }),
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_LIMIT, description: `Maximum number of matches to return. Defaults to ${DEFAULT_LIMIT}.` })),
	path: Type.Optional(Type.String({ description: "Optional project-relative file, directory, or glob to narrow semantic search. Omit unless the user named a specific area." })),
});


function renderSearchCall(args: { query?: string; path?: string }, theme: any) {
	const fg = theme.fg.bind(theme);
	const query = previewInline(args.query || "", MAX_QUERY_PREVIEW_CHARS) || "...";
	const searchPath = previewInline(args.path || "", MAX_PATH_PREVIEW_CHARS);
	const pathSuffix = searchPath ? ` ${fg("dim", `in ${searchPath}`)}` : "";
	return new Text(`${fg("toolTitle", theme.bold("search"))} ${fg("accent", JSON.stringify(query))}${pathSuffix}`, 0, 0);
}

function renderSearchResult(toolResult: any, { expanded, isPartial }: { expanded: boolean; isPartial?: boolean }, theme: any, context?: { isError?: boolean }) {
	const fg = theme.fg.bind(theme);
	if (isPartial) return new Text(fg("muted", "searching..."), 0, 0);

	if (context?.isError || toolResult?.isError) {
		return new Text(fg("error", getToolResultText(toolResult) || "Search failed."), 0, 0);
	}

	const matches = getSearchMatches(toolResult);

	if (expanded) {
		const details = getSearchDetails(toolResult);
		const lines = renderExpandedSearchResultLines(matches, details, fg);
		return new Text(lines.join("\n"), 0, 0);
	}

	if (!matches.length) return new Text(fg("muted", "No results"), 0, 0);

	const shown = matches.slice(0, COLLAPSED_RESULT_COUNT);
	const lines = shown.map((match) => `${fg("dim", "•")} ${formatSearchMatchSummary(match, fg)}`);
	if (matches.length > shown.length) {
		lines.push(fg("muted", `... ${matches.length - shown.length} more`));
	}
	return new Text(lines.join("\n"), 0, 0);
}

function getToolResultText(toolResult: any): string {
	const content = toolResult?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((item) => item?.type === "text" && typeof item.text === "string")
		.map((item) => item.text.trim())
		.filter(Boolean)
		.join("\n\n");
}

function formatSearchMatchLocation(match: SearchMatch): string {
	if (match.startLine === undefined) return match.path;
	const range = match.endLine !== undefined && match.endLine !== match.startLine ? `${match.startLine}-${match.endLine}` : String(match.startLine);
	return `${match.path}:${range}`;
}

function formatSearchMatchSummary(match: SearchMatch, fg: (key: string, value: string) => string): string {
	const score = Number.isFinite(match.score) ? match.score.toFixed(3) : "?";
	const language = match.language ? ` ${match.language}` : "";
	return `${fg("toolOutput", formatSearchMatchLocation(match))}${fg("dim", `${language} ${score}`)}`;
}

function renderExpandedSearchResultLines(matches: SearchMatch[], details: Partial<SearchDetails> | undefined, fg: (key: string, value: string) => string): string[] {
	const lines = [fg("toolTitle", `Search results (${matches.length})`)];
	if (details?.query) lines.push(`${fg("dim", "query:")} ${fg("accent", JSON.stringify(details.query))}`);
	if (details?.path) lines.push(`${fg("dim", "path:")} ${fg("toolOutput", details.path)}`);
	if (details?.projectRoot) lines.push(`${fg("dim", "root:")} ${fg("toolOutput", details.projectRoot)}`);
	if (details?.backgroundIndex) lines.push(`${fg("dim", "background index:")} ${details.backgroundIndex}`);
	if (details?.truncated) lines.push(fg("warning", "model-facing output was truncated"));
	lines.push("");
	if (!matches.length) {
		lines.push(fg("muted", "No parsed matches"));
		return lines;
	}
	for (const match of matches) {
		lines.push(`${fg("dim", "•")} ${formatSearchMatchSummary(match, fg)}`);
	}
	return lines;
}

function getSearchDetails(toolResult: any): Partial<SearchDetails> | undefined {
	const details = toolResult?.details;
	return details && typeof details === "object" ? details : undefined;
}

function getSearchMatches(toolResult: any): SearchMatch[] {
	const matches = toolResult?.details?.matches;
	return Array.isArray(matches) ? matches.filter(isSearchMatch) : [];
}

function isSearchMatch(value: any): value is SearchMatch {
	return value && typeof value.rank === "number" && typeof value.score === "number" && typeof value.path === "string";
}

export default function cocoindexExtension(pi: ExtensionAPI): void {
	const runtime = new CocoIndexRuntime();

	pi.registerTool({
		name: "search",
		label: "Search",
		description: "Semantic code search over the current repository using CocoIndex Code. CocoIndex indexing is maintained in the background; use this to find relevant code by behavior, concept, or responsibility.",
		promptSnippet: "search: Semantic code search over the current repository using CocoIndex Code. The index is maintained automatically in the background.",
		promptGuidelines: [
			"Use search for semantic code discovery when you need to find code by behavior, concept, responsibility, or natural-language description.",
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

			const indexNotifier = makeLifecycleNotifier(ctx);
			const start = runtime.startIndex(root, "search", { force: false, notify: indexNotifier });
			const args = ["search", "--limit", String(limit)];
			if (searchPath) args.push("--path", searchPath);
			args.push(query);

			try {
				const run = await runCcc(root, args, { signal, timeoutMs: SEARCH_TIMEOUT_MS });
				const matches = parseCccSearchResults(run.stdout);
				const combined = combineOutputs(run.stdout, run.stderr) || "No results.";
				const indexState = runtime.getState(root);
				const note = formatSearchIndexNote(start.status, indexState);
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
						backgroundIndex: start.status,
						truncated: truncated.truncated,
						matches,
					} satisfies SearchDetails,
				};
			} catch (error) {
				throw new Error(renderToolFailure(error, root));
			}
		},
	});

	pi.registerCommand("cc-init", {
		description: "Initialize CocoIndex Code for this project, then start background indexing. Supports --force/-f and --litellm-model MODEL.",
		handler: async (args, ctx) => {
			const root = await resolveProjectRoot(ctx.cwd);
			const parsed = parseInitArgs(args);
			if (!parsed.ok) return notify(ctx, parsed.message, "error");

			if (!hasGlobalSettings() && !parsed.hasLiteLLMModel) {
				return notify(ctx, [
					"CocoIndex global settings do not exist yet, and first-time `ccc init` may require interactive embedding configuration.",
					"To avoid hanging Pi, this command was not started.",
					"",
					"Use noninteractive LiteLLM setup:",
					"  /cc-init --litellm-model <model>",
					"",
					"Or run `ccc init` once in a terminal, then retry /cc-init.",
				].join("\n"), "warning");
			}

			try {
				const run = await runCcc(root, ["init", ...parsed.args], { timeoutMs: LONG_COMMAND_TIMEOUT_MS });
				const start = runtime.startIndex(root, "cc-init", { force: true, notify: makeLifecycleNotifier(ctx) });
				const output = formatCommandOutput("CocoIndex init", run, "head", [
					formatIndexStart(start.status, root),
				]);
				notify(ctx, output, "info");
			} catch (error) {
				notify(ctx, renderCommandFailure(error), "error");
			}
		},
	});

	pi.registerCommand("cc-status", {
		description: "Show CocoIndex extension state and `ccc status` output for this project.",
		handler: async (_args, ctx) => {
			const root = await resolveProjectRoot(ctx.cwd);
			try {
				const run = await runCcc(root, ["status"], { timeoutMs: STATUS_TIMEOUT_MS });
				const output = [runtime.formatState(root), "", formatCommandOutput("ccc status", run, "head")].join("\n");
				notify(ctx, output, "info");
			} catch (error) {
				notify(ctx, [runtime.formatState(root), "", renderCommandFailure(error)].join("\n"), "error");
			}
		},
	});

	pi.registerCommand("cc-reindex", {
		description: "Start a background CocoIndex reindex for this project.",
		handler: async (_args, ctx) => {
			const root = await resolveProjectRoot(ctx.cwd);
			if (!isInitialized(root)) return notify(ctx, `CocoIndex is not initialized for ${root}. Run /cc-init first.`, "warning");
			const start = runtime.startIndex(root, "cc-reindex", { force: true, notify: makeLifecycleNotifier(ctx) });
			notify(ctx, formatIndexStart(start.status, root), start.status === "started" || start.status === "already-running" ? "info" : "warning");
		},
	});

	pi.registerCommand("cc-doctor", {
		description: "Run `ccc doctor` diagnostics for this project.",
		handler: async (_args, ctx) => {
			const root = await resolveProjectRoot(ctx.cwd);
			try {
				const run = await runCcc(root, ["doctor"], { timeoutMs: LONG_COMMAND_TIMEOUT_MS });
				notify(ctx, formatCommandOutput("ccc doctor", run, "head"), "info");
			} catch (error) {
				notify(ctx, renderCommandFailure(error), "error");
			}
		},
	});

	pi.registerCommand("cc-reset", {
		description: "Reset this project's CocoIndex index, then start background reindexing. Requires confirmation unless --yes is provided.",
		handler: async (args, ctx) => {
			const root = await resolveProjectRoot(ctx.cwd);
			const parsed = parseResetArgs(args);
			if (!parsed.ok) return notify(ctx, parsed.message, "error");

			if (!parsed.yes) {
				if (!canConfirm(ctx)) {
					return notifyLifecycle(ctx, "reset requires confirmation. Use /cc-reset --yes in non-interactive mode.", "warning");
				}
				const confirmed = await ctx.ui.confirm("Reset CocoIndex?", `This will reset CocoIndex index data for:\n${root}\n\nSettings are kept. The extension will start background reindexing afterward.`);
				if (!confirmed) return notifyLifecycle(ctx, "reset cancelled", "info");
			}

			try {
				runtime.abortIndex(root, "cc-reset", makeLifecycleNotifier(ctx));
				const run = await runCcc(root, ["reset", "-f"], { timeoutMs: LONG_COMMAND_TIMEOUT_MS });
				runtime.clear(root);
				const notes = ["CocoIndex reset completed."];
				if (isInitialized(root)) {
					const start = runtime.startIndex(root, "cc-reset", { force: true, notify: makeLifecycleNotifier(ctx) });
					notes.push(formatIndexStart(start.status, root));
				}
				notify(ctx, formatCommandOutput("ccc reset", run, "tail", notes), "info");
			} catch (error) {
				notify(ctx, renderCommandFailure(error), "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const root = await resolveProjectRoot(ctx.cwd);
		if (isInitialized(root)) runtime.startIndex(root, "session_start", { force: false, notify: makeLifecycleNotifier(ctx) });
	});

	pi.on("session_shutdown", () => {
		runtime.shutdown();
	});
}


function parseCccSearchResults(output: string): SearchMatch[] {
	const lines = output.split(/\r?\n/);
	const matches: SearchMatch[] = [];
	let pending: { rank: number; score: number } | undefined;

	for (const line of lines) {
		const resultMatch = line.match(/^--- Result\s+(\d+)\s+\(score:\s*([^\)]+)\)\s+---$/);
		if (resultMatch) {
			const rank = Number(resultMatch[1]);
			const score = Number(resultMatch[2]);
			pending = Number.isFinite(rank) && Number.isFinite(score) ? { rank, score } : undefined;
			continue;
		}

		if (!pending) continue;
		const fileMatch = line.match(/^File:\s+(.+?)(?:\s+\[([^\]]+)\])?$/);
		if (!fileMatch) continue;

		const pathAndRange = fileMatch[1].trim();
		const rangeMatch = pathAndRange.match(/^(.+):(\d+)(?:-(\d+))?$/);
		const startLine = rangeMatch ? Number(rangeMatch[2]) : undefined;
		const endLine = rangeMatch ? Number(rangeMatch[3] ?? rangeMatch[2]) : undefined;

		matches.push({
			rank: pending.rank,
			score: pending.score,
			path: rangeMatch ? rangeMatch[1] : pathAndRange,
			...(startLine !== undefined ? { startLine } : {}),
			...(endLine !== undefined ? { endLine } : {}),
			...(fileMatch[2] ? { language: fileMatch[2].trim() } : {}),
		});
		pending = undefined;
	}

	return matches;
}

async function resolveProjectRoot(cwd: string): Promise<string> {
	const gitRoot = await findGitRoot(cwd);
	if (gitRoot) {
		const initializedRoot = findInitializedAncestor(cwd, gitRoot);
		return initializedRoot ?? gitRoot;
	}
	return findInitializedAncestor(cwd) ?? path.resolve(cwd);
}

function findInitializedAncestor(cwd: string, stopRoot?: string): string | null {
	let current = path.resolve(cwd);
	const stop = stopRoot ? path.resolve(stopRoot) : undefined;
	while (true) {
		if (existsSync(path.join(current, ".cocoindex_code", "settings.yml"))) return current;
		if (stop && current === stop) return null;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

async function findGitRoot(cwd: string): Promise<string | null> {
	try {
		const result = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			timeout: 5_000,
			maxBuffer: 1024 * 1024,
			env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
		});
		const root = String(result.stdout ?? "").trim();
		return root || null;
	} catch {
		return null;
	}
}

function isInitialized(root: string): boolean {
	return existsSync(path.join(root, ".cocoindex_code", "settings.yml"));
}

function hasGlobalSettings(): boolean {
	return existsSync(path.join(os.homedir(), ".cocoindex_code", "global_settings.yml"));
}

async function runCcc(cwd: string, args: string[], options: RunOptions): Promise<RunResult> {
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
		const err = error as NodeJS.ErrnoException & { stdout?: unknown; stderr?: unknown; code?: unknown };
		throw new CccError(renderRawFailure(err, command), {
			command,
			cwd,
			stdout: String(err.stdout ?? ""),
			stderr: String(err.stderr ?? err.message ?? ""),
			code: err.code,
		});
	}
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

function parseInitArgs(raw: string): { ok: true; args: string[]; hasLiteLLMModel: boolean } | { ok: false; message: string } {
	const tokens = tokenizeCommandArgs(raw);
	const args: string[] = [];
	let hasLiteLLMModel = false;
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === "--force" || token === "-f") {
			args.push("-f");
			continue;
		}
		if (token === "--litellm-model") {
			const model = tokens[i + 1];
			if (!model) return { ok: false, message: initUsage("Missing MODEL after --litellm-model.") };
			args.push(token, model);
			hasLiteLLMModel = true;
			i += 1;
			continue;
		}
		return { ok: false, message: initUsage(`Unknown argument: ${token}`) };
	}
	return { ok: true, args, hasLiteLLMModel };
}

function parseResetArgs(raw: string): { ok: true; yes: boolean } | { ok: false; message: string } {
	const tokens = tokenizeCommandArgs(raw);
	let yes = false;
	for (const token of tokens) {
		if (token === "--yes") {
			yes = true;
			continue;
		}
		return { ok: false, message: `Usage: /cc-reset [--yes]\n\nUnknown argument: ${token}` };
	}
	return { ok: true, yes };
}

function tokenizeCommandArgs(raw: string): string[] {
	return raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => token.replace(/^(["'])(.*)\1$/, "$2")) ?? [];
}

function initUsage(reason: string): string {
	return [`Usage: /cc-init [--force|-f] [--litellm-model MODEL]`, "", reason].join("\n");
}

function renderToolFailure(error: unknown, root: string): string {
	if (isMissingCcc(error)) return missingCccMessage();
	const text = error instanceof CccError ? error.combinedOutput : errorToMessage(error);
	if (isUninitializedError(text)) return `CocoIndex is not initialized for ${root}. Run /cc-init to create CocoIndex settings and start background indexing, then retry search.`;
	return error instanceof CccError ? error.message : text;
}

function renderCommandFailure(error: unknown): string {
	if (isMissingCcc(error)) return missingCccMessage();
	return errorToMessage(error);
}

function renderRawFailure(error: { code?: unknown; name?: string; stdout?: unknown; stderr?: unknown; message?: string }, command: string): string {
	if (error.code === "ENOENT") return missingCccMessage();
	if (error.name === "AbortError") return `Cancelled: ${command}`;
	const combined = combineOutputs(String(error.stdout ?? ""), String(error.stderr ?? error.message ?? ""));
	const truncated = truncateText(combined || String(error.message ?? "Unknown ccc error."), "tail").text;
	const exitInfo = typeof error.code === "number" ? ` (exit ${error.code})` : "";
	return `${command} failed${exitInfo}.\n\n${truncated}`;
}

function missingCccMessage(): string {
	return [
		"Semantic search is unavailable because the `ccc` command was not found.",
		"Install CocoIndex Code:",
		"  pipx install 'cocoindex-code[full]'",
		"Then reload Pi or retry.",
	].join("\n");
}

function isMissingCcc(error: unknown): boolean {
	return error instanceof CccError && error.code === "ENOENT";
}

function isUninitializedError(text: string): boolean {
	return /Not in an initialized project directory/i.test(text);
}

function errorToMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function formatCommandOutput(title: string, run: RunResult, mode: TruncationMode, notes: string[] = []): string {
	const combined = combineOutputs(run.stdout, run.stderr) || "Command completed with no output.";
	const body = truncateText(combined, mode).text;
	return [`── ${title} ──`, `cwd: ${run.cwd}`, `command: ${run.command}`, "", body, ...notes.map((note) => `\n${note}`)].join("\n").trim();
}

function formatSearchIndexNote(startStatus: "started" | "already-running" | "skipped-cooldown" | "disposed", state: ProjectIndexState): string {
	if (state.status === "running") {
		return "\n\nNote: CocoIndex background indexing is currently running; results may be slightly stale.";
	}
	if (startStatus === "skipped-cooldown" || state.status === "failed") {
		return "\n\nNote: CocoIndex background indexing is not currently healthy, so results may be stale. Run /cc-status for details or /cc-reindex to retry indexing.";
	}
	return "";
}

function formatIndexStart(status: "started" | "already-running" | "skipped-cooldown" | "disposed", root: string): string {
	switch (status) {
		case "started":
			return `CocoIndex background indexing started for ${root}.`;
		case "already-running":
			return `CocoIndex background indexing is already running for ${root}.`;
		case "skipped-cooldown":
			return `CocoIndex background indexing was not restarted because the last attempt failed recently. Run /cc-reindex to force another attempt.`;
		case "disposed":
			return "CocoIndex extension is shutting down; indexing was not started.";
	}
}

function notify(ctx: NotifyTarget, message: string, level: NotifyLevel = "info"): void {
	try {
		if (ctx.hasUI === false || !ctx.ui) return;
		ctx.ui.notify(message, level);
	} catch {
		// Notifications should never break commands, tools, or background work.
	}
}

function notifyLifecycle(ctx: NotifyTarget, message: string, level: NotifyLevel = "info"): void {
	notify(ctx, `CocoIndex: ${message}`, level);
}

function makeLifecycleNotifier(ctx: NotifyTarget): LifecycleNotifier {
	return (message, level = "info") => notifyLifecycle(ctx, message, level);
}

function emitLifecycle(notifier: LifecycleNotifier | undefined, message: string, level: NotifyLevel = "info"): void {
	try {
		notifier?.(message, level);
	} catch {
		// Lifecycle notifications are best-effort and must not affect indexing state.
	}
}

function canConfirm(ctx: ConfirmTarget): ctx is ConfirmTarget & { ui: NonNullable<ConfirmTarget["ui"]> } {
	try {
		return ctx.hasUI !== false && typeof ctx.ui?.confirm === "function";
	} catch {
		return false;
	}
}


function previewInline(value: string, maxChars: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
	return JSON.stringify(value);
}

function formatCommand(args: string[]): string {
	return ["ccc", ...args].map(shellQuote).join(" ");
}

function combineOutputs(stdout: string, stderr: string): string {
	const parts = [stdout.trim(), stderr.trim() ? `[stderr]\n${stderr.trim()}` : ""].filter(Boolean);
	return parts.join("\n\n").trim();
}

function truncateText(text: string, mode: TruncationMode, maxBytes = MAX_OUTPUT_BYTES, maxLines = MAX_OUTPUT_LINES): { text: string; truncated: boolean } {
	const originalBytes = Buffer.byteLength(text, "utf8");
	const originalLines = countLines(text);
	let next = text;
	let truncated = false;

	const lines = next.split(/\r?\n/);
	if (lines.length > maxLines) {
		truncated = true;
		next = mode === "head" ? lines.slice(0, maxLines).join("\n") : lines.slice(lines.length - maxLines).join("\n");
	}

	if (Buffer.byteLength(next, "utf8") > maxBytes) {
		truncated = true;
		next = truncateUtf8(next, maxBytes, mode);
	}

	if (!truncated) return { text: next, truncated: false };
	const note = `[output truncated: ${originalLines} lines, ${originalBytes} bytes total; showing ${countLines(next)} lines, ${Buffer.byteLength(next, "utf8")} bytes]`;
	return { text: `${next}${next.endsWith("\n") ? "" : "\n\n"}${note}`, truncated: true };
}

function countLines(text: string): number {
	if (!text.length) return 0;
	return text.split(/\r?\n/).length;
}

function truncateUtf8(text: string, maxBytes: number, mode: TruncationMode): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	if (mode === "head") {
		let end = text.length;
		while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) end -= 1;
		return text.slice(0, end);
	}
	let start = 0;
	while (start < text.length && Buffer.byteLength(text.slice(start), "utf8") > maxBytes) start += 1;
	return text.slice(start);
}

function getCooldownRemainingMs(state: ProjectIndexState, now = Date.now()): number {
	if (!state.lastFailureAt) return 0;
	return Math.max(0, FAILED_INDEX_COOLDOWN_MS - (now - state.lastFailureAt));
}

function formatDurationMs(durationMs: number): string {
	const seconds = Math.max(0, Math.round(durationMs / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	if (minutes < 60) return `${minutes}m ${remainder}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

function formatAge(timestamp: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	if (minutes < 60) return `${minutes}m ${remainder}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}
