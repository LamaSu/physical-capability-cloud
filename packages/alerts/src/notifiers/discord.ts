/**
 * Discord webhook notifier.
 *
 * Uses the native fetch (Node 20+). Embed color is keyed by severity:
 *   - info     -> 0x3ba55c (green)
 *   - warning  -> 0xfaa61a (yellow)
 *   - critical -> 0xed4245 (red)
 *
 * Author: implementer-alpha
 */

import type { Notifier } from "./index.js";
import type { Alert, Severity } from "../types.js";

const COLOR: Record<Severity, number> = {
  info: 0x3ba55c,
  warning: 0xfaa61a,
  critical: 0xed4245,
};

export interface DiscordNotifierOptions {
  webhookUrl: string;
  /** Optional fetch override for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Request timeout in ms. Defaults to 5000. */
  timeoutMs?: number;
}

export function createDiscordNotifier(opts: DiscordNotifierOptions): Notifier {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;

  return {
    name: "discord",
    async fire(alert: Alert): Promise<void> {
      const embed = {
        title: alert.title.slice(0, 256),
        description: alert.body.slice(0, 4000),
        color: COLOR[alert.severity],
        timestamp: alert.ts,
        fields: [
          { name: "source", value: alert.source, inline: true },
          { name: "severity", value: alert.severity, inline: true },
          ...(alert.context
            ? [
                {
                  name: "context",
                  value: codeFence(JSON.stringify(alert.context, bigintReplacer, 2)),
                },
              ]
            : []),
        ],
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(opts.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ embeds: [embed] }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`Discord webhook ${res.status}: ${body.slice(0, 200)}`);
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function codeFence(s: string): string {
  // Discord field values are capped at 1024 chars.
  const truncated = s.length > 900 ? s.slice(0, 900) + "\n... [truncated]" : s;
  return "```json\n" + truncated + "\n```";
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
