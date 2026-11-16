import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyMessage } from "viem";
import { WalletError } from "../wallet/errors.js";
import { signWalletMessage } from "../wallet/keys.js";
import {
  createWallet, readWallet, updateLink, validateLabel, walletPath,
  type WalletRecord,
} from "../wallet/keystore.js";

const defaultHome = vi.hoisted(() => ({ path: undefined as string | undefined }));
const storageMocks = vi.hoisted(() => ({
  foreignPath: undefined as string | undefined,
  directoryFsyncError: undefined as string | undefined,
  fileFsyncError: undefined as string | undefined,
  recordIO: false,
  calls: [] as string[],
}));
vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => defaultHome.path ?? original.homedir() };
});
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    lstatSync: (path: import("node:fs").PathLike, options?: import("node:fs").StatOptions) => {
      const stat = original.lstatSync(path, options);
      if (stat && typeof path === "string" && typeof stat.uid === "number" && path === storageMocks.foreignPath) {
        stat.uid = process.getuid!() + 1;
      }
      return stat;
    },
    writeFileSync: (...args: Parameters<typeof original.writeFileSync>) => {
      if (storageMocks.recordIO) storageMocks.calls.push("write:file");
      return original.writeFileSync(...args);
    },
    fsyncSync: (descriptor: number) => {
      const kind = original.fstatSync(descriptor).isDirectory() ? "directory" : "file";
      if (storageMocks.recordIO) storageMocks.calls.push(`fsync:${kind}`);
      const code = kind === "directory" ? storageMocks.directoryFsyncError : storageMocks.fileFsyncError;
      if (code) throw Object.assign(new Error("injected fsync failure"), { code });
      return original.fsyncSync(descriptor);
    },
    linkSync: (...args: Parameters<typeof original.linkSync>) => {
      if (storageMocks.recordIO) storageMocks.calls.push("publish:link");
      return original.linkSync(...args);
    },
    renameSync: (...args: Parameters<typeof original.renameSync>) => {
      if (storageMocks.recordIO) storageMocks.calls.push("publish:rename");
      return original.renameSync(...args);
    },
    unlinkSync: (...args: Parameters<typeof original.unlinkSync>) => {
      if (storageMocks.recordIO) storageMocks.calls.push("unlink:temporary");
      return original.unlinkSync(...args);
    },
  };
});

let root: string;
let directory: string;
let previousDirectory: string | undefined;

beforeEach(() => {
  defaultHome.path = undefined;
  storageMocks.foreignPath = undefined;
  storageMocks.directoryFsyncError = undefined;
  storageMocks.fileFsyncError = undefined;
  storageMocks.recordIO = false;
  storageMocks.calls = [];
  previousDirectory = process.env.PCC_WALLET_DIR;
  root = mkdtempSync(join(tmpdir(), "pcc-wallet-keystore-"));
  directory = join(root, "wallets");
  process.env.PCC_WALLET_DIR = directory;
});

