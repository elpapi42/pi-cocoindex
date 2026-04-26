import type { SearchMatch } from "../types.js";

export function parseCccSearchResults(output: string): SearchMatch[] {
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
