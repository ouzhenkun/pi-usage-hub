import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KiroConfig, UsageProvider, UsageReport } from "../types";
import { agentDir } from "../core/config";
import { formatDurationSeconds } from "../utils/duration";

const PI_AUTH_PATH = () => join(agentDir(), "auth.json");
const FETCH_TIMEOUT_MS = 12_000;
const REFRESH_BUFFER_MS = 2 * 60 * 1000;
const KIRO_DESKTOP_REFRESH_URL = "https://prod.{region}.auth.desktop.kiro.dev/refreshToken";

interface KiroCredentials {
  accessToken: string;
  expiresAt: number;
  region: string;
  profileArn?: string;
  refresh?: string;
  authMethod?: string;
  clientId?: string;
  clientSecret?: string;
}

interface PiKiroAuthEntry {
  type?: string;
  refresh?: string;
  access?: string;
  expires?: number;
  clientId?: string;
  clientSecret?: string;
  region?: string;
  authMethod?: string;
  profileArn?: string;
}

interface KiroUsageBreakdown {
  currentUsage?: number;
  currentUsageWithPrecision?: number;
  usageLimit?: number;
  usageLimitWithPrecision?: number;
  nextDateReset?: string | number;
}

interface KiroUsageResponse {
  nextDateReset?: string | number;
  usageBreakdown?: KiroUsageBreakdown;
  usageBreakdownList?: KiroUsageBreakdown[];
}

interface KiroListProfilesResponse {
  profiles?: Array<{ arn?: string }>;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function readTokenCredentials(): KiroCredentials | null {
  const path = PI_AUTH_PATH();
  if (!existsSync(path)) return null;

  const auth = readJson<{ kiro?: PiKiroAuthEntry }>(path);
  const tokenData = auth?.kiro;
  if (tokenData?.type !== "oauth" || !tokenData.access || !tokenData.expires) return null;

  const expiresAt = tokenData.expires;
  if (!Number.isFinite(expiresAt)) return null;

  return {
    accessToken: tokenData.access,
    expiresAt,
    region: tokenData.region ?? "us-east-1",
    profileArn: tokenData.profileArn,
    refresh: tokenData.refresh,
    authMethod: tokenData.authMethod,
    clientId: tokenData.clientId,
    clientSecret: tokenData.clientSecret,
  };
}

function isFresh(credentials: KiroCredentials): boolean {
  return Date.now() < credentials.expiresAt - REFRESH_BUFFER_MS;
}

async function refreshCredentials(credentials: KiroCredentials): Promise<KiroCredentials> {
  if (!credentials.refresh) {
    throw new Error("session expired — run /login kiro to refresh");
  }

  const parts = credentials.refresh.split("|");
  const refreshToken = parts[0] ?? "";
  const authMethod = credentials.authMethod ?? parts[parts.length - 1] ?? "idc";
  const region = credentials.region || "us-east-1";
  if (!refreshToken) throw new Error("session expired — run /login kiro to refresh");

  if (authMethod === "desktop") {
    const res = await fetch(KIRO_DESKTOP_REFRESH_URL.replace("{region}", region), {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "pi-usage-hub" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) throw new Error(`token refresh failed: HTTP ${res.status}`);

    const data = await res.json() as {
      accessToken?: string;
      refreshToken?: string;
      expiresIn?: number;
      profileArn?: string;
    };
    if (!data.accessToken) throw new Error("token refresh failed: missing access token");

    return {
      ...credentials,
      accessToken: data.accessToken,
      refresh: `${data.refreshToken || refreshToken}|desktop`,
      expiresAt: Date.now() + (data.expiresIn ?? 3600) * 1000,
      region,
      authMethod: "desktop",
      profileArn: data.profileArn || credentials.profileArn,
    };
  }

  const clientId = credentials.clientId ?? parts[1] ?? "";
  const clientSecret = credentials.clientSecret ?? parts[2] ?? "";
  if (!clientId || !clientSecret) {
    throw new Error("session expired — run /login kiro to refresh");
  }

  const res = await fetch(`https://oidc.${region}.amazonaws.com/token`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "pi-usage-hub" },
    body: JSON.stringify({ clientId, clientSecret, refreshToken, grantType: "refresh_token" }),
  });
  if (!res.ok) throw new Error(`token refresh failed: HTTP ${res.status}`);

  const data = await res.json() as { accessToken?: string; refreshToken?: string; expiresIn?: number };
  if (!data.accessToken) throw new Error("token refresh failed: missing access token");

