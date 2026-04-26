import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { renderCommandFailure, runCcc } from "../ccc.js";
import { LONG_COMMAND_TIMEOUT_MS } from "../constants.js";
import { makeLifecycleNotifier, notify } from "../notify.js";
import { formatCommandOutput, formatIndexStart } from "../output.js";
import { hasGlobalSettings, isInitialized, resolveProjectRoot } from "../project.js";
import { CocoIndexRuntime } from "../runtime.js";
import { parseInitArgs } from "./args.js";
import { ensureCocoIndexIdleForCommand } from "./guard.js";

export function registerInitCommand(pi: ExtensionAPI, runtime: CocoIndexRuntime): void {
	pi.registerCommand("cc-init", {
		description: "Initialize CocoIndex Code for this project, then start background indexing. Supports --force/-f and --litellm-model MODEL.",
		handler: async (args, ctx) => {
			try {
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

				const lifecycleNotifier = makeLifecycleNotifier(ctx);
				if (isInitialized(root) && !(await ensureCocoIndexIdleForCommand(root, ctx, "init"))) return;
				const run = await runCcc(root, ["init", ...parsed.args], { timeoutMs: LONG_COMMAND_TIMEOUT_MS });
				const start = runtime.startIndex(root, "cc-init", { force: true, notify: lifecycleNotifier });
				const output = formatCommandOutput("CocoIndex init", run, "head", [
					formatIndexStart(start.status, root),
				]);
				notify(ctx, output, "info");
			} catch (error) {
				notify(ctx, renderCommandFailure(error), "error");
			}
		},
	});
}
