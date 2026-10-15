#!/usr/bin/env node
import { createInterface } from "node:readline";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "../lib/config.js";
import { WalletError } from "./errors.js";
import {
  createWallet, readWallet, updateLink, validateLabel, walletPath,
  type WalletRecord, type Role, type KeyType,
} from "./keystore.js";
import { signWalletMessage } from "./keys.js";
import { validateProofMessage } from "./proof.js";
import { requestFunding, validateTransportUrl, walletRequest } from "./http.js";

export interface WalletRuntime {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdinIsTTY: boolean;
  prompt: () => Promise<string>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const HELP = `pcc-wallet — a wallet key held on your computer
Usage: pcc-wallet <command> --role agent|device --label <label> [options]
       onboard wallet <command> [options]

Commands: init, link, fund, status, revoke, export-address
  init            Consent, create a key, link with browser approval, then fund
  link            Request browser approval for an existing key
  fund            Request test funds for an approved link
  status          Show public local facts and the stored request's status
  revoke          Unlink using an owner API key, or use Wallets → Unlink
  export-address  Print the address or public key only

Options:
  --role agent|device                 Required
  --label <label>                      File name, 1–64 letters/digits/._@-
  --key-type secp256k1|ed25519          Defaults: agent secp256k1, device ed25519
  --chain-id 84532                     Base Sepolia only
  --gateway <origin>                   Same gateway resolution as onboard
  --yes                               Skip typed create only on non-TTY stdin
  --api-key <owner-key>                Revoke only (env: PCC_API_KEY)
  --reason <reason>                    Revoke reason: lowercase letters/_
  --encrypt                           Not in v1
  -h, --help                          Show help

Keys are stored in PCC_WALLET_DIR or ~/.pcc/wallets, 0600 in a 0700 directory.
Only the account owner can approve the link in their browser.
`;

type Command = "init" | "link" | "fund" | "status" | "revoke" | "export-address";
interface Args {
  command: Command;
  role: Role;
  label: string;
  keyType?: KeyType;
  chainId: number;
  gateway?: string;
  yes: boolean;
  apiKey?: string;
  reason?: string;
}

function parseArgs(argv: string[]): Args | null {
  if (argv.includes("--encrypt")) throw new WalletError("--encrypt is not in v1");
  if (argv.includes("--help") || argv.includes("-h")) return null;
  const [command, ...flags] = argv;
  if (!["init", "link", "fund", "status", "revoke", "export-address"].includes(command ?? "")) {
    throw new WalletError("unknown_wallet_command");
  }
  const values: Record<string, string> = {};
  let yes = false;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === "--yes") { yes = true; continue; }
    if (!["--role", "--label", "--key-type", "--chain-id", "--gateway", "--api-key", "--reason"].includes(flag)) {
      throw new WalletError("invalid_wallet_option");
    }
    const value = flags[++i];
    if (value === undefined || value.startsWith("--") || flag in values) {
      throw new WalletError("invalid_wallet_option");
    }
    values[flag] = value;
  }
  const role = values["--role"];
  if (role !== "agent" && role !== "device") throw new WalletError("role_required_agent_or_device");
  const label = values["--label"] ?? "";
  validateLabel(label);
  const keyType = values["--key-type"];
  if (keyType !== undefined && keyType !== "secp256k1" && keyType !== "ed25519") {
    throw new WalletError("unsupported_key_type");
  }
  if (values["--chain-id"] !== undefined && values["--chain-id"] !== "84532") {
    throw new WalletError("unsupported_chain");
  }
  const reason = values["--reason"];
  if (reason !== undefined && !/^[a-z_]{1,32}$/.test(reason)) throw new WalletError("invalid_revoke_reason");
  return {
    command: command as Command, role, label, keyType, chainId: 84532,
    gateway: values["--gateway"], yes, apiKey: values["--api-key"], reason,
  };
}

function gatewayOrigin(gateway?: string): string {
  return validateTransportUrl(resolveConfig({ gateway }).gatewayUrl).origin;
}

async function promptCreate(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  // EOF must cancel, including a noninteractive invocation without --yes.
  try {
    return await new Promise<string>((done) => {
      rl.once("close", () => done(""));
      rl.question("", done);
    });
  } finally { rl.close(); }
}

