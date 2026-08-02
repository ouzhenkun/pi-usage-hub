import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { UsageProvider, UsageReport, XaiConfig } from "../types";
import { agentDir } from "../core/config";
import { formatDurationMs } from "../utils/duration";

const PI_AUTH_PATH = () => join(agentDir(), "auth.json");
const GROK_AUTH_PATH = () => join(homedir(), ".grok", "auth.json");
const BILLING_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_GROK_CLI_AUTH_SCOPE_KEY =
  "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";
const DEFAULT_TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";
const FETCH_TIMEOUT_MS = 12_000;
const REFRESH_BUFFER_MS = 2 * 60 * 1000;

interface XaiCredentials {
  access: string;
  refresh?: string;
  expires?: number;
  tokenEndpoint?: string;
}

interface WeeklyUsage {
  creditUsagePercent: number;
  billingPeriodEnd: string;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function parseExpiry(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readPiCredentials(): XaiCredentials | null {
  const path = PI_AUTH_PATH();
  if (!existsSync(path)) return null;
  const auth = readJson<{ xai?: XaiCredentials; "xai-auth"?: XaiCredentials }>(path);
  const entry = auth?.xai ?? auth?.["xai-auth"];
  if (!entry?.access) return null;
  return {
    access: String(entry.access),
    refresh: entry.refresh ? String(entry.refresh) : undefined,
    expires: parseExpiry(entry.expires),
    tokenEndpoint: entry.tokenEndpoint ? String(entry.tokenEndpoint) : DEFAULT_TOKEN_ENDPOINT,
  };
}

function readGrokCliCredentials(): XaiCredentials | null {
  const path = GROK_AUTH_PATH();
  if (!existsSync(path)) return null;
  const data = readJson<Record<string, any>>(path);
  if (!data) return null;

  const oidc = data[XAI_GROK_CLI_AUTH_SCOPE_KEY];
  if (oidc && typeof oidc === "object") {
    const access = String(oidc.key || oidc.access_token || oidc.token || "");
    if (!access) return null;
    return {
      access,
      refresh: oidc.refresh_token || oidc.refresh ? String(oidc.refresh_token || oidc.refresh) : undefined,
      expires: parseExpiry(oidc.expires_at),
      tokenEndpoint: DEFAULT_TOKEN_ENDPOINT,
    };
  }

  const topLevelAccess = data.access_token || data.token;
  if (!topLevelAccess) return null;
  return {
    access: String(topLevelAccess),
    refresh: data.refresh_token || data.refresh ? String(data.refresh_token || data.refresh) : undefined,
    expires: parseExpiry(data.expires_at || data.expires),
    tokenEndpoint: DEFAULT_TOKEN_ENDPOINT,
  };
}

function readStoredCredentials(): XaiCredentials | null {
  return readPiCredentials() ?? readGrokCliCredentials();
}

function isFresh(credentials: XaiCredentials): boolean {
  if (!credentials.expires) return true;
  return Date.now() < credentials.expires - REFRESH_BUFFER_MS;
}

function validateTokenEndpoint(url: string): string {
  const normalized = url.replace(/\/$/, "");
  if (normalized !== DEFAULT_TOKEN_ENDPOINT) {
    throw new Error("unexpected xAI token endpoint — run /login xai-auth");
  }
  return DEFAULT_TOKEN_ENDPOINT;
}

async function refreshCredentials(credentials: XaiCredentials): Promise<XaiCredentials> {
  if (!credentials.refresh) {
    throw new Error("session expired — run /login xai-auth");
  }

  const tokenEndpoint = validateTokenEndpoint(credentials.tokenEndpoint || DEFAULT_TOKEN_ENDPOINT);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credentials.refresh,
    client_id: XAI_OAUTH_CLIENT_ID,
  });

  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) throw new Error(`token refresh failed: HTTP ${res.status}`);

  const data = await res.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!data.access_token) throw new Error("token refresh failed: missing access token");

  return {
    access: data.access_token,
    refresh: data.refresh_token || credentials.refresh,
    expires: Date.now() + (data.expires_in ?? 3600) * 1000,
    tokenEndpoint,
  };
}

function resetsInFromIso(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const end = new Date(iso).getTime();
  if (!Number.isFinite(end)) return undefined;
  return formatDurationMs(end - Date.now());
}

