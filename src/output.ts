import { FAILED_INDEX_COOLDOWN_MS, MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES } from "./constants.js";
import type { BackgroundIndexStartStatus, ProjectIndexState, RunResult, TruncationMode } from "./types.js";

export function formatCommandOutput(title: string, run: RunResult, mode: TruncationMode, notes: string[] = []): string {
	const combined = combineOutputs(run.stdout, run.stderr) || "Command completed with no output.";
	const body = truncateText(combined, mode).text;
	return [`── ${title} ──`, `cwd: ${run.cwd}`, `command: ${run.command}`, "", body, ...notes.map((note) => `\n${note}`)].join("\n").trim();
}

export function formatSearchIndexNote(startStatus: BackgroundIndexStartStatus, state: ProjectIndexState): string {
	if (state.status === "running") {
		return "\n\nNote: CocoIndex background indexing is currently running; results may be slightly stale.";
	}
	if (startStatus === "skipped-cooldown" || state.status === "failed") {
		return "\n\nNote: CocoIndex background indexing is not currently healthy, so results may be stale. Run /cc-status for details or /cc-reindex to retry indexing.";
	}
	return "";
}

export function formatIndexStart(status: Exclude<BackgroundIndexStartStatus, "not-started">, root: string): string {
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

export function previewInline(value: string, maxChars: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function combineOutputs(stdout: string, stderr: string): string {
	const parts = [stdout.trim(), stderr.trim() ? `[stderr]\n${stderr.trim()}` : ""].filter(Boolean);
	return parts.join("\n\n").trim();
}

export function truncateText(text: string, mode: TruncationMode, maxBytes = MAX_OUTPUT_BYTES, maxLines = MAX_OUTPUT_LINES): { text: string; truncated: boolean } {
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

export function countLines(text: string): number {
	if (!text.length) return 0;
	return text.split(/\r?\n/).length;
}

export function truncateUtf8(text: string, maxBytes: number, mode: TruncationMode): string {
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

export function getCooldownRemainingMs(state: ProjectIndexState, now = Date.now()): number {
	if (!state.lastFailureAt) return 0;
	return Math.max(0, FAILED_INDEX_COOLDOWN_MS - (now - state.lastFailureAt));
}

export function formatDurationMs(durationMs: number): string {
	const seconds = Math.max(0, Math.round(durationMs / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	if (minutes < 60) return `${minutes}m ${remainder}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

export function formatAge(timestamp: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	if (minutes < 60) return `${minutes}m ${remainder}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}
