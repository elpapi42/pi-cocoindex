import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { makeLifecycleNotifier } from "../notify.js";
import { isInitialized, resolveProjectRoot } from "../project.js";
import { CocoIndexRuntime } from "../runtime.js";

export function registerSessionHooks(pi: ExtensionAPI, runtime: CocoIndexRuntime): void {
	pi.on("session_start", async (_event, ctx) => {
		const root = await resolveProjectRoot(ctx.cwd);
		if (isInitialized(root)) runtime.startIndex(root, "session_start", { force: false, notify: makeLifecycleNotifier(ctx) });
	});

	pi.on("session_shutdown", () => {
		runtime.shutdown();
	});
}
