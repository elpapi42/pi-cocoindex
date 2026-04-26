import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getCocoIndexActivity } from "../activity.js";
import { errorToMessage } from "../ccc.js";
import { AUTO_INDEX_STATUS_TIMEOUT_MS } from "../constants.js";
import { emitLifecycle, makeLifecycleNotifier } from "../notify.js";
import { truncateText } from "../output.js";
import { isInitialized, resolveProjectRoot } from "../project.js";
import { CocoIndexRuntime } from "../runtime.js";

export function registerSessionHooks(pi: ExtensionAPI, runtime: CocoIndexRuntime): void {
	pi.on("agent_end", (_event, ctx) => {
		const cwd = ctx.cwd;
		const notify = makeLifecycleNotifier(ctx);
		void (async () => {
			let root = cwd;
			try {
				root = await resolveProjectRoot(cwd);
				if (!isInitialized(root)) return;

				const activity = await getCocoIndexActivity(root, { timeoutMs: AUTO_INDEX_STATUS_TIMEOUT_MS });
				if (activity.kind === "indexing") {
					emitLifecycle(notify, `auto-index not started for ${root}: CocoIndex status reports indexing is already in progress`, "info");
					return;
				}
				if (activity.kind === "unknown") {
					emitLifecycle(notify, `auto-index not started for ${root}: CocoIndex status is unknown (${activity.reason})`, "warning");
					return;
				}

				runtime.startIndex(root, "agent_end", { force: false, notify });
			} catch (error) {
				const message = truncateText(errorToMessage(error), "tail", 1_000, 20).text;
				emitLifecycle(notify, `auto-index not started for ${root}: failed to check CocoIndex status: ${message}`, "warning");
			}
		})();
	});

	pi.on("session_shutdown", () => {
		runtime.shutdown();
	});
}
