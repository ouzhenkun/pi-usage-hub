// Session usage panel: local session-history stats with period/provider
// navigation and per-provider model breakdown. Owns all session-tab state,
// input handling, and rendering so index.ts only wires it into the overlay.

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  collectSessionUsage,
  type ProviderSessionUsage,
  type SessionUsagePeriod,
  type SessionUsageSummary,
} from "../session/collect";
import { formatMoney, formatNumber, formatTokens, padL, padR } from "./format";

const PERIODS: { key: keyof SessionUsageSummary; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "thisWeek", label: "This Week" },
  { key: "thisMonth", label: "This Month" },
  { key: "allTime", label: "All Time" },
];

const MAX_PROVIDERS = 5;

// Column widths shared by period, provider and model rows.
const nameW = 18;
const costW = 7;
const tokW = 8;
const inW = 8;
const outW = 7;
const cacheW = 8;
const msgW = 7;
const sesW = 5;

// Model rows are indented 3 extra spaces, so their name field is narrower to
// keep every numeric column aligned with the provider rows above.
// Column order: Name Sessions Msgs ↑In ↓Out Cache Tokens Cost
function cols(n: string, s: string, m: string, i: string, o: string, ca: string, t: string, c: string, nw = nameW): string {
  return `${padR(n, nw)}${padL(s, sesW)}${padL(m, msgW)}${padL(i, inW)}${padL(o, outW)}${padL(ca, cacheW)}${padL(t, tokW)}${padL(c, costW)}`;
}

function statCols(name: string, t: { sessions: number; messages: number; cost: number; tokens: { total: number; input: number; output: number; cacheRead: number; cacheWrite: number } }, nw = nameW): string {
  return cols(
    name,
    formatNumber(t.sessions),
    formatNumber(t.messages),
    formatTokens(t.tokens.input + t.tokens.cacheWrite),
    formatTokens(t.tokens.output),
    formatTokens(t.tokens.cacheRead + t.tokens.cacheWrite),
    formatTokens(t.tokens.total),
    formatMoney(t.cost),
    nw,
  );
}

export class SessionPanel {
  private loading = false;
  private usage: SessionUsageSummary | null = null;
  private error = "";
  private load: Promise<void> | null = null;
  private periodIndex = 0;
  private providerIndex = 0;
  private expanded = new Set<string>();

  constructor(private requestRender: () => void) {}

  ensureLoaded(): void {
    if (this.usage || this.load) return;
    this.loading = true;
    this.error = "";
    this.load = collectSessionUsage()
      .then(usage => {
        this.usage = usage;
      })
      .catch(err => {
        this.error = err?.message ?? String(err);
      })
      .finally(() => {
        this.loading = false;
        this.load = null;
        this.requestRender();
      });
  }

  /** Handle a key. Returns true if the panel consumed it. */
  handleInput(data: string): boolean {
    // Left/right: switch period tab
    if (data === "\x1b[C" || data === "\x1b[D") {
      const delta = data === "\x1b[C" ? 1 : -1;
      this.periodIndex = (this.periodIndex + delta + PERIODS.length) % PERIODS.length;
      this.providerIndex = 0;
      this.expanded.clear();
      this.requestRender();
      return true;
    }

    // Up/down: navigate provider rows
    if (data === "\x1b[A" || data === "\x1b[B") {
      const delta = data === "\x1b[A" ? -1 : 1;
      const n = this.providers().length;
      if (n > 0) this.providerIndex = (this.providerIndex + delta + n) % n;
      this.requestRender();
      return true;
    }

    // Space/Enter: expand selected provider
    if (data === " " || data === "\r") {
      const name = this.providers()[this.providerIndex]?.provider;
      if (name) {
        if (this.expanded.has(name)) this.expanded.delete(name);
        else this.expanded.add(name);
        this.requestRender();
      }
      return true;
    }

    return false;
  }

  private currentPeriod(): SessionUsagePeriod | null {
    return this.usage ? this.usage[PERIODS[this.periodIndex]!.key] : null;
  }

  private providers(): ProviderSessionUsage[] {
    return this.currentPeriod()?.providers.slice(0, MAX_PROVIDERS) ?? [];
  }

  render(theme: Theme): string[] {
    const th = theme;
    if (this.loading) return [` ${th.fg("muted", "Loading local session usage...")}`];
    if (this.error) return [` ${th.fg("warning", this.error)}`];
    if (!this.usage) return [` ${th.fg("muted", "Loading...")}`];

    const lines: string[] = [];

    // ── Period tab bar (2nd-level, row 1) ──
    const tabParts = PERIODS.map(({ label }, i) => {
      const selected = i === this.periodIndex;
      return selected
        ? th.fg("accent", `[${label}]`)
        : th.fg("dim", ` ${label} `);
    });
    lines.push(` ${tabParts.join(th.fg("borderMuted", "│"))}`);
    lines.push(th.fg("borderMuted", " " + "─".repeat(72)));

    // ── Provider table (always MAX_PROVIDERS rows tall for fixed height) ──
    const providers = this.providers();
    lines.push(th.fg("muted", `   ${cols("Provider", "Sess", "Msgs", "↑In", "↓Out", "Cache", "Tokens", "Cost")}`));

    for (let i = 0; i < MAX_PROVIDERS; i++) {
      const p = providers[i];
      if (!p) {
        lines.push(""); // empty row to hold fixed height
        continue;
      }
      const selected = i === this.providerIndex;
      const isExpanded = this.expanded.has(p.provider);
      const prefix = selected ? (isExpanded ? " ▾ " : " ▸ ") : "   ";
      const text = `${prefix}${statCols(p.provider, p)}`;
      lines.push(selected ? th.fg("accent", text) : th.fg("dim", text));

      if (isExpanded) {
        for (const m of p.models) {
          lines.push(th.fg("dim", `   └ ${statCols(m.model, m, nameW - 2)}`));
        }
      }
    }

    // ── Period summary (single row) at bottom ──
    const period = PERIODS[this.periodIndex]!;
    const totals = this.usage[period.key].totals;
    lines.push("");
    lines.push(th.fg("borderMuted", " " + "─".repeat(72)));
    lines.push(th.fg("accent", `   ${statCols("Total:", totals)}`));

    lines.push("");
    lines.push(` ${th.fg("dim", `←→ period · ↑↓ provider · Space expand · Tab switch · Esc close`)}`);
    return lines;
  }
}
