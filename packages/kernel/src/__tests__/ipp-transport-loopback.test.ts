/** T11 repeats framing/deadline checks on real 127.0.0.1 HTTP sockets. */
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createHttpIppTransport } from "../adapters/ipp-transport.js";
import type { IppTransport, IppTransportRequest } from "../adapters/ipp-transport.js";

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (transport: IppTransport, request: IppTransportRequest) => Promise<void>,
  skip: () => void,
): Promise<void> {
  const server = createServer(handler);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    // These checks are written, not test-run in a socket-restricted sandbox.
    // The lane runs them normally; no application failure is converted to a skip.
    if (code === "EPERM" || code === "EACCES") { skip(); return; }
    throw error;
  }
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback server has no TCP address");
    await run(createHttpIppTransport(), {
      host: "127.0.0.1", port: address.port, path: "/ipp/print",
      body: new Uint8Array([1, 1, 0, 2]), deadlineMs: 1_000, maxResponseBytes: 1_024,
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function expectSocketClosed(closed: Promise<void>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("Production agent:false left the printer socket open")), 1000);
    closed.then(() => { clearTimeout(deadline); resolve(); }, error => { clearTimeout(deadline); reject(error); });
  });
}

describe("HTTP IPP transport, real loopback sockets (T11)", () => {
  it("T1: an exact Content-Length response succeeds", async ({ skip }) => {
    // Revert the transport's Content-Length acceptance or request POST headers to fail.
    await withServer((req, res) => {
      expect(req.method).toBe("POST");
      expect(req.headers["content-type"]).toBe("application/ipp");
      expect(req.headers["content-length"]).toBe("4");
      expect(req.headers.connection).toBe("close");
      res.writeHead(200, { "Content-Type": "application/ipp", "Content-Length": "3" });
      res.end("IPP");
    }, async (transport, request) => {
      expect(await transport(request)).toEqual({ ok: true, httpStatus: 200, body: Buffer.from("IPP") });
    }, skip);
  });

  it("T2: Content-Length with chunked is refused", async ({ skip }) => {
    // The server emits raw bytes so its own writer does not normalize ambiguous framing.
    await withServer((_req, res) => {
      res.socket?.end("HTTP/1.1 200 OK\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nIPP\r\n0\r\n\r\n");
    }, async (transport, request) => {
      expect(await transport(request)).toMatchObject({ ok: false, kind: "framing", sent: true });
    }, skip);
  });

  it("T5: a socket closing before Content-Length bytes is incomplete", async ({ skip }) => {
    // Revert the response aborted/close/completeness checks to fail.
    await withServer((_req, res) => {
      res.socket?.end("HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nIPP");
    }, async (transport, request) => {
      expect(await transport(request)).toMatchObject({ ok: false, kind: "incomplete", sent: true });
    }, skip);
  });

  for (const [name, body] of [
    ["chunk-framed", "3\r\nIPP\r\n0\r\n\r\n"],
    ["raw close-delimited", "RAW-BODY-NOT-CHUNKED"],
  ]) {
    it(`R4 F-4/PF: production transport refuses trailing HTAB with a ${name} body`, async ({ skip }) => {
      // Kills PF-trim over agent:false when sockets are available.
      await withServer((_req, res) => {
        res.socket?.end(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\t\r\n\r\n${body}`);
      }, async (transport, request) => {
        expect(await transport(request)).toMatchObject({ ok: false, kind: "framing", sent: true });
      }, skip);
    });
  }

  it("T7: a silent connected server is bounded by the total deadline", async ({ skip }) => {
    // Revert the transport's total deadline timer to fail.
    await withServer(() => {}, async (transport, request) => {
      expect(await transport({ ...request, deadlineMs: 100 })).toMatchObject({ ok: false, kind: "deadline", sent: true });
    }, skip);
  });

  it("T13: agent:false closes the real socket after too_large before server teardown", async ({ skip }) => {
    let onClose!: () => void;
    const closed = new Promise<void>(resolve => { onClose = resolve; });
    await withServer((req, res) => {
      req.socket.once("close", onClose);
      res.writeHead(200, { "Content-Length": "100" });
      res.write("1234"); // Keep the response open; only the client can close it.
    }, async (transport, request) => {
      expect(await transport({ ...request, maxResponseBytes: 3 })).toMatchObject({ ok: false, kind: "too_large", sent: true });
      await expectSocketClosed(closed);
    }, skip);
  });

  it("T13: agent:false closes the real socket after its deadline before server teardown", async ({ skip }) => {
    let onClose!: () => void;
    const closed = new Promise<void>(resolve => { onClose = resolve; });
    await withServer(req => { req.socket.once("close", onClose); }, async (transport, request) => {
      expect(await transport({ ...request, deadlineMs: 75 })).toMatchObject({ ok: false, kind: "deadline", sent: true });
      await expectSocketClosed(closed);
    }, skip);
  });

  it("T08: the production parser refuses bare-LF framing", async ({ skip }) => {
    await withServer((_req, res) => {
      res.socket?.end("HTTP/1.1 200 OK\nContent-Length: 3\n\nIPP");
    }, async (transport, request) => {
      expect(await transport(request)).toMatchObject({ ok: false, kind: "framing", sent: true });
    }, skip);
  });
});