function parseWeeklyUsage(payload: unknown): WeeklyUsage {
  if (!payload || typeof payload !== "object") throw new Error("invalid billing payload");
  const config = (payload as Record<string, unknown>).config;
  if (!config || typeof config !== "object") throw new Error("invalid billing payload");

  const currentPeriod = (config as Record<string, unknown>).currentPeriod as
    | Record<string, unknown>
    | undefined;
  if (currentPeriod?.type !== "USAGE_PERIOD_TYPE_WEEKLY") {
    throw new Error("could not parse usage");
  }

  const creditUsagePercentRaw = (config as Record<string, unknown>).creditUsagePercent;
  const billingPeriodEnd = (config as Record<string, unknown>).billingPeriodEnd;
  if (
    typeof billingPeriodEnd !== "string" ||
    !Number.isFinite(new Date(billingPeriodEnd).getTime())
  ) {
    throw new Error("could not parse usage");
  }

  // Fresh billing cycle omits creditUsagePercent; treat missing/invalid as 0 instead of failing.
  const creditUsagePercent =
    typeof creditUsagePercentRaw === "number" && Number.isFinite(creditUsagePercentRaw)
      ? creditUsagePercentRaw
      : 0;

  return { creditUsagePercent, billingPeriodEnd };
}

async function fetchJson(url: string, token: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-xai-token-auth": "xai-grok-cli",
        accept: "application/json",
        "user-agent": "pi-usage-hub",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function isUnauthorized(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { status?: number }).status === 401;
}

async function fetchBillingUsage(token: string): Promise<WeeklyUsage> {
  return parseWeeklyUsage(await fetchJson(`${BILLING_BASE_URL}/billing?format=credits`, token));
}

function mapUsage(weekly: WeeklyUsage): UsageReport {
  return {
    weekly: {
      pct: weekly.creditUsagePercent,
      resetsIn: resetsInFromIso(weekly.billingPeriodEnd),
    },
  };
}

export function makeXaiProvider(name: string, cfg: XaiConfig = {}): UsageProvider {
  // In-memory only — intentionally not written back to auth.json.
  let cachedCredentials: XaiCredentials | null = null;
  let diskRefreshAtCache: string | undefined;

  async function getCredentials(forceRefresh = false): Promise<XaiCredentials | null> {
    const stored = readStoredCredentials();
    if (!stored) {
      cachedCredentials = null;
      diskRefreshAtCache = undefined;
      return null;
    }

    // Drop cache if disk was re-logged to a different refresh token.
    if (
      cachedCredentials &&
      stored.refresh &&
      diskRefreshAtCache &&
      stored.refresh !== diskRefreshAtCache &&
      stored.refresh !== cachedCredentials.refresh
    ) {
      cachedCredentials = null;
      diskRefreshAtCache = undefined;
    }

    if (!forceRefresh) {
      if (isFresh(stored)) {
        cachedCredentials = stored;
        diskRefreshAtCache = stored.refresh;
        return stored;
      }
      // Prefer session cache after a prior refresh (tokens are not persisted).
      if (cachedCredentials && isFresh(cachedCredentials)) {
        return cachedCredentials;
      }
    }

    const base =
      cachedCredentials?.refresh
        ? {
            access: cachedCredentials.access,
            refresh: cachedCredentials.refresh,
            expires: cachedCredentials.expires,
            tokenEndpoint: cachedCredentials.tokenEndpoint ?? stored.tokenEndpoint,
          }
        : stored;

    cachedCredentials = await refreshCredentials(base);
    diskRefreshAtCache = stored.refresh;
    return cachedCredentials;
  }

  return {
    key: name,
    matchProviders: cfg.matchProviders ?? [name, "xai-auth", "xai", "grok-cli"],
    shortLabel: cfg.shortLabel ?? "XAI",
    label: cfg.label ?? "xAI (SuperGrok)",
    hidden: cfg.hidden,
    detect: () => readStoredCredentials() !== null,

    fetchUsage: async (): Promise<UsageReport> => {
      try {
        const credentials = await getCredentials(false);
        if (!credentials) return { error: "not logged in — run /login xai-auth" };
        try {
          return mapUsage(await fetchBillingUsage(credentials.access));
        } catch (err) {
          if (!isUnauthorized(err)) throw err;
          const refreshed = await getCredentials(true);
          if (!refreshed) return { error: "session expired — run /login xai-auth" };
          return mapUsage(await fetchBillingUsage(refreshed.access));
        }
      } catch (err: any) {
        if (err?.name === "AbortError") return { error: "timeout" };
        return { error: err?.message ?? String(err) };
      }
    },
  };
}
