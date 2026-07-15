import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TokenStats {
  total: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SessionUsageTotals {
  sessions: number;
  messages: number;
  cost: number;
  tokens: TokenStats;
}

export interface ModelSessionUsage extends SessionUsageTotals {
  model: string;
}

export interface ProviderSessionUsage extends SessionUsageTotals {
  provider: string;
  models: ModelSessionUsage[];
}

export interface SessionUsagePeriod {
  totals: SessionUsageTotals;
  providers: ProviderSessionUsage[];
}

export interface SessionUsageSummary {
  today: SessionUsagePeriod;
  thisWeek: SessionUsagePeriod;
  thisMonth: SessionUsagePeriod;
  allTime: SessionUsagePeriod;
}

interface MutableStats {
  sessions: Set<string>;
  messages: number;
  cost: number;
  tokens: TokenStats;
}

interface MutableProvider extends MutableStats {
  models: Map<string, MutableStats>;
}

interface MutablePeriod {
  totals: MutableStats;
  providers: Map<string, MutableProvider>;
}

interface SessionMessage {
  provider: string;
  model: string;
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  timestamp: number;
}

type PeriodName = keyof SessionUsageSummary;

function getSessionsDir(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "sessions");
}

async function collectSessionFiles(dir: string, files: string[], signal?: AbortSignal): Promise<void> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (signal?.aborted) return;
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await collectSessionFiles(entryPath, files, signal);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(entryPath);
      }
    }
  } catch {
    // Ignore unreadable session directories.
  }
}

function emptyTokens(): TokenStats {
  return { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function emptyStats(): MutableStats {
  return { sessions: new Set(), messages: 0, cost: 0, tokens: emptyTokens() };
}

function emptyProvider(): MutableProvider {
  return { sessions: new Set(), messages: 0, cost: 0, tokens: emptyTokens(), models: new Map() };
}

function emptyPeriod(): MutablePeriod {
  return { totals: emptyStats(), providers: new Map() };
}

function addStats(stats: MutableStats, sessionId: string, message: SessionMessage): void {
  stats.sessions.add(sessionId);
  stats.messages++;
  stats.cost += message.cost;
  stats.tokens.total += message.input + message.output + message.cacheWrite;
  stats.tokens.input += message.input;
  stats.tokens.output += message.output;
  stats.tokens.cacheRead += message.cacheRead;
  stats.tokens.cacheWrite += message.cacheWrite;
}

function periodsFor(timestamp: number, todayMs: number, weekStartMs: number, monthStartMs: number): PeriodName[] {
  const periods: PeriodName[] = ["allTime"];
  if (timestamp >= todayMs) periods.push("today");
  if (timestamp >= weekStartMs) periods.push("thisWeek");
  if (timestamp >= monthStartMs) periods.push("thisMonth");
  return periods;
}

async function parseSessionFile(
  filePath: string,
  seenHashes: Set<string>,
  signal?: AbortSignal,
): Promise<{ sessionId: string; messages: SessionMessage[] } | null> {
  try {
    const content = await readFile(filePath, "utf8");
    if (signal?.aborted) return null;

    let sessionId = "";
    const messages: SessionMessage[] = [];
    const lines = content.trim().split("\n");

    for (let i = 0; i < lines.length; i++) {
      if (signal?.aborted) return null;
      if (i % 500 === 0) await new Promise<void>(resolve => setImmediate(resolve));

      const line = lines[i]?.trim();
      if (!line) continue;

      try {
        const entry = JSON.parse(line);
        if (entry.type === "session") {
          sessionId = entry.id || sessionId;
          continue;
        }

        const msg = entry.type === "message" ? entry.message : null;
        if (msg?.role !== "assistant" || !msg.usage || !msg.provider) continue;

        const input = msg.usage.input || 0;
        const output = msg.usage.output || 0;
        const cacheRead = msg.usage.cacheRead || 0;
        const cacheWrite = msg.usage.cacheWrite || 0;
        const fallbackTs = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
        const timestamp = msg.timestamp || (Number.isNaN(fallbackTs) ? 0 : fallbackTs);
        const totalTokens = input + output + cacheRead + cacheWrite;
        const hash = `${timestamp}:${totalTokens}`;
        if (seenHashes.has(hash)) continue;
        seenHashes.add(hash);

        messages.push({
          provider: msg.provider,
          model: msg.model || "unknown",
          cost: msg.usage.cost?.total || 0,
          input,
          output,
          cacheRead,
          cacheWrite,
          timestamp,
        });
      } catch {
        // Skip malformed entries.
      }
    }

    return sessionId ? { sessionId, messages } : null;
  } catch {
    return null;
  }
}

function finalizeStats(stats: MutableStats): SessionUsageTotals {
  return {
    sessions: stats.sessions.size,
    messages: stats.messages,
    cost: stats.cost,
    tokens: stats.tokens,
  };
}

function finalizePeriod(period: MutablePeriod): SessionUsagePeriod {
  const providers = Array.from(period.providers.entries())
    .map(([provider, stats]) => ({
      provider,
      ...finalizeStats(stats),
      models: Array.from(stats.models.entries())
        .map(([model, m]) => ({ model, ...finalizeStats(m) }))
        .sort((a, b) => b.cost - a.cost || b.tokens.total - a.tokens.total),
    }))
    .sort((a, b) => b.cost - a.cost || b.tokens.total - a.tokens.total);

  return {
    totals: finalizeStats(period.totals),
    providers,
  };
}

export async function collectSessionUsage(signal?: AbortSignal): Promise<SessionUsageSummary> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();

  const startOfWeek = new Date();
  const dayOfWeek = startOfWeek.getDay();
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  startOfWeek.setDate(startOfWeek.getDate() - daysSinceMonday);
  startOfWeek.setHours(0, 0, 0, 0);
  const weekStartMs = startOfWeek.getTime();

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const monthStartMs = startOfMonth.getTime();

  const periods: Record<PeriodName, MutablePeriod> = {
    today: emptyPeriod(),
    thisWeek: emptyPeriod(),
    thisMonth: emptyPeriod(),
    allTime: emptyPeriod(),
  };

  const files: string[] = [];
  await collectSessionFiles(getSessionsDir(), files, signal);
  files.sort();

  const seenHashes = new Set<string>();
  for (const file of files) {
    if (signal?.aborted) break;
    const parsed = await parseSessionFile(file, seenHashes, signal);
    if (!parsed) continue;

    for (const message of parsed.messages) {
      for (const periodName of periodsFor(message.timestamp, todayMs, weekStartMs, monthStartMs)) {
        const period = periods[periodName];
        let provider = period.providers.get(message.provider);
        if (!provider) {
          provider = emptyProvider();
          period.providers.set(message.provider, provider);
        }
        let model = provider.models.get(message.model);
        if (!model) {
          model = emptyStats();
          provider.models.set(message.model, model);
        }
        addStats(model, parsed.sessionId, message);
        addStats(provider, parsed.sessionId, message);
        addStats(period.totals, parsed.sessionId, message);
      }
    }
  }

  return {
    today: finalizePeriod(periods.today),
    thisWeek: finalizePeriod(periods.thisWeek),
    thisMonth: finalizePeriod(periods.thisMonth),
    allTime: finalizePeriod(periods.allTime),
  };
}
