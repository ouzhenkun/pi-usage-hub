import type { UsageProvider, UsageReport } from "../types";

export function bar(pct: number, width = 24): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  const color = pct < 70 ? "32" : pct < 90 ? "33" : "31";
  const blocks = "\u2588".repeat(filled) + "\u2591".repeat(empty);
  return `\x1b[${color}m${blocks}\x1b[0m`;
}

export function shortReport(report: UsageReport, provider: UsageProvider): string {
  if (report.error) {
    const authError = /not logged in|session expired/i.test(report.error);
    return `${provider.shortLabel} ${authError ? "login required" : "error"}`;
  }
  if (report.displayText) return `${provider.shortLabel} ${report.displayText}`;

  const primary = report.session ?? report.weekly ?? report.monthly;
  if (!primary) return provider.shortLabel;

  const resetStr = primary.resetsIn ? ` · ↻ ${primary.resetsIn}` : "";
  let text = `${primary.pct.toFixed(0)}%${resetStr}`;

  const secondary: string[] = [];
  if (report.session != null) {
    if (report.weekly != null) secondary.push(`W${report.weekly.pct.toFixed(0)}%`);
    if (report.monthly != null) secondary.push(`M${report.monthly.pct.toFixed(0)}%`);
  } else if (report.weekly != null && report.monthly != null) {
    secondary.push(`M${report.monthly.pct.toFixed(0)}%`);
  }
  if (secondary.length > 0) text += ` / ${secondary.join(" ")}`;

  return `${provider.shortLabel} ${text}`;
}

export function fullReport(report: UsageReport, provider: UsageProvider): string {
  const lines: string[] = [];
  lines.push(`\x1b[1m${provider.label}\x1b[0m`);

  if (report.displayText) {
    const match = report.displayText.match(/[\d,.]+/);
    const amount = match ? parseFloat(match[0].replace(/,/g, "")) : 0;
    const color = amount >= 20 ? "32" : amount >= 10 ? "33" : "31";
    lines.push(`  Balance: \x1b[${color}m${report.displayText}\x1b[0m`);
    return lines.join("\n");
  }

  if (report.error) {
    lines.push(`  \x1b[31m\u2716 ${report.error}\x1b[0m`);
    return lines.join("\n");
  }

  if (report.session) {
    const r = report.session.resetsIn ? `  \u23F1 ${report.session.resetsIn}` : "";
    lines.push(`  Rolling: ${bar(report.session.pct)} ${report.session.pct.toFixed(1)}%${r}`);
  }
  if (report.weekly) {
    const r = report.weekly.resetsIn ? `  \u23F1 ${report.weekly.resetsIn}` : "";
    lines.push(`  Weekly:  ${bar(report.weekly.pct)} ${report.weekly.pct.toFixed(1)}%${r}`);
  }
  if (report.monthly) {
    const r = report.monthly.resetsIn ? `  \u23F1 ${report.monthly.resetsIn}` : "";
    lines.push(`  Monthly: ${bar(report.monthly.pct)} ${report.monthly.pct.toFixed(1)}%${r}`);
  }

  return lines.join("\n");
}
