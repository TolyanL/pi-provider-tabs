/**
 * pi-provider-tabs — `/models`: model picker with provider tabs and scoped models.
 *
 * Why a separate command: the built-in `/model`, `/scoped-models` and the `Ctrl+P`
 * cycle live inside pi and are closed to extensions (built-in commands are
 * dispatched before extension commands, and `app.model.select` / `app.model.cycle*`
 * are reserved shortcuts). Hence the picker ships as its own `/models` command.
 *
 * Features:
 *   - provider tabs (plus an "All" tab);
 *   - "All models" / "scoped" modes (Ctrl+A);
 *   - "scoped" shows exactly the models selected in `/scoped-models`
 *     (`ctx.scopedModels`: enabledModels in settings.json, the --models flag or a
 *     selection made in `/scoped-models`); the extension keeps no list of its own;
 *   - when scope is not empty the picker opens in "scoped" mode;
 *   - in "All models" mode scoped models are marked with `◆`;
 *   - Ctrl+F adds/removes a model from scope: the live session list
 *     (`ctx.scopedModels`) plus `enabledModels` in <agent-dir>/settings.json;
 *   - fuzzy filter, Enter switches the session model, Ctrl+R refreshes provider
 *     catalogs;
 *   - `ctrl+shift+l` opens the picker from the editor where the terminal can tell it
 *     apart from ctrl+l (Kitty keyboard protocol / modifyOtherKeys).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ScopedModel,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  fuzzyFilter,
  Key,
  type KeybindingsManager,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

const modelKey = (model: Model<Api>): string => `${model.provider}/${model.id}`;

// ─── Helpers ─────────────────────────────────────────────────────────

const padToWidth = (line: string, width: number): string => {
  const current = visibleWidth(line);
  return current >= width ? truncateToWidth(line, width) : line + " ".repeat(width - current);
};

/** Printable text typed into the filter, or undefined for control/escape sequences. */
function printableText(data: string): string | undefined {
  if (!data) return undefined;
  const text = decodeKittyPrintable(data) ?? data;
  if (text.startsWith("\x1b")) return undefined;
  if (/[\x00-\x1f\x7f]/.test(text)) return undefined;
  return text;
}

// ─── Component ───────────────────────────────────────────────────────

type Mode = "all" | "favorites";

interface Row {
  key: string;
  model: Model<Api>;
  isCurrent: boolean;
  isScoped: boolean;
}

/** Only problems are surfaced in the hint row; ordinary actions stay silent. */
interface Status {
  text: string;
}

interface ToggleResult {
  /** Whether the model is in scope after the toggle. */
  inScope: boolean;
  /** Warning shown in the hint row (for example when settings.json could not be written). */
  note?: string;
}

/** Header/footer lines of the picker itself: 3 borders, title, tabs, search, 2 hint rows. */
const PICKER_LINES = 8;
/** pi's footer and the minimum chat viewport: the picker never gets the whole terminal. */
const PI_CHROME_LINES = 8;
/** Upper bound for the model list, keeping the picker compact like the built-in selectors. */
const MAX_LIST_ROWS = 14;

export class ProviderTabsComponent implements Component {
  private models: Model<Api>[];
  /** Mutable copy of the session scope, kept in sync with the live `ctx.scopedModels`. */
  private readonly scopedKeys: Set<string>;
  private readonly providerLabel: (provider: string) => string;
  private readonly readModels: () => Model<Api>[];
  private readonly refreshCatalog: () => Promise<string | undefined>;
  private readonly onToggleScope: (model: Model<Api>) => ToggleResult;
  private readonly onSelect: (model: Model<Api>) => void;
  private readonly onCancel: () => void;
  private readonly currentKey: string | undefined;

