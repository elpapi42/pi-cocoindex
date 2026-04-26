import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { renderCommandFailure, runCcc } from "../ccc.js";
import { STATUS_TIMEOUT_MS } from "../constants.js";
import { notify } from "../notify.js";
import { formatCommandOutput } from "../output.js";
import { resolveProjectRoot } from "../project.js";
import { CocoIndexRuntime } from "../runtime.js";

export function registerStatusCommand(pi: ExtensionAPI, runtime: CocoIndexRuntime): void {
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
}
