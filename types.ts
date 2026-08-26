export interface UsageData {
  pct: number;
  resetsIn?: string;
}

export interface UsageReport {
  session?: UsageData;
  weekly?: UsageData;
  monthly?: UsageData;
  error?: string;
  displayText?: string;
}

export interface UsageProvider {
  key: string;
  /** model.provider values this usage entry matches (besides key). */
  matchProviders?: string[];
  shortLabel: string;
  label: string;
  /** If true, excluded from active providers (quota panel and footer). Login still works. */
  hidden?: boolean;
  detect(): boolean;
  fetchUsage(): Promise<UsageReport>;
  login?(): Promise<boolean>;
}

/** Built-in factory id (L1 `type` field). */
export type ProviderType =
  | "deepseek"
  | "newapi"
  | "ark"
  | "opencode-go"
  | "xai"
  | "kiro"
  | "kimi-coding"
  | "zai";

/** Shared optional fields for factories and config entries. */
export interface ProviderMeta {
  matchProviders?: string[];
  shortLabel?: string;
  label?: string;
  /** If true, exclude from active providers (quota panel, footer). Login still works. */
  hidden?: boolean;
  /** If true, do not register / refuse registration entirely. */
  disabled?: boolean;
}

/** Factory input — no type (caller already picked the factory). */
export interface DeepseekConfig extends ProviderMeta {
  apiKey: string;
}

export interface NewApiConfig extends ProviderMeta {
  host: string;
  token: string;
  userId: string;
}

export interface ArkConfig extends ProviderMeta {
  /** Full Cookie header; if set, skips Chrome. */
  cookie?: string;
  /** Optional CSRF; otherwise parsed from cookie (`csrfToken=`). */
  csrfToken?: string;
}

export interface OpencodeGoConfig extends ProviderMeta {
  workspaceId: string;
  /** `auth` cookie value; if set, skips Chrome. */
  auth?: string;
}

export interface XaiConfig extends ProviderMeta {}

export interface KiroConfig extends ProviderMeta {}

export interface KimiCodingConfig extends ProviderMeta {
  /** Optional; falls back to the "kimi-coding" entry in pi's auth.json. */
  apiKey?: string;
}

export interface ZaiConfig extends ProviderMeta {
  /** Optional; falls back to the "zai" entry in pi's auth.json. */
  apiKey?: string;
}

/** L1 entry after parse — name always set (auto: type, type-2, … when omitted/clashing). */
export type BuiltinProviderConfig =
  | ({ name: string; type: "deepseek" } & DeepseekConfig)
  | ({ name: string; type: "newapi" } & NewApiConfig)
  | ({ name: string; type: "ark" } & ArkConfig)
  | ({ name: string; type: "opencode-go" } & OpencodeGoConfig)
  | ({ name: string; type: "xai" } & XaiConfig)
  | ({ name: string; type: "kiro" } & KiroConfig)
  | ({ name: string; type: "kimi-coding" } & KimiCodingConfig)
  | ({ name: string; type: "zai" } & ZaiConfig);

/**
 * L2 entry: no `type` — targets an externally-registered (custom) provider.
 * Meta fields override the provider's own values at register time; all other
 * fields pass through to `hub.getProviderConfig(name)`.
 */
export interface ExtensionProviderConfig extends ProviderMeta {
  name: string;
  [key: string]: unknown;
}

export type ProviderConfig = BuiltinProviderConfig | ExtensionProviderConfig;

export interface UsageHubConfig {
  providers?: ProviderConfig[];
}

export interface UsageHub {
  register(p: UsageProvider): void;
  unregister(key: string): void;
  /** Instantiate a built-in provider and register it (auto name allocation). Returns its key, or null if unknown type / disabled. */
  registerBuiltin(type: ProviderType, cfg?: ProviderMeta & Record<string, unknown>): string | null;
  /** Raw config entry for a custom provider key, if the user added one. */
  getProviderConfig(key: string): ExtensionProviderConfig | undefined;
  list(): UsageProvider[];
  /** Match model → cached one-line summary, or null if no provider / not fetched yet. */
  getSummary(model?: { provider?: string }): string | null;
  getReport(key: string): UsageReport | null;
  refresh(opts?: {
    model?: { provider?: string };
    force?: boolean;
  }): Promise<string | null>;
  invalidate(key?: string): void;
}
