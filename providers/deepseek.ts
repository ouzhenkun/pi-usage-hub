import type { DeepseekConfig, UsageProvider, UsageReport } from "../types";

const API_URL = "https://api.deepseek.com/user/balance";
const FETCH_TIMEOUT_MS = 10_000;

export function makeDeepseekProvider(name: string, cfg: DeepseekConfig): UsageProvider {
  const apiKey = cfg.apiKey;
  return {
    key: name,
    matchProviders: cfg.matchProviders ?? [name, "deepseek"],
    shortLabel: cfg.shortLabel ?? "DS",
    label: cfg.label ?? "DeepSeek",
    detect: () => !!apiKey,

    fetchUsage: async (): Promise<UsageReport> => {
      if (!apiKey) return { error: "no API key configured" };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        const res = await fetch(API_URL, {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          signal: controller.signal,
        });

        if (!res.ok) return { error: `HTTP ${res.status}` };

        const body: any = await res.json();
        const info = (body?.balance_infos ?? [{}])[0];
        const balance = info?.total_balance ?? "0";
        const currency = info?.currency ?? "CNY";
        const available = body?.is_available;

        if (!available) {
          return { displayText: `\u26A0\uFE0F account unavailable` };
        }

        return { displayText: `\u00A5${balance} ${currency}` };
      } catch (err: any) {
        if (err?.name === "AbortError") return { error: "timeout" };
        return { error: err?.message ?? String(err) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
