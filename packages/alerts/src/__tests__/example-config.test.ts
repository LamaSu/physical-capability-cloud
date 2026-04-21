/**
 * Regression test: the shipped PCC example config must always parse cleanly
 * through the Zod schema. If someone edits `config/alerts.pcc.example.json`
 * and breaks it, this fails in CI before a deploy.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { alertsConfigSchema } from "../config.js";

const here = dirname(fileURLToPath(import.meta.url));
const examplePath = resolve(here, "../../config/alerts.pcc.example.json");

describe("alerts.pcc.example.json (shipped PCC config)", () => {
  const raw = readFileSync(examplePath, "utf-8");
  const parsed = JSON.parse(raw);

  it("parses through the Zod schema", () => {
    expect(() => alertsConfigSchema.parse(parsed)).not.toThrow();
  });

  const cfg = alertsConfigSchema.parse(parsed);

  it("watches the PCCProtocol root on Base Sepolia", () => {
    const protocol = cfg.chainWatchers.find(
      (w) => w.address.toLowerCase() === "0x80ad204d2c4b659cbdaab11684ae1a9f0dc14b23",
    );
    expect(protocol).toBeDefined();
    expect(protocol!.chain).toBe("base-sepolia");
    expect(protocol!.events.map((e) => e.name)).toEqual(
      expect.arrayContaining([
        "EscrowCreated",
        "FeeCollected",
        "GovernorTransferred",
      ]),
    );
    // GovernorTransferred is governance takeover — must be critical
    const gov = protocol!.events.find((e) => e.name === "GovernorTransferred");
    expect(gov?.onFire).toBe("critical");
  });

  it("watches the MilestoneEscrow lifecycle on Base Sepolia", () => {
    const escrow = cfg.chainWatchers.find((w) => w.label.startsWith("escrow-"));
    expect(escrow).toBeDefined();
    expect(escrow!.events.map((e) => e.name)).toEqual(
      expect.arrayContaining([
        "EscrowFunded",
        "MilestoneReleased",
        "DisputeFiled",
        "BondSlashed",
      ]),
    );
    const slash = escrow!.events.find((e) => e.name === "BondSlashed");
    expect(slash?.onFire).toBe("critical");
  });

  it("probes all three deployed chains", () => {
    const labels = cfg.rpcProbes.map((p) => p.label).sort();
    expect(labels).toEqual(["base-sepolia", "flow-evm-testnet", "sepolia-l1"]);
  });

  it("tracks heartbeats for gateway, oracle, verifier workers", () => {
    const workers = cfg.heartbeats.map((h) => h.worker).sort();
    expect(workers).toEqual(["oracle-worker", "pcc-gateway", "verifier-worker"]);
  });

  it("ships without a Discord webhook set — operator fills in at deploy", () => {
    expect(cfg.notifiers.discord).toBeUndefined();
  });
});
