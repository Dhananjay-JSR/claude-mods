# intent-lens

A **Claude Mod** that shows the intent of a tool call — in plain language, above the prompt, *before* the tool runs.

```
▸ Bash  tidy up the build output — rm -rf dist && npm run build
▸ Edit  ~/app/src/auth.ts (12 → 24 lines)
⚠ Bash  delete files recursively — rm -rf ~/projects/old
```

Claude Code normally shows you a tool *row* after it has already decided to act. `intent-lens` translates the call into one human sentence while it is still pending, so you can see what is about to happen in the one place your eyes already are: the band above the prompt.

No tokens, no network, no dependencies. It is a local translation of the arguments Claude is about to run with.

## What it does

| Surface | What you see |
| :- | :- |
| Band above the prompt | One line per tool call, drawn while Claude is working: a marker, the tool, and the intent |
| Toast | A warning when a shell command can destroy work (`rm -rf`, `git reset --hard`, force-push, `DROP TABLE`, `curl … \| sh`, …) |
| `/intent` | `on` / `off` / `toggle` / `log` / `clear`, persisted across sessions |
| `/intent-log` | The last 20 calls in plain language, with `✓` / `✗` outcomes |

The band is drawn only while Claude is working, so an idle session stays clean.

## Install

A mod is a Claude Code plugin whose `hooks/hooks.json` names a JavaScript module. This repository *is* that plugin folder.

### Run it for one session

```bash
./run.sh
```

That is a one-line wrapper around:

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir /path/to/intent-lens
```

### Check it loaded

At the prompt, run `/plugin`, press Tab to **Installed**, and look for `intent-lens`. Or run `/intent` — it prints the current state.

### Use it in every session

Add the plugin directory to your environment, or install it from a marketplace:

```bash
export CLAUDE_CODE_PLUGIN_DIRS="/path/to/intent-lens"
```

## Version requirements

| Claude Code | What you need |
| :- | :- |
| **2.1.287+** | Nothing. Mods are on by default and `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is ignored. |
| **2.1.259 – 2.1.286** | `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the environment. `run.sh` sets it for you. |
| Older than 2.1.259 | Mods don't exist yet. Update Claude Code. |

Built and verified against **2.1.273** on macOS. `claude plugin validate` passes.

## How the intent is worked out

Everything is a pure function of the tool name and arguments — there is no model call, so it costs nothing and adds no latency.

| Tool | What it says |
| :- | :- |
| `Bash` | Claude's own `description` for the command, then the command itself, on one line |
| `Read` | `read ~/app/src/auth.ts:12-40` |
| `Edit` / `MultiEdit` | `edit ~/app/src/auth.ts (12 → 24 lines)` / `(3 changes)` |
| `Write` | `write ~/app/notes.md (48 lines)` |
| `Grep` | `search for "useEffect" in ~/app/src` |
| `Glob` | `find files matching **/*.test.ts under ~/app` |
| `WebFetch` / `WebSearch` | `fetch developer.mozilla.org` / `search the web for "…"` |
| `Task` / `Agent` | `start a explore subagent — find the auth middleware` |
| `TodoWrite` | `update the task list (6 items)` |
| `AskUserQuestion` | `ask you: Which database should this use?` |
| `mcp__server__tool` | `server:tool` |
| anything else | The first two string arguments, so new tools still say something useful |

`Bash` is the interesting one: Claude Code's Bash tool already requires Claude to describe each command, so the description **is** the stated intent. `intent-lens` puts it in front of the command instead of leaving it buried in the tool row.

### Risk detection

Shell commands are matched against a small list of patterns that can destroy work or reach outside the project:

- recursive `rm`
- `git reset --hard`, `git clean -fd`, force-push
- `DROP` / `TRUNCATE` on a table or database
- `mkfs`, `dd if=`, redirects into `/dev/sd*`
- fork bombs
- `curl … | sh`
- `sudo`, `chmod -R 777`
- `npm publish`, `cargo publish`

A match turns the marker red (`⚠`) and raises a toast. It is a **reminder, not a sandbox** — it matches the text of the command, so treat it as a hint, not a guarantee.

## Design notes

A Claude Mod runs inside Claude Code's own process, which is why the rules are strict:

- **No npm imports.** Only relative imports and the `claude-code` module are allowed, so Claude Code can read the whole mod before running it.
- **No ambient `fs` or `fetch`.** Every side effect goes through the `$` API (`$.store`, `$.ui`, `$.command`), which `claude plugin validate` lists.
- **One hook per event.** Hooks chain like middleware; `intent-lens` only observes, always calling `next(e)` and returning the result untouched, so it never changes what Claude sees or runs.

`claude plugin validate .` output for this mod:

```
❯ ./register.js hooks: session.start, tool.call, ui.render{component=AbovePrompt}, command.run{command=intent}, command.run{command=intent-log}
❯ ./register.js calls: $.command.register, $.store.get, $.store.set, $.ui.invalidate, $.ui.resolve, $.ui.toast
✔ Validation passed
```

## Layout

```
intent-lens/
├── .claude-plugin/plugin.json   manifest (name, version, description)
├── hooks/hooks.json             {"modules": ["./register.js"]} — this is what makes it a mod
├── hooks/register.js            the mod: 5 hooks and the heuristics
└── run.sh                       starts Claude Code with the mod loaded
```

## Limitations

- The band shows the **most recent** call, not a queue of parallel ones.
- Nothing is drawn in `claude -p` or other headless runs, where there is no UI; the hooks still work.
- Intent is a heuristic, not a model summary. A model-written intent would cost tokens per call and would need `$.model.complete`; that is deliberately left out.
- The band is a shared surface: it is placed above whatever other mods draw, and the user can collapse it with `Ctrl+X Ctrl+A`.

## Background

Claude Mods are Claude Code plugins with a `modules` entry that names a TypeScript or JavaScript file whose functions run inside Claude Code's process, with hot reload. A hook looks like this:

```js
export function register(on) {
  on('tool.call', async ($, e, next) => {
    // e.tool is the tool name; the arguments are fields of e
    return next(e)
  })
}
```

- [Mods overview](https://code.claude.com/docs/en/plugins/mods/overview)
- [Create a mod](https://code.claude.com/docs/en/plugins/mods/create)
- [Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)
- [Draw in the interface](https://code.claude.com/docs/en/plugins/mods/interface)

## License

MIT
