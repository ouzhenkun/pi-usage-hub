import type {
  BuiltinProviderConfig,
  ExtensionProviderConfig,
  ProviderConfig,
  ProviderMeta,
  ProviderType,
  UsageProvider,
} from "../types";
import { makeDeepseekProvider } from "../providers/deepseek";
import { makeNewApiProvider } from "../providers/newapi";
import { makeArkProvider } from "../providers/ark";
import { makeOpencodeGoProvider } from "../providers/opencode-go";
import { makeXaiProvider } from "../providers/xai";
import { makeKiroProvider } from "../providers/kiro";
import { makeKimiCodingProvider } from "../providers/kimi-coding";
import { makeZaiProvider } from "../providers/zai";

const FACTORIES = {
  deepseek: makeDeepseekProvider,
  newapi: makeNewApiProvider,
  ark: makeArkProvider,
  "opencode-go": makeOpencodeGoProvider,
  xai: makeXaiProvider,
  kiro: makeKiroProvider,
  "kimi-coding": makeKimiCodingProvider,
  zai: makeZaiProvider,
} satisfies Record<ProviderType, (name: string, cfg: any) => UsageProvider>;

function makeProvider(cfg: BuiltinProviderConfig): UsageProvider {
  const factory = FACTORIES[cfg.type] as (name: string, cfg: unknown) => UsageProvider;
  return factory(cfg.name, cfg);
}

/** Config-entry meta wins over the provider's own values, per explicitly-set field. */
function applyMeta(p: UsageProvider, cfg: ExtensionProviderConfig): UsageProvider {
  return {
    ...p,
    matchProviders: cfg.matchProviders ?? p.matchProviders,
    shortLabel: cfg.shortLabel ?? p.shortLabel,
    label: cfg.label ?? p.label,
    hidden: cfg.hidden ?? p.hidden,
  };
}

function allocateName(base: string, taken: (name: string) => boolean): string {
  if (!taken(base)) return base;
  let n = 2;
  while (taken(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export class ProviderRegistry {
  private providers = new Map<string, UsageProvider>();
  private extensionConfigs = new Map<string, ExtensionProviderConfig>();

  register(provider: UsageProvider): void {
    const cfg = this.extensionConfigs.get(provider.key);
    if (cfg?.disabled) return;
    this.providers.set(provider.key, cfg ? applyMeta(provider, cfg) : provider);
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

  getExtensionConfig(key: string): ExtensionProviderConfig | undefined {
    return this.extensionConfigs.get(key);
  }

  registerBuiltin(type: ProviderType, cfg: ProviderMeta & Record<string, unknown> = {}): string | null {
    const factory = FACTORIES[type] as ((name: string, cfg: unknown) => UsageProvider) | undefined;
    if (!factory || cfg.disabled) return null;
    const preferred = typeof (cfg as { name?: unknown }).name === "string"
      ? (cfg as { name: string }).name.trim()
      : "";
    const name = allocateName(preferred || type, n => this.providers.has(n));
    this.register(factory(name, cfg));
    return name;
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
      if (typeof (cfg as { type?: unknown }).type === "string") {
        const builtin = cfg as BuiltinProviderConfig;
        if (builtin.disabled) continue;
        // Name pre-allocated by the config parser; register verbatim (last write wins).
        this.register(makeProvider(builtin));
      } else {
        this.extensionConfigs.set(cfg.name, cfg as ExtensionProviderConfig);
      }
    }
  }
}
