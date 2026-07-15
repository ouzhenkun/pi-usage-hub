import { execFile } from "node:child_process";
import type { ArkConfig, UsageProvider, UsageReport } from "../types";
import { readChromeCookies } from "../utils/chrome-cookies";
import { formatDurationSeconds } from "../utils/duration";

const COOKIE_DOMAINS = ["console.volcengine.com", ".volcengine.com"];
const API_URL =
  "https://console.volcengine.com/api/top/ark/cn-beijing/2024-01-01/GetCodingPlanUsage?";
const FETCH_TIMEOUT_MS = 15_000;

function parseCookieHeader(header: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) map[name] = value;
  }
  return map;
}

function chromeCookies(): Record<string, string> {
  if (process.platform !== "darwin") return {};
  const cookies = readChromeCookies("%volcengine%", COOKIE_DOMAINS);
  const map: Record<string, string> = {};
  for (const c of cookies) map[c.name] = c.value;
  return map;
}

function resolveCookies(cfg: ArkConfig): { cookieHeader: string; csrf: string; digest?: string } | null {
  if (cfg.cookie?.trim()) {
    const map = parseCookieHeader(cfg.cookie);
    const cookieHeader = cfg.cookie.trim();
    const csrf = cfg.csrfToken?.trim() || map.csrfToken || "";
    return { cookieHeader, csrf, digest: map.digest };
  }

  const map = chromeCookies();
  if (!map.userInfo && !map.digest) return null;
  const cookieHeader = Object.entries(map).map(([k, v]) => `${k}=${v}`).join("; ");
  return { cookieHeader, csrf: cfg.csrfToken?.trim() || map.csrfToken || "", digest: map.digest };
}

async function callApi(cookieHeader: string, csrf: string): Promise<UsageReport> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        "content-type": "application/json",
        cookie: cookieHeader,
        origin: "https://console.volcengine.com",
        referer: "https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        "x-csrf-token": csrf,
      },
      body: "{}",
      signal: controller.signal,
    });

    if (!res.ok) return { error: `HTTP ${res.status}` };

    const body: any = await res.json();
    const err = body?.ResponseMetadata?.Error;
    if (err) return { error: err.Message ?? err.Code };

    return parseQuota(body);
  } catch (err: any) {
    if (err?.name === "AbortError") return { error: "timeout" };
    return { error: err?.message ?? String(err) };
  } finally {
    clearTimeout(timer);
  }
}

interface QuotaEntry {
  Level: string;
  Percent: number;
  ResetTimestamp: number;
}

function parseQuota(raw: any): UsageReport {
  const entries: QuotaEntry[] = raw?.Result?.QuotaUsage ?? [];
  if (entries.length === 0) return { error: "no QuotaUsage entries" };

  const report: UsageReport = {};
  const now = Date.now() / 1000;

  for (const q of entries) {
    const resetSec = Math.max(0, q.ResetTimestamp - now);
    const data = { pct: q.Percent, resetsIn: formatDurationSeconds(resetSec) };
    if (q.Level === "session") report.session = data;
    else if (q.Level === "weekly") report.weekly = data;
    else if (q.Level === "monthly") report.monthly = data;
  }
  return report;
}

export function makeArkProvider(name: string, cfg: ArkConfig = {}): UsageProvider {
  const manual = !!cfg.cookie?.trim();

  return {
    key: name,
    matchProviders: cfg.matchProviders ?? [name, "ark"],
    shortLabel: cfg.shortLabel ?? "ARK",
    label: cfg.label ?? "ARK Coding",
    detect: () => resolveCookies(cfg) !== null,

    fetchUsage: async (): Promise<UsageReport> => {
      const auth = resolveCookies(cfg);
      if (!auth) {
        return {
          error: manual
            ? "invalid cookie in config"
            : "not logged in — set cookie in config or /usage-hub login ark",
        };
      }
      const result = await callApi(auth.cookieHeader, auth.csrf);
      if (result.error === "HTTP 401" || result.error === "HTTP 403") {
        return {
          error: manual
            ? "session expired — refresh cookie in config"
            : "session expired — run /usage-hub login ark",
        };
      }
      return result;
    },

    login: manual
      ? undefined
      : async (): Promise<boolean> => {
          const oldDigest = resolveCookies(cfg)?.digest;
          execFile("open", ["-a", "Google Chrome",
            "https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?LLM=%7B%7D&advancedActiveKey=subscribe",
          ]);
          const deadline = Date.now() + 300_000;
          while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 2000));
            const cur = resolveCookies(cfg)?.digest;
            if (cur && cur !== oldDigest) return true;
            if (!oldDigest && resolveCookies(cfg)) {
              const auth = resolveCookies(cfg)!;
              const probe = await callApi(auth.cookieHeader, auth.csrf);
              if (!probe.error) return true;
            }
          }
          return false;
        },
  };
}
