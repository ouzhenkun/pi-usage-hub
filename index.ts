import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { UsageHub, UsageProvider } from "./types";
import { loadConfig } from "./core/config";
import { ProviderRegistry } from "./core/registry";
import { UsageCache } from "./core/cache";
import { fullReport } from "./ui/format-report";
import { UsageWindow } from "./ui/usage-window";
import { isCloseKey } from "./ui/format";

export default function register(pi: ExtensionAPI) {
  const registry = new ProviderRegistry();
  const cache = new UsageCache();

  // Cache updates → event bus (no public subscribe)
  cache.subscribe((e) => {
    pi.events.emit("pi-usage-hub:updated", e);
  });

  const cfg = loadConfig();
  registry.loadFromConfig(cfg.providers ?? []);

  const hub: UsageHub = {
    register(p) {
      registry.register(p);
    },
    unregister(key) {
      registry.unregister(key);
      cache.invalidate(key);
    },
    list() {
      return registry.list();
    },
    getSummary(model) {
      const provider = registry.matchModel(model);
      if (!provider) return null;
      return cache.getSummary(provider.key);
    },
    getReport(key) {
      return cache.getReport(key);
    },
    async refresh(opts) {
      const provider = registry.matchModel(opts?.model);
      if (!provider) return null;
      const entry = await cache.refreshProvider(provider, opts?.force ?? false);
      return entry.summary;
    },
    invalidate(key) {
      cache.invalidate(key);
    },
  };

  const offRegister = pi.events.on("pi-usage-hub:register", (data: unknown) => {
    const p = data as UsageProvider;
    if (p && typeof p === "object" && typeof p.key === "string") {
      hub.register(p);
    }
  });
  const offUnregister = pi.events.on("pi-usage-hub:unregister", (data: unknown) => {
    const d = data as { key?: string };
    if (d?.key) hub.unregister(d.key);
  });

  // Emit now and again on session_start so late listeners (footer-hub) still get the hub.
  pi.events.emit("pi-usage-hub:ready", hub);
  pi.on("session_start", async () => {
    pi.events.emit("pi-usage-hub:ready", hub);
  });

  pi.on("session_shutdown", async () => {
    offRegister();
    offUnregister();
  });

  pi.registerCommand("usage-hub", {
    description: "Show usage/quota. /usage-hub session · /usage-hub login <provider>",
    handler: async (_args, ctx) => {
      const args = _args.trim();

      if (args.startsWith("login")) {
        const target = args.slice(5).trim().toLowerCase();
        const all = registry.list();
        const loginable = all.filter(p => p.login);

        if (!target) {
          ctx.ui.notify(
            `Usage: /usage-hub login <provider>. Try: ${loginable.map(p => p.key).join(", ") || "(none)"}`,
            "warning",
          );
          return;
        }

        const targets = all.filter(
          p => p.login && (p.key === target || p.matchProviders?.includes(target)),
        );

        if (targets.length === 0) {
          ctx.ui.notify(
            `Unknown provider "${target}". Try: ${loginable.map(p => p.key).join(", ") || "(none)"}`,
            "warning",
          );
          return;
        }

        for (const p of targets) {
          ctx.ui.notify(`Opening browser for ${p.label}…`, "info");
          const ok = await p.login!();
          if (ok) {
            cache.invalidate(p.key);
            ctx.ui.notify(`${p.label} login succeeded`, "info");
          } else {
            ctx.ui.notify(`${p.label} login timeout`, "warning");
          }
        }

        await Promise.all(
          registry.detectActive().map(p => cache.refreshProvider(p, true)),
        );
        return;
      }

      if (ctx.mode !== "tui") {
        ctx.ui.notify("Fetching usage data…", "info");
        const detected = registry.detectActive();
        if (detected.length === 0) {
          ctx.ui.notify("No supported usage provider detected", "info");
          return;
        }
        const reports = await Promise.all(
          detected.map(async provider => {
            const entry = await cache.refreshProvider(provider, true);
            return { provider, report: entry.report };
          }),
        );
        const lines = reports.map(r => fullReport(r.report, r.provider));
        ctx.ui.notify(lines.join("\n\n"), "info");
        return;
      }

      const initialMode = args === "session" ? "session" : "quota";

      let handle: { focus: () => void; isFocused: () => boolean } | undefined;
      const panelRef = { current: undefined as UsageWindow | undefined };
      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        const unsubscribeInput = ctx.ui.onTerminalInput((data) => {
          if (!isCloseKey(data) || handle?.isFocused()) return;
          handle?.focus();
          return { data };
        });
        let quotaStarted = false;
        let panel: UsageWindow;

        const loadQuota = () => {
          if (quotaStarted) return;
          quotaStarted = true;

          const detected = registry.detectActive();
          if (detected.length === 0) {
            panel.finishLoading();
            tui.requestRender();
            return;
          }
          panel.setPendingProviders(detected);
          tui.requestRender();

          void Promise.all(detected.map(async provider => {
            const entry = await cache.refreshProvider(provider, true);
            panel.addReport(provider, entry.report);
            tui.requestRender();
          })).then(() => {
            panel.finishLoading();
            tui.requestRender();
          });
        };

        panel = new UsageWindow(
          theme,
          done,
          () => tui.requestRender(),
          unsubscribeInput,
          initialMode,
          loadQuota,
        );
        panelRef.current = panel;
        if (initialMode === "quota") loadQuota();
        return panel;
      }, {
        overlay: true,
        overlayOptions: {
          width: "80%",
          minWidth: 74,
          maxHeight: "80%",
          anchor: "center",
          // Pass terminal height each frame so the quota view can scroll correctly.
          visible: (_tw, termHeight) => {
            panelRef.current?.setViewHeight(termHeight);
            return true;
          },
        },
        onHandle: overlayHandle => {
          handle = overlayHandle;
        },
      });
    },
  });
}
