import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { renderCommandFailure } from "../ccc.js";
import { makeLifecycleNotifier, notify } from "../notify.js";
import { formatIndexStart } from "../output.js";
import { isInitialized, resolveProjectRoot } from "../project.js";
import { CocoIndexRuntime } from "../runtime.js";
import { ensureCocoIndexIdleForCommand } from "./guard.js";

export function registerReindexCommand(pi: ExtensionAPI, runtime: CocoIndexRuntime): void {
	pi.registerCommand("cc-reindex", {
		description: "Start a background CocoIndex reindex for this project.",
		handler: async (_args, ctx) => {
			try {
				const root = await resolveProjectRoot(ctx.cwd);
				if (!isInitialized(root)) return notify(ctx, `CocoIndex is not initialized for ${root}. Run /cc-init first.`, "warning");
				const lifecycleNotifier = makeLifecycleNotifier(ctx);
				if (!(await ensureCocoIndexIdleForCommand(root, ctx, "reindex"))) return;
				const start = runtime.startIndex(root, "cc-reindex", { force: true, notify: lifecycleNotifier });
				notify(ctx, formatIndexStart(start.status, root), start.status === "started" || start.status === "already-running" ? "info" : "warning");
			} catch (error) {
				notify(ctx, renderCommandFailure(error), "error");
			}
		},
	});
}
