import type { UsageProvider, UsageReport } from "../types";
import { shortReport } from "../ui/format-report";

export const DEFAULT_TTL_MS = 60_000;

export interface CacheEntry {
  report: UsageReport;
  summary: string;
  fetchedAt: number;
}

type Subscriber = (e: { key: string; summary: string | null }) => void;

export class UsageCache {
  private entries = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<CacheEntry>>();
  private subscribers = new Set<Subscriber>();

  constructor(private ttlMs = DEFAULT_TTL_MS) {}

  getSummary(key: string): string | null {
    return this.entries.get(key)?.summary ?? null;
  }

  getReport(key: string): UsageReport | null {
    return this.entries.get(key)?.report ?? null;
  }

  invalidate(key?: string): void {
    if (key) {
      this.entries.delete(key);
      this.notify(key, null);
      return;
    }
    const keys = [...this.entries.keys()];
    this.entries.clear();
    for (const k of keys) this.notify(k, null);
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  async refreshProvider(provider: UsageProvider, force = false): Promise<CacheEntry> {
    const hit = this.entries.get(provider.key);
    if (!force && hit && Date.now() - hit.fetchedAt < this.ttlMs) return hit;

    const existing = this.inflight.get(provider.key);
    if (existing) return existing;

    const job = (async () => {
      let report: UsageReport;
      try {
        report = await provider.fetchUsage();
      } catch (err) {
        report = { error: err instanceof Error ? err.message : String(err) };
      }
      const entry: CacheEntry = {
        report,
        summary: shortReport(report, provider),
        fetchedAt: Date.now(),
      };
      this.entries.set(provider.key, entry);
      this.notify(provider.key, entry.summary);
      return entry;
    })().finally(() => {
      this.inflight.delete(provider.key);
    });

    this.inflight.set(provider.key, job);
    return job;
  }

  private notify(key: string, summary: string | null): void {
    for (const fn of this.subscribers) {
      try {
        fn({ key, summary });
      } catch {
        // ignore subscriber errors
      }
    }
  }
}
