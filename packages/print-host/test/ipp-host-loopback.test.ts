import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { verifyBundleSignature } from "@pcc/kernel-sdk";
import type { EvidenceBundle } from "@pcc/spec";
import {
  IPP_OPERATION, IPP_TAG, booleanValue, decodeIppMessage, encodeIppMessage,
  enumValue, integerValue, keywordValue, type IppGroup, type IppMessage,
} from "../../kernel/dist/adapters/ipp-codec.js";
import { main } from "../src/cli.js";
import { createGatewayClient, type RelayEvidenceBundle } from "../src/gateway-client.js";
import { generateHostKeys } from "../src/keygen.js";

/** The kernel's fake-printer test helper is not published in its built package. */
function reply(request: IppMessage, groups: IppGroup[]): Buffer {
  return Buffer.from(encodeIppMessage({ version: request.version, code: 0, requestId: request.requestId, groups }));
}

describe("real IPP host loopback", () => {
  it("prints the PDF over production HTTP and relays a genuine session bundle without a chain send", async () => {
    const root = await mkdtemp(join(tmpdir(), "ph2-real-ipp-"));
    const requests: IppMessage[] = [];
    const serverErrors: unknown[] = [];
    const server = createServer((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      incoming.on("end", () => {
        try {
          const request = decodeIppMessage(Buffer.concat(chunks));
          requests.push(request);
          let groups: IppGroup[];
          if (request.code === IPP_OPERATION.GET_PRINTER_ATTRIBUTES) {
            groups = [{ tag: IPP_TAG.PRINTER_ATTRIBUTES, attributes: [
              { name: "printer-state", values: [enumValue(3)] },
              { name: "printer-state-reasons", values: [keywordValue("none")] },
              { name: "printer-is-accepting-jobs", values: [booleanValue(true)] },
            ] }];
          } else if (request.code === IPP_OPERATION.PRINT_JOB || request.code === IPP_OPERATION.GET_JOB_ATTRIBUTES) {
            groups = [{ tag: IPP_TAG.JOB_ATTRIBUTES, attributes: [
              { name: "job-id", values: [integerValue(77)] },
              ...(request.code === IPP_OPERATION.GET_JOB_ATTRIBUTES ? [
                { name: "job-state", values: [enumValue(9)] },
                { name: "job-state-reasons", values: [keywordValue("job-completed-successfully")] },
                { name: "job-impressions-completed", values: [integerValue(1)] },
              ] : []),
            ] }];
          } else throw new Error("unexpected loopback IPP operation");
          const body = reply(request, groups);
          response.writeHead(200, { "content-type": "application/ipp", "content-length": String(body.length) });
          response.end(body);
        } catch (error) { serverErrors.push(error); response.writeHead(500).end(); }
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("loopback printer has no TCP address");
      const generated = await generateHostKeys(join(root, "keys"));
      const rpcUrlFile = join(root, "rpc-url");
      const apiKeyFile = join(root, "api-key");
      await writeFile(rpcUrlFile, "http://127.0.0.1:1/unused\n", { mode: 0o600 });
      await writeFile(apiKeyFile, `pcc_test_${randomBytes(24).toString("hex")}\n`, { mode: 0o600 });
      const inputsDir = join(root, "inputs");
      const dataDir = join(root, "data");
      await mkdir(inputsDir, { mode: 0o700 });
      await mkdir(dataDir, { mode: 0o700 });
      const configFile = join(root, "host.json");
      await writeFile(configFile, JSON.stringify({
        kernelId: "loopback-kernel", deviceId: "loopback-printer",
        printer: { uri: `ipp://127.0.0.1:${address.port}/ipp/print` },
        chain: { chainId: 31337, rpcUrlFile },
        gateway: { baseUrl: "https://gateway.example.test", apiKeyFile },
        keys: { deviceKeyFile: generated.paths.deviceKeyFile, operatorKeyFile: generated.paths.operatorKeyFile },
        dataDir,
      }), { mode: 0o600 });
      const pdf = Buffer.from("%PDF-1.7\nreal HTTP loopback document\n%%EOF\n");
      await writeFile(join(inputsDir, "buyer.pdf"), pdf);
      await writeFile(join(inputsDir, "loopback-job.json"), JSON.stringify({
        jobName: "buyer.pdf", documentFile: "buyer.pdf", totalPages: 1,
        unit: {
          settlementUnitId: `0x${randomBytes(32).toString("hex")}`,
          challengeNonce: `0x${randomBytes(32).toString("hex")}`,
          fundedAt: Math.floor(Date.now() / 1000) - 60, reclaimAt: Math.floor(Date.now() / 1000) + 3600,
        },
      }));
      const calls: Array<{ path: string; method: string }> = [];
      let posted: RelayEvidenceBundle | undefined;
      const fetchImpl = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async (input, init) => {
        const path = new URL(String(input)).pathname;
        calls.push({ path, method: init?.method ?? "GET" });
        let body: unknown;
        if (path.endsWith("/heartbeat")) body = { acknowledged: true };
        else if (path.endsWith("/jobs")) body = {
          emergencyStop: "clear", jobs: [{ id: "loopback-job", kernelId: "loopback-kernel", status: "queued" }],
        };
        else if (path.endsWith("/job-status")) body = { updated: true };
        else if (path.endsWith("/evidence")) {
          const request = JSON.parse(String(init?.body));
          posted = request.evidence;
          body = { stored: true, jobId: request.jobId, contentHash: request.evidence.bundleHash, hashModel: "event_bundle_hash" };
        } else throw new Error("unexpected fake gateway call");
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      });
      const createBroadcaster = vi.fn(() => { throw new Error("no-submit must not create a chain sender"); });
      let stdout = "";
      let stderr = "";
      expect(await main(["run", "--config", configFile, "--once", "--no-submit", "--inputs-dir", inputsDir], {
        stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } },
      }, { createGateway: config => createGatewayClient({ ...config, fetchImpl }), createBroadcaster })).toBe(0);
      expect(stderr).toBe("");
      expect(serverErrors).toEqual([]);
      const prints = requests.filter(request => request.code === IPP_OPERATION.PRINT_JOB);
      expect(prints).toHaveLength(1);
      expect(Buffer.from(prints[0]!.data!)).toEqual(pdf);
      expect(requests.some(request => request.code === IPP_OPERATION.GET_JOB_ATTRIBUTES)).toBe(true);
      expect(calls.filter(call => call.path === "/api/operator/evidence")).toEqual([
        { path: "/api/operator/evidence", method: "POST" },
      ]);
      expect(posted?.events.length).toBeGreaterThan(0);
      expect(posted!.events.some(event => event.type === "execution_completed")).toBe(true);
      expect(posted!.events.every(event => event.source.simulated === false)).toBe(true);
      expect(posted!.sessionKeyAuthorization).toBeDefined();
      expect(posted!.kernelSignature?.algorithm).toBe("ed25519");
      const sessionKey = Buffer.from(posted!.sessionKeyAuthorization!.publicKey.replace(/^0x/, ""), "hex");
      expect(verifyBundleSignature(posted as EvidenceBundle, sessionKey)).toBe(true);
      const records = (await readFile(join(dataDir, "journal", "loopback-job.jsonl"), "utf8"))
        .trim().split("\n").map(line => JSON.parse(line));
      expect(records.at(-1)).toMatchObject({ state: "evidence_stored", code: "submit_disabled" });
      expect(stdout.split("\n")).toContain("submit_disabled");
      expect(createBroadcaster).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