afterEach(() => {
  vi.restoreAllMocks();
  defaultHome.path = undefined;
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
  it("does not publish an empty key file after SIGKILL immediately following the exclusive open", () => {
    const packageDirectory = fileURLToPath(new URL("../../", import.meta.url));
    const build = spawnSync(process.execPath, [join(packageDirectory, "node_modules/typescript/bin/tsc"), "-p", "."], {
      cwd: packageDirectory, encoding: "utf8",
    });
    expect(build.status, build.stderr).toBe(0);
    const entry = pathToFileURL(join(packageDirectory, "dist/wallet/keystore.js")).href;
    const script = [
      'import fs from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      'const originalOpen = fs.openSync;',
      'fs.openSync = (...args) => { const fd = originalOpen(...args); if (typeof args[0] === "string" && args[0].startsWith(process.env.PCC_WALLET_DIR + "/") && (args[1] & fs.constants.O_CREAT)) process.kill(process.pid, "SIGKILL"); return fd; };',
      'syncBuiltinESMExports();',
      `const { createWallet } = await import(${JSON.stringify(entry)});`,
      'createWallet({ label: "participant", role: "agent", keyType: "secp256k1", chainId: 84532, gatewayOrigin: "http://127.0.0.1:3200", createdAt: "2026-10-13T12:00:00.000Z" });',
    ].join("\n");
    const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env }, encoding: "utf8",
    });
    expect(crashed.signal).toBe("SIGKILL");
    expect(existsSync(walletPath("participant"))).toBe(false);
    create();
    expect(readWallet("participant").label).toBe("participant");
  });

  it("fsyncs a temporary key file before no-clobber publication and directory fsync", () => {
    storageMocks.recordIO = true;
    create();
    expect(storageMocks.calls).toEqual([
      "write:file", "fsync:file", "publish:link", "unlink:temporary", "fsync:directory",
    ]);
  });

  it("fsyncs a temporary link update before rename and directory fsync", () => {
    const wallet = create();
    storageMocks.recordIO = true;
    updateLink(wallet, { requestId: "lr_durable", status: "awaiting_approval" });
    expect(storageMocks.calls).toEqual(["write:file", "fsync:file", "publish:rename", "fsync:directory"]);
  });

  it.each(["EINVAL", "ENOTSUP"])("tolerates unsupported directory fsync (%s) for create and update", (code) => {
    storageMocks.directoryFsyncError = code;
    const wallet = create();
    updateLink(wallet, { requestId: "lr_durable", status: "awaiting_approval" });
    expect(readWallet("participant").link.requestId).toBe("lr_durable");
    expect(lstatSync(walletPath("participant")).mode & 0o777).toBe(0o600);
  });

  it("keeps a complete published key file when directory fsync fails with EIO", () => {
    storageMocks.directoryFsyncError = "EIO";
    expect(() => create()).toThrow(/wallet_storage_failed/);
    expect(readWallet("participant").label).toBe("participant");
  });

  it.each(["EINVAL", "ENOTSUP", "EIO"])("refuses file fsync failure (%s) before publishing a key", (code) => {
    storageMocks.fileFsyncError = code;
    expect(() => create()).toThrow(/wallet_storage_failed/);
    expect(existsSync(walletPath("participant"))).toBe(false);
    storageMocks.fileFsyncError = undefined;
    create();
  });

  function useDefaultDirectory(): string {
    defaultHome.path = root;
    delete process.env.PCC_WALLET_DIR;
    const parent = join(root, ".pcc");
    mkdirSync(parent, { mode: 0o755 });
    chmodSync(parent, 0o755);
    directory = join(parent, "wallets");
    return parent;
  }

  it("accepts the default wallets path under an existing 0755 .pcc without loosening key storage", () => {
    const parent = useDefaultDirectory();
    create();
    expect(lstatSync(parent).mode & 0o777).toBe(0o755);
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(walletPath("participant")).mode & 0o777).toBe(0o600);
    expect(readWallet("participant").label).toBe("participant");
  });

  it.each([0o775, 0o777])("refuses a writable default .pcc parent (%i) with its path and chmod guidance", (mode) => {
    const parent = useDefaultDirectory();
    chmodSync(parent, mode);
    let failure: unknown;
    try { create(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(WalletError);
    expect(String(failure)).toContain(parent);
    expect(String(failure)).toContain("chmod 700");
    expect(existsSync(directory)).toBe(false);
  });

  it("refuses a default .pcc parent belonging to another non-root uid", () => {
    useDefaultDirectory();
    vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
    expect(() => create()).toThrow(/owner/);
    expect(existsSync(directory)).toBe(false);
  });

  it("accepts a safe symlinked default .pcc parent", () => {
    defaultHome.path = root;
    delete process.env.PCC_WALLET_DIR;
    const target = join(root, "parent-target");
    mkdirSync(target, { mode: 0o755 });
    symlinkSync(target, join(root, ".pcc"), "dir");
    directory = join(root, ".pcc", "wallets");
    create();
    expect(readWallet("participant").label).toBe("participant");
    expect(existsSync(join(target, "wallets", "participant.json"))).toBe(true);
  });

  it("accepts a safe symlinked ancestor for create, read and link updates", () => {
    const target = join(root, "resolved-parent");
    mkdirSync(target, { mode: 0o700 });
    const alias = join(root, "alias-parent");
    symlinkSync(target, alias, "dir");
    directory = join(alias, "wallets");
    process.env.PCC_WALLET_DIR = directory;
    const wallet = create();
    updateLink(wallet, { requestId: "lr_safe", status: "awaiting_approval" });
    expect(readWallet("participant").link.requestId).toBe("lr_safe");
    expect(lstatSync(join(target, "wallets")).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(target, "wallets", "participant.json")).mode & 0o777).toBe(0o600);
  });

  it.each([0o770, 0o777])("refuses a writable non-sticky ancestor (%i) before creating storage", (mode) => {
    const parent = join(root, "unsafe-parent");
    mkdirSync(parent, { mode });
    chmodSync(parent, mode);
    directory = join(parent, "wallets");
    process.env.PCC_WALLET_DIR = directory;
    expect(() => create()).toThrow(/permissions/);
    expect(existsSync(directory)).toBe(false);
  });

  it("allows a sticky shared ancestor while retaining a private wallets directory", () => {
    const parent = join(root, "sticky-parent");
    mkdirSync(parent, { mode: 0o1777 });
    chmodSync(parent, 0o1777);
    directory = join(parent, "wallets");
    process.env.PCC_WALLET_DIR = directory;
    create();
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
  });

  it("refuses a foreign non-root ancestor after resolving it", () => {
    const parent = join(root, "foreign-parent");
    mkdirSync(parent, { mode: 0o700 });
    storageMocks.foreignPath = parent;
    directory = join(parent, "wallets");
    process.env.PCC_WALLET_DIR = directory;
    expect(() => create()).toThrow(/owner/);
    expect(existsSync(directory)).toBe(false);
  });

  it("allows a sticky default .pcc parent", () => {
    const parent = useDefaultDirectory();
    chmodSync(parent, 0o1777);
    create();
    expect(lstatSync(parent).mode & 0o7777).toBe(0o1777);
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
  });

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

  it("refuses the first user-owned path when getuid changes before create", () => {
    mkdirSync(directory, { mode: 0o700 });
    const uid = process.getuid!();
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    expect(() => create()).toThrow(/^wallet_directory_owner_mismatch/);
  });

  it("refuses the first user-owned path when getuid changes during read", () => {
    create();
    const uid = process.getuid!();
    vi.spyOn(process, "getuid").mockReturnValueOnce(uid).mockReturnValue(uid + 1);
    expect(() => readWallet("participant")).toThrow(/^wallet_directory_owner_mismatch/);
  });

  it("refuses an existing wallets directory when only its owner is foreign", () => {
    mkdirSync(directory, { mode: 0o700 });
    storageMocks.foreignPath = directory;
    expect(() => create()).toThrow(/^wallet_directory_owner_mismatch$/);
    expect(existsSync(walletPath("participant"))).toBe(false);
  });

  it("refuses a key file when only its owner is foreign", () => {
    create();
    storageMocks.foreignPath = walletPath("participant");
    expect(() => readWallet("participant")).toThrow(/wallet_file_owner_mismatch/);
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

  it.each(["status", "requestId", "linkId"])("refuses unsafe stored link %s without revealing contents", (field) => {
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

describe("opaque stored account ids", () => {
  it("round-trips an email accountId without using it as a filename", () => {
    const wallet = updateLink(create(), { status: "approved", linkId: "wl_test", accountId: "alice@example.com" });
    expect(readWallet("participant").link.accountId).toBe("alice@example.com");
    expect(walletPath(wallet.label)).toBe(join(directory, "participant.json"));
  });
});

describe("keystore surviving-mutant rules", () => {
  it("K8 refuses a writable non-sticky GRANDPARENT (not only the nearest ancestor)", () => {
    const hostile = join(root, "hostile"); mkdirSync(hostile); chmodSync(hostile, 0o777);
    const middle = join(hostile, "middle"); mkdirSync(middle); chmodSync(middle, 0o755);
    process.env.PCC_WALLET_DIR = join(middle, "wallets");
    expect(() => create()).toThrow(/permissions_refused/);
  });
  it("K5 refuses a group-writable setgid (2770) parent: setgid is not sticky", () => {
    const shared = join(root, "shared"); mkdirSync(shared); chmodSync(shared, 0o2770);
    process.env.PCC_WALLET_DIR = join(shared, "wallets");
    expect(() => create()).toThrow(/permissions_refused/);
  });
  it("K9 refuses a symlinked ancestor whose TARGET is world-writable", () => {
    const target = join(root, "open-target"); mkdirSync(target); chmodSync(target, 0o777);
    const alias = join(root, "alias"); symlinkSync(target, alias, "dir");
    process.env.PCC_WALLET_DIR = join(alias, "wallets");
    expect(() => create()).toThrow(/permissions_refused/);
  });
  it("K10 a read refuses once an ancestor becomes writable by others", () => {
    const parent = join(root, "parent"); mkdirSync(parent); chmodSync(parent, 0o755);
    process.env.PCC_WALLET_DIR = join(parent, "wallets");
    create();
    chmodSync(parent, 0o777);
    expect(() => readWallet("participant")).toThrow(/permissions_refused/);
  });
  it("F2f a stored plain-http public gateway origin is an invalid keystore", () => {
    const parent = join(root, "parent"); mkdirSync(parent); chmodSync(parent, 0o755);
    process.env.PCC_WALLET_DIR = join(parent, "wallets");
    create();
    const path = walletPath("participant");
    const data = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...data, gatewayOrigin: "http://pcc.example" }), { mode: 0o600 });
    expect(() => readWallet("participant")).toThrow(/invalid_keystore/);
  });
});

it("uses the real root ancestor owner, including uid-mapped sandbox mounts", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const rootOwner = actual.lstatSync("/").uid;
  if (rootOwner === 0 || rootOwner === process.getuid!()) expect(() => create()).not.toThrow();
  else expect(() => create()).toThrow(/wallet_directory_owner_mismatch/);
});
