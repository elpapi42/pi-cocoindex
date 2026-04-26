import type { CocoIndexActivity } from "../activity.js";
import type { SearchDetails } from "../types.js";

export function makeUnknownActivityRetryMessage(fields: {
	root: string;
	query: string;
	limit: number;
	path?: string;
	activity: Extract<CocoIndexActivity, { kind: "unknown" }>;
}): string {
	const originalSearch = ["Original search:", `- query: ${JSON.stringify(fields.query)}`, `- limit: ${fields.limit}`];
	if (fields.path) originalSearch.push(`- path: ${fields.path}`);
	return [
		`CocoIndex semantic search status could not be confirmed quickly for ${fields.root}.`,
		`Reason: ${fields.activity.reason}.`,
		"To avoid racing an active index operation, retry this search shortly.",
		"Use other available tools such as read, bash, grep, find, or ls while CocoIndex settles, or run /cc-status for diagnostics.",
		"",
		...originalSearch,
	].join("\n");
}

export function makeIndexingRetryResult(fields: {
	root: string;
	query: string;
	limit: number;
	path?: string;
	backgroundIndex: SearchDetails["backgroundIndex"];
	activity?: CocoIndexActivity;
	message?: string;
}) {
	const originalSearch = ["Original search:", `- query: ${JSON.stringify(fields.query)}`, `- limit: ${fields.limit}`];
	if (fields.path) originalSearch.push(`- path: ${fields.path}`);
	const reasonLine = fields.activity?.source === "ccc-status"
		? "CocoIndex status reports that indexing is currently in progress."
		: "The Pi extension already has an active CocoIndex indexing job.";
	const message = fields.message ?? [
		`CocoIndex semantic search is currently indexing for ${fields.root}.`,
		reasonLine,
		"Retry this search shortly; the semantic index is still being updated.",
		"Use other available tools such as read, bash, grep, find, or ls to inspect files while indexing completes.",
		"",
		...originalSearch,
	].join("\n");
	return {
		content: [{ type: "text" as const, text: message }],
		details: {
			status: "indexing" as const,
			cwd: fields.root,
			projectRoot: fields.root,
			query: fields.query,
			limit: fields.limit,
			path: fields.path,
			backgroundIndex: fields.backgroundIndex,
			truncated: false,
			matches: [],
			message,
			retryable: true,
		} satisfies SearchDetails,
	};
}
