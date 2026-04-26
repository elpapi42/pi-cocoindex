import { getCocoIndexActivity } from "../activity.js";
import { STATUS_TIMEOUT_MS } from "../constants.js";
import { notify } from "../notify.js";
import type { NotifyTarget } from "../notify.js";

export async function ensureCocoIndexIdleForCommand(root: string, ctx: NotifyTarget, action: string): Promise<boolean> {
	const activity = await getCocoIndexActivity(root, { timeoutMs: STATUS_TIMEOUT_MS });
	if (activity.kind === "idle") return true;
	if (activity.kind === "indexing") {
		notify(ctx, `CocoIndex ${action} was not started for ${root} because CocoIndex status reports indexing is already in progress. Retry after indexing completes or run /cc-status for details.`, "info");
		return false;
	}
	notify(ctx, `CocoIndex ${action} was not started for ${root} because idle status could not be confirmed (${activity.reason}). To avoid conflicting with an active index operation, run /cc-status for diagnostics and retry when status is healthy.`, "warning");
	return false;
}
