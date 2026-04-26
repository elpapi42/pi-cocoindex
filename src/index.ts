import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerInitCommand } from "./commands/init.js";
import { registerReindexCommand } from "./commands/reindex.js";
import { registerResetCommand } from "./commands/reset.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerSessionHooks } from "./hooks/session.js";
import { CocoIndexRuntime } from "./runtime.js";
import { registerSearchTool } from "./search/tool.js";

export default function cocoindexExtension(pi: ExtensionAPI): void {
	const runtime = new CocoIndexRuntime();

	registerSearchTool(pi, runtime);

	registerInitCommand(pi, runtime);
	registerStatusCommand(pi, runtime);
	registerReindexCommand(pi, runtime);
	registerDoctorCommand(pi);
	registerResetCommand(pi, runtime);

	registerSessionHooks(pi, runtime);
}
