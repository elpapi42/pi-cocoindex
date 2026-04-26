import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function resolveProjectRoot(cwd: string): Promise<string> {
	const gitRoot = await findGitRoot(cwd);
	if (gitRoot) {
		const initializedRoot = findInitializedAncestor(cwd, gitRoot);
		return initializedRoot ?? gitRoot;
	}
	return findInitializedAncestor(cwd) ?? path.resolve(cwd);
}

export function findInitializedAncestor(cwd: string, stopRoot?: string): string | null {
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

export async function findGitRoot(cwd: string): Promise<string | null> {
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

export function isInitialized(root: string): boolean {
	return existsSync(path.join(root, ".cocoindex_code", "settings.yml"));
}

export function hasGlobalSettings(): boolean {
	return existsSync(path.join(os.homedir(), ".cocoindex_code", "global_settings.yml"));
}
