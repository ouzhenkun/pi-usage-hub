import type { ProviderConfig, UsageProvider } from "../types";
import { makeDeepseekProvider } from "../providers/deepseek";
import { makeNewApiProvider } from "../providers/newapi";
import { makeArkProvider } from "../providers/ark";
import { makeOpencodeGoProvider } from "../providers/opencode-go";
import { makeXaiProvider } from "../providers/xai";
import { makeKiroProvider } from "../providers/kiro";

export class ProviderRegistry {
  private providers = new Map<string, UsageProvider>();

  register(provider: UsageProvider): void {
    this.providers.set(provider.key, provider);
  }

  unregister(key: string): void {
    this.providers.delete(key);
  }

  clear(): void {
    this.providers.clear();
  }

  list(): UsageProvider[] {
    return [...this.providers.values()];
  }

  get(key: string): UsageProvider | undefined {
    return this.providers.get(key);
  }

  detectActive(): UsageProvider[] {
    return this.list().filter(p => {
      if (p.hidden) return false;
      try {
        return p.detect();
      } catch {
        return false;
      }
    });
  }

  matchModel(model?: { provider?: string }): UsageProvider | null {
    const current = model?.provider;
    if (!current) return null;
    return this.detectActive().find(p =>
      p.key === current || (p.matchProviders?.includes(current) ?? false),
    ) ?? null;
  }

  loadFromConfig(providers: ProviderConfig[]): void {
    for (const cfg of providers) {
      const provider = makeProvider(cfg);
      if (provider) this.register(provider);
    }
  }
}

function makeProvider(cfg: ProviderConfig): UsageProvider | null {
  switch (cfg.type) {
    case "deepseek":
      return makeDeepseekProvider(cfg.name, cfg);
    case "newapi":
      return makeNewApiProvider(cfg.name, cfg);
    case "ark":
      return makeArkProvider(cfg.name, cfg);
    case "opencode-go":
      return makeOpencodeGoProvider(cfg.name, cfg);
    case "xai":
      return makeXaiProvider(cfg.name, cfg);
    case "kiro":
      return makeKiroProvider(cfg.name, cfg);
  }
}
