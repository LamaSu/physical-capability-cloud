import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyMessage } from "viem";
import { WalletError } from "../wallet/errors.js";
import { signWalletMessage } from "../wallet/keys.js";
import {
  createWallet, readWallet, updateLink, validateLabel, walletPath,
  type WalletRecord,
} from "../wallet/keystore.js";

let root: string;
let directory: string;
let previousDirectory: string | undefined;

beforeEach(() => {
  previousDirectory = process.env.PCC_WALLET_DIR;
  root = mkdtempSync(join(tmpdir(), "pcc-wallet-keystore-"));
  directory = join(root, "wallets");
  process.env.PCC_WALLET_DIR = directory;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousDirectory === undefined) delete process.env.PCC_WALLET_DIR;
  else process.env.PCC_WALLET_DIR = previousDirectory;
  rmSync(root, { recursive: true, force: true });
});

function create(keyType: "secp256k1" | "ed25519" = "secp256k1"): WalletRecord {
  return createWallet({
    label: "participant", role: keyType === "ed25519" ? "device" : "agent",
    keyType, chainId: 84532, gatewayOrigin: "http://127.0.0.1:3200",
    createdAt: "2026-10-13T12:00:00.000Z",
  });
}

function secretForms(wallet: WalletRecord): string[] {
  const secret = wallet.keyType === "secp256k1" ? wallet.privateKey! : wallet.seed!;
  const hex = secret.replace(/^0x/, "");
  return [hex, `0x${hex}`, Buffer.from(hex, "hex").toString("base64")];
}

function expectSafeError(action: () => unknown, wallet: WalletRecord): void {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(WalletError);
  const text = String(caught);
  for (const secret of secretForms(wallet)) expect(text).not.toContain(secret);
  expect(text).not.toMatch(/privateKey|seed/);
}

