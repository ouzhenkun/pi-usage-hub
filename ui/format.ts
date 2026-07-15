// Shared display/formatting helpers used by the usage overlay and its panels.

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export function visibleWidth(text: string): number {
  return text.replace(ANSI_RE, "").length;
}

export function truncateToWidth(text: string, width: number): string {
  let out = "";
  let used = 0;
  for (let i = 0; i < text.length; ) {
    if (text[i] === "\x1b") {
      const match = text.slice(i).match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }
    const char = text[i]!;
    if (used + 1 > width) break;
    out += char;
    used++;
    i++;
  }
  return out;
}

function matchesKittyKey(data: string, codepoint: number, modifier = 0): boolean {
  const match = data.match(/^\x1b\[(\d+)(?::\d*)?(?::\d+)?(?:;(\d+))?(?::\d+)?u$/);
  if (!match) return false;
  const keyCodepoint = Number(match[1]);
  const keyModifier = Number(match[2] ?? "1") - 1;
  return keyCodepoint === codepoint && keyModifier === modifier;
}

function matchesModifyOtherKey(data: string, codepoint: number, modifier = 0): boolean {
  const match = data.match(/^\x1b\[27;(\d+);(\d+)~$/);
  if (!match) return false;
  const keyModifier = Number(match[1]) - 1;
  const keyCodepoint = Number(match[2]);
  return keyCodepoint === codepoint && keyModifier === modifier;
}

export function isCloseKey(data: string): boolean {
  return data === "\x1b"
    || data === "\x03"
    || data === "q"
    || data === "Q"
    || matchesKittyKey(data, 27)
    || matchesModifyOtherKey(data, 27)
    || matchesKittyKey(data, 113)
    || matchesKittyKey(data, 81)
    || matchesKittyKey(data, 99, 4)
    || matchesModifyOtherKey(data, 99, 4);
}

export function formatMoney(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 10) return `$${value.toFixed(2)}`;
  if (value < 100) return `$${value.toFixed(1)}`;
  return `$${Math.round(value)}`;
}

export function formatTokens(value: number): string {
  if (value === 0) return "-";
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

export function formatNumber(value: number): string {
  return value === 0 ? "-" : value.toLocaleString();
}

export function clip(s: string, w: number): string {
  return s.length > w ? `${s.slice(0, w - 1)}…` : s;
}

export function padR(s: string, w: number): string {
  const c = clip(s, w);
  return c + " ".repeat(Math.max(0, w - c.length));
}

export function padL(s: string, w: number): string {
  const c = clip(s, w);
  return " ".repeat(Math.max(0, w - c.length)) + c;
}
