import { Text } from "@mariozechner/pi-tui";
import { COLLAPSED_RESULT_COUNT, MAX_PATH_PREVIEW_CHARS, MAX_QUERY_PREVIEW_CHARS } from "../constants.js";
import { previewInline } from "../output.js";
import type { SearchDetails, SearchMatch } from "../types.js";

export function renderSearchCall(args: { query?: string; path?: string }, theme: any) {
	const fg = theme.fg.bind(theme);
	const query = previewInline(args.query || "", MAX_QUERY_PREVIEW_CHARS) || "...";
	const searchPath = previewInline(args.path || "", MAX_PATH_PREVIEW_CHARS);
	const pathSuffix = searchPath ? ` ${fg("dim", `in ${searchPath}`)}` : "";
	return new Text(`${fg("toolTitle", theme.bold("search"))} ${fg("accent", JSON.stringify(query))}${pathSuffix}`, 0, 0);
}

export function renderSearchResult(toolResult: any, { expanded, isPartial }: { expanded: boolean; isPartial?: boolean }, theme: any, context?: { isError?: boolean }) {
	const fg = theme.fg.bind(theme);
	if (isPartial) return new Text(fg("muted", "searching..."), 0, 0);

	if (context?.isError || toolResult?.isError) {
		return new Text(fg("error", getToolResultText(toolResult) || "Search failed."), 0, 0);
	}

	const matches = getSearchMatches(toolResult);
	const details = getSearchDetails(toolResult);

	if (expanded) {
		const lines = renderExpandedSearchResultLines(matches, details, fg);
		return new Text(lines.join("\n"), 0, 0);
	}

	if (details?.status === "indexing" && details.message) return new Text(fg("warning", details.message), 0, 0);
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
	const metadata: string[] = [];
	if (details?.query) metadata.push(`${fg("dim", "query:")} ${fg("accent", JSON.stringify(details.query))}`);
	if (details?.path) metadata.push(`${fg("dim", "path:")} ${fg("toolOutput", details.path)}`);
	if (details?.projectRoot) metadata.push(`${fg("dim", "root:")} ${fg("toolOutput", details.projectRoot)}`);
	if (details?.backgroundIndex) metadata.push(`${fg("dim", "background index:")} ${details.backgroundIndex}`);
	if (details?.retryable) metadata.push(`${fg("dim", "retryable:")} yes`);
	if (details?.truncated) metadata.push(fg("warning", "model-facing output was truncated"));

	const lines = metadata.length > 0 ? ["", ...metadata, ""] : [];
	if (details?.status === "indexing" && details.message) {
		lines.push(fg("warning", details.message));
		return lines;
	}
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
