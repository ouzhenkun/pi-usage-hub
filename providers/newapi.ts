import type { NewApiConfig, UsageProvider, UsageReport } from "../types";

const QUOTA_PER_DOLLAR = 500_000;
const FETCH_TIMEOUT_MS = 10_000;
const BJ_OFFSET_MS = 8 * 60 * 60 * 1000;

async function apiGet(cfg: NewApiConfig, endpoint: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.host}${endpoint}`, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.token}`,
        "New-Api-User": cfg.userId,
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBalance(cfg: NewApiConfig): Promise<number | null> {
  const data = await apiGet(cfg, "/api/user/self");
  if (!data?.success || !data?.data) return null;
  return (data.data.quota ?? 0) / QUOTA_PER_DOLLAR;
}

async function fetchTodayUsage(cfg: NewApiConfig): Promise<number | null> {
  const nowMs = Date.now();
  const startMs = Math.floor((nowMs + BJ_OFFSET_MS) / 86_400_000) * 86_400_000 - BJ_OFFSET_MS;
  const startTs = Math.floor(startMs / 1000);
  const endTs = Math.floor(nowMs / 1000);
  const data = await apiGet(
    cfg,
    `/api/data/self?start_timestamp=${startTs}&end_timestamp=${endTs}&default_time=day`,
  );
  if (!data?.success) return null;
  const rows: any[] = data.data ?? [];
  return rows.reduce((sum: number, r: any) => sum + (r.quota ?? 0), 0) / QUOTA_PER_DOLLAR;
}

function fmt(v: number | null): string {
  return v === null ? "$?" : `$${v.toFixed(2)}`;
}

function labelFromName(name: string): string {
  return name.replace(/[-_]+/g, "-").toUpperCase();
}

export function makeNewApiProvider(name: string, cfg: NewApiConfig): UsageProvider {
  const shortLabel = cfg.shortLabel ?? labelFromName(name);
  return {
    key: name,
    matchProviders: cfg.matchProviders ?? [name],
    shortLabel,
    label: cfg.label ?? `NewAPI ${shortLabel}`,
    detect: () => !!(cfg.host && cfg.token && cfg.userId),

    fetchUsage: async (): Promise<UsageReport> => {
      if (!cfg.host || !cfg.token || !cfg.userId) {
        return { error: `no credentials — add ${name} to pi-usage-hub.json` };
      }
      const [balance, today] = await Promise.all([fetchBalance(cfg), fetchTodayUsage(cfg)]);
      if (balance === null) return { error: "failed to fetch balance" };
      return { displayText: `${fmt(balance)} · ${fmt(today)}` };
    },
  };
}
