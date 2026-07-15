/**
 * Example: register session/OAuth usage providers via L2 (not via config).
 *
 * Not loaded by the package. Copy into ~/.pi/agent/extensions/ or adapt.
 *
 *   pi.events.on("pi-usage-hub:ready", hub => hub.register(...))
 *   pi.events.emit("pi-usage-hub:register", provider)
 *
 * Prefer L1 config when possible:
 *
 *   { "name": "xai", "type": "xai", "matchProviders": ["xai-auth", "xai", "grok-cli"] }
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { makeArkProvider } from "../providers/ark";
import { makeXaiProvider } from "../providers/xai";
import { makeKiroProvider } from "../providers/kiro";
import type { UsageHub, UsageProvider } from "../types";

const providers: UsageProvider[] = [
  makeArkProvider("ark", { matchProviders: ["ark"] }),
  makeXaiProvider("xai", {
    matchProviders: ["xai-auth", "xai", "grok-cli"],
  }),
  makeKiroProvider("kiro", { matchProviders: ["kiro"] }),
];

export default function register(pi: ExtensionAPI) {
  const attach = (hub: UsageHub) => {
    for (const p of providers) hub.register(p);
  };

  const offReady = pi.events.on("pi-usage-hub:ready", (hub: UsageHub) => {
    attach(hub);
  });
  for (const p of providers) {
    pi.events.emit("pi-usage-hub:register", p);
  }

  pi.on("session_shutdown", async () => {
    offReady();
  });
}
