/**
 * Tests for the Discord notifier: payload shape, color mapping, error paths.
 *
 * Author: implementer-alpha
 */

import { describe, it, expect, vi } from "vitest";
import { createDiscordNotifier } from "../notifiers/discord.js";
import type { Alert } from "../types.js";

function makeAlert(overrides?: Partial<Alert>): Alert {
  return {
    ts: "2026-04-21T12:00:00Z",
    source: "manual",
    severity: "info",
    title: "test",
    body: "body text",
    context: { foo: "bar", big: 500n },
    ...overrides,
  };
}

describe("createDiscordNotifier", () => {
  it("POSTs an embed to the webhook URL with the correct color for info", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 204 }));
    const notifier = createDiscordNotifier({
      webhookUrl: "https://discord.example/webhook",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await notifier.fire(makeAlert({ severity: "info" }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://discord.example/webhook");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0].color).toBe(0x3ba55c);
    expect(body.embeds[0].title).toBe("test");
  });

  it("uses the critical color for critical severity", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 204 }));
    const notifier = createDiscordNotifier({
      webhookUrl: "https://discord.example/webhook",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await notifier.fire(makeAlert({ severity: "critical" }));
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.embeds[0].color).toBe(0xed4245);
  });

  it("serializes bigints in context", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 204 }));
    const notifier = createDiscordNotifier({
      webhookUrl: "https://discord.example/webhook",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await notifier.fire(makeAlert());
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    const contextField = body.embeds[0].fields.find((f: { name: string }) => f.name === "context");
    expect(contextField).toBeDefined();
    expect(contextField.value).toContain('"big": "500"');
  });

  it("throws when webhook returns non-2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad", { status: 500 }));
    const notifier = createDiscordNotifier({
      webhookUrl: "https://discord.example/webhook",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(notifier.fire(makeAlert())).rejects.toThrow(/Discord webhook 500/);
  });
});
