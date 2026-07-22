import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { UsageProvider, UsageReport } from "../types";
import { fullReport } from "./format-report";
import { SessionPanel } from "./session-panel";
import { isCloseKey, truncateToWidth, visibleWidth } from "./format";

export class UsageWindow {
  private mode: "quota" | "session";
  private loading = true;
  /** Fixed display order (config/registry order). */
  private orderedProviders: UsageProvider[] = [];
  private reports = new Map<UsageProvider, UsageReport>();
  private message = "Fetching usage data...";
  private session: SessionPanel;

  /** Scroll state for the quota view. */
  private scrollOffset = 0;
  private lastContentLines = 0;
  /** Available content lines (border/header/footer excluded). Set via setViewHeight(). */
  private viewHeight = 15;

  constructor(
    private theme: Theme,
    private done: () => void,
    private requestRender: () => void,
    private unsubscribeInput?: () => void,
    initialMode: "quota" | "session" = "quota",
    private ensureQuotaLoaded?: () => void,
  ) {
    this.mode = initialMode;
    this.session = new SessionPanel(requestRender);
    if (initialMode === "session") this.session.ensureLoaded();
  }

  /**
   * Called each render cycle by the overlay's `visible` callback so the quota
   * view knows how many content lines it can show without overflowing.
   */
  setViewHeight(termHeight: number): void {
    // maxHeight: "80%" → overlay inner height ≈ floor(termHeight * 0.8)
    // Fixed overhead: top-border + title + separator + empty + hints + bottom-border = 6
    const overlayH = Math.floor(termHeight * 0.8);
    this.viewHeight = Math.max(4, overlayH - 6);
  }

  setPendingProviders(pendingProviders: UsageProvider[]): void {
    this.orderedProviders = pendingProviders;
    this.reports.clear();
    this.message = "";
    this.scrollOffset = 0;
    this.invalidate();
  }

  addReport(provider: UsageProvider, report: UsageReport): void {
    this.reports.set(provider, report);
    this.invalidate();
  }

  finishLoading(): void {
    this.loading = false;
    this.message = this.reports.size === 0 ? "No supported usage provider detected" : "";
    this.invalidate();
  }

  setError(error: string): void {
    this.loading = false;
    this.orderedProviders = [];
    this.reports.clear();
    this.message = error;
    this.invalidate();
  }

  handleInput(data: string): void {
    if (isCloseKey(data)) {
      this.done();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.mode = this.mode === "quota" ? "session" : "quota";
      if (this.mode === "session") this.session.ensureLoaded();
      if (this.mode === "quota") this.ensureQuotaLoaded?.();
      this.scrollOffset = 0;
      this.requestRender();
      return;
    }
    if (this.mode === "quota") {
      if (matchesKey(data, Key.up)) {
        this.scrollOffset = Math.max(0, this.scrollOffset - 1);
        this.requestRender();
        return;
      }
      if (matchesKey(data, Key.down)) {
        const maxScroll = Math.max(0, this.lastContentLines - this.viewHeight);
        this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
        this.requestRender();
        return;
      }
    }
    if (this.mode === "session") this.session.handleInput(data);
  }

  render(width: number): string[] {
    const w = Math.max(32, width);
    const innerW = Math.max(1, w - 2);
    const bodyW = Math.max(1, innerW - 2);
    const th = this.theme;

    const pad = (s: string) => s + " ".repeat(Math.max(0, bodyW - visibleWidth(s)));
    const row = (content = "") =>
      th.fg("border", "│") + " " + pad(truncateToWidth(content, bodyW)) + " " + th.fg("border", "│");

    const active = this.mode === "quota"
      ? `${th.fg("accent", "[Quota]")} ${th.fg("dim", "[Session]")}`
      : `${th.fg("dim", "[Quota]")} ${th.fg("accent", "[Session]")}`;

    let content: string[];
    if (this.mode === "quota") {
      const allLines = this.renderQuotaLines();
      this.lastContentLines = allLines.length;
      const maxScroll = Math.max(0, this.lastContentLines - this.viewHeight);
      this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
      content = allLines.slice(this.scrollOffset, this.scrollOffset + this.viewHeight);
    } else {
      content = this.session.render(th);
    }

    const lines: string[] = [];
    lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
    lines.push(row(` ${th.fg("accent", th.bold("Estimated Usage"))} ${active}`));
    lines.push(row(th.fg("borderMuted", "─".repeat(innerW))));
    for (const line of content) lines.push(row(line));
    if (this.mode === "quota") {
      const canScroll = this.lastContentLines > this.viewHeight;
      const scrollHint = canScroll ? "↑↓ scroll · " : "";
      lines.push(row());
      lines.push(row(` ${th.fg("dim", `${scrollHint}Tab switch · Esc close`)}`));
    }
    lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
    return lines;
  }

  private renderQuotaLines(): string[] {
    const th = this.theme;
    const lines: string[] = [];

    if (this.message) {
      const text = this.message.startsWith("No ")
        ? th.fg("muted", this.message)
        : th.fg("warning", this.message);
      lines.push(` ${text}`);
    }

    for (let i = 0; i < this.orderedProviders.length; i++) {
      if (i > 0) lines.push("");
      const provider = this.orderedProviders[i]!;
      const report = this.reports.get(provider);
      if (report) {
        for (const line of fullReport(report, provider).split("\n")) {
          lines.push(` ${line}`);
        }
      } else {
        lines.push(` ${th.fg("accent", th.bold(provider.label))}`);
        lines.push(` ${th.fg("muted", "Loading...")}`);
      }
    }

    return lines;
  }

  invalidate(): void {}

  dispose(): void {
    this.unsubscribeInput?.();
    this.unsubscribeInput = undefined;
  }
}
