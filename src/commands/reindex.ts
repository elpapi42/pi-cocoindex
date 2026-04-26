import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { makeLifecycleNotifier, notify } from "../notify.js";
import { formatIndexStart } from "../output.js";
import { isInitialized, resolveProjectRoot } from "../project.js";
import { CocoIndexRuntime } from "../runtime.js";

export function registerReindexCommand(pi: ExtensionAPI, runtime: CocoIndexRuntime): void {
	pi.registerCommand("cc-reindex", {
		description: "Start a background CocoIndex reindex for this project.",
		handler: async (_args, ctx) => {
			const root = await resolveProjectRoot(ctx.cwd);
			if (!isInitialized(root)) return notify(ctx, `CocoIndex is not initialized for ${root}. Run /cc-init first.`, "warning");
			const start = runtime.startIndex(root, "cc-reindex", { force: true, notify: makeLifecycleNotifier(ctx) });
			notify(ctx, formatIndexStart(start.status, root), start.status === "started" || start.status === "already-running" ? "info" : "warning");
		},
	});
}
