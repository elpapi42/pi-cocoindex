export function parseInitArgs(raw: string): { ok: true; args: string[]; hasLiteLLMModel: boolean } | { ok: false; message: string } {
	const tokens = tokenizeCommandArgs(raw);
	const args: string[] = [];
	let hasLiteLLMModel = false;
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === "--force" || token === "-f") {
			args.push("-f");
			continue;
		}
		if (token === "--litellm-model") {
			const model = tokens[i + 1];
			if (!model) return { ok: false, message: initUsage("Missing MODEL after --litellm-model.") };
			args.push(token, model);
			hasLiteLLMModel = true;
			i += 1;
			continue;
		}
		return { ok: false, message: initUsage(`Unknown argument: ${token}`) };
	}
	return { ok: true, args, hasLiteLLMModel };
}

export function parseResetArgs(raw: string): { ok: true; yes: boolean } | { ok: false; message: string } {
	const tokens = tokenizeCommandArgs(raw);
	let yes = false;
	for (const token of tokens) {
		if (token === "--yes") {
			yes = true;
			continue;
		}
		return { ok: false, message: `Usage: /cc-reset [--yes]\n\nUnknown argument: ${token}` };
	}
	return { ok: true, yes };
}

export function tokenizeCommandArgs(raw: string): string[] {
	return raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => token.replace(/^(["'])(.*)\1$/, "$2")) ?? [];
}

function initUsage(reason: string): string {
	return [`Usage: /cc-init [--force|-f] [--litellm-model MODEL]`, "", reason].join("\n");
}
