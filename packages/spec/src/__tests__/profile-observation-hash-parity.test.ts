/**
 * Python byte parity for an event that can satisfy a measurement profile: the
 * additive `source.adapterType` / `source.adapterVersion` fields and a
 * `payload.profileObservation` record (profile-admission.ts). Evidence asked
 * for it (bus #3419): pcc-node's Python producer and the TS verifier must give
 * one event one hash, or a Python-produced observation can never bind.
 *
 * The expected hash was computed by pcc-node's canonicalizer
 * (pcc_node/log_capture.py) and is checked here against both implementations.
 * Like pcc-node-signing-preimage-parity.test.ts, this loads the Python module
 * by path (standard library only), so it runs in CI; a missing python3 fails,
 * never skips.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { canonicalize, hashEvent } from "../util/canonical.js";
import { computeBundleSetDigest, isDecimalValue } from "../evidence/profile-admission.js";
import type { EvidenceEvent } from "../types/evidence.js";

const MODULE = fileURLToPath(new URL("../../../pcc-node/pcc_node/log_capture.py", import.meta.url));

const EVENT = {
  type: "instrument_result",
  timestamp: "2026-09-28T12:00:20.000Z",
  source: {
    deviceId: "dev-scale",
    deviceType: "instrument",
    kernelId: "kernel-golden-1",
    adapterType: "scale",
    adapterVersion: "ScaleAdapter-1.0.0",
    firmwareVersion: "scale-fw-1.0",
  },
  payload: {
    jobId: "job-golden-1",
    passed: true,
    profileObservation: {
      profileDigest: "0x7efecb6c05ae4241a87dc5082f7c9d1bac9158060a78beb01dcdfb2496e9bb6a",
      primitiveId: "artifact.hash",
      object: { kind: "documentHash", value: "sha256:" + "b".repeat(64) },
      method: "load-cell",
      quantity: "mass",
      unit: "kg",
      value: "0.0000001",
      sampleId: "sha256:" + "5a".repeat(32),
    },
  },
};

/** Computed by pcc_node/log_capture.py: sha256_hex(canonicalize({type, timestamp, source, payload})). */
const EXPECTED_HASH = "sha256:7f655ef2cd3b2202791578ace37534dfde0fce991b8907d6a7337e06a5d89050";

const PROBE = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("pcc_node_log_capture", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
e = json.loads(sys.argv[2])
print(json.dumps({
    "hash": m.sha256_hex(m.canonicalize({"type": e["type"], "timestamp": e["timestamp"], "source": e["source"], "payload": e["payload"]})),
    "float": m.canonicalize({"v": 1e-7}),
}))
`;

function python(): { hash: string; float: string } {
  return JSON.parse(
    execFileSync("python3", ["-c", PROBE, MODULE, JSON.stringify(EVENT)], {
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    }),
  );
}

/**
 * The bundle-set digest (profile-admission.ts `computeBundleSetDigest`), as a
 * known-answer vector for whoever pins a set: the gateway now, a kernel seal
 * later, and the oracle when it checks one. Computed by pcc-node's Python
 * canonicalizer over the explicit preimage, so dropping or renaming the domain
 * separator, or any preimage field, fails here.
 */
const SET_H1 = "sha256:" + "1".repeat(64);
const SET_H2 = "sha256:" + "2".repeat(64);
const SET_SUBJECT = { jobId: "job-golden-1", kernelId: "kernel-golden-1" };
const SET_UNIT = "0x" + "ab".repeat(32);
const EXPECTED_SET_DIGEST = "sha256:0a4e0b2921450b40dcef729559eb0b6ba4eaab9aff844c4a9bc061b90e6285fb";
const EXPECTED_UNIT_SET_DIGEST = "sha256:965f2f0c50750b5171f2f8dc845c44eb0753bba4f2a5903d6f1d8c7c1b037dc8";

const SET_PROBE = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("pcc_node_log_capture", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
a = json.loads(sys.argv[2])
base = {"domain": "PCC:evidence-bundle-set:v1", "jobId": a["jobId"], "kernelId": a["kernelId"], "bundleHashes": sorted(set(a["hashes"]))}
print(json.dumps({"set": m.sha256_hex(m.canonicalize(base)), "unit": m.sha256_hex(m.canonicalize(dict(base, settlementUnitId=a["unit"])))}))
`;

describe("bundle-set digest: known-answer vector, Python and TS agree (F2)", () => {
  it("TS reproduces the golden, order- and duplicate-insensitive", async () => {
    expect(await computeBundleSetDigest(SET_SUBJECT, [SET_H2, SET_H1, SET_H2])).toBe(EXPECTED_SET_DIGEST);
    expect(await computeBundleSetDigest({ ...SET_SUBJECT, settlementUnitId: SET_UNIT }, [SET_H1, SET_H2])).toBe(
      EXPECTED_UNIT_SET_DIGEST,
    );
  });

  it("pcc-node's Python canonicalizer reproduces both goldens from the explicit, domain-separated preimage", () => {
    const out = JSON.parse(
      execFileSync(
        "python3",
        ["-c", SET_PROBE, MODULE, JSON.stringify({ ...SET_SUBJECT, hashes: [SET_H2, SET_H1], unit: SET_UNIT })],
        { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
      ),
    );
    expect(out).toEqual({ set: EXPECTED_SET_DIGEST, unit: EXPECTED_UNIT_SET_DIGEST });
  });
});

describe("profile observation event hash: Python and TS agree (evidence #3419)", () => {
  it("the TS verifier reproduces the Python-computed golden", async () => {
    expect(await hashEvent(EVENT as unknown as Omit<EvidenceEvent, "hash" | "id">)).toBe(EXPECTED_HASH);
  });

  it("pcc-node's Python canonicalizer reproduces the same golden", () => {
    expect(python().hash).toBe(EXPECTED_HASH);
  });

  it("the value is a decimal string because a JSON float would split the hash between producers", () => {
    expect(isDecimalValue(EVENT.payload.profileObservation.value)).toBe(true);
    // The same reading as a float canonicalizes differently in the two languages.
    expect(canonicalize({ v: 1e-7 })).toBe('{"v":1e-7}');
    expect(python().float).toBe('{"v":1e-07}');
  });
});
