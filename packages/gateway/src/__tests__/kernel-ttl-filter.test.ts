/**
 * Unit tests for the TTL filter + sweeper (feat/ed25519-keys-and-kernel-ttl).
 *
 * Pure logic — no DB, no Fastify. The DB-backed integration tests live in
 * kernel-ttl-integration.test.ts.
 */

import { describe, it, expect } from "vitest";
import { filterCapabilitiesByTtl } from "../facades/capability.facade.js";
import {
  resolveKernelTtlHours,
  computeValidUntilIso,
} from "../facades/kernel.facade.js";

describe("filterCapabilitiesByTtl", () => {
  const now = new Date("2026-06-18T12:00:00.000Z");

  it("keeps rows with valid_until in the future", () => {
    const future = new Date(now.getTime() + 3600_000).toISOString();
    const rows = [{ id: "a", validUntil: future }];
    expect(filterCapabilitiesByTtl(rows, now)).toEqual(rows);
  });

  it("drops rows with valid_until in the past", () => {
    const past = new Date(now.getTime() - 3600_000).toISOString();
    const rows = [
      { id: "a", validUntil: past },
      { id: "b", validUntil: new Date(now.getTime() + 3600_000).toISOString() },
    ];
    const filtered = filterCapabilitiesByTtl(rows, now);
    expect(filtered.map((r) => r.id)).toEqual(["b"]);
  });

  it("keeps rows with NULL valid_until (legacy pre-migration rows)", () => {
    const rows = [
      { id: "a", validUntil: null },
      { id: "b" as const },
    ];
    // Both stay — the filter never silently drops "no opinion" rows.
    expect(filterCapabilitiesByTtl(rows as any, now).length).toBe(2);
  });

  it("keeps rows with unparseable valid_until (corrupted column)", () => {
    const rows = [{ id: "a", validUntil: "not a date" }];
    expect(filterCapabilitiesByTtl(rows, now).length).toBe(1);
  });

  it("accepts both validUntil (camel) and valid_until (snake) shapes", () => {
    const past = new Date(now.getTime() - 3600_000).toISOString();
    const rows = [
      { id: "a", valid_until: past },
      { id: "b", validUntil: past },
    ];
    expect(filterCapabilitiesByTtl(rows as any, now).length).toBe(0);
  });

  it("treats valid_until === now as expired (strict >)", () => {
    const exact = now.toISOString();
    const rows = [{ id: "a", validUntil: exact }];
    // The filter checks `parsed > nowMs` — equality is "just expired".
    expect(filterCapabilitiesByTtl(rows, now)).toEqual([]);
  });
});

describe("resolveKernelTtlHours", () => {
  it("defaults to 24 when env unset", () => {
    delete process.env.KERNEL_TTL_HOURS;
    expect(resolveKernelTtlHours()).toBe(24);
  });

  it("respects in-band env values", () => {
    process.env.KERNEL_TTL_HOURS = "48";
    expect(resolveKernelTtlHours()).toBe(48);
    delete process.env.KERNEL_TTL_HOURS;
  });

  it("falls back to default on out-of-band values", () => {
    process.env.KERNEL_TTL_HOURS = "0";
    expect(resolveKernelTtlHours()).toBe(24);
    process.env.KERNEL_TTL_HOURS = "999";
    expect(resolveKernelTtlHours()).toBe(24);
    process.env.KERNEL_TTL_HOURS = "garbage";
    expect(resolveKernelTtlHours()).toBe(24);
    delete process.env.KERNEL_TTL_HOURS;
  });

  it("computeValidUntilIso is now + TTL hours", () => {
    delete process.env.KERNEL_TTL_HOURS;
    const now = new Date("2026-06-18T12:00:00.000Z");
    const out = computeValidUntilIso(now);
    expect(out).toBe("2026-06-19T12:00:00.000Z"); // exactly +24h
  });
});
