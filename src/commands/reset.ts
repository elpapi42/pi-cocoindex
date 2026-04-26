import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { renderCommandFailure, runCcc } from "../ccc.js";
import { LONG_COMMAND_TIMEOUT_MS } from "../constants.js";
import { canConfirm, makeLifecycleNotifier, notify, notifyLifecycle } from "../notify.js";
import { formatCommandOutput, formatIndexStart } from "../output.js";
import { isInitialized, resolveProjectRoot } from "../project.js";
import { CocoIndexRuntime } from "../runtime.js";
import { parseResetArgs } from "./args.js";
import { ensureCocoIndexIdleForCommand } from "./guard.js";

export function registerResetCommand(pi: ExtensionAPI, runtime: CocoIndexRuntime): void {
	pi.registerCommand("cc-reset", {
		description: "Reset this project's CocoIndex index, then start background reindexing. Requires confirmation unless --yes is provided.",
		handler: async (args, ctx) => {
			try {
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

				const lifecycleNotifier = makeLifecycleNotifier(ctx);
				runtime.abortIndex(root, "cc-reset", lifecycleNotifier);
				if (!(await ensureCocoIndexIdleForCommand(root, ctx, "reset"))) return;
				const run = await runCcc(root, ["reset", "-f"], { timeoutMs: LONG_COMMAND_TIMEOUT_MS });
				runtime.clear(root);
				const notes = ["CocoIndex reset completed."];
				if (isInitialized(root)) {
					const start = runtime.startIndex(root, "cc-reset", { force: true, notify: lifecycleNotifier });
					notes.push(formatIndexStart(start.status, root));
				}
				notify(ctx, formatCommandOutput("ccc reset", run, "tail", notes), "info");
			} catch (error) {
				notify(ctx, renderCommandFailure(error), "error");
			}
		},
	});
}
