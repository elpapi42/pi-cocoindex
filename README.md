# pi-cocoindex

Pi extension that exposes [CocoIndex Code](https://github.com/cocoindex-io/cocoindex) semantic code search as one simple agent tool named `search`.

The product shape is intentionally small: agents get one semantic search tool, while CocoIndex lifecycle/debug controls stay as human slash commands.

## Install

CocoIndex Code must be installed separately because this package is only the Pi extension wrapper:

```bash
pipx install 'cocoindex-code[full]'
```

Install the Pi extension from npm:

```bash
pi install npm:pi-cocoindex
```

Or install directly from GitHub:

```bash
pi install git:github.com/elpapi42/pi-cocoindex
```

For local development from this repository:

```bash
pi -e .
```

## Quickstart

1. Install CocoIndex Code:

   ```bash
   pipx install 'cocoindex-code[full]'
   ```

2. Install or load this Pi extension:

   ```bash
   pi install npm:pi-cocoindex
   # or, while developing locally:
   pi -e .
   ```

3. Initialize CocoIndex for the project from inside Pi:

   ```text
   /cc-init --litellm-model openai/text-embedding-3-small
   ```

   If you already have CocoIndex global settings, `/cc-init` without `--litellm-model` is fine. If global settings do not exist yet, the extension requires `--litellm-model MODEL` to avoid hanging Pi on CocoIndex's interactive first-run setup.

4. Check configuration and indexing health:

   ```text
   /cc-doctor
   /cc-reindex
   /cc-status
   ```

5. Ask Pi to use semantic search. The agent sees only the `search` tool:

   ```ts
   search({
     query: "where request authentication is validated",
     path: "src/api"
   })
   ```

## Agent tool

The extension registers exactly one agent-facing tool:

```ts
search({
  query: string,
  limit?: number, // default 10, max 25
  path?: string   // optional project-relative file or glob; use `src/**` for recursive directory search
})
```

`search` runs `ccc search --limit N [--path PATH] QUERY` from the resolved project root. It does **not** run `--refresh`; indexing is managed in the background so searches stay fast. If background indexing is running or unhealthy, results include a note that they may be stale. Omit `path` unless the user names an area or broad results are noisy. Files like `src/index.ts` work directly; for recursive directory search, use glob form such as `src/**`, not plain `src` or `src/`.

In Pi's TUI, the tool call renders as `search "<query>"`. The collapsed result body renders a compact bulleted summary with relative path, line range, language, and CocoIndex score; the expanded view keeps the same bulleted match format for all parsed matches and adds search metadata such as query, path filter, project root, background index state, and truncation status. The model still receives the full CocoIndex snippets in the tool content.

`path` is project-relative. Leading `@` is stripped for agent convenience, while absolute paths and `..` traversal are rejected. Directory-like filters are not normalized automatically in v1; pass an explicit glob such as `src/**` when you want everything under a directory.

## Project root and indexing

The extension treats the git repository as the product boundary. It resolves the project root in this order:

1. `git rev-parse --show-toplevel`
2. nearest initialized CocoIndex ancestor between Pi's current directory and that git root, if one exists
3. Pi's current working directory, or an initialized ancestor above it only when no git root exists

On session start, if the project is already initialized, the extension starts a deduped background `ccc index`. It does not auto-run `ccc init` from the search tool.

The extension is deliberately chatty while indexing: Pi notifications announce background index start, already-running/cooldown decisions, completion with elapsed time, failures with a short diagnostic hint, and reset-time aborts. If that becomes too noisy in practice, this is the first behavior to tune down.

## Human commands

Lifecycle/debug operations are slash commands for the human, not tools for the agent:

```text
/cc-init [--force|-f] [--litellm-model MODEL]
/cc-status
/cc-reindex
/cc-doctor
/cc-reset [--yes]
```

- `/cc-init` runs `ccc init`, then starts background indexing. If CocoIndex global settings do not exist yet, the command requires `--litellm-model MODEL` for noninteractive setup; otherwise run `ccc init` once in a terminal first.
- `/cc-status` shows dense extension state — initialized status, current index state, reason, start/finish times, last success/failure, retry cooldown, and last error — plus raw `ccc status` output.
- `/cc-reindex` starts/dedupes background `ccc index`.
- `/cc-doctor` runs `ccc doctor`.
- `/cc-reset` confirms unless `--yes`, runs `ccc reset -f`, then starts background indexing if the project remains initialized.

## Notes

- First-time CocoIndex setup may require embedding configuration. To avoid hanging Pi on an interactive prompt, `/cc-init` will not run before global settings exist unless you provide `/cc-init --litellm-model <model>`.
- Background index failures are throttled for five minutes so every search does not repeatedly spawn a failing index process. `/cc-reindex` bypasses that cooldown. Use `/cc-status` whenever chatty lifecycle notifications indicate a failed or stale index.
- CocoIndex settings and index state live outside this npm package and should not be committed from projects that use it.

## License

MIT © 2026 pi-cocoindex contributors.
