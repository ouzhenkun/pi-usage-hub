import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KimiCodingConfig, UsageProvider, UsageData, UsageReport } from "../types";
import { agentDir } from "../core/config";
import { formatDurationSeconds } from "../utils/duration";

const API_URL = "https://api.kimi.com/coding/v1/usages";
const FETCH_TIMEOUT_MS = 15_000;

interface KimiQuota {
  limit?: string;
  used?: string;
  remaining?: string;
  resetTime?: string;
}

interface KimiUsagesPayload {
  usage?: KimiQuota;
  limits?: { window?: { duration?: number; timeUnit?: string }; detail?: KimiQuota }[];
}

function readAuthKey(): string | null {
  const path = join(agentDir(), "auth.json");
  if (!existsSync(path)) return null;
  try {
    const auth = JSON.parse(readFileSync(path, "utf-8"));
    const key = auth?.["kimi-coding"]?.key;
    return typeof key === "string" && key ? key : null;
  } catch {
    return null;
  }
}

function parseQuota(q: KimiQuota): UsageData | null {
  const limit = Number(q.limit);
  const used = Number(q.used);
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used)) return null;
  const resetMs = q.resetTime ? Date.parse(q.resetTime) : NaN;
  const resetSec = Number.isFinite(resetMs) ? (resetMs - Date.now()) / 1000 : undefined;
  return {
    pct: (used / limit) * 100,
    resetsIn: resetSec != null && resetSec > 0 ? formatDurationSeconds(resetSec) : undefined,
  };
}

function parseUsage(p: KimiUsagesPayload): UsageReport {
  const report: UsageReport = {};
  if (p.usage) {
    const weekly = parseQuota(p.usage);
    if (weekly) report.weekly = weekly;
  }
  const detail = p.limits?.[0]?.detail;
  if (detail) {
    const session = parseQuota(detail);
    if (session) report.session = session;
  }
  if (!report.session && !report.weekly) return { error: "could not parse usage" };
  return report;
}

export function makeKimiCodingProvider(name: string, cfg: KimiCodingConfig = {}): UsageProvider {
  const resolveApiKey = () => cfg.apiKey || readAuthKey();

  return {
    key: name,
    matchProviders: cfg.matchProviders ?? [name, "kimi-coding"],
    shortLabel: cfg.shortLabel ?? "KC",
    label: cfg.label ?? "Kimi for Coding",
    hidden: cfg.hidden,
    detect: () => resolveApiKey() !== null,

    fetchUsage: async (): Promise<UsageReport> => {
      const apiKey = resolveApiKey();
      if (!apiKey) return { error: "no API key — run /login kimi-coding or set apiKey in config" };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        const res = await fetch(API_URL, {
          headers: {
            accept: "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          signal: controller.signal,
        });

        if (res.status === 401 || res.status === 403) return { error: "invalid API key" };
        if (!res.ok) return { error: `HTTP ${res.status}` };

        const payload: KimiUsagesPayload = await res.json();
        return parseUsage(payload);
      } catch (err: any) {
        if (err?.name === "AbortError") return { error: "timeout" };
        return { error: err?.message ?? String(err) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
