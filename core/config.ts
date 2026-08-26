import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  BuiltinProviderConfig,
  ExtensionProviderConfig,
  ProviderConfig,
  ProviderMeta,
  ProviderType,
  UsageHubConfig,
} from "../types";

interface BuiltinSchema {
  /** Fields that must be non-empty strings, or the entry is skipped. */
  required?: string[];
  /** Extra string fields picked into the config when present. */
  optional?: string[];
}

const BUILTIN_SCHEMAS: Record<ProviderType, BuiltinSchema> = {
  deepseek: { required: ["apiKey"] },
  newapi: { required: ["host", "token", "userId"] },
  ark: { optional: ["cookie", "csrfToken"] },
  "opencode-go": { required: ["workspaceId"], optional: ["auth"] },
  xai: {},
  kiro: {},
  "kimi-coding": { optional: ["apiKey"] },
  zai: { optional: ["apiKey"] },
};

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function configPath(): string {
  return join(agentDir(), "pi-usage-hub.json");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((v): v is string => typeof v === "string");
  return items.length > 0 ? items : undefined;
}

function parseMeta(raw: Record<string, unknown>): ProviderMeta {
  return {
    matchProviders: asStringArray(raw.matchProviders),
    shortLabel: typeof raw.shortLabel === "string" ? raw.shortLabel : undefined,
    label: typeof raw.label === "string" ? raw.label : undefined,
    hidden: typeof raw.hidden === "boolean" ? raw.hidden : undefined,
    disabled: typeof raw.disabled === "boolean" ? raw.disabled : undefined,
  };
}

/** Prefer explicit name; otherwise type, then type-2, type-3, … */
function allocateName(type: ProviderType, preferred: string | undefined, seen: Set<string>): string {
  const base = preferred?.trim() || type;
  if (!seen.has(base)) return base;
  let n = 2;
  while (seen.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function parseBuiltinEntry(
  raw: Record<string, unknown>,
  index: number,
  seen: Set<string>,
): BuiltinProviderConfig | null {
  if (typeof raw.type !== "string" || !(raw.type in BUILTIN_SCHEMAS)) {
    console.warn(`[pi-usage-hub] skip providers[${index}]: unknown or missing type`);
    return null;
  }

  const type = raw.type as ProviderType;
  const preferred = typeof raw.name === "string" ? raw.name : undefined;
  const name = allocateName(type, preferred, seen);
  if (preferred?.trim() && name !== preferred.trim()) {
    console.warn(`[pi-usage-hub] providers[${index}] name "${preferred.trim()}" taken, using "${name}"`);
  }

  const schema = BUILTIN_SCHEMAS[type];
  const required = schema.required ?? [];
  for (const field of required) {
    if (typeof raw[field] !== "string" || !raw[field]) {
      console.warn(`[pi-usage-hub] skip providers[${index}]: ${type} requires ${required.join(", ")}`);
      return null;
    }
  }

  const fields: Record<string, string> = {};
  for (const field of [...required, ...(schema.optional ?? [])]) {
    const value = raw[field];
    if (typeof value === "string") fields[field] = value;
  }

  seen.add(name);
  return { name, type, ...parseMeta(raw), ...fields } as BuiltinProviderConfig;
}

function parseExtensionEntry(
  raw: Record<string, unknown>,
  index: number,
): ExtensionProviderConfig | null {
  if (typeof raw.name !== "string" || !raw.name.trim()) {
    console.warn(`[pi-usage-hub] skip providers[${index}]: entry without type requires a name`);
    return null;
  }
  return { ...raw, ...parseMeta(raw), name: raw.name.trim() };
}

function parseProviderEntry(raw: unknown, index: number, seen: Set<string>): ProviderConfig | null {
  if (!isObject(raw)) {
    console.warn(`[pi-usage-hub] skip providers[${index}]: not an object`);
    return null;
  }
  if (raw.type == null) return parseExtensionEntry(raw, index);
  return parseBuiltinEntry(raw, index, seen);
}

export function loadConfig(): UsageHubConfig {
  const path = configPath();
  if (!existsSync(path)) return { providers: [] };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    console.warn(`[pi-usage-hub] failed to parse ${path}`);
    return { providers: [] };
  }

  if (!isObject(raw) || !Array.isArray(raw.providers)) {
    console.warn(`[pi-usage-hub] ${path} must be { "providers": [ ... ] }`);
    return { providers: [] };
  }

  const providers: ProviderConfig[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < raw.providers.length; i++) {
    const parsed = parseProviderEntry(raw.providers[i], i, seen);
    if (parsed) providers.push(parsed);
  }

  return { providers };
}