  return {
    ...credentials,
    accessToken: data.accessToken,
    refresh: `${data.refreshToken || refreshToken}|${clientId}|${clientSecret}|idc`,
    expiresAt: Date.now() + (data.expiresIn ?? 3600) * 1000,
    region,
    authMethod: "idc",
    clientId,
    clientSecret,
  };
}

function parseReset(value: string | number | undefined): number | undefined {
  if (value == null) return undefined;
  if (typeof value === "number") return value > 10_000_000_000 ? value / 1000 : value;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms / 1000 : undefined;
}

async function postKiro<T>(credentials: KiroCredentials, target: string, body: Record<string, unknown>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`https://q.${credentials.region}.amazonaws.com/`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        "content-type": "application/x-amz-json-1.0",
        "x-amz-target": target,
        "user-agent": "pi-usage-hub",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}${text ? ` ${text}` : ""}`);
    }

    return await res.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveProfileArn(credentials: KiroCredentials): Promise<string | undefined> {
  if (credentials.profileArn) return credentials.profileArn;

  try {
    const data = await postKiro<KiroListProfilesResponse>(
      credentials,
      "AmazonCodeWhispererService.ListAvailableProfiles",
      {},
    );
    return data.profiles?.find(profile => profile.arn)?.arn;
  } catch {
    return undefined;
  }
}

function usageBodies(profileArn: string | undefined): Array<Record<string, unknown>> {
  const maybeProfile = profileArn ? { profileArn } : {};
  return [
    { ...maybeProfile, origin: "AI_EDITOR", resourceType: "AGENTIC_REQUEST", isEmailRequired: true },
    { ...maybeProfile, origin: "AI_EDITOR", resourceType: "AGENTIC_REQUEST" },
    { ...maybeProfile, origin: "CLI", resourceType: "CREDIT", isEmailRequired: false },
    { ...maybeProfile, origin: "CLI", resourceType: "CREDIT" },
    { ...maybeProfile, origin: "CLI" },
    maybeProfile,
  ];
}

async function fetchUsageData(credentials: KiroCredentials): Promise<KiroUsageResponse> {
  const profileArn = await resolveProfileArn(credentials);
  const errors: string[] = [];

  for (const body of usageBodies(profileArn)) {
    try {
      return await postKiro<KiroUsageResponse>(
        credentials,
        "AmazonCodeWhispererService.GetUsageLimits",
        body,
      );
    } catch (err: any) {
      errors.push(err?.message ?? String(err));
    }
  }

  throw new Error(errors[0] ?? "usage fetch failed");
}

function mapUsage(data: KiroUsageResponse): UsageReport {
  const item = data.usageBreakdownList?.[0] ?? data.usageBreakdown;
  if (!item) return { error: "could not parse usage" };

  const used = item.currentUsageWithPrecision ?? item.currentUsage ?? 0;
  const limit = item.usageLimitWithPrecision ?? item.usageLimit ?? 0;
  if (!limit) return { error: "no usage limit" };

  const pct = (used / limit) * 100;
  const resetTs = parseReset(item.nextDateReset ?? data.nextDateReset);
  const resetsIn = resetTs ? formatDurationSeconds(resetTs - Date.now() / 1000) : "";

  return { session: { pct, resetsIn } };
}

export function makeKiroProvider(name: string, cfg: KiroConfig = {}): UsageProvider {
  let cachedRefreshCredentials: KiroCredentials | null = null;

  async function getCredentials(): Promise<KiroCredentials | null> {
    const credentials = readTokenCredentials();
    if (!credentials) return null;
    if (isFresh(credentials)) return credentials;

    if (
      cachedRefreshCredentials &&
      cachedRefreshCredentials.refresh === credentials.refresh &&
      isFresh(cachedRefreshCredentials)
    ) {
      return cachedRefreshCredentials;
    }

    cachedRefreshCredentials = await refreshCredentials(credentials);
    return cachedRefreshCredentials;
  }

  return {
    key: name,
    matchProviders: cfg.matchProviders ?? [name, "kiro"],
    shortLabel: cfg.shortLabel ?? "KIRO",
    label: cfg.label ?? "Kiro",
    // Presence in config enables the provider; auth comes from auth.json.
    detect: () => true,

    fetchUsage: async (): Promise<UsageReport> => {
      try {
        const credentials = await getCredentials();
        if (!credentials) return { error: "not logged in — run /login kiro" };
        return mapUsage(await fetchUsageData(credentials));
      } catch (err: any) {
        if (err?.name === "AbortError") return { error: "timeout" };
        return { error: err?.message ?? String(err) };
      }
    },
  };
}
