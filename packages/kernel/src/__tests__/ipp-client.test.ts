/** C4/C5 and operation contracts. Each guard named here is the client line under test. */
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import vectors from "./fixtures/ipp-vectors.json" with { type: "json" };
import {
  IPP_INT_MAX, IPP_OPERATION, IPP_TAG, IPP_VALUE,
  decodeIppMessage, encodeIppMessage, enumValue, integerValue, keywordValue, textValue,
  type IppAttribute,
} from "../adapters/ipp-codec.js";
import { IppClient, ippCompletionVerdict, ippStatusName, sanitizeIppMessage, type IppClientConfig } from "../adapters/ipp-client.js";
import { FakeIppPrinter, ippResponse, jobResponse, printerResponse } from "./helpers/fake-ipp-printer.js";

const URI = "ipp://printer.test/ipp/print";
const DOCUMENT = Buffer.from("%PDF-1.4\n");
function client(printer: FakeIppPrinter, extra: Partial<IppClientConfig> = {}): IppClient {
  return new IppClient({ printerUri: URI, transport: printer.transport, ...extra });
}
function text(attribute: IppAttribute): string[] {
  return attribute.values.map(value => Buffer.from(value.bytes).toString("utf8"));
}

describe("IppClient wire operations", () => {
  it("exchange operationAttributes starts with charset, language and URI in RFC order", async () => {
    const printer = new FakeIppPrinter();
    const api = client(printer);
    await api.printJob({ jobName: "résumé.pdf", documentFormat: "application/pdf", document: DOCUMENT });
    await api.getJobAttributes(77);
    await api.cancelJob(77);
    await api.pausePrinter();
    await api.resumePrinter();
    await api.getPrinterAttributes(["printer-state", "printer-is-accepting-jobs"]);
    expect(printer.requests.map(request => request.requestId)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(printer.requests.map(request => request.code)).toEqual([
      IPP_OPERATION.PRINT_JOB, IPP_OPERATION.GET_JOB_ATTRIBUTES, IPP_OPERATION.CANCEL_JOB,
      IPP_OPERATION.PAUSE_PRINTER, IPP_OPERATION.RESUME_PRINTER, IPP_OPERATION.GET_PRINTER_ATTRIBUTES,
    ]);
    for (const request of printer.requests) {
      expect(request.version).toEqual([1, 1]);
      expect(request.groups).toHaveLength(1);
      expect(request.groups[0]!.tag).toBe(IPP_TAG.OPERATION_ATTRIBUTES);
      const attributes = request.groups[0]!.attributes;
      expect(attributes.slice(0, 3).map(attribute => attribute.name)).toEqual([
        "attributes-charset", "attributes-natural-language", "printer-uri",
      ]);
      expect(attributes.slice(0, 3).map(text)).toEqual([["utf-8"], ["en"], [URI]]);
    }
    const print = printer.requests[0]!;
    expect(print.groups[0]!.attributes.map(attribute => attribute.name)).toEqual([
      "attributes-charset", "attributes-natural-language", "printer-uri", "requesting-user-name", "job-name", "document-format",
    ]);
    expect(text(print.groups[0]!.attributes[3]!)).toEqual(["pcc-kernel"]);
    expect(print.groups[0]!.attributes[3]!.values[0]!.tag).toBe(IPP_VALUE.NAME);
    expect(text(print.groups[0]!.attributes[4]!)).toEqual(["résumé.pdf"]);
    expect(Buffer.from(print.data!)).toEqual(DOCUMENT);
    const getJob = printer.requests[1]!;
    expect(getJob.groups[0]!.attributes.slice(3).map(attribute => attribute.name)).toEqual(["job-id", "requested-attributes"]);
    expect(text(getJob.groups[0]!.attributes[4]!)).toEqual(["job-id", "job-state", "job-state-reasons", "job-impressions-completed"]);
    expect(getJob.groups[0]!.attributes[4]!.values.every(value => value.tag === IPP_VALUE.KEYWORD)).toBe(true);
    expect(printer.requests[2]!.groups[0]!.attributes.slice(3).map(attribute => attribute.name)).toEqual(["job-id", "requesting-user-name"]);
    expect(printer.requests[3]!.groups[0]!.attributes.slice(3).map(attribute => attribute.name)).toEqual(["requesting-user-name"]);
    expect(printer.requests[4]!.groups[0]!.attributes.slice(3).map(attribute => attribute.name)).toEqual(["requesting-user-name"]);
    expect(printer.requests[5]!.groups[0]!.attributes.slice(3).map(attribute => attribute.name)).toEqual(["requesting-user-name", "requested-attributes"]);
    expect(printer.transportRequests.map(raw => raw.deadlineMs)).toEqual([120000, 15000, 15000, 15000, 15000, 15000]);
    expect(printer.transportRequests.every(raw => raw.host === "printer.test" && raw.port === 631 && raw.path === "/ipp/print")).toBe(true);
  });

  it("exchange honors injected version, language, user, deadlines and cap", async () => {
    const printer = new FakeIppPrinter();
    const api = client(printer, {
      printerUri: "ipp://[::1]:8631/path%20space", version: [2, 0], requestingUserName: "pcc-node",
      naturalLanguage: "en-us", requestDeadlineMs: 31, printJobDeadlineMs: 53, maxResponseBytes: 97,
      nextRequestId: () => 77,
    });
    await api.printJob({ jobName: "test.pdf", documentFormat: "application/pdf", document: DOCUMENT });
    await api.pausePrinter();
    expect(printer.requests.every(request => request.version[0] === 2 && request.version[1] === 0 && request.requestId === 77)).toBe(true);
    expect(text(printer.requests[0]!.groups[0]!.attributes[1]!)).toEqual(["en-us"]);
    expect(text(printer.requests[0]!.groups[0]!.attributes[3]!)).toEqual(["pcc-node"]);
    expect(printer.transportRequests.map(raw => raw.deadlineMs)).toEqual([53, 31]);
    expect(printer.transportRequests.every(raw => raw.host === "::1" && raw.port === 8631 && raw.path === "/path%20space" && raw.maxResponseBytes === 97)).toBe(true);
  });

  it("nextRequestId wraps the default counter at signed integer max", async () => {
    const printer = new FakeIppPrinter();
    const api = client(printer);
    Object.assign(api, { requestId: IPP_INT_MAX });
    await api.pausePrinter();
    await api.resumePrinter();
    expect(printer.requests.map(request => request.requestId)).toEqual([IPP_INT_MAX, 1]);
  });

  it("exchange carries AbortSignal only on read operations", async () => {
    const printer = new FakeIppPrinter();
    const api = client(printer);
    const controller = new AbortController();
    await api.getJobAttributes(77, controller.signal);
    await api.getPrinterAttributes(["printer-state"], controller.signal);
    await api.cancelJob(77);
    expect(printer.transportRequests.map(raw => raw.signal)).toEqual([controller.signal, controller.signal, undefined]);
  });
});

describe("IppClient answer validation guards", () => {
  it.each([303, 404, 500])("exchange HTTP guard refuses %i before attempting decode and never follows redirects", async (httpStatus) => {
    const printer = new FakeIppPrinter(() => ({ ok: true, httpStatus, body: new Uint8Array([1]) }));
    const result = await client(printer).pausePrinter();
    expect(result).toMatchObject({ ok: false, kind: "http", sent: true, httpStatus });
    expect(printer.requests).toHaveLength(1);
  });

  it.each(["connect", "deadline", "aborted", "framing", "too_large", "incomplete", "io"] as const)("exchange surfaces %s transport failures without a retry or raw error text", async (kind) => {
    const printer = new FakeIppPrinter(() => ({ ok: false, kind, sent: kind !== "connect", message: "RAW_SECRET ipp://user:password@printer.test/path" }));
    const result = await client(printer).pausePrinter();
    expect(result).toMatchObject({ ok: false, kind, sent: kind !== "connect" });
    expect(printer.requests).toHaveLength(1);
    if (!result.ok) {
      expect(result.message).not.toContain("RAW_SECRET");
      expect(result.message).not.toContain("password");
      expect(result.message).not.toContain("printer.test");
    }
  });

  it("exchange contains an incorrectly throwing transport without leaking its error or retrying", async () => {
    const printer = new FakeIppPrinter(() => { throw new Error("ipp://user:secret@printer.test/ RAW_RESPONSE"); });
    const result = await client(printer).resumePrinter();
    expect(result).toMatchObject({ ok: false, kind: "io", sent: true, message: "IPP transport failed" });
    expect(printer.requests).toHaveLength(1);
  });

  it("exchange decode guard refuses malformed bytes before version/status checks", async () => {
    const printer = new FakeIppPrinter(() => ({ ok: true, httpStatus: 200, body: Buffer.from("MALFORMED_SECRET") }));
    const result = await client(printer).pausePrinter();
    expect(result).toMatchObject({ ok: false, kind: "decode", sent: true, httpStatus: 200 });
    expect(result.message).not.toContain("MALFORMED_SECRET");
  });

  it.each([[1, 0], [1, 2], [2, 0]] as [number, number][])("exchange exact-version guard refuses %i.%i and names both versions", async (major, minor) => {
    const printer = new FakeIppPrinter(request => ippResponse(request, { version: [major, minor], requestId: 88, statusCode: 0x0507 }));
    const result = await client(printer).pausePrinter();
    expect(result).toMatchObject({ ok: false, kind: "version", sent: true });
    if (!result.ok) {
      expect(result.message).toContain(`${major}.${minor}`);
      expect(result.message).toContain("1.1");
    }
  });

  it("exchange request-id guard runs before the IPP status guard", async () => {
    const printer = new FakeIppPrinter(request => ippResponse(request, { requestId: request.requestId + 1, statusCode: 0x0507 }));
    expect(await client(printer).pausePrinter()).toMatchObject({ ok: false, kind: "request_id", sent: true });
  });

  it.each([0x0000, 0x0001, 0x00ff])("exchange success-class guard accepts status 0x%s", async (statusCode) => {
    const printer = new FakeIppPrinter(request => ippResponse(request, { statusCode }));
    expect(await client(printer).pausePrinter()).toMatchObject({ ok: true, statusCode, httpStatus: 200 });
  });

  it.each([0x0401, 0x0402, 0x0403, 0x0404, 0x0501, 0x0506, 0x0507])("exchange status guard names failure 0x%s for one pause and one resume", async (statusCode) => {
    const printer = new FakeIppPrinter(request => ippResponse(request, { statusCode }));
    const api = client(printer);
    const pause = await api.pausePrinter();
    const resume = await api.resumePrinter();
    for (const result of [pause, resume]) {
      expect(result).toMatchObject({ ok: false, kind: "ipp_status", sent: true, statusCode, httpStatus: 200 });
      if (!result.ok) expect(result.message).toContain(ippStatusName(statusCode));
    }
    expect(printer.operationRequests(IPP_OPERATION.PAUSE_PRINTER)).toHaveLength(1);
    expect(printer.operationRequests(IPP_OPERATION.RESUME_PRINTER)).toHaveLength(1);
  });

  it("statusMessage/sanitizeIppMessage permits only printable, bounded text without URI credentials", async () => {
    const secret = `ipp://user:password@printer.test/path\n${"é".repeat(300)}`;
    const printer = new FakeIppPrinter(request => ippResponse(request, { statusCode: 0x0404, groups: [{
      tag: IPP_TAG.OPERATION_ATTRIBUTES,
      attributes: [{ name: "status-message", values: [textValue(secret)] }],
    }] }));
    const result = await client(printer).cancelJob(77);
    expect(result).toMatchObject({ ok: false, kind: "ipp_status", statusCode: 0x0404 });
    if (!result.ok) {
      expect(result.message).toContain("client-error-not-possible");
      expect(result.message).toMatch(/^[\x20-\x7e]{1,200}$/);
      expect(result.message).not.toMatch(/password|printer\.test|ipp:\/\//);
    }
    expect(sanitizeIppMessage("bad\u0000text")).toBe("bad?text");
  });

  it.each([0, -1, 1.5, IPP_INT_MAX + 1, NaN])("job-id input guard refuses %s before transport", async (jobId) => {
    const printer = new FakeIppPrinter();
    const api = client(printer);
    expect(await api.getJobAttributes(jobId)).toMatchObject({ ok: false, kind: "encode", sent: false });
    expect(await api.cancelJob(jobId)).toMatchObject({ ok: false, kind: "encode", sent: false });
    expect(printer.requests).toHaveLength(0);
  });

  it("exchange encode guard refuses a bad injected request-id before transport", async () => {
    const printer = new FakeIppPrinter();
    expect(await client(printer, { nextRequestId: () => 0 }).pausePrinter()).toMatchObject({ ok: false, kind: "encode", sent: false });
    expect(printer.requests).toHaveLength(0);
  });
});

describe("C5: every golden Print-Job answer (readJobId exact-single integer guard)", () => {
  it.each(Object.entries(vectors.print_job_answers))("%s returns only a proven job-id and never resends", async (_name, vector) => {
    const printer = new FakeIppPrinter(() => ({ ok: true, httpStatus: 200, body: Buffer.from(vector.hex, "hex") }));
    const api = client(printer, { version: [2, 0], nextRequestId: () => vector.requestId });
    const result = await api.printJob({ jobName: "job.pdf", documentFormat: "application/pdf", document: DOCUMENT });
    expect(result.ok ? result.jobId : null).toBe(vector.pccnodeJobId);
    expect(printer.operationRequests(IPP_OPERATION.PRINT_JOB)).toHaveLength(1);
    if (!result.ok) {
      expect(result.sent).toBe(true);
      if (decodeIppMessage(Buffer.from(vector.hex, "hex")).code > 0xff) {
        expect(result.kind).toBe("ipp_status");
        expect(result.statusCode).toBe(decodeIppMessage(Buffer.from(vector.hex, "hex")).code);
      } else expect(result.kind).toBe("job_id");
    }
  });
});

describe("C4: every golden job answer (strict identity and ippCompletionVerdict guards)", () => {
  it.each(Object.entries(vectors.get_job_attributes_answers))("%s agrees with pcc-node", async (_name, vector) => {
    const printer = new FakeIppPrinter(() => ({ ok: true, httpStatus: "httpStatus" in vector ? vector.httpStatus : 200, body: Buffer.from(vector.hex, "hex") }));
    const result = await client(printer, { version: [2, 0], nextRequestId: () => vector.requestId }).getJobAttributes(vector.askedJobId);
    const verdict = result.ok ? ippCompletionVerdict(result.jobState, result.jobStateReasons).verdict : "waiting";
    expect(verdict).toBe(vector.pccnodeVerdict);
    expect(printer.requests).toHaveLength(1);
    if (result.ok && result.jobState === 9 && vector.pccnodeVerdict === "waiting") {
      expect(result.jobStateReasons).toBeNull();
      expect(result.reasonsProblem).toBeTruthy();
    }
  });

  it.each(["job-completed-with-errors", "completed-with-errors"])("ippCompletionVerdict marks %s as with-errors", reason => {
    expect(ippCompletionVerdict(9, [reason])).toEqual({ verdict: "failed", completion: "with-errors" });
  });
  it.each(["job-canceled-by-user", "job-canceled-by-operator", "job-canceled-at-device", "aborted-by-system", "processing-to-stop-point"])("ippCompletionVerdict marks %s as stopped", reason => {
    expect(ippCompletionVerdict(9, [reason])).toEqual({ verdict: "failed", completion: "stopped" });
  });
  it("ippCompletionVerdict preserves queued-in-device precedence over terminal-error reasons", () => {
    expect(ippCompletionVerdict(9, ["queued-in-device", "job-completed-with-errors"])).toEqual({ verdict: "unobservable", completion: "unobservable" });
    expect(ippCompletionVerdict(9, ["none", "job-completed-with-errors"])).toEqual({ verdict: "failed", completion: "with-errors" });
    expect(ippCompletionVerdict(9, ["job-completed-successfully", "job-restartable"])).toEqual({ verdict: "completed" });
    expect(ippCompletionVerdict(42, ["none"])).toEqual({ verdict: "waiting" });
    expect(ippCompletionVerdict(null, ["none"])).toEqual({ verdict: "waiting" });
  });
});

describe("Get-Job-Attributes strict readers", () => {
  it("getJobAttributes returns a valid impressions count, and ignores unusable optional counts", async () => {
    const printer = new FakeIppPrinter(request => jobResponse(request, { jobState: 5, impressionsCompleted: 3 }));
    const result = await client(printer).getJobAttributes(77);
    expect(result).toMatchObject({ ok: true, jobId: 77, jobState: 5, jobStateReasons: ["job-printing"], impressionsCompleted: 3 });
    for (const values of [[integerValue(-1)], [enumValue(3)], [integerValue(1), integerValue(2)]]) {
      const malformed = new FakeIppPrinter(request => {
        const answer = jobResponse(request, { jobState: 5 });
        if (!answer.ok) throw new Error("bad fixture");
        const message = decodeIppMessage(answer.body);
        message.groups[0]!.attributes.push({ name: "job-impressions-completed", values });
        return { ok: true, httpStatus: 200, body: encodeIppMessage(message) };
      });
      const unusable = await client(malformed).getJobAttributes(77);
      expect(unusable.ok).toBe(true);
      expect(unusable).not.toHaveProperty("impressionsCompleted");
    }
  });

  it("getJobAttributes requires exactly one job group even when another group's state is clean", async () => {
    const printer = new FakeIppPrinter(request => ippResponse(request, { groups: [
      { tag: IPP_TAG.JOB_ATTRIBUTES, attributes: [{ name: "job-id", values: [integerValue(77)] }] },
      { tag: IPP_TAG.JOB_ATTRIBUTES, attributes: [{ name: "job-state", values: [enumValue(9)] }] },
    ] }));
    expect(await client(printer).getJobAttributes(77)).toMatchObject({ ok: false, kind: "job_id" });
  });

  it("getJobAttributes state reader cannot use an enum from the Unsupported group", async () => {
    const printer = new FakeIppPrinter(request => ippResponse(request, { groups: [
      { tag: IPP_TAG.UNSUPPORTED_ATTRIBUTES, attributes: [{ name: "job-state", values: [enumValue(9)] }] },
      { tag: IPP_TAG.JOB_ATTRIBUTES, attributes: [{ name: "job-id", values: [integerValue(77)] }, { name: "job-state-reasons", values: [keywordValue("none")] }] },
    ] }));
    expect(await client(printer).getJobAttributes(77)).toMatchObject({ ok: true, jobState: null, jobStateReasons: ["none"] });
  });

  it.each([
    { values: [integerValue(9)] }, { values: [enumValue(9), enumValue(9)] },
    { values: [{ tag: IPP_VALUE.ENUM, bytes: new Uint8Array([9]) }] },
  ])("getJobAttributes rejects non-single/non-enum/non-four-octet job-state %j", async ({ values }) => {
    const printer = new FakeIppPrinter(request => ippResponse(request, { groups: [{ tag: IPP_TAG.JOB_ATTRIBUTES, attributes: [
      { name: "job-id", values: [integerValue(77)] },
      { name: "job-state", values },
      { name: "job-state-reasons", values: [keywordValue("none")] },
    ] }] }));
    expect(await client(printer).getJobAttributes(77)).toMatchObject({ ok: true, jobState: null, jobStateProblem: expect.any(String) });
  });

  it("readJobReasons rejects duplicate attributes and a malformed value in a reason set", async () => {
    for (const reasonAttributes of [
      [{ name: "job-state-reasons", values: [keywordValue("none")] }, { name: "job-state-reasons", values: [keywordValue("none")] }],
      [{ name: "job-state-reasons", values: [keywordValue("job-completed-successfully"), { tag: IPP_VALUE.KEYWORD, bytes: Buffer.from("job-completed-with-errors ") }] }],
    ]) {
      const printer = new FakeIppPrinter(request => ippResponse(request, { groups: [{ tag: IPP_TAG.JOB_ATTRIBUTES, attributes: [
        { name: "job-id", values: [integerValue(77)] }, { name: "job-state", values: [enumValue(9)] }, ...reasonAttributes,
      ] }] }));
      expect(await client(printer).getJobAttributes(77)).toMatchObject({ ok: true, jobState: 9, jobStateReasons: null, reasonsProblem: expect.any(String) });
    }
  });

  it("getPrinterAttributes exposes parsed printer groups without manufacturing values", async () => {
    const printer = new FakeIppPrinter(request => printerResponse(request, { printerState: 4, acceptingJobs: false }));
    const result = await client(printer).getPrinterAttributes(["printer-state"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.groups[0]!.tag).toBe(IPP_TAG.PRINTER_ATTRIBUTES);
      expect(result.message.groups[0]!.attributes[0]!.values[0]!.tag).toBe(IPP_VALUE.ENUM);
      expect(Buffer.from(result.message.groups[0]!.attributes[0]!.values[0]!.bytes)).toEqual(Buffer.from(enumValue(4).bytes));
    }
  });
});
