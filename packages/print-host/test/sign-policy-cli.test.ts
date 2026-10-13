import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAddress, recoverAddress, type Hex } from "viem";
import {
  acceptanceDigest, buildUnitConfig, domainSeparator, jobPolicyHash, prePolicyRoot,
  settlementUnitId, unitsRoot, type JobPolicyFields,
} from "@pcc/contracts/vnext";
import { main } from "../src/cli.js";
import { generateHostKeys } from "../src/keygen.js";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

const address = (byte: string) => getAddress(`0x${byte.repeat(20)}`);
const word = (label: string): Hex => `0x${createHash("sha256").update(label).digest("hex")}`;
const json = (value: unknown): string => JSON.stringify(value, (_key, field: unknown) =>
  typeof field === "bigint" ? field.toString() : field);
type EditableInput = Record<string, unknown> & {
  policy: Record<string, unknown>;
  units: Array<Record<string, unknown> & { payouts: Array<Record<string, unknown>> }>;
};

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: { write: (value: string) => { stdout += value; } },
      stderr: { write: (value: string) => { stderr += value; } },
    },
    output: () => ({ stdout, stderr }),
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ph-policy-cli-"));
  directories.push(root);
  await chmod(root, 0o700);
  const generated = await generateHostKeys(join(root, "keys"));
  const configFile = join(root, "host.json");
  const termsFile = join(root, "terms.json");
  const inputFile = join(root, "policy.json");
  const outputFile = join(root, "signature.json");
  await writeFile(configFile, json({
    kernelId: "policy-cli", deviceId: "policy-printer",
    printer: { uri: "ipp://localhost:631/printers/test" },
    chain: { chainId: 84532, rpcUrlFile: join(root, "rpc-url") },
    gateway: { baseUrl: "https://gateway.example.test", apiKeyFile: join(root, "api-key") },
    keys: { deviceKeyFile: generated.paths.deviceKeyFile, operatorKeyFile: generated.paths.operatorKeyFile },
    dataDir: join(root, "data"),
  }), { mode: 0o600 });
  const now = BigInt(Math.floor(Date.now() / 1000));
  const unit = buildUnitConfig({
    milestoneIndex: 0n, stepId: word("cli-step"), requiredTier: 1,
    g: 1000n, feeBps: 100, feeRecipient: address("cc"), reclaimAt: now + 3600n,
    compositionSchemaVersion: 1, compositionRoot: word("cli-composition"),
    payouts: [{ recipient: address("dd"), amount: 990n }],
  });
  const policy: JobPolicyFields = {
    chainId: 84532n, factory: address("aa"), implementation: address("bb"),
    escrow: address("ee"), payer: address("dd"), operator: generated.identity.operatorAddress as `0x${string}`,
    jobIdHash: word("cli-job"), termsHash: word("cli-terms"), policyNonce: 0n,
    prePolicyRoot: prePolicyRoot([unit]), unitsRoot: unitsRoot([settlementUnitId({
      chainId: 84532n, escrow: address("ee"), jobIdHash: word("cli-job"),
      milestoneIndex: unit.milestoneIndex, stepId: unit.stepId,
    })]), expiry: now + 300n, acceptedPolicyDigest: word("cli-accepted"),
  };
  const input = { policy, units: [unit] };
  const terms = {
    minG: 100n, allowedRequiredTiers: [1], reclaimMinSeconds: 600,
    reclaimMaxSeconds: 7200, maxFeeBps: 100, allowedFeeRecipients: [address("cc")],
    allowedPayoutRecipients: [address("dd")],
    maxUnits: 2, maxAcceptanceSeconds: 600,
  };
  await writeFile(termsFile, json(terms), { mode: 0o600 });
  await writeFile(inputFile, json(input), { mode: 0o600 });
  const argv = ["sign-policy", "--config", configFile, "--terms", termsFile,
    "--input", inputFile, "--out", outputFile];
  return { root, generated, configFile, termsFile, inputFile, outputFile, argv, input, terms };
}

