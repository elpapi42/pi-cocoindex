import type { LifecycleNotifier, NotifyLevel } from "./types.js";

export interface NotifyTarget {
	hasUI?: boolean;
	ui?: {
		notify(message: string, level?: NotifyLevel): void;
	};
}

export interface ConfirmTarget extends NotifyTarget {
	ui?: NotifyTarget["ui"] & {
		confirm(title: string, message: string): Promise<boolean>;
	};
}

export function notify(ctx: NotifyTarget, message: string, level: NotifyLevel = "info"): void {
	try {
		if (ctx.hasUI === false || !ctx.ui) return;
		ctx.ui.notify(message, level);
	} catch {
		// Notifications should never break commands, tools, or background work.
	}
}

export function notifyLifecycle(ctx: NotifyTarget, message: string, level: NotifyLevel = "info"): void {
	notify(ctx, `CocoIndex: ${message}`, level);
}

export function makeLifecycleNotifier(ctx: NotifyTarget): LifecycleNotifier {
	return (message, level = "info") => notifyLifecycle(ctx, message, level);
}

export function emitLifecycle(notifier: LifecycleNotifier | undefined, message: string, level: NotifyLevel = "info"): void {
	try {
		notifier?.(message, level);
	} catch {
		// Lifecycle notifications are best-effort and must not affect indexing state.
	}
}

export function canConfirm(ctx: ConfirmTarget): ctx is ConfirmTarget & { ui: NonNullable<ConfirmTarget["ui"]> } {
	try {
		return ctx.hasUI !== false && typeof ctx.ui?.confirm === "function";
	} catch {
		return false;
	}
}
