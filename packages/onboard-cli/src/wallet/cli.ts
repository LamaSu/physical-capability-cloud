#!/usr/bin/env node
import { createInterface } from "node:readline";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "../lib/config.js";
import { WalletError } from "./errors.js";
import {
  assertWalletAbsent, createWallet, readWallet, updateLink, validateLabel, walletPath,
  type WalletRecord, type Role, type KeyType,
} from "./keystore.js";
import { signWalletMessage } from "./keys.js";
import { validateProofMessage } from "./proof.js";
import { requestFunding, validateTransportUrl, waitForFundingReceipt, walletRequest, type FundingResult } from "./http.js";

const CLIENT_VERSION = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

export interface WalletRuntime {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdinIsTTY: boolean;
  prompt: () => Promise<string>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  waitForReceipt: (hash: `0x${string}`, rpcUrl: string, timeoutMs: number) => Promise<{ status: "success" | "reverted" }>;
  receiptTimeoutMs: number;
}

const HELP = `pcc-wallet — a wallet key held on your computer
Usage: pcc-wallet <command> --role agent|device --label <label> [options]
       onboard wallet <command> [options]

Commands: init, link, fund, status, revoke, export-address
  init            Consent, create a key, link with browser approval, then fund
  link            Request browser approval for an existing key
  fund            Request test funds for an approved link
  status          Show public local facts and the stored request's status
  revoke          Use the approving API key; dashboard approvals: Wallets → Unlink
  export-address  Print the address or public key only

Options:
  --role agent|device                 Required
  --label <label>                      File name, 1–64 letters/digits/._@-
  --key-type secp256k1|ed25519          Defaults: agent secp256k1, device ed25519
  --chain-id 84532                     Base Sepolia only
  --gateway <origin>                   Same gateway resolution as onboard
  --public-origin <url>                Browser/proof origin (default: gateway origin)
  --rpc-url <url>                      Base Sepolia receipts (env: PCC_RPC_URL)
  --kernel-id <id>                     Optional device binding on init/link
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
  publicOrigin?: string;
  yes: boolean;
  apiKey?: string;
  reason?: string;
  kernelId?: string;
  rpcUrl?: string;
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
    if (!["--role", "--label", "--key-type", "--chain-id", "--gateway", "--public-origin", "--api-key", "--reason", "--kernel-id", "--rpc-url"].includes(flag)) {
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
  const kernelId = values["--kernel-id"];
  if (kernelId !== undefined) {
    if (role !== "device") throw new WalletError("kernel_id_requires_device");
    if (!/^[\x21-\x7E]{1,128}$/.test(kernelId) || /^(?:eip155|ed25519):/i.test(kernelId)) throw new WalletError("invalid_kernel_id");
    if (command !== "init" && command !== "link") throw new WalletError("invalid_wallet_option");
  }
  return {
    command: command as Command, role, label, keyType, chainId: 84532,
    gateway: values["--gateway"], publicOrigin: values["--public-origin"], yes, apiKey: values["--api-key"], reason, kernelId,
    rpcUrl: values["--rpc-url"],
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
    waitForReceipt: waitForFundingReceipt, receiptTimeoutMs: 60_000,
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

async function linkWallet(wallet: WalletRecord, io: WalletRuntime, kernelId?: string, publicOrigin = wallet.gatewayOrigin): Promise<WalletRecord> {
  const created = await walletRequest(wallet.gatewayOrigin, "/api/wallets/link-requests", "POST", {
    keyType: wallet.keyType,
    ...(wallet.keyType === "secp256k1" ? { address: wallet.address } : { publicKey: wallet.publicKey }),
    role: wallet.role, label: wallet.label, chainId: wallet.chainId,
    clientInfo: { name: "pcc-wallet", version: CLIENT_VERSION },
    ...(kernelId === undefined ? {} : { kernelId }),
  });
  if (!identifier(created.requestId) || !created.requestId.startsWith("lr_")
    || typeof created.userCode !== "string" || !/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/.test(created.userCode)
    || created.verificationUri !== `${publicOrigin}/link`
    || typeof created.message !== "string" || typeof created.expiresAt !== "string"
    || !Number.isSafeInteger(created.interval) || (created.interval as number) <= 0) invalidResponse();
  const expiresAt = Date.parse(created.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= io.now()) invalidResponse();
  wallet = updateLink(wallet, { requestId: created.requestId, status: "pending_proof" });
  validateProofMessage(created.message, wallet, created.requestId, io.now(), kernelId, publicOrigin);
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

function printClaims(result: FundingResult, io: WalletRuntime): void {
  for (const claim of result.claims) io.stdout(`${claim.token} ${claim.amount} ${claim.status}${claim.txHash ? ` ${claim.txHash}` : ""}\n`);
  for (const entry of result.skipped ?? []) io.stdout(`${entry.token} ${entry.amount} skipped: ${entry.reason} (${entry.cap})\n`);
}

async function fundWallet(wallet: WalletRecord, io: WalletRuntime, rpcUrl: string): Promise<boolean> {
  if (wallet.keyType === "ed25519") throw new WalletError("not_fundable");
  if (!wallet.link.linkId || !wallet.link.requestId || wallet.link.status !== "approved") throw new WalletError("approved_link_required");
  const deadline = io.now() + 60_000;
  for (let attempt = 0; attempt < 8; attempt++) {
    const result = await requestFunding(wallet.gatewayOrigin, wallet.link.requestId, wallet.role);
    if (result.status === "unavailable") {
      io.stdout("funding is not available on this gateway; ask the operator for test funds\nlinked (unfunded)\n");
      return false;
    }
    if (result.status === "pending") {
      if (attempt === 7 || io.now() >= deadline) {
        printClaims(result, io);
        throw new WalletError("funding_pending");
      }
      await io.sleep(Math.min(500 * 2 ** attempt, 10_000, deadline - io.now()));
      if (io.now() >= deadline) { printClaims(result, io); throw new WalletError("funding_pending"); }
      continue;
    }
    if (result.status === "partial") {
      printClaims(result, io);
      io.stdout("Run pcc-wallet fund again after 30 s to retry failed claims.\n");
    }
    const receiptDeadline = io.now() + io.receiptTimeoutMs;
    for (const claim of result.claims) {
      if (!claim.txHash) continue;
      const remaining = receiptDeadline - io.now();
      if (remaining < 2) throw new WalletError("funding_receipt_timeout");
      let receipt: { status: "success" | "reverted" };
      try { receipt = await io.waitForReceipt(claim.txHash, rpcUrl, remaining); }
      catch (error) {
        if (error instanceof WalletError) throw error;
        throw new WalletError("funding_rpc_unavailable");
      }
      if (receipt.status !== "success") throw new WalletError("funding_transaction_reverted");
    }
    if (result.status === "partial") throw new WalletError("funding_partial");
    printClaims(result, io);
    io.stdout("funded\n");
    return true;
  }
  throw new WalletError("funding_pending");
}

async function execute(args: Args, io: WalletRuntime): Promise<number> {
  if (args.command === "revoke" && !args.apiKey && !process.env.PCC_API_KEY) {
    throw new WalletError("revoke from the dashboard (Wallets → Unlink), or pass an owner API key", 2);
  }
  const origin = gatewayOrigin(args.gateway);
  const publicOrigin = args.publicOrigin === undefined ? origin : validateTransportUrl(args.publicOrigin).origin;
  const rpcUrl = args.rpcUrl ?? (process.env.PCC_RPC_URL || "https://sepolia.base.org");
  if (args.command === "init" || args.command === "fund") validateTransportUrl(rpcUrl, "rpc");
  if (args.command === "init") {
    assertWalletAbsent(args.label);
    const keyType = args.keyType ?? (args.role === "agent" ? "secp256k1" : "ed25519");
    io.stdout(`pcc wallet init --role ${args.role} --label ${args.label}\nThis creates a NEW wallet key on this computer:\n  file      ${walletPath(args.label)} (mode 0600)\n  network   Base Sepolia (test network). Test funds have no value.\n  custody   only this file. PCC never receives it and cannot recover it.\nNext: your PCC account owner approves the link in a browser; ${keyType === "ed25519" ? "No test funds are available for ed25519 keys." : "then test funds arrive."}\nType "create" to continue:\n`);
    if (!(args.yes && !io.stdinIsTTY) && (await io.prompt()).trim() !== "create") {
      throw new WalletError("creation_cancelled");
    }
    let wallet = createWallet({
      label: args.label, role: args.role,
      keyType,
      chainId: args.chainId, gatewayOrigin: origin, createdAt: new Date(io.now()).toISOString(),
    });
    wallet = await linkWallet(wallet, io, args.kernelId, publicOrigin);
    if (wallet.keyType === "ed25519") { io.stdout("linked (unfunded: not_fundable)\n"); return 0; }
    try {
      if (await fundWallet(wallet, io, rpcUrl)) io.stdout("ready\n");
    } catch (error) {
      if (error instanceof WalletError && (
        (error.httpStatus === 403 && error.code === "link_inactive")
        || (error.httpStatus === 409 && ["cap_reached", "not_fundable"].includes(error.code))
        || (error.httpStatus === 502 && error.code === "faucet_error")
        || (error.httpStatus === 503 && error.code === "faucet_unavailable")
      )) {
        io.stdout(`linked (unfunded: ${error.code}${error.errorClass ? `, ${error.errorClass}` : ""})\n`);
        if (error.cap) io.stdout(`cap: ${error.cap}\n`);
      } else throw error;
    }
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
      await linkWallet(wallet, io, args.kernelId, publicOrigin);
      return 0;
    case "fund":
      await fundWallet(wallet, io, rpcUrl);
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
      let data: Record<string, unknown>;
      try {
        data = await walletRequest(origin, `/api/wallets/${encodeURIComponent(wallet.link.linkId)}/revoke`, "POST",
          args.reason ? { reason: args.reason } : {}, apiKey);
      } catch (error) {
        if (error instanceof WalletError && error.httpStatus === 404) {
          throw new WalletError("This API key did not approve the link; use the approving API key or revoke from the dashboard (Wallets → Unlink).", 2);
        }
        throw error;
      }
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
    if (args.apiKey) io.stderr("Note: --api-key is visible to other local users; prefer PCC_API_KEY.\n");
    return await execute(args, io);
  } catch (error) {
    const safe = error instanceof WalletError ? error : new WalletError("wallet_operation_failed");
    io.stderr(`${safe.code}${safe.errorClass ? `, ${safe.errorClass}` : ""}${safe.cap ? ` (cap: ${safe.cap})` : ""}\n`);
    if (safe.code === "expired") io.stderr("The request expired, or the owner's page said it was already linked; start again with a new key.\n");
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