function defaults(): WalletRuntime {
  return {
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
    stdinIsTTY: Boolean(process.stdin.isTTY), prompt: promptCreate, now: Date.now,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  };
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function invalidResponse(): never { throw new WalletError("invalid_gateway_response"); }

function requestPath(requestId: string): string {
  return `/api/wallets/link-requests/${encodeURIComponent(requestId)}`;
}

function pollState(data: Record<string, unknown>): string {
  const status = data.status;
  if (typeof status !== "string" || ![
    "authorization_pending", "slow_down", "approved", "denied", "expired", "failed",
  ].includes(status)) invalidResponse();
  if (status === "approved" && (!identifier(data.linkId)
    || (data.accountId !== undefined && typeof data.accountId !== "string"))) invalidResponse();
  return status;
}

function saveState(wallet: WalletRecord, data: Record<string, unknown>): WalletRecord {
  const status = pollState(data);
  if (["authorization_pending", "slow_down"].includes(status)
    && ((wallet.link.status === "approved" && wallet.link.linkId) || wallet.link.status === "revoked")) return wallet;
  return updateLink(wallet, {
    ...wallet.link, status,
    ...(status === "approved" ? { linkId: data.linkId as string,
      ...(typeof data.accountId === "string" ? { accountId: data.accountId } : {}) } : {}),
  });
}

async function linkWallet(wallet: WalletRecord, io: WalletRuntime): Promise<WalletRecord> {
  const created = await walletRequest(wallet.gatewayOrigin, "/api/wallets/link-requests", "POST", {
    keyType: wallet.keyType,
    ...(wallet.keyType === "secp256k1" ? { address: wallet.address } : { publicKey: wallet.publicKey }),
    role: wallet.role, label: wallet.label, chainId: wallet.chainId,
  });
  if (!identifier(created.requestId) || !created.requestId.startsWith("lr_")
    || typeof created.userCode !== "string" || !/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/.test(created.userCode)
    || created.verificationUri !== `${wallet.gatewayOrigin}/link`
    || typeof created.message !== "string" || typeof created.expiresAt !== "string"
    || !Number.isSafeInteger(created.interval) || (created.interval as number) <= 0) invalidResponse();
  const expiresAt = Date.parse(created.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= io.now()) invalidResponse();
  wallet = updateLink(wallet, { requestId: created.requestId, status: "pending_proof" });
  validateProofMessage(created.message, wallet, created.requestId, io.now());
  const signature = await signWalletMessage(wallet, created.message);
  const proof = await walletRequest(wallet.gatewayOrigin, `${requestPath(created.requestId)}/proof`, "POST", { signature });
  if (proof.status !== "awaiting_approval") invalidResponse();
  wallet = updateLink(wallet, { requestId: created.requestId, status: "awaiting_approval" });
  io.stdout(`Code: ${created.userCode}\nOpen: ${created.verificationUri}\nYour PCC account owner must approve this link in the browser.\n`);
  let intervalMs = (created.interval as number) * 1000;
  while (io.now() < expiresAt) {
    await io.sleep(Math.min(intervalMs, expiresAt - io.now()));
    if (io.now() >= expiresAt) break;
    const data = await walletRequest(wallet.gatewayOrigin, requestPath(created.requestId), "GET");
    if (io.now() >= expiresAt) break;
    wallet = saveState(wallet, data);
    if (data.status === "approved") { io.stdout("linked\n"); return wallet; }
    if (data.status === "denied" || data.status === "expired" || data.status === "failed") {
      throw new WalletError(data.status);
    }
    if (data.status === "slow_down") intervalMs += 5000;
  }
  updateLink(wallet, { ...wallet.link, status: "expired" });
  throw new WalletError("expired");
}

async function fundWallet(wallet: WalletRecord, io: WalletRuntime): Promise<boolean> {
  if (!wallet.link.linkId || wallet.link.status !== "approved") throw new WalletError("approved_link_required");
  const result = await requestFunding(wallet.gatewayOrigin, wallet.link.linkId);
  if (!result.funded) {
    io.stdout("funding is not available on this gateway; ask the operator for test funds\nlinked (unfunded)\n");
    return false;
  }
  io.stdout(`funded\n${result.txHashes.map((hash) => `${hash}\n`).join("")}`);
  return true;
}

async function execute(args: Args, io: WalletRuntime): Promise<number> {
  if (args.command === "revoke" && !args.apiKey && !process.env.PCC_API_KEY) {
    throw new WalletError("revoke from the dashboard (Wallets → Unlink), or pass an owner API key", 2);
  }
  const origin = gatewayOrigin(args.gateway);
  if (args.command === "init") {
    io.stdout(`pcc wallet init --role ${args.role} --label ${args.label}\nThis creates a NEW wallet key on this computer:\n  file      ${walletPath(args.label)} (mode 0600)\n  network   Base Sepolia (test network). Test funds have no value.\n  custody   only this file. PCC never receives it and cannot recover it.\nNext: your PCC account owner approves the link in a browser; then test funds arrive.\nType "create" to continue:\n`);
    if (!(args.yes && !io.stdinIsTTY) && (await io.prompt()).trim() !== "create") {
      throw new WalletError("creation_cancelled");
    }
    let wallet = createWallet({
      label: args.label, role: args.role,
      keyType: args.keyType ?? (args.role === "agent" ? "secp256k1" : "ed25519"),
      chainId: args.chainId, gatewayOrigin: origin, createdAt: new Date(io.now()).toISOString(),
    });
    wallet = await linkWallet(wallet, io);
    if (await fundWallet(wallet, io)) io.stdout("ready\n");
    return 0;
  }
  let wallet = readWallet(args.label);
  if (wallet.role !== args.role || (args.keyType && wallet.keyType !== args.keyType) || wallet.chainId !== args.chainId) {
    throw new WalletError("wallet_configuration_mismatch");
  }
  if (args.command === "export-address") {
    io.stdout(`${wallet.address ?? wallet.publicKey}\n`);
    return 0;
  }
  if (wallet.gatewayOrigin !== origin) throw new WalletError("wallet_gateway_mismatch");
  switch (args.command) {
    case "link":
      if (wallet.link.status === "approved" && wallet.link.linkId) throw new WalletError("wallet_already_linked");
      await linkWallet(wallet, io);
      return 0;
    case "fund":
      await fundWallet(wallet, io);
      return 0;
    case "status": {
      io.stdout(`label: ${wallet.label}\nrole: ${wallet.role}\nkey type: ${wallet.keyType}\n${wallet.address ? "address" : "public key"}: ${wallet.address ?? wallet.publicKey}\nchain: ${wallet.chainId}\ngateway: ${wallet.gatewayOrigin}\nfile: ${walletPath(wallet.label)} (mode 0600)\ncreated: ${wallet.createdAt}\nlocal status: ${wallet.link.status ?? "unlinked"}\n`);
      if (wallet.link.requestId) {
        const data = await walletRequest(origin, requestPath(wallet.link.requestId), "GET");
        const status = pollState(data);
        // Revocation is permanent for this link, even if the original request
        // continues to report its historical approval.
        if (wallet.link.status !== "revoked") wallet = saveState(wallet, data);
        io.stdout(`request status: ${status}\n`);
        if (["denied", "expired", "failed"].includes(status)) throw new WalletError(status);
      }
      return 0;
    }
    case "revoke": {
      const apiKey = args.apiKey || process.env.PCC_API_KEY;
      if (!apiKey) throw new WalletError("revoke from the dashboard (Wallets → Unlink), or pass an owner API key", 2);
      if (!wallet.link.linkId) throw new WalletError("linked_wallet_required");
      const data = await walletRequest(origin, `/api/wallets/${encodeURIComponent(wallet.link.linkId)}/revoke`, "POST",
        args.reason ? { reason: args.reason } : {}, apiKey);
      if (data.status !== "revoked") invalidResponse();
      updateLink(wallet, { ...wallet.link, status: "revoked" });
      io.stdout("revoked\n");
      return 0;
    }
  }
}

export async function main(argv: string[] = process.argv.slice(2), overrides: Partial<WalletRuntime> = {}): Promise<number> {
  const io = { ...defaults(), ...overrides };
  try {
    const args = parseArgs(argv);
    if (!args) { io.stdout(HELP); return 0; }
    return await execute(args, io);
  } catch (error) {
    const safe = error instanceof WalletError ? error : new WalletError("wallet_operation_failed");
    io.stderr(`${safe.code}\n`);
    return safe.exitCode;
  }
}

function isDirectRun(): boolean {
  try {
    return Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
  } catch { return false; }
}

if (isDirectRun()) {
  main().then((code) => { process.exitCode = code; }, () => {
    process.stderr.write("wallet_operation_failed\n");
    process.exitCode = 1;
  });
}
