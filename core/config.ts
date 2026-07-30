import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig, ProviderType, UsageHubConfig } from "../types";

const TYPES = new Set<ProviderType>([
  "deepseek",
  "newapi",
  "ark",
  "opencode-go",
  "xai",
  "kiro",
]);

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

/** Prefer explicit name; otherwise type, then type-2, type-3, … */
function allocateName(type: ProviderType, preferred: string | undefined, seen: Set<string>): string {
  const base = preferred?.trim() || type;
  if (!seen.has(base)) return base;
  let n = 2;
  while (seen.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function parseProviderEntry(
  raw: unknown,
  index: number,
  seen: Set<string>,
): ProviderConfig | null {
  if (!isObject(raw)) {
    console.warn(`[pi-usage-hub] skip providers[${index}]: not an object`);
    return null;
  }

  if (typeof raw.type !== "string" || !TYPES.has(raw.type as ProviderType)) {
    console.warn(`[pi-usage-hub] skip providers[${index}]: unknown or missing type`);
    return null;
  }

  const type = raw.type as ProviderType;
  const preferred = typeof raw.name === "string" ? raw.name : undefined;
  const name = allocateName(type, preferred, seen);
  if (preferred?.trim() && name !== preferred.trim()) {
    console.warn(`[pi-usage-hub] providers[${index}] name "${preferred.trim()}" taken, using "${name}"`);
  }

  const meta = {
    matchProviders: asStringArray(raw.matchProviders),
    shortLabel: typeof raw.shortLabel === "string" ? raw.shortLabel : undefined,
    label: typeof raw.label === "string" ? raw.label : undefined,
    hidden: typeof raw.hidden === "boolean" ? raw.hidden : undefined,
  };

  switch (type) {
    case "deepseek": {
      if (typeof raw.apiKey !== "string" || !raw.apiKey) {
        console.warn(`[pi-usage-hub] skip providers[${index}]: deepseek requires apiKey`);
        return null;
      }
      return { name, type: "deepseek", ...meta, apiKey: raw.apiKey };
    }
    case "newapi": {
      if (
        typeof raw.host !== "string" ||
        typeof raw.token !== "string" ||
        typeof raw.userId !== "string"
      ) {
        console.warn(`[pi-usage-hub] skip providers[${index}]: newapi requires host, token, userId`);
        return null;
      }
      return {
        name,
        type: "newapi",
        ...meta,
        host: raw.host,
        token: raw.token,
        userId: raw.userId,
      };
    }
    case "opencode-go": {
      if (typeof raw.workspaceId !== "string" || !raw.workspaceId) {
        console.warn(`[pi-usage-hub] skip providers[${index}]: opencode-go requires workspaceId`);
        return null;
      }
      return {
        name,
        type: "opencode-go",
        ...meta,
        workspaceId: raw.workspaceId,
        auth: typeof raw.auth === "string" ? raw.auth : undefined,
      };
    }
    case "ark":
      return {
        name,
        type: "ark",
        ...meta,
        cookie: typeof raw.cookie === "string" ? raw.cookie : undefined,
        csrfToken: typeof raw.csrfToken === "string" ? raw.csrfToken : undefined,
      };
    case "xai":
      return { name, type: "xai", ...meta };
    case "kiro":
      return { name, type: "kiro", ...meta };
  }
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
    if (!parsed) continue;
    seen.add(parsed.name);
    providers.push(parsed);
  }

  return { providers };
}
