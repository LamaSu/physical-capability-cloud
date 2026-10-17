import { randomBytes } from "node:crypto";
import { closeSync, constants, openSync, writeFileSync } from "node:fs";
import { receiptSignerFromSeed } from "../packages/gateway/src/settlement/receipt-signer.js";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out" || !args[1]) {
  process.stderr.write("usage: generate-gateway-receipt-key --out <path>\n");
  process.exitCode = 1;
} else {
  try {
    const seed = `0x${randomBytes(32).toString("hex")}`;
    const key = receiptSignerFromSeed(seed);
    if (!key) throw new Error("receipt key unavailable");
    const fd = openSync(args[1], constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      writeFileSync(fd, `${seed}\n`, "utf8");
    } finally {
      closeSync(fd);
    }
    process.stdout.write(`kid=${key.kid}\npublicKey=${key.publicKey}\n`);
  } catch {
    process.stderr.write("gateway receipt key generation failed\n");
    process.exitCode = 1;
  }
}
