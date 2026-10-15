import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress, recoverAddress, type Hex } from "viem";
import {
  acceptanceDigest, buildUnitConfig, domainSeparator, jobPolicyHash, policySalt, predictEscrow, prePolicyRoot,
  settlementUnitId, unitsRoot, type JobPolicyFields,
} from "@pcc/contracts/vnext";
import {
  computeAcceptedPolicyDigest, computeBindingsRoot, computePlanUnitKey, computeSubjectBlockHash,
  formatOperatorPrincipalId, principalTupleWord,
  type SubjectBinding, type SubjectBlockFields,
} from "@pcc/spec";
import { main } from "../src/cli.js";
import { generateHostKeys } from "../src/keygen.js";
import { loadHostTerms, loadJobPolicyInput, PolicyJsonError } from "../src/policy-json.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open) };
});

const directories: string[] = [];
beforeEach(async () => {
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

const address = (byte: string) => getAddress(`0x${byte.repeat(20)}`);
const word = (label: string): Hex => `0x${createHash("sha256").update(label).digest("hex")}`;
const thursdayTermsHash: Hex = "0xf037904088f851954883103836132ab016be7a8b0ff4867a4b7b6463a5e4f6b7";
const s2ProgramHash: Hex = "0x56c1897725442876a5b7adfde81b81c83b9ef09aade75aa3a81a911856330e4a";
const zeroWord = (): Hex => `0x${"00".repeat(32)}`;
const oneByteOff = (value: Hex): Hex => `${value.slice(0, -2)}${value.endsWith("00") ? "01" : "00"}` as Hex;
const json = (value: unknown): string => JSON.stringify(value, (_key, field: unknown) =>
  typeof field === "bigint" ? field.toString() : field);
type EditableInput = Record<string, unknown> & {
  policy: Record<string, unknown>;
  units: Array<Record<string, unknown> & { payouts: Array<Record<string, unknown>> }>;
  subjectBlock: Record<string, unknown>;
  bindings: Array<Record<string, unknown>>;
};
const malformedTermsChainCases: Array<[string, (value: Record<string, unknown>) => void]> = [
  ["missing chainId", (value) => { delete value.chainId; }],
  ["string chainId", (value) => { value.chainId = "84532"; }],
  ["chainId 1", (value) => { value.chainId = 1; }],
  ["chainId 84533", (value) => { value.chainId = 84533; }],
];

function bindEscrow(input: { policy: JobPolicyFields; units: ReturnType<typeof buildUnitConfig>[] }) {
  input.policy.prePolicyRoot = prePolicyRoot(input.units);
  input.policy.escrow = predictEscrow({
    factory: input.policy.factory, implementation: input.policy.implementation, salt: policySalt(input.policy),
  });
  input.policy.unitsRoot = unitsRoot(input.units.map((unit) => settlementUnitId({
    chainId: input.policy.chainId, escrow: input.policy.escrow, jobIdHash: input.policy.jobIdHash,
    milestoneIndex: unit.milestoneIndex, stepId: unit.stepId,
  })));
}

function bindAccepted(input: { policy: JobPolicyFields; subjectBlock: SubjectBlockFields; bindings: SubjectBinding[] }) {
  const subjectBlockHash = computeSubjectBlockHash(input.subjectBlock);
  const bindingsRoot = computeBindingsRoot(input.bindings);
  input.policy.acceptedPolicyDigest = computeAcceptedPolicyDigest({
    termsHash: input.policy.termsHash, subjectBlockHash, bindingsRoot,
  });
  return { subjectBlockHash, bindingsRoot, acceptedPolicyDigest: input.policy.acceptedPolicyDigest };
}

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
    g: 1000n, feeBps: 100, feeRecipient: address("cc"), reclaimAt: now + 1814400n,
    compositionSchemaVersion: 0, compositionRoot: zeroWord(),
    payouts: [{ recipient: address("dd"), amount: 990n }],
  });
  const policy: JobPolicyFields = {
    chainId: 84532n, factory: address("aa"), implementation: address("bb"),
    escrow: address("ee"), payer: address("dd"), operator: generated.identity.operatorAddress as `0x${string}`,
    jobIdHash: word("cli-job"), termsHash: thursdayTermsHash, policyNonce: 0n,
    prePolicyRoot: prePolicyRoot([unit]), unitsRoot: unitsRoot([settlementUnitId({
      chainId: 84532n, escrow: address("ee"), jobIdHash: word("cli-job"),
      milestoneIndex: unit.milestoneIndex, stepId: unit.stepId,
    })]), expiry: now + 300n, acceptedPolicyDigest: word("cli-accepted"),
  };
  // Synthetic fields exercise the producer; this is not an oracle golden vector.
  const subjectBlock: SubjectBlockFields = {
    payer: principalTupleWord("operator", formatOperatorPrincipalId(84532, policy.payer)),
    operatorPrincipal: principalTupleWord("operator", formatOperatorPrincipalId(84532, policy.operator)),
    operatorSettlementAddress: address("dd").toLowerCase() as `0x${string}`,
    authorizedTuplesRoot: word("cli-tuples"), expertSetRoot: word("cli-experts"),
    executorSetRoot: word("cli-executors"), expectedRecipient: word("cli-recipient"),
    targetSystemIdentity: word("cli-system"), committedProgramHash: s2ProgramHash,
    recipeRef: word("cli-recipe"), sampleManifestRef: word("cli-samples"),
    childrenRoot: word("cli-children"), operatingEnvelopeHash: word("cli-envelope"),
    expectedRouteArea: word("cli-route"), expectedLocationHash: word("cli-location"),
    captureNonceAnchor: word("cli-capture"), challengeAnchor: word("cli-challenge"), integrityGrade: 1,
  };
  const bindings: SubjectBinding[] = [{
    planUnitKey: computePlanUnitKey(0, unit.milestoneIndex, unit.stepId),
    requirementIdHash: word("cli-requirement"), sourceKind: 1, propositionKind: 1, valueRef: word("cli-value"),
  }];
  const input = { policy, units: [unit], subjectBlock, bindings };
  const commitments = bindAccepted(input);
  bindEscrow(input);
  const terms = {
    chainId: 84532,
    minG: 100n, allowedRequiredTiers: [1], reclaimMinSeconds: 864000,
    reclaimMaxSeconds: 31536000, maxFeeBps: 100, allowedFeeRecipients: [address("cc")],
    allowedPayoutRecipients: [address("dd")],
    maxUnits: 2, maxAcceptanceSeconds: 600,
    factory: policy.factory, implementation: policy.implementation,
    operatorPayoutRecipient: address("dd"), maxPassThrough: 0n,
    termsHash: thursdayTermsHash, subjectPins: { committedProgramHash: s2ProgramHash },
  };
  await writeFile(termsFile, json(terms), { mode: 0o600 });
  await writeFile(inputFile, json(input), { mode: 0o600 });
  const argv = ["sign-policy", "--config", configFile, "--terms", termsFile,
    "--input", inputFile, "--out", outputFile];
  return { root, generated, configFile, termsFile, inputFile, outputFile, argv, input, terms, commitments };
}

