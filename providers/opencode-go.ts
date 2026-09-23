import { execFile } from "node:child_process";
import type { OpencodeGoConfig, UsageProvider, UsageReport } from "../types";
import { readChromeCookies } from "../utils/chrome-cookies";
import { formatDurationSeconds } from "../utils/duration";

const FETCH_TIMEOUT_MS = 10_000;
const SESSION_COOKIE = "__Host-console_session";
const STATUS_URL = "https://opencode.ai/console/api/go/status";

type Meter = {
  limitMicroCents?: string;
  usedMicroCents?: string;
  resetsAt?: string;
};

function readChromeSessionCookie(): string | null {
  if (process.platform !== "darwin") return null;
  const cookies = readChromeCookies("%opencode.ai%", ["opencode.ai", ".opencode.ai"]);
  return cookies.find(c => c.name === SESSION_COOKIE)?.value ?? null;
}

function resolveSession(cfg: OpencodeGoConfig): string | null {
  if (cfg.auth?.trim()) return cfg.auth.trim();
  return readChromeSessionCookie();
}

function toWindow(
  meter: Meter | undefined,
  fallbackResetsAt?: string,
): { pct: number; resetsIn: string } | null {
  const limit = Number(meter?.limitMicroCents);
  const used = Number(meter?.usedMicroCents);
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used)) return null;
  const resetsAt = meter?.resetsAt ?? fallbackResetsAt;
  const resetsInSec = resetsAt ? (Date.parse(resetsAt) - Date.now()) / 1000 : Number.NaN;
  return { pct: (used / limit) * 100, resetsIn: formatDurationSeconds(resetsInSec) };
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
    detect: () => !!workspaceId && (!!resolveSession(cfg) || !manual),

    fetchUsage: async (): Promise<UsageReport> => {
      if (!workspaceId) return { error: "no credentials configured" };

      const session = resolveSession(cfg);
      if (!session) {
        return {
          error: manual
            ? "invalid auth in config"
            : "not logged in — set auth in config or /usage-hub login ocg",
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        const res = await fetch(STATUS_URL, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0",
            Accept: "application/json",
            "x-org-id": workspaceId,
            Cookie: `${SESSION_COOKIE}=${session}`,
          },
          signal: controller.signal,
        });

        if (res.status === 401 || res.status === 403) {
          return { error: "session expired — /usage-hub login ocg" };
        }
        if (!res.ok) return { error: `HTTP ${res.status}` };

        let data: { access?: { endsAt?: string; meters?: Record<string, Meter> } };
        try {
          data = await res.json();
        } catch {
          return { error: "could not parse usage from response" };
        }

        const meters = data?.access?.meters;
        const fiveHour = toWindow(meters?.fiveHour);
        const weekly = toWindow(meters?.week);
        const monthly = toWindow(meters?.month, data?.access?.endsAt);
        if (!fiveHour && !weekly && !monthly) return { error: "could not parse usage from response" };

        const report: UsageReport = {};
        if (fiveHour) report.session = fiveHour;
        if (weekly) report.weekly = weekly;
        if (monthly) report.monthly = monthly;
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
          execFile("open", ["-a", "Google Chrome", `https://opencode.ai/console/${workspaceId}/go`]);
          const deadline = Date.now() + 300_000;
          while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 2000));
            if (readChromeSessionCookie()) return true;
          }
          return false;
        },
  };
}
