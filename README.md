<div align="center">

# opencode usage-bar

**Your whole session — and your plan — on one line at the bottom of the prompt.**

[![opencode](https://img.shields.io/badge/opencode-v2-0f766e)](https://opencode.ai/v2/docs/)

```
~/GitLab/in.pulse-analytics  git:feature/remote-exam-retention  86%        297.0K (30%)  (+0 -0)  $0.18
```

</div>

---

The "how much of my plan did I burn?" number lives on the website, and the default footer keeps context and cost where you barely look. This plugin takes over the prompt footer and puts everything in one line — then lets you **click the folder and branch labels to shrink them** when you need the room.

## What's on the bar

| Side | Item | Source |
|---|---|---|
| Left | Folder | session directory, `~` for the home dir |
| Left | Git branch | VCS info for the session location |
| Left | **Plan usage %** | official Go API `GET /zen/go/v1/usage` (the bar shows the monthly window) |
| Right | Context | last assistant message tokens ÷ model context limit |
| Right | Git diff | `(+additions -deletions)` from the working tree |
| Right | Session cost | summed across the session family (session + subagents) |

- No key configured? The percentage falls back to a local estimate and is marked `~86%`.
- The site **rounds** while the API **truncates**; `percentBias: 1` compensates so the bar matches the site.
- The bar hides the native `folder:branch` text some hosts still render inside the footer.

## Quick start

OpenCode V2, tested on `2.0.23` (Windows). There is no npm package: the plugin is installed as a local TUI plugin.

```sh
git clone https://github.com/LucasInstra/usage-bar.git ~/.config/opencode/plugins/usage-bar
cd ~/.config/opencode/plugins/usage-bar
npm install --no-save @opencode/plugin@2.0.23   # match your opencode version; resolves the import in index.ts
```

Restart OpenCode (TUI plugins load at start).

To avoid duplicating context/cost with the default footer, disable it in `~/.config/opencode/cli.json`, keeping everything else that is already there:

```jsonc
{
  "plugins": ["-opencode.prompt.footer"]
}
```

## Credentials

The official percentage needs a key. Resolution order:

1. `USAGE_BAR_CONSOLE_KEY` environment variable (preferred)
2. `console.key` file beside the plugin (one line; gitignored, never commit it)
3. `~/.local/share/opencode/auth.json` → provider `opencode-go` — **automatic** on any machine signed in to the Go plan

Without any of them the bar still works with the local estimate (`~NN%`).

## Click to compact

Click the folder or the branch label to cycle through shorter forms; each click goes one level deeper and wraps around:

```
~/GitLab/in.pulse-analytics   →   in.pulse-analytics   →   ipa   →   pulse (alias)   →   back
feature/remote-exam-retention →   feat/remote-exam-re… →   feat/rer  →   (hidden for main/master, optional)
```

- `alt+click` goes back one level; `shift+click` copies the full value (opt-in, OSC 52)
- Hover highlights the clickable parts
- Keyboard fallbacks for the same actions: `alt+p` (path) and `alt+g` (branch)
- Levels that would render the exact same text are skipped, so every click changes something
- Tabs and windows stay in sync with `persist: "file"` (every instance watches the state file and rescans every 2s)

## Configuration (`config.json`)

| key | values | default | what it does |
|---|---|---|---|
| `plan` | `go` \| `go_plus` | `go` | limit tables used by the local fallback |
| `source` | `auto` \| `official` \| `console` \| `local` | `auto` | where the plan % comes from |
| `percentBias` | number | `1` | added to the displayed % so it matches the site |
| `refreshSeconds` | number (min 10) | `60` | how often the data refreshes |
| `cycle` | `{ mode, day }` | billing, day 14 | local fallback cycle |
| `show.*` | booleans | see file | `path`, `branch`, `plan`, `context`, `diff`, `cost`, `reset` |
| `compact.click` | `cycle` \| `toggle` \| `off` | `cycle` | click behavior |
| `compact.alias` | `{ "folder": "nick" }` | `{}` | nickname per folder name (case-insensitive) |
| `compact.initials` | `{ from, min }` | `last`, `3` | initials source and minimum length |
| `compact.pathLevels` / `branchLevels` | arrays | see file | level order |
| `compact.hideMainBranch` | boolean | `false` | hide `main`/`master` in the compacted branch |
| `compact.hover` | boolean | `true` | brighten on hover |
| `compact.copy` | boolean | `false` | shift+click copies (OSC 52) |
| `compact.persist` | `session` \| `file` \| `off` | `session` | remember levels; `file` writes `compact-state.json` and syncs tabs/windows |
| `compact.keybinds` | `{ path, branch }` \| `null` | `alt+p` / `alt+g` | keyboard fallbacks |

## How it works

`index.ts` is a no-op server entry so OpenCode discovers the plugin (TUI plugins need one). `tui.tsx` is the whole UI: it claims `prepend`/`append` on the `prompt.footer` slot, fetches the official usage on a `refreshSeconds` interval, and reacts to session/model/folder changes.

Deep history, decisions and validation notes live in [HANDOFF.md](HANDOFF.md).

## Development

Edit `tui.tsx`/`config.json`, then restart the TUI. Syntax check without running OpenCode:

```sh
bun build tui.tsx --outfile /tmp/usage-bar.js --external solid-js --external "@opentui/solid" --external "@opencode/plugin/tui"
```
