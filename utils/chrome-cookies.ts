import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, unlinkSync, mkdtempSync } from "node:fs";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CHROME_COOKIE_DB = join(
  process.env.HOME ?? "~",
  "Library",
  "Application Support",
  "Google",
  "Chrome",
  "Default",
  "Cookies",
);
const CHROME_EPOCH_OFFSET = 11_644_473_600;

export interface CookieRow {
  hostKey: string;
  name: string;
  value: string;
}

let cachedKey: Buffer | null = null;

function getChromeKey(): Buffer {
  if (cachedKey) return cachedKey;
  const password = execFileSync("security", [
    "find-generic-password", "-w", "-s", "Chrome Safe Storage",
  ], { encoding: "utf8", timeout: 5000 }).trim();
  cachedKey = pbkdf2Sync(Buffer.from(password), "saltysalt", 1003, 16, "sha1");
  return cachedKey;
}

function decryptCookie(blob: Buffer, key: Buffer): string | null {
  if (!blob.subarray(0, 3).equals(Buffer.from("v10"))) {
    try { return blob.toString("utf-8"); } catch { return null; }
  }
  const ct = blob.subarray(3);
  const iv = Buffer.alloc(16, 0x20);
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, iv);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    return plain.subarray(32).toString("utf-8");
  } catch {
    return null;
  }
}

/** Read cookies from Chrome for domains matching `likePattern` (SQL LIKE). macOS only. */
export function readChromeCookies(likePattern: string, validDomains: string[]): CookieRow[] {
  if (process.platform !== "darwin") return [];
  if (!existsSync(CHROME_COOKIE_DB)) return [];

  const tmpDir = mkdtempSync(join(tmpdir(), "pi-cookies-"));
  const tmpDb = join(tmpDir, "Cookies");
  try {
    copyFileSync(CHROME_COOKIE_DB, tmpDb);
  } catch {
    return [];
  }

  const key = getChromeKey();
  const nowChrome = (Date.now() / 1000 + CHROME_EPOCH_OFFSET) * 1_000_000;

  try {
    const stdout = execFileSync("sqlite3", [
      "-separator", "|",
      "-noheader",
      tmpDb,
      `SELECT host_key, name, hex(encrypted_value), expires_utc\n       FROM cookies WHERE host_key LIKE '${likePattern.replace(/'/g, "''")}'`,
    ], { encoding: "utf8", timeout: 5000 });

    const rows: CookieRow[] = [];
    for (const line of stdout.trim().split("\n")) {
      if (!line) continue;
      const [hostKey, name, encHex, expiresUtcStr] = line.split("|");
      const expiresUtc = Number(expiresUtcStr);
      if (!hostKey || !name || !encHex) continue;
      if (expiresUtc && expiresUtc < nowChrome) continue;
      if (!validDomains.includes(hostKey)) continue;

      const value = decryptCookie(Buffer.from(encHex, "hex"), key);
      if (value == null) continue;

      try { Buffer.from(value, "latin1"); } catch { continue; }

      rows.push({ hostKey, name, value });
    }
    return rows;
  } catch {
    return [];
  } finally {
    try { unlinkSync(tmpDb); } catch { /* ignore */ }
  }
}
