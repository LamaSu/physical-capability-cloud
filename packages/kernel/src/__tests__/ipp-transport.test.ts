/** T1-T10 exercise Node's real HTTP parser over a Duplex, without sockets. */
import { Buffer } from "node:buffer";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpIppTransport } from "../adapters/ipp-transport.js";
import type { IppTransportRequest } from "../adapters/ipp-transport.js";

class ResponseDuplex extends Duplex {
  connecting = false;
  readonly writes: Buffer[] = [];
  private answered = false;

  constructor(private readonly answer: (connection: ResponseDuplex) => void) { super(); }
  _read(): void {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.writes.push(Buffer.from(chunk));
    if (!this.answered) {
      this.answered = true;
      queueMicrotask(() => this.answer(this));
    }
    callback();
  }
  respond(bytes: string, close = true): void {
    this.push(Buffer.from(bytes, "ascii"));
    if (close) this.push(null);
  }
}

function request(overrides: Partial<IppTransportRequest> = {}): IppTransportRequest {
  return {
    host: "printer.invalid", port: 631, path: "/ipp/print", body: new Uint8Array([1, 1, 0, 2]),
    deadlineMs: 1_000, maxResponseBytes: 1_024, ...overrides,
  };
}

function scripted(answer: string | ((connection: ResponseDuplex) => void)) {
  const connection = new ResponseDuplex(typeof answer === "string" ? (stream) => stream.respond(answer) : answer);
  const createConnection = vi.fn(() => connection);
  // Node 22 ignores createConnection with agent:false. The production factory's
  // internal per-request Agent seam injects this Duplex into the actual parser.
  return { connection, createConnection, transport: createHttpIppTransport({ createConnection }) };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("HTTP IPP transport, socket-free", () => {
  it("T1: accepts an exact Content-Length and sends the fixed POST headers and exact body", async () => {
    // Revert the explicit request headers or res.end completeness check to fail.
    const { transport, connection, createConnection } = scripted("HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nIPP");
    const result = await transport(request());
    expect(result).toEqual({ ok: true, httpStatus: 200, body: Buffer.from("IPP") });
    expect(createConnection).toHaveBeenCalledTimes(1);
    const sent = Buffer.concat(connection.writes);
    const headerEnd = sent.indexOf("\r\n\r\n") + 4;
    const headers = sent.subarray(0, headerEnd).toString("ascii");
    expect(headers).toContain("POST /ipp/print HTTP/1.1\r\n");
    expect(headers).toContain("Content-Type: application/ipp\r\n");
    expect(headers).toContain("Content-Length: 4\r\n");
    expect(headers).toContain("Connection: close\r\n");
    expect(headers).not.toMatch(/Expect:|Accept-Encoding:|Transfer-Encoding:/i);
    expect(sent.subarray(headerEnd)).toEqual(Buffer.from(request().body));
    expect(connection.destroyed).toBe(true);
  });

  it("T1: accepts chunked only once its terminal chunk arrives", async () => {
    // Revert the Transfer-Encoding check or res.complete check to fail.
    const { transport } = scripted("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nIPP\r\n0\r\n\r\n");
    expect(await transport(request())).toEqual({ ok: true, httpStatus: 200, body: Buffer.from("IPP") });
  });

  it("T2: refuses Content-Length together with chunked", async () => {
    // Revert strict parser/error classification or both-header refusal to fail.
    const { transport } = scripted("HTTP/1.1 200 OK\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nIPP\r\n0\r\n\r\n");
    expect(await transport(request())).toMatchObject({ ok: false, kind: "framing", sent: true });
  });

  it.each([
    ["identical duplicate Content-Length", "Content-Length: 3\r\nContent-Length: 3"],
    ["different duplicate Content-Length", "Content-Length: 3\r\nContent-Length: 4"],
    ["comma Content-Length", "Content-Length: 3, 3"],
    ["non-decimal Content-Length", "Content-Length: +3"],
    ["unsupported coding", "Transfer-Encoding: gzip"],
    ["coding chain", "Transfer-Encoding: gzip, chunked"],
    ["duplicate Transfer-Encoding", "Transfer-Encoding: chunked\r\nTransfer-Encoding: chunked"],
  ])("T3: refuses %s", async (_name, headers) => {
    // Revert rawHeaders multiplicity/syntax checks or HPE_ classification to fail.
    const { transport } = scripted(`HTTP/1.1 200 OK\r\n${headers}\r\n\r\nIPP`);
    expect(await transport(request())).toMatchObject({ ok: false, kind: "framing", sent: true });
  });

  it.each([
    ["bad size", "X\r\nIPP\r\n0\r\n\r\n"],
    ["missing chunk CRLF", "3\r\nIPPXX0\r\n\r\n"],
    ["missing terminal chunk", "3\r\nIPP\r\n"],
  ])("T4: refuses %s", async (_name, body) => {
    // Revert strict parser mode or incomplete-response handlers to fail.
    const { transport } = scripted(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${body}`);
    const result = await transport(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["framing", "incomplete"]).toContain(result.kind);
  });

  it("T5: reports a short Content-Length body as incomplete", async () => {
    // Revert res.aborted/close handlers or exact length check to fail.
    const { transport } = scripted("HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nIPP");
    expect(await transport(request())).toMatchObject({ ok: false, kind: "incomplete", sent: true });
  });

  it("T6: destroys the connection as bytes exceed the cap", async () => {
    // Revert the streaming total > maxResponseBytes check to fail.
    const { transport, connection } = scripted("HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\n1234");
    expect(await transport(request({ maxResponseBytes: 3 }))).toMatchObject({ ok: false, kind: "too_large", sent: true });
    expect(connection.destroyed).toBe(true);
  });

  it("T7: one hard deadline covers silence and clears its timer", async () => {
    // Revert the total setTimeout or finish's clearTimeout to fail.
    vi.useFakeTimers();
    const { transport, connection } = scripted(() => {});
    const pending = transport(request({ deadlineMs: 100 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ ok: false, kind: "deadline", sent: true });
    expect(connection.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("T7: receiving partial body bytes does not extend the hard deadline", async () => {
    // Replacing the total timer with an idle socket timeout makes this fail.
    vi.useFakeTimers();
    const { transport, connection } = scripted((stream) => stream.respond("HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\n1", false));
    const pending = transport(request({ deadlineMs: 100 }));
    await vi.advanceTimersByTimeAsync(90);
    connection.push(Buffer.from("2"));
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject({ ok: false, kind: "deadline" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("T8: refuses close-delimited framing by name", async () => {
    // Revert the no-framing-header refusal to fail.
    const { transport } = scripted("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nIPP");
    expect(await transport(request())).toMatchObject({ ok: false, kind: "framing", message: expect.stringContaining("close-delimited") });
  });

  it("T9: a socket creation failure has sent:false and exposes no endpoint or raw error", async () => {
    // Revert pre-connection sent:false tracking or sanitized catch to fail.
    const transport = createHttpIppTransport({ createConnection: () => { throw new Error("secret-user:password@printer.invalid"); } });
    const result = await transport(request());
    expect(result).toMatchObject({ ok: false, kind: "connect", sent: false });
    if (!result.ok) expect(result.message).not.toMatch(/secret|password|printer.invalid/);
  });

  it("T9: a socket that fails before connecting has sent:false", async () => {
    // Revert socket.connecting and connect event handling to fail.
    const { transport, connection } = scripted((stream) => stream.destroy(new Error("refused")));
    connection.connecting = true;
    expect(await transport(request())).toMatchObject({ ok: false, kind: "connect", sent: false });
  });

  it("T9: a failure after connection has sent:true", async () => {
    // Revert socket-established sent:true tracking to fail.
    const { transport } = scripted((stream) => stream.destroy(new Error("network failed")));
    expect(await transport(request())).toMatchObject({ ok: false, kind: "io", sent: true });
  });

  it.each([404, 303])("T10: returns HTTP %i without following its Location", async (status) => {
    // Adding redirect following or refusing statuses in the transport makes this fail.
    const { transport, createConnection } = scripted(`HTTP/1.1 ${status} Response\r\nLocation: http://elsewhere.invalid/\r\nContent-Length: 3\r\n\r\nIPP`);
    expect(await transport(request())).toEqual({ ok: true, httpStatus: status, body: Buffer.from("IPP") });
    expect(createConnection).toHaveBeenCalledTimes(1);
  });

  it("abort destroys an in-flight connection and clears the hard deadline", async () => {
    // Revert signal listener/finish cleanup to fail.
    vi.useFakeTimers();
    const controller = new AbortController();
    const { transport, connection } = scripted(() => {});
    const pending = transport(request({ signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, kind: "aborted", sent: true });
    expect(connection.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an already-aborted signal performs no connection work and creates no timer", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    const { transport, createConnection } = scripted(() => {});
    expect(await transport(request({ signal: controller.signal }))).toMatchObject({ ok: false, kind: "aborted", sent: false });
    expect(createConnection).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("success and parser failure both clear the hard deadline", async () => {
    vi.useFakeTimers();
    for (const raw of ["HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nIPP", "HTTP/1.1 200 OK\r\nContent-Length: 3,3\r\n\r\nIPP"]) {
      const { transport } = scripted(raw);
      const result = transport(request());
      await vi.advanceTimersByTimeAsync(0);
      await result;
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});