describe("print-host sign-policy CLI", () => {
  it("writes the public acceptance fields and three producer commitments at mode 0644 with compiler digest parity", async () => {
    const current = await fixture();
    // Vitest workers cannot change process.umask. Force the restrictive creation
    // mode that a 077 umask produces, so chmod(0644) is essential to this test.
    const actualOpen = (await vi.importActual<typeof fs>("node:fs/promises")).open;
    let creationMode: number | undefined;
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      const handle = await actualOpen(path, flags, path === current.outputFile ? 0o600 : mode);
      if (path === current.outputFile) creationMode = (await handle.stat()).mode & 0o777;
      return handle;
    });
    const captured = capture();
    expect(await main(current.argv, captured.io)).toBe(0);
    expect(captured.output()).toEqual({ stdout: "", stderr: "" });
    const output = JSON.parse(await readFile(current.outputFile, "utf8")) as {
      operator: `0x${string}`; chainId: number; escrow: `0x${string}`; acceptanceDigest: Hex; signature: Hex;
      subjectBlockHash: Hex; bindingsRoot: Hex; acceptedPolicyDigest: Hex;
      subjectBlock: SubjectBlockFields; bindings: SubjectBinding[];
    };
    expect(Object.keys(output).sort()).toEqual([
      "acceptanceDigest", "acceptedPolicyDigest", "bindings", "bindingsRoot", "chainId", "escrow", "operator", "signature", "subjectBlock", "subjectBlockHash",
    ]);
    expect(output.operator).toBe(current.generated.identity.operatorAddress);
    expect(output.chainId).toBe(84532);
    expect(output.escrow).toBe(current.input.policy.escrow);
    expect(output.subjectBlockHash).toBe(current.commitments.subjectBlockHash);
    expect(output.bindingsRoot).toBe(current.commitments.bindingsRoot);
    expect(output.acceptedPolicyDigest).toBe(current.commitments.acceptedPolicyDigest);
    expect(output.subjectBlock).toEqual(current.input.subjectBlock);
    expect(output.bindings).toEqual(current.input.bindings);
    expect(computeSubjectBlockHash(output.subjectBlock)).toBe(output.subjectBlockHash);
    expect(computeBindingsRoot(output.bindings)).toBe(output.bindingsRoot);
    expect(output.acceptanceDigest).toBe(acceptanceDigest(
      domainSeparator(current.input.policy.chainId, current.input.policy.escrow), jobPolicyHash(current.input.policy),
    ));
    expect(await recoverAddress({ hash: output.acceptanceDigest, signature: output.signature })).toBe(output.operator);
    expect((await stat(current.outputFile)).mode & 0o777).toBe(0o644);
    expect(creationMode).toBe(0o600);
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

  const commitmentRefusalCases: Array<[
    string, (current: Awaited<ReturnType<typeof fixture>>) => void,
  ]> = [
    ["terms_hash_mismatch", (current) => {
      current.input.policy.termsHash = oneByteOff(current.input.policy.termsHash);
      bindAccepted(current.input);
      bindEscrow(current.input);
    }],
    ["subject_pin_mismatch", (current) => {
      current.input.subjectBlock.committedProgramHash = oneByteOff(s2ProgramHash);
      bindAccepted(current.input);
      bindEscrow(current.input);
    }],
    ["settlement_address_mismatch", (current) => {
      current.input.subjectBlock.operatorSettlementAddress = address("de").toLowerCase() as `0x${string}`;
      bindAccepted(current.input);
      bindEscrow(current.input);
    }],
    ["bindings_root_mismatch", (current) => {
      Object.assign(current.terms, { bindingsRoot: oneByteOff(current.commitments.bindingsRoot) });
    }],
    ["accepted_policy_mismatch", (current) => {
      current.input.policy.acceptedPolicyDigest = oneByteOff(current.input.policy.acceptedPolicyDigest);
      bindEscrow(current.input);
    }],
    ["composition_not_supported", (current) => {
      current.input.units[0] = buildUnitConfig({
        ...current.input.units[0], compositionSchemaVersion: 1, compositionRoot: word("cli-composition"),
      });
      bindEscrow(current.input);
    }],
  ];
  it.each(commitmentRefusalCases)("prints only %s and creates no signature artifact", async (code, mutate) => {
    const current = await fixture();
    mutate(current);
    await writeFile(current.inputFile, json(current.input));
    await writeFile(current.termsFile, json(current.terms));
    const captured = capture();
    expect(await main(current.argv, captured.io)).toBe(1);
    expect(captured.output()).toEqual({ stdout: "", stderr: `${code}\n` });
    await expect(stat(current.outputFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("signs with an exact bindings root pin and a checksum settlement address pin", async () => {
    const current = await fixture();
    Object.assign(current.terms, { bindingsRoot: current.commitments.bindingsRoot });
    Object.assign(current.terms.subjectPins, { operatorSettlementAddress: address("dd") });
    await writeFile(current.termsFile, json(current.terms));
    const captured = capture();
    expect(await main(current.argv, captured.io)).toBe(0);
    expect(captured.output()).toEqual({ stdout: "", stderr: "" });
  });

  it.each([[84532, 31337], [31337, 84532]] as const)(
    "refuses terms chain %s for config chain %s without creating output", async (termsChainId, configChainId) => {
      const current = await fixture();
      current.terms.chainId = termsChainId;
      await writeFile(current.termsFile, json(current.terms));
      const config = JSON.parse(await readFile(current.configFile, "utf8"));
      config.chain.chainId = configChainId;
      await writeFile(current.configFile, json(config));
      const captured = capture();
      expect(await main(current.argv, captured.io)).toBe(1);
      expect(captured.output()).toEqual({ stdout: "", stderr: "bad_terms\n" });
      await expect(stat(current.outputFile)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

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
    ["an extra subject field", (value) => { value.subjectBlock.personal = "private-subject-value"; }],
    ["a missing subject field", (value) => { delete value.subjectBlock.challengeAnchor; }],
    ["a duplicate requirement hash", (value) => { value.bindings.push({ ...value.bindings[0] }); }],
    ["an extra binding field", (value) => { value.bindings[0].personal = "private-binding-value"; }],
    ["missing subjectBlock", (value) => { delete (value as Record<string, unknown>).subjectBlock; }],
    ["missing bindings", (value) => { delete (value as Record<string, unknown>).bindings; }],
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
    bindEscrow(current.input);
    await writeFile(current.inputFile, json(current.input));
    const captured = capture();
    expect(await main(current.argv, captured.io)).toBe(0);
    const output = JSON.parse(await readFile(current.outputFile, "utf8"));
    expect(output.acceptanceDigest).toBe(acceptanceDigest(
      domainSeparator(current.input.policy.chainId, current.input.policy.escrow), jobPolicyHash(current.input.policy),
    ));
  });

  const malformedTermsCases: Array<[string, (value: Record<string, unknown>) => void]> = [
    ...malformedTermsChainCases,
    ["an extra terms field", (value) => { value.personal = "private-terms-value"; }],
    ["numeric minG", (value) => { value.minG = 100; }],
    ["a fractional time limit", (value) => { value.maxAcceptanceSeconds = 1.5; }],
    ["missing allowedPayoutRecipients", (value) => { delete value.allowedPayoutRecipients; }],
    ["missing factory", (value) => { delete value.factory; }],
    ["missing implementation", (value) => { delete value.implementation; }],
    ["missing termsHash", (value) => { delete value.termsHash; }],
    ["zero termsHash", (value) => { value.termsHash = zeroWord(); }],
    ["malformed termsHash", (value) => { value.termsHash = "private-terms-hash"; }],
    ["missing subjectPins", (value) => { delete value.subjectPins; }],
    ["subjectPins lacking committedProgramHash", (value) => { value.subjectPins = {}; }],
    ["an unknown subject pin", (value) => {
      value.subjectPins = { committedProgramHash: s2ProgramHash, personal: "private-pin-value" };
    }],
    ["a malformed program pin", (value) => { value.subjectPins = { committedProgramHash: "private-program" }; }],
    ["a fractional integrity grade pin", (value) => {
      value.subjectPins = { committedProgramHash: s2ProgramHash, integrityGrade: 1.5 };
    }],
    ["a settlement pin differing from the configured recipient", (value) => {
      value.subjectPins = { committedProgramHash: s2ProgramHash, operatorSettlementAddress: address("de") };
    }],
    ["a malformed bindings root", (value) => { value.bindingsRoot = "private-bindings-root"; }],
    ["zero factory", (value) => { value.factory = address("00"); }],
    ["zero implementation", (value) => { value.implementation = address("00"); }],
    ["missing operatorPayoutRecipient", (value) => { delete value.operatorPayoutRecipient; }],
    ["missing maxPassThrough", (value) => { delete value.maxPassThrough; }],
    ["numeric maxPassThrough", (value) => { value.maxPassThrough = 0; }],
    ["negative maxPassThrough", (value) => { value.maxPassThrough = "-1"; }],
    ["operator payout recipient outside the allowlist", (value) => { value.operatorPayoutRecipient = address("aa"); }],
    ["reclaim minimum below the protocol minimum", (value) => { value.reclaimMinSeconds = 863999; }],
    ["reclaim maximum above the protocol maximum", (value) => { value.reclaimMaxSeconds = 31536001; }],
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

  it("reports a writable terms file with only bad_mode and creates no output", async () => {
    const current = await fixture();
    await chmod(current.termsFile, 0o666);
    const captured = capture();
    expect(await main(current.argv, captured.io)).toBe(1);
    expect(captured.output()).toEqual({ stdout: "", stderr: "bad_mode\n" });
    await expect(stat(current.outputFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["chmod", "writeFile", "close"] as const)("unlinks its output when %s fails and permits a retry", async (operation) => {
    const current = await fixture();
    const actualOpen = (await vi.importActual<typeof fs>("node:fs/promises")).open;
    let faultInstalled = false;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actualOpen(...args);
      if (args[0] === current.outputFile && !faultInstalled) {
        faultInstalled = true;
        if (operation === "close") {
          const actualClose = handle.close.bind(handle);
          vi.spyOn(handle, "close").mockImplementationOnce(async () => {
            await actualClose();
            throw new Error("private library failure");
          });
        } else vi.spyOn(handle, operation).mockRejectedValueOnce(new Error("private library failure"));
      }
      return handle;
    });
    const captured = capture();
    expect(await main(current.argv, captured.io)).toBe(1);
    expect(captured.output()).toEqual({ stdout: "", stderr: "write_failed\n" });
    expect(faultInstalled).toBe(true);
    await expect(stat(current.outputFile)).rejects.toMatchObject({ code: "ENOENT" });
    const retry = capture();
    expect(await main(current.argv, retry.io)).toBe(0);
    expect(retry.output()).toEqual({ stdout: "", stderr: "" });
    expect((await stat(current.outputFile)).mode & 0o777).toBe(0o644);
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

async function expectJsonFailure(operation: () => Promise<unknown>, code: string) {
  let caught: unknown;
  try { await operation(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(PolicyJsonError);
  expect((caught as PolicyJsonError).code).toBe(code);
  expect((caught as Error).message).toBe(code);
  expect(Object.hasOwn(caught as object, "cause")).toBe(false);
  expect(Object.keys(caught as object).sort()).toEqual(["code", "name"]);
}

describe("policy JSON file boundaries", () => {
  it("refuses an extra subject key directly at input load with bad_input", async () => {
    const current = await fixture();
    const candidate = JSON.parse(json(current.input)) as EditableInput;
    candidate.subjectBlock.unapproved = "extra-subject-field";
    await writeFile(current.inputFile, json(candidate));
    await expect(loadJobPolicyInput(current.inputFile)).rejects.toMatchObject({
      name: "OperatorSigningError", code: "bad_input", message: "bad_input",
    });
  });
  it.each([
    ["termsHash", (terms: Record<string, unknown>) => { delete terms.termsHash; }],
    ["committedProgramHash pin", (terms: Record<string, unknown>) => { terms.subjectPins = {}; }],
  ] as const)("refuses a missing %s at terms load", async (_field, mutate) => {
    const current = await fixture();
    const terms = JSON.parse(json(current.terms));
    mutate(terms);
    await writeFile(current.termsFile, json(terms));
    await expect(loadHostTerms(current.termsFile)).rejects.toMatchObject({
      name: "OperatorSigningError", code: "bad_terms", message: "bad_terms",
    });
  });

  it("loads all 18 subject pins without dropping any field", async () => {
    const current = await fixture();
    const terms = { ...current.terms, subjectPins: current.input.subjectBlock };
    await writeFile(current.termsFile, json(terms));
    expect((await loadHostTerms(current.termsFile)).subjectPins).toEqual(current.input.subjectBlock);
  });

  it.each(malformedTermsChainCases)("refuses %s in terms JSON with bad_terms", async (_name, mutate) => {
    const current = await fixture();
    const terms = JSON.parse(json(current.terms));
    mutate(terms);
    await writeFile(current.termsFile, json(terms));
    await expect(loadHostTerms(current.termsFile)).rejects.toMatchObject({
      name: "OperatorSigningError", code: "bad_terms", message: "bad_terms",
    });
  });

  it.each([0o666, 0o620, 0o602])("refuses writable terms mode %s", async (mode) => {
    const current = await fixture();
    await chmod(current.termsFile, mode);
    await expectJsonFailure(() => loadHostTerms(current.termsFile), "bad_mode");
  });

  it.each([0o644, 0o600])("loads owner-controlled terms mode %s", async (mode) => {
    const current = await fixture();
    await chmod(current.termsFile, mode);
    expect(await loadHostTerms(current.termsFile)).toEqual(current.terms);
  });

  it("accepts the exact protocol reclaim bounds in terms JSON", async () => {
    const current = await fixture();
    expect((await loadHostTerms(current.termsFile)).reclaimMinSeconds).toBe(864000);
    expect((await loadHostTerms(current.termsFile)).reclaimMaxSeconds).toBe(31536000);
  });

  it("checks the terms owner and default owner without exposing a path", async () => {
    const current = await fixture();
    await expectJsonFailure(() => loadHostTerms(current.termsFile, { expectedUid: process.getuid!() + 1 }), "bad_owner");
    expect(await loadHostTerms(current.termsFile, { expectedUid: process.getuid!() })).toEqual(current.terms);
  });

  it.each(["terms", "input"] as const)("requires an absolute regular %s file and refuses links", async (kind) => {
    const current = await fixture();
    const path = kind === "terms" ? current.termsFile : current.inputFile;
    const load = kind === "terms" ? loadHostTerms : loadJobPolicyInput;
    await expectJsonFailure(() => load("relative-private-policy.json"), "not_absolute");
    await expectJsonFailure(() => load(current.root), "not_regular_file");
    const link = join(current.root, `${kind}-link.json`);
    await symlink(path, link);
    await expectJsonFailure(() => load(link), "symlink");
    await expectJsonFailure(() => load(join(current.root, "missing-private-file")), "not_found");
  });

  it.each(["terms", "input"] as const)("refuses a %s FIFO without waiting for a writer", async (kind) => {
    const current = await fixture();
    const load = kind === "terms" ? loadHostTerms : loadJobPolicyInput;
    const fifo = join(current.root, `${kind}-fifo`);
    execFileSync("mkfifo", [fifo], { stdio: "inherit" });
    // Release the original unbounded readFile implementation during the initial
    // red run. A secure reader rejects the FIFO before this writer is started.
    let writerStarted = false;
    const release = setTimeout(() => {
      writerStarted = true;
      execFileSync(process.execPath, ["-e", "const fs=require('node:fs');try{const fd=fs.openSync(process.argv[1],fs.constants.O_WRONLY|fs.constants.O_NONBLOCK);fs.writeSync(fd,'{');fs.closeSync(fd);}catch{}", fifo], { stdio: "inherit" });
    }, 1000);
    try {
      await expectJsonFailure(() => load(fifo), "not_regular_file");
      expect(writerStarted).toBe(false);
    } finally { clearTimeout(release); }
  });

  it("detects terms swapped between lstat and open", async () => {
    const current = await fixture();
    const actualOpen = (await vi.importActual<typeof fs>("node:fs/promises")).open;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      await fs.rename(current.termsFile, join(current.root, "original-terms"));
      await writeFile(current.termsFile, json(current.terms), { mode: 0o600 });
      return actualOpen(...args);
    });
    await expectJsonFailure(() => loadHostTerms(current.termsFile), "changed_during_open");
  });

  it.each(["terms", "input"] as const)("refuses a %s symlink swapped in before open", async (kind) => {
    const current = await fixture();
    const path = kind === "terms" ? current.termsFile : current.inputFile;
    const load = kind === "terms" ? loadHostTerms : loadJobPolicyInput;
    const actualOpen = (await vi.importActual<typeof fs>("node:fs/promises")).open;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const target = join(current.root, `original-${kind}`);
      await fs.rename(path, target);
      await symlink(target, path);
      return actualOpen(...args);
    });
    await expectJsonFailure(() => load(path), "read_failed");
  });

  it("rechecks terms mode after open", async () => {
    const current = await fixture();
    const actualOpen = (await vi.importActual<typeof fs>("node:fs/promises")).open;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actualOpen(...args);
      await handle.chmod(0o666);
      return handle;
    });
    await expectJsonFailure(() => loadHostTerms(current.termsFile), "bad_mode");
  });

  it("rechecks terms owner on the opened handle", async () => {
    const current = await fixture();
    const actualOpen = (await vi.importActual<typeof fs>("node:fs/promises")).open;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actualOpen(...args);
      const actualStat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementationOnce(async (...statArgs) => {
        const opened = await actualStat(...statArgs);
        opened.uid = typeof opened.uid === "number" ? opened.uid + 1 : opened.uid + 1n;
        return opened;
      });
      return handle;
    });
    await expectJsonFailure(() => loadHostTerms(current.termsFile), "bad_owner");
  });

  it.each(["terms", "input"] as const)("rechecks the opened %s is regular", async (kind) => {
    const current = await fixture();
    const path = kind === "terms" ? current.termsFile : current.inputFile;
    const load = kind === "terms" ? loadHostTerms : loadJobPolicyInput;
    const actualOpen = (await vi.importActual<typeof fs>("node:fs/promises")).open;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actualOpen(...args);
      const actualStat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementationOnce(async (...statArgs) => {
        const opened = await actualStat(...statArgs);
        vi.spyOn(opened, "isFile").mockReturnValue(false);
        return opened;
      });
      return handle;
    });
    await expectJsonFailure(() => load(path), "not_regular_file");
  });

  it.each(["terms", "input"] as const)("checks opened %s size before reading", async (kind) => {
    const current = await fixture();
    const path = kind === "terms" ? current.termsFile : current.inputFile;
    const load = kind === "terms" ? loadHostTerms : loadJobPolicyInput;
    const maxBytes = kind === "terms" ? 64 * 1024 : 1024 * 1024;
    const actualOpen = (await vi.importActual<typeof fs>("node:fs/promises")).open;
    let read: { mock: { calls: unknown[][] } } | undefined;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actualOpen(...args);
      const actualStat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementationOnce(async (...statArgs) => {
        const opened = await actualStat(...statArgs);
        opened.size = typeof opened.size === "number" ? maxBytes + 1 : BigInt(maxBytes + 1);
        return opened;
      });
      read = vi.spyOn(handle, "read");
      return handle;
    });
    await expectJsonFailure(() => load(path), "too_large");
    expect(read).toBeDefined();
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["terms", "input"] as const)("bounds %s reads if the file grows after fstat", async (kind) => {
    const current = await fixture();
    const path = kind === "terms" ? current.termsFile : current.inputFile;
    const load = kind === "terms" ? loadHostTerms : loadJobPolicyInput;
    const maxBytes = kind === "terms" ? 64 * 1024 : 1024 * 1024;
    const actualOpen = (await vi.importActual<typeof fs>("node:fs/promises")).open;
    let read: { mock: { calls: unknown[][] } } | undefined;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actualOpen(...args);
      const actualStat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementationOnce(async (...statArgs) => {
        const opened = await actualStat(...statArgs);
        await writeFile(path, " ".repeat(maxBytes + 4096));
        return opened;
      });
      read = vi.spyOn(handle, "read");
      return handle;
    });
    await expectJsonFailure(() => load(path), "too_large");
    expect(read).toBeDefined();
    const buffer = read!.mock.calls[0][0] as Buffer;
    expect(buffer.length).toBe(maxBytes + 1);
    expect(buffer.every((byte) => byte === 0)).toBe(true);
  });

  it("permits an input file writable by other users because signed terms constrain its content", async () => {
    const current = await fixture();
    await chmod(current.inputFile, 0o666);
    expect(await loadJobPolicyInput(current.inputFile)).toEqual(current.input);
  });
});
