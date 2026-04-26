import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { renderCommandFailure, runCcc } from "../ccc.js";
import { LONG_COMMAND_TIMEOUT_MS } from "../constants.js";
import { notify } from "../notify.js";
import { formatCommandOutput } from "../output.js";
import { resolveProjectRoot } from "../project.js";

export function registerDoctorCommand(pi: ExtensionAPI): void {
	pi.registerCommand("cc-doctor", {
		description: "Run `ccc doctor` diagnostics for this project.",
		handler: async (_args, ctx) => {
			const root = await resolveProjectRoot(ctx.cwd);
			try {
				const run = await runCcc(root, ["doctor"], { timeoutMs: LONG_COMMAND_TIMEOUT_MS });
				notify(ctx, formatCommandOutput("ccc doctor", run, "head"), "info");
			} catch (error) {
				notify(ctx, renderCommandFailure(error), "error");
			}
		},
	});
}
