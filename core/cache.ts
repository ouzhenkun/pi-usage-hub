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
  private generation = new Map<string, number>();
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
      this.drop(key);
      return;
    }
    const keys = new Set([...this.entries.keys(), ...this.inflight.keys()]);
    for (const k of keys) this.drop(k);
  }

  /** Bump the generation so requests started before this point cannot repopulate the cache. */
  private drop(key: string): void {
    this.generation.set(key, (this.generation.get(key) ?? 0) + 1);
    this.inflight.delete(key);
    this.entries.delete(key);
    this.notify(key, null);
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

    const key = provider.key;
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const generation = this.generation.get(key) ?? 0;
    let job: Promise<CacheEntry>;
    job = (async () => {
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
      if ((this.generation.get(key) ?? 0) === generation) {
        this.entries.set(key, entry);
        this.notify(key, entry.summary);
      }
      return entry;
    })().finally(() => {
      if (this.inflight.get(key) === job) this.inflight.delete(key);
    });

    this.inflight.set(key, job);
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
