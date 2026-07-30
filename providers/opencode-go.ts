import { execFile } from "node:child_process";
import type { OpencodeGoConfig, UsageProvider, UsageReport } from "../types";
import { readChromeCookies } from "../utils/chrome-cookies";
import { formatDurationSeconds } from "../utils/duration";

const SCRAPED_NUMBER = "(-?\\d+(?:\\.\\d+)?)";
const FETCH_TIMEOUT_MS = 10_000;

function makeRe(key: string): RegExp[] {
  const pctFirst = new RegExp(`${key}:\\$R\\[\\d+\\]=\\{[^}]*usagePercent:${SCRAPED_NUMBER}[^}]*resetInSec:${SCRAPED_NUMBER}[^}]*\\}`);
  const resetFirst = new RegExp(`${key}:\\$R\\[\\d+\\]=\\{[^}]*resetInSec:${SCRAPED_NUMBER}[^}]*usagePercent:${SCRAPED_NUMBER}[^}]*\\}`);
  return [pctFirst, resetFirst];
}

function parseWindow(html: string, key: string): { pct: number; resetsInSec: number } | null {
  const [rePct, reReset] = makeRe(key);
  const m1 = rePct.exec(html);
  if (m1) {
    const pct = Number(m1[1]), sec = Number(m1[2]);
    if (Number.isFinite(pct) && Number.isFinite(sec)) return { pct, resetsInSec: sec };
  }
  const m2 = reReset.exec(html);
  if (m2) {
    const sec = Number(m2[1]), pct = Number(m2[2]);
    if (Number.isFinite(pct) && Number.isFinite(sec)) return { pct, resetsInSec: sec };
  }
  return null;
}

function readChromeAuthCookie(): string | null {
  if (process.platform !== "darwin") return null;
  const cookies = readChromeCookies("%opencode.ai%", ["opencode.ai", ".opencode.ai"]);
  return cookies.find(c => c.name === "auth")?.value ?? null;
}

function resolveAuth(cfg: OpencodeGoConfig): string | null {
  if (cfg.auth?.trim()) return cfg.auth.trim();
  return readChromeAuthCookie();
}

export function makeOpencodeGoProvider(name: string, cfg: OpencodeGoConfig): UsageProvider {
  const workspaceId = cfg.workspaceId;
  const manual = !!cfg.auth?.trim();

  return {
    key: name,
    matchProviders: cfg.matchProviders ?? [name, "opencode-go"],
    shortLabel: cfg.shortLabel ?? "OCG",
    label: cfg.label ?? "OpenCode Go",
    hidden: cfg.hidden,
    detect: () => !!workspaceId && (!!resolveAuth(cfg) || !manual),

    fetchUsage: async (): Promise<UsageReport> => {
      if (!workspaceId) return { error: "no credentials configured" };

      const authCookie = resolveAuth(cfg);
      if (!authCookie) {
        return {
          error: manual
            ? "invalid auth in config"
            : "not logged in — set auth in config or /usage-hub login ocg",
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        const res = await fetch(
          `https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`,
          {
            headers: {
              "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0",
              Accept: "text/html",
              Cookie: `auth=${authCookie}`,
            },
            signal: controller.signal,
          },
        );

        if (!res.ok) return { error: `HTTP ${res.status}` };

        const html = await res.text();
        const rolling = parseWindow(html, "rollingUsage");
        const weekly = parseWindow(html, "weeklyUsage");
        const monthly = parseWindow(html, "monthlyUsage");

        if (!rolling && !weekly && !monthly) return { error: "could not parse usage from dashboard" };

        const report: UsageReport = {};
        if (rolling) report.session = { pct: rolling.pct, resetsIn: formatDurationSeconds(rolling.resetsInSec) };
        if (weekly) report.weekly = { pct: weekly.pct, resetsIn: formatDurationSeconds(weekly.resetsInSec) };
        if (monthly) report.monthly = { pct: monthly.pct, resetsIn: formatDurationSeconds(monthly.resetsInSec) };
        return report;
      } catch (err: any) {
        if (err?.name === "AbortError") return { error: "timeout" };
        return { error: err?.message ?? String(err) };
      } finally {
        clearTimeout(timer);
      }
    },

    login: manual
      ? undefined
      : async (): Promise<boolean> => {
          if (!workspaceId) return false;
          execFile("open", ["-a", "Google Chrome", `https://opencode.ai/workspace/${workspaceId}/go`]);
          const deadline = Date.now() + 300_000;
          while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 2000));
            if (readChromeAuthCookie()) return true;
          }
          return false;
        },
  };
}