describe("wallet keystore", () => {
  it.each([0o000, 0o777])("creates a 0600 file in a 0700 directory even under umask %i", (mask) => {
    // Node forbids changing the process-wide umask from a worker thread. Run
    // this same assertion in a single fork, which owns its process and umask.
    if (process.env.PCC_WALLET_UMASK_TEST !== "1") {
      const result = spawnSync("./node_modules/.bin/vitest", [
        "run", "--pool=forks", "--poolOptions.forks.singleFork",
        "src/__tests__/wallet-keystore.test.ts", "-t", `even under umask ${mask}`,
      ], {
        cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8",
        env: { ...process.env, PCC_WALLET_UMASK_TEST: "1" },
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      return;
    }
    const previousMask = process.umask(mask);
    try {
      create();
      expect(lstatSync(directory).mode & 0o777).toBe(0o700);
      expect(lstatSync(walletPath("participant")).mode & 0o777).toBe(0o600);
    } finally { process.umask(previousMask); }
  });

  it("refuses an existing file without replacing its identity", () => {
    create();
    const original = readFileSync(walletPath("participant"), "utf8");
    expect(() => create()).toThrow(WalletError);
    expect(readFileSync(walletPath("participant"), "utf8")).toBe(original);
  });

  it("refuses a symlinked file for creation and reading", () => {
    mkdirSync(directory, { mode: 0o700 });
    const target = join(root, "target.json");
    writeFileSync(target, "untouched", { mode: 0o600 });
    symlinkSync(target, walletPath("participant"));
    expect(() => create()).toThrow(/symlink/);
    expect(() => readWallet("participant")).toThrow(/symlink/);
    expect(readFileSync(target, "utf8")).toBe("untouched");
  });

  it("refuses a symlinked wallet directory", () => {
    const target = join(root, "target");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, directory, "dir");
    expect(() => create()).toThrow(/symlink/);
    expect(existsSync(join(target, "participant.json"))).toBe(false);
  });

  it("refuses a 0644 file on read", () => {
    create();
    chmodSync(walletPath("participant"), 0o644);
    expect(() => readWallet("participant")).toThrow(/mode|permissions/);
  });

  it.each([0o710, 0o701, 0o770, 0o777])("refuses directory group or other bits (%i)", (mode) => {
    mkdirSync(directory, { mode });
    chmodSync(directory, mode);
    expect(() => create()).toThrow(/mode|permissions/);
    expect(existsSync(walletPath("participant"))).toBe(false);
  });

  it("refuses a directory belonging to another uid", () => {
    mkdirSync(directory, { mode: 0o700 });
    const uid = process.getuid!();
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    expect(() => create()).toThrow(/owner|owned/);
  });

  it("refuses a file belonging to another uid", () => {
    create();
    const uid = process.getuid!();
    vi.spyOn(process, "getuid").mockReturnValueOnce(uid).mockReturnValue(uid + 1);
    expect(() => readWallet("participant")).toThrow(/owner|owned/);
  });

  it("refuses Windows before creating or reading a file", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      expect(() => create()).toThrow(/Windows|win32/);
      expect(() => readWallet("participant")).toThrow(/Windows|win32/);
      expect(existsSync(directory)).toBe(false);
    } finally { Object.defineProperty(process, "platform", descriptor); }
  });

  it("updates only link state through an owner-only replacement", () => {
    const wallet = create();
    const updated = updateLink(wallet, {
      requestId: "lr_test", linkId: "wl_test", accountId: "acct_test", status: "approved",
    });
    expect(updated.link.linkId).toBe("wl_test");
    expect(readWallet("participant")).toEqual(updated);
    expect(updated.privateKey).toBe(wallet.privateKey);
    expect(lstatSync(walletPath("participant")).mode & 0o777).toBe(0o600);
  });

  it("refuses replacing a link after the file becomes world-readable", () => {
    const wallet = create();
    chmodSync(walletPath("participant"), 0o644);
    expectSafeError(() => updateLink(wallet, { status: "approved" }), wallet);
  });

  it("a fresh link state clears prior link and account ids", () => {
    const wallet = updateLink(create(), { linkId: "wl_old", accountId: "acct_old", status: "approved" });
    const pending = updateLink(wallet, { requestId: "lr_new", status: "pending_proof" });
    expect(pending.link).toEqual({ requestId: "lr_new", status: "pending_proof" });
    expect(readWallet("participant").link).toEqual(pending.link);
  });

  it.each(["status", "requestId", "linkId", "accountId"])("refuses unsafe stored link %s without revealing contents", (field) => {
    const wallet = create();
    writeFileSync(walletPath("participant"), JSON.stringify({
      ...wallet, link: { [field]: `invalid ${secretForms(wallet)[0]}` },
    }), { mode: 0o600 });
    expectSafeError(() => readWallet("participant"), wallet);
  });

  it("refuses non-canonical stored creation timestamps", () => {
    const wallet = create();
    writeFileSync(walletPath("participant"), JSON.stringify({ ...wallet, createdAt: "2026-10-13" }), { mode: 0o600 });
    expectSafeError(() => readWallet("participant"), wallet);
  });

  it("validates labels before creating directories", () => {
    for (const label of ["", "../outside", "a/b", "white space", "x".repeat(65)]) {
      expect(() => validateLabel(label)).toThrow(WalletError);
      expect(() => walletPath(label)).toThrow(WalletError);
    }
    expect(() => validateLabel("Printer_1.example@site-2")).not.toThrow();
    expect(existsSync(directory)).toBe(false);
  });

  it.each(["secp256k1", "ed25519"] as const)("rejects a mismatched %s public identity without leaking material", (keyType) => {
    const wallet = create(keyType);
    const changed = keyType === "secp256k1"
      ? { ...wallet, address: "0x0000000000000000000000000000000000000001" }
      : { ...wallet, publicKey: "00".repeat(32) };
    writeFileSync(walletPath("participant"), JSON.stringify(changed), { mode: 0o600 });
    expectSafeError(() => readWallet("participant"), wallet);
  });

  it("sanitizes malformed keystore errors", () => {
    const wallet = create();
    writeFileSync(walletPath("participant"), `${JSON.stringify(wallet)} broken`, { mode: 0o600 });
    expectSafeError(() => readWallet("participant"), wallet);
  });
});

describe("wallet key signatures", () => {
  it("signs EIP-191 message bytes with the persisted secp256k1 key", async () => {
    const wallet = create();
    const message = "PCC participant signature test\nexact bytes";
    const signature = await signWalletMessage(readWallet("participant"), message);
    expect(await verifyMessage({ address: wallet.address!, message, signature: signature as `0x${string}` })).toBe(true);
  });

  it("stores a 32-byte ed25519 seed and signs exact UTF-8 bytes", async () => {
    const wallet = create("ed25519");
    expect(wallet.seed).toMatch(/^[0-9a-f]{64}$/);
    expect(wallet.publicKey).toMatch(/^[0-9a-f]{64}$/);
    const message = "PCC-LINK-V1\nUTF-8: café";
    const signature = await signWalletMessage(readWallet("participant"), message);
    expect(signature).toMatch(/^[0-9a-f]{128}$/);
    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(wallet.publicKey!, "hex")]),
      format: "der", type: "spki",
    });
    expect(verify(null, Buffer.from(message, "utf8"), publicKey, Buffer.from(signature, "hex"))).toBe(true);
  });

  it("wraps signing failures without leaking input key material", async () => {
    const wallet = create();
    const malformed = { ...wallet, privateKey: `${wallet.privateKey}invalid` as `0x${string}` };
    const failure = await signWalletMessage(malformed, "test").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WalletError);
    for (const secret of secretForms(wallet)) expect(String(failure)).not.toContain(secret);
    expect(String(failure)).not.toMatch(/privateKey|seed/);
  });
});
