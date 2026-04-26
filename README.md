# pi-cocoindex

Pi extension that exposes [CocoIndex Code](https://github.com/cocoindex-io/cocoindex) semantic code search as one simple agent tool named `search`.

## Install / load

From this directory:

```bash
pi -e .
```

CocoIndex Code must be installed separately:

```bash
pipx install 'cocoindex-code[full]'
```

## Agent tool

The extension registers exactly one agent-facing tool:

```ts
search({
  query: string,
  limit?: number, // default 10, max 25
  path?: string   // optional project-relative file, directory, or glob
})
```

`search` runs `ccc search --limit N [--path PATH] QUERY` from the resolved project root. It does **not** run `--refresh`; indexing is managed in the background so searches stay fast. If background indexing is running, results include a note that they may be slightly stale.

`path` is project-relative. Leading `@` is stripped for agent convenience, while absolute paths and `..` traversal are rejected.

## Project root and indexing

The extension treats the git repository as the product boundary. It resolves the project root in this order:

1. `git rev-parse --show-toplevel`
2. nearest initialized CocoIndex ancestor between Pi's current directory and that git root, if one exists
3. Pi's current working directory, or an initialized ancestor above it only when no git root exists

On session start, if the project is already initialized, the extension starts a deduped background `ccc index`. It does not auto-run `ccc init` from the search tool.

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
- `/cc-status` shows extension state plus `ccc status`.
- `/cc-reindex` starts/dedupes background `ccc index`.
- `/cc-doctor` runs `ccc doctor`.
- `/cc-reset` confirms unless `--yes`, runs `ccc reset -f`, then starts background indexing if the project remains initialized.

## Notes

- First-time CocoIndex setup may require embedding configuration. To avoid hanging Pi on an interactive prompt, `/cc-init` will not run before global settings exist unless you provide `/cc-init --litellm-model <model>`.
- Background index failures are throttled for five minutes so every search does not repeatedly spawn a failing index process. `/cc-reindex` bypasses that cooldown.
