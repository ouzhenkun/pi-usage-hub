import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ZaiConfig, UsageProvider, UsageData, UsageReport } from "../types";
import { agentDir } from "../core/config";
import { formatDurationSeconds } from "../utils/duration";

// Undocumented endpoint reverse-engineered from the z.ai dashboard XHR.
// CN mirror: https://open.bigmodel.cn/api/monitor/usage/quota/limit (same account data).
const API_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const FETCH_TIMEOUT_MS = 15_000;

interface ZaiLimit {
  type?: string;
  unit?: number;
  number?: number;
  percentage?: number;
  nextResetTime?: number;
  usage?: number;
  currentValue?: number;
  remaining?: number;
}

interface ZaiQuotaPayload {
  code?: number;
  success?: boolean;
  msg?: string;
  data?: { limits?: ZaiLimit[]; level?: string };
}

function readAuthKey(): string | null {
  const path = join(agentDir(), "auth.json");
  if (!existsSync(path)) return null;
  try {
    const auth = JSON.parse(readFileSync(path, "utf-8"));
    const key = auth?.zai?.key;
    return typeof key === "string" && key ? key : null;
  } catch {
    return null;
  }
}

function parseLimit(l: ZaiLimit): UsageData | null {
  let pct = l.percentage;
  if (typeof pct !== "number" || !Number.isFinite(pct)) {
    if (typeof l.usage === "number" && l.usage > 0 && typeof l.currentValue === "number") {
      pct = (l.currentValue / l.usage) * 100;
    } else {
      return null;
    }
  }
  const resetSec =
    typeof l.nextResetTime === "number" ? (l.nextResetTime - Date.now()) / 1000 : undefined;
  return {
    pct,
    resetsIn: resetSec != null && resetSec > 0 ? formatDurationSeconds(resetSec) : undefined,
  };
}

function parseUsage(payload: ZaiQuotaPayload): UsageReport {
  const limits = payload.data?.limits;
  if (!Array.isArray(limits)) return { error: payload.msg || "no usage data" };

  const report: UsageReport = {};
  for (const l of limits) {
    const parsed = parseLimit(l);
    if (!parsed) continue;
    if (l.type === "TOKENS_LIMIT" && l.unit === 3) report.session ??= parsed;
    else if (l.type === "TOKENS_LIMIT" && l.unit === 6) report.weekly ??= parsed;
    else if (l.type === "TIME_LIMIT") report.monthly ??= parsed;
  }

  if (!report.session && !report.weekly && !report.monthly) {
    return { error: "could not parse usage" };
  }
  return report;
}

export function makeZaiProvider(name: string, cfg: ZaiConfig = {}): UsageProvider {
  const resolveApiKey = () => cfg.apiKey || readAuthKey();

  return {
    key: name,
    matchProviders: cfg.matchProviders ?? [name, "zai"],
    shortLabel: cfg.shortLabel ?? "ZAI",
    label: cfg.label ?? "Z.ai Coding Plan",
    hidden: cfg.hidden,
    detect: () => resolveApiKey() !== null,

    fetchUsage: async (): Promise<UsageReport> => {
      const apiKey = resolveApiKey();
      if (!apiKey) return { error: "no API key — run /login zai or set apiKey in config" };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        const res = await fetch(API_URL, {
          headers: {
            accept: "application/json",
            // bare key, no Bearer prefix
            authorization: apiKey,
          },
          signal: controller.signal,
        });

        if (res.status === 401 || res.status === 403) return { error: "invalid API key" };
        if (!res.ok) return { error: `HTTP ${res.status}` };

        const payload: ZaiQuotaPayload = await res.json();
        if (payload.success === false || (payload.code != null && payload.code !== 200)) {
          return { error: payload.msg || `code ${payload.code}` };
        }
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
