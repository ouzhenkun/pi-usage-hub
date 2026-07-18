/**
 * Example: register a custom usage provider through the event API.
 *
 * Copy this file into ~/.pi/agent/extensions/ and adapt the endpoint,
 * credentials, response shape, and labels for your provider.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface UsageReport {
  session?: { pct: number; resetsIn?: string };
  weekly?: { pct: number; resetsIn?: string };
  monthly?: { pct: number; resetsIn?: string };
  error?: string;
  displayText?: string;
}

interface UsageProvider {
  key: string;
  matchProviders?: string[];
  shortLabel: string;
  label: string;
  detect(): boolean;
  fetchUsage(): Promise<UsageReport>;
}

interface UsageHub {
  register(provider: UsageProvider): void;
}

interface RelayUsageResponse {
  used: number;
  limit: number;
  resetsIn?: string;
}

const endpoint = process.env.MY_RELAY_USAGE_URL;
const token = process.env.MY_RELAY_TOKEN;

const provider: UsageProvider = {
  key: "my-relay",
  matchProviders: ["my-relay"],
  shortLabel: "RELAY",
  label: "My Relay",
  detect: () => Boolean(endpoint && token),
  async fetchUsage() {
    try {
      const response = await fetch(endpoint!, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) return { error: `HTTP ${response.status}` };

      const usage = await response.json() as RelayUsageResponse;
      if (!Number.isFinite(usage.used) || !Number.isFinite(usage.limit) || usage.limit <= 0) {
        return { error: "invalid usage response" };
      }

      return {
        monthly: {
          pct: (usage.used / usage.limit) * 100,
          resetsIn: usage.resetsIn,
        },
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  },
};

export default function register(pi: ExtensionAPI) {
  const offReady = pi.events.on("pi-usage-hub:ready", (hub: UsageHub) => {
    hub.register(provider);
  });

  // Covers the case where pi-usage-hub loaded before this extension.
  pi.events.emit("pi-usage-hub:register", provider);

  pi.on("session_shutdown", async () => {
    offReady();
    pi.events.emit("pi-usage-hub:unregister", { key: provider.key });
  });
}
