import { INDEX_TIMEOUT_MS } from "./constants.js";
import { errorToMessage, runCcc } from "./ccc.js";
import { emitLifecycle } from "./notify.js";
import { formatAge, formatDurationMs, getCooldownRemainingMs, truncateText } from "./output.js";
import { isInitialized } from "./project.js";
import type { BackgroundIndexStartStatus, LifecycleNotifier, ProjectIndexState, StartIndexOptions } from "./types.js";

export class CocoIndexRuntime {
	private readonly states = new Map<string, ProjectIndexState>();
	private disposed = false;

	getState(root: string): ProjectIndexState {
		let state = this.states.get(root);
		if (!state) {
			state = { status: "idle" };
			this.states.set(root, state);
		}
		return state;
	}

	formatState(root: string): string {
		const state = this.getState(root);
		const cooldownRemaining = getCooldownRemainingMs(state);
		const lines = [
			`CocoIndex status for ${root}:`,
			`- initialized: ${isInitialized(root) ? "yes" : "no"}`,
			`- extension index: ${state.status}`,
		];
		if (state.reason) lines.push(`- current/last reason: ${state.reason}`);
		if (state.startedAt) lines.push(`- started: ${formatAge(state.startedAt)} ago`);
		if (state.finishedAt) lines.push(`- finished: ${formatAge(state.finishedAt)} ago`);
		if (state.lastSucceededAt) lines.push(`- last success: ${formatAge(state.lastSucceededAt)} ago`);
		if (state.lastFailureAt) lines.push(`- last failure: ${formatAge(state.lastFailureAt)} ago`);
		if (cooldownRemaining > 0) lines.push(`- retry cooldown: ${formatDurationMs(cooldownRemaining)} remaining`);
		if (state.lastError) lines.push(`- last error: ${truncateText(state.lastError, "tail", 2_000, 80).text}`);
		return lines.join("\n");
	}

	startIndex(root: string, reason: string, options: StartIndexOptions = {}): { status: Exclude<BackgroundIndexStartStatus, "not-started">; state: ProjectIndexState } {
		const state = this.getState(root);
		if (this.disposed) {
			emitLifecycle(options.notify, `index not started (${reason}) for ${root}: extension is shutting down`, "warning");
			return { status: "disposed", state };
		}
		if (state.status === "running" && state.promise) {
			emitLifecycle(options.notify, `index already running for ${root} (current reason: ${state.reason ?? "unknown"}; requested: ${reason})`, "info");
			return { status: "already-running", state };
		}

		const now = Date.now();
		const cooldownRemaining = getCooldownRemainingMs(state, now);
		if (!options.force && cooldownRemaining > 0) {
			emitLifecycle(options.notify, `index not restarted for ${root} (${reason}): last failure is in cooldown for ${formatDurationMs(cooldownRemaining)}. Use /cc-reindex to force.`, "warning");
			return { status: "skipped-cooldown", state };
		}

		const controller = new AbortController();
		state.status = "running";
		state.controller = controller;
		state.reason = reason;
		state.startedAt = now;
		state.finishedAt = undefined;
		state.lastError = undefined;
		emitLifecycle(options.notify, `index started for ${root} (${reason})`, "info");

		let promise!: Promise<void>;
		promise = (async () => {
			let runError: unknown;
			try {
				await runCcc(root, ["index"], { signal: controller.signal, timeoutMs: INDEX_TIMEOUT_MS });
			} catch (error) {
				runError = error;
			}

			if (this.disposed || this.getState(root).promise !== promise) return;

			const finishedAt = Date.now();
			if (runError === undefined) {
				Object.assign(state, {
					status: "succeeded" as const,
					promise: undefined,
					controller: undefined,
					finishedAt,
					lastSucceededAt: finishedAt,
					lastError: undefined,
					lastFailureAt: undefined,
				});
				emitLifecycle(options.notify, `index completed for ${root} (${reason}) in ${formatDurationMs(finishedAt - now)}`, "info");
				return;
			}

			const message = errorToMessage(runError);
			Object.assign(state, {
				status: "failed" as const,
				promise: undefined,
				controller: undefined,
				finishedAt,
				lastError: message,
				lastFailureAt: finishedAt,
			});
			emitLifecycle(options.notify, `index failed for ${root} (${reason}) after ${formatDurationMs(finishedAt - now)}: ${truncateText(message, "tail", 1_500, 40).text}\nRun /cc-status for state or /cc-doctor for diagnostics.`, "warning");
		})();
		state.promise = promise;
		return { status: "started", state };
	}

	abortIndex(root: string, reason = "abort", notify?: LifecycleNotifier): void {
		const state = this.getState(root);
		const wasRunning = state.status === "running";
		const startedAt = state.startedAt;
		state.controller?.abort();
		state.promise = undefined;
		state.controller = undefined;
		state.status = "idle";
		state.reason = undefined;
		state.startedAt = undefined;
		state.finishedAt = undefined;
		if (wasRunning) {
			emitLifecycle(notify, `index aborted for ${root} (${reason}${startedAt ? ` after ${formatDurationMs(Date.now() - startedAt)}` : ""})`, "warning");
		}
	}

	clear(root: string): void {
		this.abortIndex(root);
		this.states.set(root, { status: "idle" });
	}

	shutdown(): void {
		this.disposed = true;
		for (const state of this.states.values()) {
			state.controller?.abort();
			state.promise = undefined;
			state.controller = undefined;
			if (state.status === "running") state.status = "idle";
		}
	}
}
