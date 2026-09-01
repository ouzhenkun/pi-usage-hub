import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodexConfig, UsageData, UsageProvider, UsageReport } from "../types";
import { agentDir } from "../core/config";
import { formatDurationSeconds } from "../utils/duration";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const FETCH_TIMEOUT_MS = 15_000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

interface StoredCodexCredential {
  type?: string;
  access?: string;
  accountId?: string;
  account_id?: string;
  expires?: number;
}

interface UsageWindow {
  used_percent?: number | null;
  reset_after_seconds?: number | null;
  reset_at?: number | null;
  limit_window_seconds?: number | null;
}

interface UsagePayload {
  rate_limit?: {
    primary_window?: UsageWindow | null;
    secondary_window?: UsageWindow | null;
  };
}

interface Credentials {
  accessToken: string;
  accountId: string;
  expires?: number;
}

function readCredentials(): Credentials | null {
  const path = join(agentDir(), "auth.json");
  if (!existsSync(path)) return null;

  try {
    const auth = JSON.parse(readFileSync(path, "utf-8")) as { "openai-codex"?: StoredCodexCredential };
    const entry = auth["openai-codex"];
    const accountId = entry?.accountId ?? entry?.account_id;
    if (entry?.type !== "oauth" || typeof entry.access !== "string" || !entry.access || typeof accountId !== "string" || !accountId) {
      return null;
    }
    return { accessToken: entry.access, accountId, expires: entry.expires };
  } catch {
    return null;
  }
}

function isFresh(credentials: Credentials): boolean {
  return credentials.expires == null || Date.now() < credentials.expires;
}

function toUsageData(window: UsageWindow | null | undefined): UsageData | undefined {
  if (!window || typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent)) return undefined;

  let resetSeconds: number | undefined;
  if (typeof window.reset_after_seconds === "number" && Number.isFinite(window.reset_after_seconds)) {
    resetSeconds = window.reset_after_seconds;
  } else if (typeof window.reset_at === "number" && Number.isFinite(window.reset_at)) {
    const resetAtMs = window.reset_at > 100_000_000_000 ? window.reset_at : window.reset_at * 1000;
    resetSeconds = (resetAtMs - Date.now()) / 1000;
  }

  return {
    pct: Math.min(100, Math.max(0, window.used_percent)),
    resetsIn: resetSeconds != null && resetSeconds > 0 ? formatDurationSeconds(resetSeconds) : undefined,
  };
}

function isRollingWindow(window: UsageWindow | null | undefined): boolean {
  const seconds = window?.limit_window_seconds;
  return typeof seconds === "number" && seconds > 0 && seconds < WEEK_SECONDS - 24 * 60 * 60;
}

function isWeeklyWindow(window: UsageWindow | null | undefined): boolean {
  const seconds = window?.limit_window_seconds;
  return typeof seconds === "number" && Math.abs(seconds - WEEK_SECONDS) <= 24 * 60 * 60;
}

export function parseCodexUsage(payload: UsagePayload): UsageReport {
  const rateLimit = payload.rate_limit;
  const primary = rateLimit?.primary_window;
  const secondary = rateLimit?.secondary_window;

  let session = isRollingWindow(primary) ? toUsageData(primary) : undefined;
  let weekly = isWeeklyWindow(primary) ? toUsageData(primary) : undefined;

  if (!session && isRollingWindow(secondary)) session = toUsageData(secondary);
  if (!weekly && isWeeklyWindow(secondary)) weekly = toUsageData(secondary);

  // Old responses omit duration metadata. With two windows, their documented order is rolling then weekly.
  if (!session && primary && secondary) session = toUsageData(primary);
  if (!weekly && secondary) weekly = toUsageData(secondary);
  // A single undifferentiated window is treated as weekly so the UI never invents a 5h allowance.
  if (!session && !weekly && primary) weekly = toUsageData(primary);

  if (!session && !weekly) return { error: "could not parse usage" };
  return {
    ...(session ? { session } : {}),
    ...(weekly ? { weekly } : {}),
  };
}

export function makeCodexProvider(name: string, cfg: CodexConfig = {}): UsageProvider {
  return {
    key: name,
    matchProviders: cfg.matchProviders ?? [name, "openai-codex"],
    shortLabel: cfg.shortLabel ?? "Codex",
    label: cfg.label ?? "OpenAI Codex",
    hidden: cfg.hidden,
    detect: () => readCredentials() !== null,

    fetchUsage: async (): Promise<UsageReport> => {
      const stored = readCredentials();
      if (!stored) return { error: "not logged in — run /login openai-codex" };

      try {
        if (!isFresh(stored)) return { error: "session expired — run /login openai-codex" };
        const accessToken = stored.accessToken;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
          const res = await fetch(USAGE_URL, {
            headers: {
              accept: "application/json",
              authorization: `Bearer ${accessToken}`,
              "chatgpt-account-id": stored.accountId,
            },
            signal: controller.signal,
          });
          if (res.status === 401 || res.status === 403) return { error: "session expired — run /login openai-codex" };
          if (!res.ok) return { error: `HTTP ${res.status}` };
          return parseCodexUsage(await res.json() as UsagePayload);
        } finally {
          clearTimeout(timer);
        }
      } catch (err: any) {
        if (err?.name === "AbortError") return { error: "timeout" };
        return { error: err?.message ?? String(err) };
      }
    },
  };
}