  private mode: Mode = "all";
  private providerIndex = 0; // 0 = all providers
  private query = "";
  private rows: Row[] = [];
  private selected = 0;
  private top = 0;
  private tabOffset = 0;
  private status: Status | undefined;
  private refreshing = false;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    options: {
      models: Model<Api>[];
      current: Model<Api> | undefined;
      /** `provider/id` of the models selected in `/scoped-models`. */
      scopedKeys: ReadonlySet<string>;
      providerLabel: (provider: string) => string;
      readModels: () => Model<Api>[];
      refreshCatalog: () => Promise<string | undefined>;
      /** Adds or removes the model from scope; returns the resulting state. */
      onToggleScope: (model: Model<Api>) => ToggleResult;
      onSelect: (model: Model<Api>) => void;
      onCancel: () => void;
      initialQuery?: string;
    },
  ) {
    this.models = [...options.models];
    this.scopedKeys = new Set(options.scopedKeys);
    this.providerLabel = options.providerLabel;
    this.readModels = options.readModels;
    this.refreshCatalog = options.refreshCatalog;
    this.onToggleScope = options.onToggleScope;
    this.onSelect = options.onSelect;
    this.onCancel = options.onCancel;
    this.currentKey = options.current ? modelKey(options.current) : undefined;
    this.query = options.initialQuery?.trim() ?? "";
    // Open on the scoped list when it actually has something to show.
    const hasScopedModels = this.models.some((model) => this.scopedKeys.has(modelKey(model)));
    this.mode = hasScopedModels ? "favorites" : "all";
    this.rebuild();
  }

  // ── state ────────────────────────────────────────────────────────

  private providerIds(): string[] {
    // Tabs follow the current mode: in the scoped view only providers of scoped models.
    const ids = new Set(this.modeModels().map((model) => model.provider));
    return [...ids].sort((a, b) => this.label(a).localeCompare(this.label(b)));
  }

  private label(provider: string): string {
    const display = this.providerLabel(provider);
    return display && display.length > 0 ? display : provider;
  }

  private modeModels(): Model<Api>[] {
    return this.mode === "favorites"
      ? this.models.filter((model) => this.scopedKeys.has(modelKey(model)))
      : this.models;
  }

  private rebuild(preferredKey?: string, fallbackIndex?: number): void {
    // Capture the selection before the row list is replaced: `this.rows` below is the new list.
    const previousKey = preferredKey ?? this.rows[this.selected]?.key;
    const providers = this.providerIds();
    if (this.providerIndex > providers.length) this.providerIndex = providers.length;
    const provider = this.providerIndex === 0 ? undefined : providers[this.providerIndex - 1];

    const scoped = this.modeModels().filter((model) => !provider || model.provider === provider);
    const sorted = [...scoped].sort((a, b) => {
      if (!provider) {
        const byProvider = this.label(a.provider).localeCompare(this.label(b.provider));
        if (byProvider !== 0) return byProvider;
      }
      return a.id.localeCompare(b.id);
    });

    const query = this.query.trim();
    const visible = query
      ? fuzzyFilter(sorted, query, (model) => `${model.provider}/${model.id} ${model.name ?? ""}`)
      : sorted;

    this.rows = visible.map((model) => {
      const key = modelKey(model);
      return {
        key,
        model,
        isCurrent: key === this.currentKey,
        isScoped: this.scopedKeys.has(key),
      };
    });

    let index = previousKey ? this.rows.findIndex((row) => row.key === previousKey) : -1;
    if (index === -1 && fallbackIndex !== undefined && this.rows.length > 0) {
      index = Math.min(fallbackIndex, this.rows.length - 1);
    }
    if (index === -1) index = this.rows.findIndex((row) => row.isCurrent);
    if (index === -1) index = 0;
    this.selected = Math.max(0, Math.min(index, this.rows.length - 1));
    this.ensureVisible();
  }

  private listHeight(): number {
    const rows = this.tui.terminal?.rows ?? 24;
    // The editor container that hosts the picker is shorter than the terminal, so reserve
    // room for pi's own chrome: otherwise a long list pushes the key hints off screen.
    const available = rows - PICKER_LINES - PI_CHROME_LINES;
    return Math.max(3, Math.min(MAX_LIST_ROWS, available));
  }

  private ensureVisible(): void {
    const height = this.listHeight();
    const maxTop = Math.max(0, this.rows.length - height);
    if (this.selected < this.top) this.top = this.selected;
    if (this.selected >= this.top + height) this.top = this.selected - height + 1;
    this.top = Math.max(0, Math.min(this.top, maxTop));
  }

  private touch(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  private move(delta: number): void {
    if (this.rows.length === 0) return;
    const next = Math.max(0, Math.min(this.selected + delta, this.rows.length - 1));
    if (next === this.selected) return;
    this.selected = next;
    this.ensureVisible();
    this.touch();
  }

  private moveTo(index: number): void {
    if (this.rows.length === 0) return;
    this.selected = Math.max(0, Math.min(index, this.rows.length - 1));
    this.ensureVisible();
    this.touch();
  }

  private cycleProvider(delta: number): void {
    const count = this.providerIds().length + 1;
    if (count <= 1) return;
    this.providerIndex = (this.providerIndex + delta + count) % count;
    this.rebuild();
    this.touch();
  }

  private toggleMode(): void {
    this.mode = this.mode === "all" ? "favorites" : "all";
    // Provider tabs differ between modes, so do not carry a provider selection across.
    this.providerIndex = 0;
    this.rebuild();
    this.touch();
  }

  private setQuery(query: string): void {
    this.query = query.slice(0, 60);
    this.rebuild();
    this.touch();
  }

  private toggleScope(): void {
    const row = this.rows[this.selected];
    if (!row) return;
    const result = this.onToggleScope(row.model);
    // Keep the local copy in sync with the live session scope the callback changed.
    if (result.inScope) this.scopedKeys.add(row.key);
    else this.scopedKeys.delete(row.key);
    this.rebuild(undefined, this.selected);
    this.setWarning(result.note);
  }

  private select(): void {
    const row = this.rows[this.selected];
    if (row) this.onSelect(row.model);
  }

  private setWarning(text: string | undefined): void {
    this.status = text ? { text } : undefined;
    this.touch();
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    this.touch();
    try {
      const problem = await this.refreshCatalog();
      this.models = [...this.readModels()];
      this.rebuild();
      this.setWarning(problem);
    } catch (error) {
      this.setWarning(
        `Could not refresh the catalog: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.refreshing = false;
      this.touch();
    }
  }

  // ── input ────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.move(-1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.move(1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.move(-this.listHeight());
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.move(this.listHeight());
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.moveTo(0);
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.moveTo(this.rows.length - 1);
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
      this.cycleProvider(1);
      return;
    }
    if (matchesKey(data, "shift+tab") || matchesKey(data, Key.left)) {
      this.cycleProvider(-1);
      return;
    }
    if (matchesKey(data, Key.ctrl("a"))) {
      this.toggleMode();
      return;
    }
    if (matchesKey(data, Key.ctrl("f"))) {
      this.toggleScope();
      return;
    }
    if (matchesKey(data, Key.ctrl("r"))) {
      void this.refresh();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.select();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.ctrl("c"))) {
      this.onCancel();
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      this.setQuery(this.query.slice(0, -1));
      return;
    }
    if (matchesKey(data, Key.space)) {
      this.setQuery(`${this.query} `);
      return;
    }
    const text = printableText(data);
    if (text) this.setQuery(this.query + text);
  }

  // ── render ───────────────────────────────────────────────────────

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const theme = this.theme;
    const separator = theme.fg("borderMuted", "─".repeat(Math.max(1, width)));

    const lines: string[] = [
      separator,
      this.renderTitle(),
      this.renderTabs(width),
      this.renderSearch(),
      separator,
    ];

    const height = this.listHeight();
    const end = Math.min(this.rows.length, this.top + height);
    if (this.rows.length === 0) {
      lines.push(theme.fg("warning", `  ${this.emptyHint()}`));
    } else {
      for (let index = this.top; index < end; index += 1) {
        const row = this.rows[index];
        if (row) lines.push(this.renderRow(row, index === this.selected));
      }
    }

    lines.push(separator, ...this.renderHints(width));
    this.cachedWidth = width;
    this.cachedLines = lines.map((line) => padToWidth(line, width));
    return this.cachedLines;
  }

  private chipText(label: string, count?: number): string {
    return count === undefined ? ` ${label} ` : ` ${label} ${count} `;
  }

  private chip(label: string, active: boolean, count?: number): string {
    const theme = this.theme;
    const text = this.chipText(label, count);
    return active ? theme.bold(theme.fg("accent", text)) : theme.fg("muted", text);
  }

  private renderTitle(): string {
    const theme = this.theme;
    // The chip is a mode switch only: no counts here, the tab row already shows sizes.
    const scopedChip =
      this.scopedKeys.size > 0 || this.mode === "favorites"
        ? this.chip("scoped", this.mode === "favorites")
        : "";
    const modes = `${this.chip("All models", this.mode === "all")}${scopedChip}`;
    return `  ${theme.bold(theme.fg("accent", "Models"))}  ${modes}`;
  }

  private renderTabs(width: number): string {
    const theme = this.theme;
    const providers = this.providerIds();
    const scoped = this.modeModels();
    const countFor = (provider?: string): number =>
      scoped.filter((model) => !provider || model.provider === provider).length;

    const tabs = [
      { label: "All", count: countFor() },
      ...providers.map((provider) => ({ label: this.label(provider), count: countFor(provider) })),
    ];

    const budget = Math.max(12, width - 2 - 4); // prefix 2 + overflow markers 2+2
    const widths = tabs.map((tab) => visibleWidth(this.chipText(tab.label, tab.count)) + 3);
    const active = this.providerIndex;

    let offset = Math.max(0, Math.min(this.tabOffset, tabs.length - 1));
    if (active < offset) offset = active;
    let last = offset - 1;
    for (;;) {
      let used = 0;
      last = offset - 1;
      for (let index = offset; index < tabs.length; index += 1) {
        const width = widths[index] ?? 0;
        if (used + width > budget && index > offset) break;
        used += width;
        last = index;
      }
      if (active <= last || last >= tabs.length - 1) break;
      offset += 1;
    }
    this.tabOffset = offset;

    const parts: string[] = [];
    if (offset > 0) parts.push(theme.fg("dim", "‹"));
    for (let index = offset; index <= last; index += 1) {
      const tab = tabs[index];
      if (!tab) continue;
      parts.push(this.chip(tab.label, index === active, tab.count));
    }
    if (last < tabs.length - 1) parts.push(theme.fg("dim", "›"));
    return `  ${parts.join(theme.fg("dim", " · "))}`;
  }

  private renderSearch(): string {
    const theme = this.theme;
    const label = theme.fg("muted", "Search:");
    const value =
      this.query.length > 0
        ? `${theme.fg("text", this.query)}${theme.fg("accent", "▏")}`
        : theme.fg("dim", "… start typing");
    return `  ${label} ${value}`;
  }

  private renderRow(row: Row, isSelected: boolean): string {
    const theme = this.theme;
    // Same affordances as pi's built-in pickers: "→" cursor, "✓" marks the active model.
    const cursor = isSelected ? theme.fg("accent", "→ ") : "  ";
    const current = row.isCurrent ? theme.fg("accent", "✓ ") : "  ";
    // In the scoped view every row is scoped, so the marker would be noise.
    const scopedMark =
      this.mode === "all"
        ? `${row.isScoped ? theme.fg("warning", "◆") : theme.fg("dim", "·")} `
        : "";

    const paint = (text: string): string => (isSelected ? theme.fg("accent", text) : text);

    const showProvider = this.providerIndex === 0;
    const provider = showProvider ? theme.fg("muted", `  [${this.label(row.model.provider)}]`) : "";
    const name =
      row.model.name && row.model.name !== row.model.id
        ? theme.fg("muted", `  ${row.model.name}`)
        : "";

    return `${cursor}${scopedMark}${current}${paint(row.model.id)}${provider}${name}`;
  }

  private emptyHint(): string {
    if (this.query.trim().length > 0)
      return "Nothing matched: backspace clears the filter, esc closes.";
    if (this.mode === "favorites") {
      return this.scopedKeys.size > 0
        ? "No scoped models available: none of them are authorized."
        : "Scope is empty: ctrl+f in \"All models\" adds a model to scope.";
    }
    return "No models: /login adds a provider, ctrl+r refreshes catalogs.";
  }

  private renderHints(width: number): string[] {
    const theme = this.theme;
    const primaryFull = ["↑↓ move", "⏎ select", "esc cancel"];
    const primaryShort = ["↑↓", "⏎", "esc"];
    const secondary =
      this.mode === "favorites"
        ? ["tab/←→ provider", "ctrl+f remove from scoped", "ctrl+a all models", "ctrl+r refresh"]
        : ["tab/←→ provider", "ctrl+f add to scoped", "ctrl+a scoped", "ctrl+r refresh"];

    // Descriptions stay visible: the primary row never degrades past its compact form,
    // and the secondary row drops its least important actions instead.
    const fits = (parts: string[], budget: number): boolean =>
      visibleWidth(parts.join(" · ")) <= budget;
    const primaryBudget = Math.max(8, width - 2);
    const primary = fits(primaryFull, primaryBudget)
      ? primaryFull.join(" · ")
      : primaryShort.join(" · ");

    const warning = this.status ? ` · ${theme.fg("warning", this.status.text)}` : "";
    const secondaryBudget = Math.max(8, width - 2 - visibleWidth(warning));
    const kept = [...secondary];
    while (kept.length > 0 && !fits(kept, secondaryBudget)) kept.pop();

    return [`  ${theme.fg("dim", primary)}`, `  ${theme.fg("dim", kept.join(" · "))}${warning}`];
  }
}

// ─── Extension ───────────────────────────────────────────────────────

let pickerOpen = false;

async function showModelsPicker(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  initialQuery?: string,
): Promise<void> {
  if (pickerOpen) return;
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify("/models works in interactive mode only", "warning");
    return;
  }
  pickerOpen = true;
  try {
    await openModelsPicker(pi, ctx, initialQuery);
  } finally {
    pickerOpen = false;
  }
}

async function openModelsPicker(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  initialQuery?: string,
): Promise<void> {
  const scopedKeys = new Set(ctx.scopedModels.map((entry) => modelKey(entry.model)));
  const readModels = (): Model<Api>[] => [...ctx.modelRegistry.getAvailable()];
  const providerLabel = (provider: string): string =>
    ctx.modelRegistry.getProviderDisplayName(provider) || provider;

  /**
   * The session scope is exposed read-only, but `ctx.scopedModels` is the live array
   * `session.cycleModel()` reads, so in-place edits apply to Ctrl+P immediately.
   */
  const liveScope = (): ScopedModel[] | undefined => {
    const candidate: unknown = ctx.scopedModels;
    return Array.isArray(candidate) ? (candidate as ScopedModel[]) : undefined;
  };

  const globalSettingsPath = join(getAgentDir(), "settings.json");
  const projectSettingsPath = join(ctx.cwd, CONFIG_DIR_NAME, "settings.json");
  const projectDefinesScope = (): boolean => {
    if (!existsSync(projectSettingsPath)) return false;
    try {
      const parsed = JSON.parse(readFileSync(projectSettingsPath, "utf8")) as {
        enabledModels?: unknown;
      };
      return Array.isArray(parsed.enabledModels);
    } catch {
      return false;
    }
  };

  /** Rewrite only `enabledModels`, keeping every other setting as it is. */
  const writeEnabledModels = (update: (patterns: string[]) => string[]): string | undefined => {
    try {
      const parsed = (
        existsSync(globalSettingsPath)
          ? JSON.parse(readFileSync(globalSettingsPath, "utf8"))
          : {}
      ) as Record<string, unknown>;
      const current = Array.isArray(parsed.enabledModels)
        ? parsed.enabledModels.filter(
            (pattern): pattern is string => typeof pattern === "string",
          )
        : [];
      const next = update(current);
      if (next.length > 0) parsed.enabledModels = next;
      else delete parsed.enabledModels;
      // A plain write (no tmp+rename) keeps a symlinked settings.json a symlink.
      writeFileSync(globalSettingsPath, JSON.stringify(parsed, null, 2), "utf8");
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  // `provider/id` without glob characters; the id itself may contain slashes
  // (for example commandcode/minimax/minimax-m3.1-flash).
  const EXACT_PATTERN = /^[^/*?[\]]+(?:\/[^*?[\]]+)+$/;
  const hasGlobPatterns = (patterns: string[]): boolean =>
    patterns.some((pattern) => !EXACT_PATTERN.test(pattern));

  const toggleScope = (model: Model<Api>): ToggleResult => {
    const key = modelKey(model);
    const exact = `${model.provider}/${model.id}`;
    const live = liveScope();
    const projectScope = projectDefinesScope();

    if (!scopedKeys.has(key)) {
      live?.push({ model });
      scopedKeys.add(key);
      if (projectScope) {
        return {
          inScope: true,
          note: "scope: project settings define enabledModels — changed for this session only",
        };
      }
      const error = writeEnabledModels((patterns) =>
        patterns.some((pattern) => pattern.toLowerCase() === exact.toLowerCase())
          ? patterns
          : [...patterns, exact],
      );
      return error
        ? { inScope: true, note: `scope: +${exact}; settings not written: ${error}` }
        : { inScope: true };
    }

    if (live) {
      const index = live.findIndex((entry) => modelKey(entry.model) === key);
      if (index >= 0) live.splice(index, 1);
    }
    scopedKeys.delete(key);
    if (projectScope) {
      return {
        inScope: false,
        note: "scope: project settings define enabledModels — changed for this session only",
      };
    }

    let lingeringGlobs = false;
    const error = writeEnabledModels((patterns) => {
      const remaining = patterns.filter(
        (pattern) => pattern.toLowerCase() !== exact.toLowerCase(),
      );
      lingeringGlobs = hasGlobPatterns(remaining);
      return remaining;
    });
    if (error)
      return { inScope: false, note: `scope: −${exact}; settings not written: ${error}` };
    return lingeringGlobs
      ? {
          inScope: false,
          note: "scope: removed; glob patterns remain in settings — it may come back after restart",
        }
      : { inScope: false };
  };

  const selected = await ctx.ui.custom<Model<Api> | undefined>(
    (tui, theme, keybindings, done) =>
      new ProviderTabsComponent(tui, theme, keybindings, {
        models: readModels(),
        current: ctx.model,
        scopedKeys,
        onToggleScope: toggleScope,
        providerLabel,
        readModels,
        refreshCatalog: async () => {
          const result = await ctx.modelRegistry.refresh();
          if (result.errors.size > 0) {
            return `Could not refresh: ${[...result.errors.keys()].join(", ")}`;
          }
          return undefined;
        },
        onSelect: (model) => done(model),
        onCancel: () => done(undefined),
        initialQuery,
      }),
  );

  if (!selected) return;
  const ok = await pi.setModel(selected);
  ctx.ui.notify(
    ok
      ? `Model: ${selected.provider}/${selected.id}`
      : `No auth for ${selected.provider}: /login ${selected.provider}`,
    ok ? "info" : "warning",
  );
}

export default function providerTabsExtension(pi: ExtensionAPI): void {
  pi.registerCommand("models", {
    description: "Pick a model: provider tabs, scoped models, filter",
    handler: async (args, ctx) => showModelsPicker(pi, ctx, args.trim()),
  });

  // `app.model.select` owns ctrl+l, and in legacy terminals ctrl+shift+l arrives as the
  // very same byte, so this binding only fires where the terminal disambiguates it
  // (Kitty keyboard protocol / modifyOtherKeys). Elsewhere ctrl+shift+l simply keeps
  // opening pi's built-in model selector.
  pi.registerShortcut("ctrl+shift+l", {
    description: "Pick a model (provider-tabs)",
    handler: async (ctx) => showModelsPicker(pi, ctx),
  });
}
