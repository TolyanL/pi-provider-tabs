# pi-provider-tabs

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Pi extension](https://img.shields.io/badge/pi-extension-blueviolet.svg)](https://pi.dev)

A `/models` picker for [Pi](https://pi.dev) that groups every available model into provider tabs, filters by typing, and edits your scoped-models list in place.

Pi's built-in `/model`, `/scoped-models`, and the `Ctrl+P` cycle are closed to extensions: built-in commands are dispatched first, and the model shortcuts are reserved. This extension therefore ships its own `/models` command instead of trying to replace them.

## Features

- **Provider tabs** with counts, plus an `All` tab. Tabs follow the current mode and scroll (`‹` / `›`) on narrow terminals.
- **Two modes** — `All models` and `scoped` — switched with `ctrl+a`. When scope is non-empty, the picker opens straight into `scoped`.
- **Scoped marking** — in `All models`, scoped models carry `◆`; `✓` marks the model active in the session, `→` marks the cursor.
- **Fuzzy filter** over `provider/id` and the model display name; `/models <text>` opens with the filter prefilled.
- **Scope editing** — `ctrl+f` adds or removes the selected model from scope, updating the live session list *and* `enabledModels` in settings.
- **Catalog refresh** — `ctrl+r` reloads provider catalogs without leaving the picker.
- **Compact layout** — the list is capped at 14 rows and hint rows keep their descriptions, so actions are dropped (never their labels) before anything scrolls off screen.
- **Quiet feedback** — no position counters and no confirmation toasts; only real warnings (settings not written, glob patterns left behind) appear in the hint row.

## Requirements

- [Pi](https://pi.dev) with extension support, running in interactive TUI mode.
- A terminal that can distinguish `ctrl+shift+l` from `ctrl+l` if you want the shortcut (kitty, WezTerm, foot, Ghostty — anything supporting the Kitty keyboard protocol or `modifyOtherKeys`).

No build step and no runtime dependencies: Pi loads the TypeScript entry point directly. `@earendil-works/pi-ai`, `pi-coding-agent`, and `pi-tui` are declared as peer dependencies provided by the host.

## Installation

```sh
pi install git:github.com/TolyanL/pi-provider-tabs
```

Pin a tag or commit:

```sh
pi install git:github.com/TolyanL/pi-provider-tabs@v0.1.0
```

Try it for a single invocation without touching your settings:

```sh
pi -e git:github.com/TolyanL/pi-provider-tabs
```

Restart Pi, or run `/reload`, after changing the extension. The package is npm-shaped (`keywords: ["pi-package"]`), so `pi install npm:pi-provider-tabs` works the same way if you publish it.

## Usage

```sh
pi                 # start Pi
/models            # open the picker
/models sonnet     # open it with the filter prefilled
```

`ctrl+shift+l` opens the picker from the editor, exactly like `/models`. It is a regular extension shortcut, so it shows up in `/hotkeys`.

## Screen

`scoped` mode (the default when scope is not empty):

```text
──────────────────────────────────────────────────────────────
  Models   All models  scoped
   All 12 · AnyModel 7 · Command Code 4 · llama-cpp-local 1 · ›
  Search: … start typing
──────────────────────────────────────────────────────────────
→ ✓ deepseek/deepseek-v4.1-flash  [Command Code]  DeepSeek V4.1 Flash
    glm/glm-5.3                     [AnyModel]
──────────────────────────────────────────────────────────────
  ↑↓ move · ⏎ select · esc cancel
  tab/←→ provider · ctrl+f remove from scoped · ctrl+a all models · ctrl+r refresh
```

`All models` mode (`ctrl+a`) marks scoped models with `◆` and everything else with `·`:

```text
  Models   All models  scoped
   All 180 · AnyModel 77 · Command Code 93 · llama-cpp-local 1 · ›
→ ◆ ✓ deepseek/deepseek-v4.1-flash  [Command Code]  DeepSeek V4.1 Flash
    ·   claude-sonnet-4-6           [Command Code]  Claude Sonnet 4.6 (CC)
```

The `scoped` chip appears only when scope is configured and shows the mode alone, without counts. Hint rows adapt to the terminal width: `ctrl+r`, then `ctrl+a`, then `ctrl+f` are dropped first, while `↑↓`, `⏎`, and `esc` always stay visible.

## Keys

| Key | Action |
|---|---|
| `↑` `↓`, `pageUp` `pageDown`, `home` `end` | Move through the list |
| `tab` / `shift+tab`, `←` / `→` | Next/previous provider tab (including `All`) |
| `ctrl+a` | Switch between `All models` and `scoped` |
| `ctrl+f` | Add/remove the selected model from scoped models |
| `ctrl+r` | Refresh provider catalogs |
| typing, `backspace` | Fuzzy filter over `provider/id` and model name |
| `enter` | Switch the session model |
| `esc`, `ctrl+c` | Close |

## Scoped models

The list comes from `ctx.scopedModels` — exactly the set `/scoped-models` and `Ctrl+P` use. The extension keeps no list of its own.

Scope can be configured from outside the picker:

- `/scoped-models` (save with `ctrl+s` in its dialog);
- the `enabledModels` setting in Pi's settings;
- the `--models 'anthropic/*,*sonnet*'` flag at startup.

When scope is empty, the picker opens on `All models`, and `ctrl+f` creates the list.

`ctrl+f` updates two places at once:

1. **Live session scope** — `Ctrl+P` and `/scoped-models` see the change immediately, because the extension edits the same array `session.cycleModel()` reads.
2. **`enabledModels` in the global settings file** — so the choice survives a restart. Only that key is rewritten; other settings are preserved, and a symlinked settings file stays a symlink.

### Write caveats

- If a model is in scope through a glob pattern (`anthropic/*`), removing it only drops the exact `provider/id`. The pattern stays, so the model may return after a restart. Edit the list in `/scoped-models` instead.
- If project settings define `enabledModels`, the global settings file is not rewritten: the change lives in the session only. The picker says so in the hint row.
- Write failures never block the session change; the error is shown next to the hints.

## Shortcut caveat

`ctrl+l` is Pi's `app.model.select` (the built-in model selector), and legacy terminals encode `ctrl+shift+l` as the very same byte. The binding therefore fires only where the terminal can tell the two apart (Kitty keyboard protocol / `modifyOtherKeys`). Elsewhere `ctrl+shift+l` keeps opening Pi's built-in selector, and `/models` is always available.

## Limitations

- `pi.setModel()` switches the session model. The Extension API cannot persist it as the default for new sessions; the built-in picker does that on `ctrl+s`.
- `session.setScopedModels()` is not exposed to extensions, so scope is edited surgically: the live `ctx.scopedModels` array plus `enabledModels` in settings.
- The picker is TUI-only. Outside interactive mode, `/models` reports that.

## Development

The whole extension lives in `index.ts`. Pi loads TypeScript directly, so there is no build step — run `/reload` after edits.

Useful entry points:

- `ProviderTabsComponent` — the picker UI: state, input handling, and rendering.
- `showModelsPicker` — guards against double-open and checks TUI availability.
- `openModelsPicker` — reads `ctx.scopedModels`, resolves provider labels, and wires selection and refresh.
- `toggleScope` — updates the live scope and persists `enabledModels`.
- `providerTabsExtension` — registers the `/models` command and the `ctrl+shift+l` shortcut.

## License

[MIT](LICENSE) © TolyanL