describe("print-host sign-policy CLI", () => {
  it("writes only the five public acceptance fields at mode 0644 with compiler digest parity", async () => {
    const current = await fixture();
    const captured = capture();
    expect(await main(current.argv, captured.io)).toBe(0);
    expect(captured.output()).toEqual({ stdout: "", stderr: "" });
    const output = JSON.parse(await readFile(current.outputFile, "utf8")) as {
      operator: `0x${string}`; chainId: number; escrow: `0x${string}`; acceptanceDigest: Hex; signature: Hex;
    };
    expect(Object.keys(output).sort()).toEqual(["acceptanceDigest", "chainId", "escrow", "operator", "signature"]);
    expect(output.operator).toBe(current.generated.identity.operatorAddress);
    expect(output.chainId).toBe(84532);
    expect(output.escrow).toBe(current.input.policy.escrow);
    expect(output.acceptanceDigest).toBe(acceptanceDigest(
      domainSeparator(current.input.policy.chainId, current.input.policy.escrow), jobPolicyHash(current.input.policy),
    ));
    expect(await recoverAddress({ hash: output.acceptanceDigest, signature: output.signature })).toBe(output.operator);
    expect((await stat(current.outputFile)).mode & 0o777).toBe(0o644);
    const secret = JSON.parse(await readFile(current.generated.paths.operatorKeyFile, "utf8")).privateKey.slice(2) as string;
    const rendered = json(output) + captured.output().stdout + captured.output().stderr;
    expect(Array.from({ length: secret.length - 11 }, (_, index) => secret.slice(index, index + 12))
      .some((fragment) => rendered.includes(fragment)), "acceptance artifact and CLI output contain no private key fragments").toBe(false);
  });

  it("refuses to overwrite an existing output and leaves its bytes and permissions untouched", async () => {
    const current = await fixture();
    const existing = randomBytes(24).toString("base64");
    await writeFile(current.outputFile, existing, { mode: 0o600 });
    const captured = capture();
    expect(await main(current.argv, captured.io)).toBe(1);
    expect(captured.output()).toEqual({ stdout: "", stderr: "output_exists\n" });
    expect(await readFile(current.outputFile, "utf8")).toBe(existing);
    expect((await stat(current.outputFile)).mode & 0o777).toBe(0o600);
  });

  it("prints only the closed code on an operator check failure", async () => {
    const current = await fixture();
    current.input.policy.operator = address("ff");
    await writeFile(current.inputFile, json(current.input));
    const captured = capture();
    expect(await main(current.argv, captured.io)).toBe(1);
    expect(captured.output()).toEqual({ stdout: "", stderr: "operator_mismatch\n" });
    await expect(stat(current.outputFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  const malformedInputCases: Array<[string, (value: EditableInput) => void]> = [
    ["an extra top-level field", (value) => { value.personal = randomBytes(24).toString("base64"); }],
    ["an extra policy field", (value) => { value.policy.personal = "private-policy-value"; }],
    ["an extra unit field", (value) => { value.units[0].personal = "private-unit-value"; }],
    ["an extra payout field", (value) => { value.units[0].payouts[0].personal = "private-payout-value"; }],
    ["a caller supplied clock", (value) => { value.now = "2099-01-01T00:00:00Z"; }],
    ["a numeric bigint field", (value) => { value.policy.chainId = 84532; }],
    ["an exponent bigint string", (value) => { value.units[0].g = "1e3"; }],
    ["a noncanonical decimal string", (value) => { value.units[0].g = "01000"; }],
    ["a negative decimal string", (value) => { value.units[0].g = "-1000"; }],
    ["a fractional number field", (value) => { value.units[0].requiredTier = 1.5; }],
    ["a missing policy field", (value) => { delete value.policy.escrow; }],
  ];
  it.each(malformedInputCases)("strictly refuses %s without printing values", async (_name, mutate) => {
    const current = await fixture();
    const value = JSON.parse(json(current.input));
    mutate(value);
    await writeFile(current.inputFile, JSON.stringify(value));
    const captured = capture();
    expect(await main(current.argv, captured.io)).toBe(1);
    expect(captured.output()).toEqual({ stdout: "", stderr: "bad_input\n" });
  });

  it("preserves a decimal policy nonce larger than Number.MAX_SAFE_INTEGER", async () => {
    const current = await fixture();
    current.input.policy.policyNonce = BigInt(Number.MAX_SAFE_INTEGER) + 17n;
    await writeFile(current.inputFile, json(current.input));
    const captured = capture();
    expect(await main(current.argv, captured.io)).toBe(0);
    const output = JSON.parse(await readFile(current.outputFile, "utf8"));
    expect(output.acceptanceDigest).toBe(acceptanceDigest(
      domainSeparator(current.input.policy.chainId, current.input.policy.escrow), jobPolicyHash(current.input.policy),
    ));
  });

  const malformedTermsCases: Array<[string, (value: Record<string, unknown>) => void]> = [
    ["an extra terms field", (value) => { value.personal = "private-terms-value"; }],
    ["numeric minG", (value) => { value.minG = 100; }],
    ["a fractional time limit", (value) => { value.maxAcceptanceSeconds = 1.5; }],
    ["missing allowedPayoutRecipients", (value) => { delete value.allowedPayoutRecipients; }],
    ["empty allowedPayoutRecipients", (value) => { value.allowedPayoutRecipients = []; }],
    ["duplicate payout recipients differing only in case", (value) => {
      value.allowedPayoutRecipients = [address("dd"), address("dd").toLowerCase()];
    }],
  ];
  it.each(malformedTermsCases)("strictly refuses %s", async (_name, mutate) => {
    const current = await fixture();
    const value = JSON.parse(json(current.terms));
    mutate(value);
    await writeFile(current.termsFile, JSON.stringify(value));
    const captured = capture();
    expect(await main(current.argv, captured.io)).toBe(1);
    expect(captured.output()).toEqual({ stdout: "", stderr: "bad_terms\n" });
  });

  it("discards JSON parser details and input paths", async () => {
    const current = await fixture();
    await writeFile(current.inputFile, "private-policy-value{");
    const captured = capture();
    expect(await main(current.argv, captured.io)).toBe(1);
    expect(captured.output()).toEqual({ stdout: "", stderr: "bad_json\n" });
  });

  it("discards configuration error paths", async () => {
    const current = await fixture();
    current.argv[2] = join(current.root, "missing-private-config.json");
    const captured = capture();
    expect(await main(current.argv, captured.io)).toBe(1);
    expect(captured.output()).toEqual({ stdout: "", stderr: "not_found\n" });
  });

  it.each([
    ["sign-policy"], ["sign-policy", "--config"],
    ["sign-policy", "--unknown", "private-value"],
    ["sign-policy", "--config", "private-value", "--config", "private-value"],
  ])("reports bad arguments with only a code (%#)", async (...argv: string[]) => {
    const captured = capture();
    expect(await main(argv, captured.io)).toBe(2);
    expect(captured.output()).toEqual({ stdout: "", stderr: "bad_arguments\n" });
  });
});
