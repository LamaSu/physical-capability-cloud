/** Bounded HTTP exchange for IPP. A failure never implies the device received nothing. */
import { Agent, request as httpRequest } from "node:http";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { Buffer } from "node:buffer";
import type { Duplex } from "node:stream";

export interface IppTransportRequest {
  host: string;
  port: number;
  path: string;
  body: Uint8Array;
  deadlineMs: number;
  maxResponseBytes: number;
  signal?: AbortSignal;
}

export type IppTransportResult =
  | { ok: true; httpStatus: number; body: Uint8Array }
  | {
      ok: false;
      kind: "connect" | "deadline" | "aborted" | "framing" | "too_large" | "incomplete" | "io";
      sent: boolean;
      message: string;
    };

export type IppTransport = (request: IppTransportRequest) => Promise<IppTransportResult>;

/** @internal A socket-free test seam; production callers omit these options. */
interface HttpIppTransportOptions {
  createConnection?: (options: RequestOptions) => Duplex;
}

type FailureKind = Extract<IppTransportResult, { ok: false }>["kind"];

/** Each invocation sends once, uses one total deadline, and resolves on every exit. */
export function createHttpIppTransport(options: HttpIppTransportOptions = {}): IppTransport {
  return (input) => new Promise<IppTransportResult>((resolve) => {
    let settled = false;
    let sent = false;
    let req: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let testAgent: Agent | undefined;
    let abortSignal: AbortSignal | undefined;

    const finish = (result: IppTransportResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      // Destroy on success as well: Connection: close never leaves reusable sockets.
      req?.destroy();
      testAgent?.destroy();
      resolve(result);
    };
    const fail = (kind: FailureKind, message: string): void => finish({ ok: false, kind, sent, message });
    const onAbort = (): void => fail("aborted", "IPP request was aborted");

    try {
      if (!Number.isInteger(input.deadlineMs) || input.deadlineMs < 1 || input.deadlineMs > 0x7fffffff
          || !Number.isSafeInteger(input.maxResponseBytes) || input.maxResponseBytes < 1) {
        fail("io", "IPP transport requires a positive deadline and response size cap");
        return;
      }
      abortSignal = input.signal;
      if (abortSignal?.aborted) {
        onAbort();
        return;
      }
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => fail("deadline", "IPP request exceeded its total deadline"), input.deadlineMs);

      let agent: Agent | false = false;
      if (options.createConnection) {
        // Node 22 ignores options.createConnection with agent:false. A private Agent
        // injects the Duplex into the same real HTTP parser, only for this test seam.
        testAgent = new Agent({ keepAlive: false });
        testAgent.createConnection = options.createConnection as typeof testAgent.createConnection;
        agent = testAgent;
      }
      req = httpRequest({
        host: input.host,
        port: input.port,
        path: input.path,
        method: "POST",
        agent,
        insecureHTTPParser: false,
        headers: {
          "Content-Type": "application/ipp",
          "Content-Length": String(input.body.byteLength),
          Connection: "close",
        },
      }, (res) => {
        response = res;
        // A response proves a connection existed, even before its connect event.
        sent = true;
        // Install this before a framing refusal destroys the request/response.
        res.on("error", () => fail("incomplete", "IPP response failed before completion"));
        if (settled) { res.destroy(); return; }

        const lengths: string[] = [];
        const transfers: string[] = [];
        for (let index = 0; index < res.rawHeaders.length; index += 2) {
          const name = res.rawHeaders[index].toLowerCase();
          const value = res.rawHeaders[index + 1].replace(/^[ \t]+|[ \t]+$/g, "");
          if (name === "content-length") lengths.push(value);
          if (name === "transfer-encoding") transfers.push(value);
        }
        if (lengths.length && transfers.length) {
          fail("framing", "IPP response has both Content-Length and Transfer-Encoding");
          return;
        }
        if (lengths.length > 1 || (lengths.length === 1 && !/^[0-9]+$/.test(lengths[0]))) {
          fail("framing", "IPP response has malformed or duplicate Content-Length");
          return;
        }
        if (transfers.length > 1 || (transfers.length === 1 && transfers[0].toLowerCase() !== "chunked")) {
          fail("framing", "IPP response has unsupported or duplicate Transfer-Encoding");
          return;
        }
        if (!lengths.length && !transfers.length) {
          fail("framing", "IPP response uses unsupported close-delimited framing");
          return;
        }
        const length = lengths.length ? Number(lengths[0]) : undefined;
        if (length !== undefined && !Number.isSafeInteger(length)) {
          fail("framing", "IPP response Content-Length is not a safe byte count");
          return;
        }

        let total = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          total += chunk.byteLength;
          if (total > input.maxResponseBytes) {
            fail("too_large", "IPP response exceeded its size cap");
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (!res.complete || (length !== undefined && total !== length)) {
            fail("incomplete", "IPP response ended before its framing was complete");
            return;
          }
          finish({ ok: true, httpStatus: res.statusCode ?? 0, body: Buffer.concat(chunks, total) });
        });
        res.on("aborted", () => fail("incomplete", "IPP response was aborted before completion"));
        res.on("close", () => {
          if (!res.readableEnded) fail("incomplete", "IPP response closed before its end");
        });
      });
      req.on("socket", (socket) => {
        // Duplex test connections are already established. Real sockets keep
        // sent:false until connect, so DNS/refused connections are clean failures.
        if (!(socket as typeof socket & { connecting?: boolean }).connecting) sent = true;
        else socket.once("connect", () => { sent = true; });
      });
      req.on("error", (error: Error & { code?: string }) => {
        if (error.code?.startsWith("HPE_")) {
          fail("framing", "IPP response has malformed HTTP framing");
        } else if (response) {
          fail("incomplete", "IPP response failed before completion");
        } else if (!sent) {
          fail("connect", "IPP connection could not be established");
        } else {
          fail("io", "IPP connection failed after it was established");
        }
      });
      req.end(Buffer.from(input.body));
    } catch {
      // Never echo network errors: they can contain endpoints or response bytes.
      fail(sent ? "io" : "connect", sent
        ? "IPP request failed after its connection was established"
        : "IPP connection could not be established");
    }
  });
}
