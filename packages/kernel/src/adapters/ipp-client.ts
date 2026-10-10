/** IPP operations over an injected byte transport. No retries and no clock. */
import { URL } from "node:url";
import {
  IPP_INT_MAX, IPP_OPERATION, IPP_STATUS, IPP_TAG,
  charsetValue, decodeIppMessage, encodeIppMessage, integerValue, jobGroup,
  keywordValue, mimeMediaTypeValue, nameValue, naturalLanguageValue,
  readEnum, readInteger, readKeyword, readText, singleAttribute, uriValue,
  type IppAttribute, type IppGroup, type IppMessage, type IppValue,
} from "./ipp-codec.js";
import type { IppTransport, IppTransportResult } from "./ipp-transport.js";

export interface IppClientConfig {
  printerUri: string;
  transport: IppTransport;
  version?: [number, number];
  requestingUserName?: string;
  naturalLanguage?: string;
  requestDeadlineMs?: number;
  printJobDeadlineMs?: number;
  maxResponseBytes?: number;
  nextRequestId?: () => number;
}

export interface IppClientFailure {
  ok: false;
  kind: string;
  sent: boolean;
  httpStatus?: number;
  statusCode?: number;
  message: string;
}

export interface IppClientSuccess {
  ok: true;
  message: IppMessage;
  httpStatus: 200;
  statusCode: number;
}

export type IppClientResult = IppClientSuccess | IppClientFailure;
export type IppPrintJobResult = (IppClientSuccess & { jobId: number }) | IppClientFailure;
export type IppGetJobAttributesResult = (IppClientSuccess & {
  jobId: number;
  jobState: number | null;
  jobStateProblem?: string;
  jobStateReasons: string[] | null;
  reasonsProblem?: string;
  impressionsCompleted?: number;
}) | IppClientFailure;

/** Printable, bounded diagnostic text. URI text is never copied to diagnostics. */
export function sanitizeIppMessage(message: string): string {
  return message
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"']*/gi, "[redacted URI]")
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, 200);
}

const STATUS_NAMES: Readonly<Record<number, string>> = {
  0x0000: "successful-ok",
  0x0001: "successful-ok-ignored-or-substituted-attributes",
  0x0002: "successful-ok-conflicting-attributes",
  0x0400: "client-error-bad-request",
  0x0401: "client-error-forbidden",
  0x0402: "client-error-not-authenticated",
  0x0403: "client-error-not-authorized",
  0x0404: "client-error-not-possible",
  0x0405: "client-error-timeout",
  0x0406: "client-error-not-found",
  0x0407: "client-error-gone",
  0x0408: "client-error-request-entity-too-large",
  0x0409: "client-error-request-value-too-long",
  0x040a: "client-error-document-format-not-supported",
  0x040b: "client-error-attributes-or-values-not-supported",
  0x040c: "client-error-uri-scheme-not-supported",
  0x040d: "client-error-charset-not-supported",
  0x040e: "client-error-conflicting-attributes",
  0x040f: "client-error-compression-not-supported",
  0x0410: "client-error-compression-error",
  0x0411: "client-error-document-format-error",
  0x0412: "client-error-document-access-error",
  0x0500: "server-error-internal-error",
  0x0501: "server-error-operation-not-supported",
  0x0502: "server-error-service-unavailable",
  0x0503: "server-error-version-not-supported",
  0x0504: "server-error-device-error",
  0x0505: "server-error-temporary-error",
  0x0506: "server-error-not-accepting-jobs",
  0x0507: "server-error-busy",
  0x0508: "server-error-job-canceled",
  0x0509: "server-error-multiple-document-jobs-not-supported",
};

export function ippStatusName(code: number): string {
  const hex = `0x${code.toString(16).padStart(4, "0")}`;
  return `${STATUS_NAMES[code] ?? "unknown-status"} (${hex})`;
}

export interface IppCompletionVerdict {
  verdict: "completed" | "failed" | "unobservable" | "waiting";
  completion?: "with-errors" | "stopped" | "unobservable";
  problem?: string;
}

const COMPLETED_OK = new Set(["none", "job-completed-successfully", "job-restartable"]);
const COMPLETED_ERRORS = new Set(["job-completed-with-errors", "completed-with-errors"]);
const STOPPED = new Set([
  "job-canceled-by-user", "job-canceled-by-operator", "job-canceled-at-device",
  "aborted-by-system", "processing-to-stop-point",
]);

/** Same precedence and clean-completion allowlist as pcc-node's ipp_completion_verdict. */
export function ippCompletionVerdict(jobState: number | null, reasons: string[] | null): IppCompletionVerdict {
  if (jobState === 7 || jobState === 8) return { verdict: "failed" };
  if (jobState !== 9) return { verdict: "waiting" };
  if (reasons === null || reasons.length === 0) {
    return { verdict: "waiting", problem: "Completed job has no usable job-state-reasons" };
  }
  if (reasons.includes("queued-in-device")) return { verdict: "unobservable", completion: "unobservable" };
  if (reasons.some(reason => COMPLETED_ERRORS.has(reason))) return { verdict: "failed", completion: "with-errors" };
  if (reasons.some(reason => STOPPED.has(reason))) return { verdict: "failed", completion: "stopped" };
  if ((reasons.includes("none") && reasons.length !== 1) || reasons.some(reason => !COMPLETED_OK.has(reason))) {
    return { verdict: "unobservable", completion: "unobservable" };
  }
  return { verdict: "completed" };
}

function oneValue(group: IppGroup, name: string): { value: IppValue } | { problem: string } {
  const attribute = singleAttribute(group, name);
  if ("problem" in attribute) return attribute;
  if (attribute.value.values.length !== 1) return { problem: `${name} must have exactly one value` };
  return { value: attribute.value.values[0]! };
}

function readJobId(message: IppMessage): { value: number } | { problem: string } {
  const group = jobGroup(message);
  if ("problem" in group) return { problem: "Response must have exactly one Job Attributes group" };
  const value = oneValue(group.value, "job-id");
  if ("problem" in value) return value;
  const integer = readInteger(value.value);
  if ("problem" in integer) return { problem: "job-id must be a four-octet integer" };
  if (integer.value < 1 || integer.value > IPP_INT_MAX) return { problem: "job-id must be in 1..2147483647" };
  return integer;
}

function readJobReasons(group: IppGroup): { value: string[] } | { problem: string } {
  const attribute = singleAttribute(group, "job-state-reasons");
  if ("problem" in attribute) return { problem: "job-state-reasons must occur exactly once" };
  if (attribute.value.values.length === 0) return { problem: "job-state-reasons has no values" };
  const reasons: string[] = [];
  for (const value of attribute.value.values) {
    const keyword = readKeyword(value);
    if ("problem" in keyword) return { problem: "job-state-reasons contains an unusable keyword" };
    reasons.push(keyword.value);
  }
  return { value: reasons };
}

function statusMessage(message: IppMessage): string | undefined {
  const groups = message.groups.filter(group => group.tag === IPP_TAG.OPERATION_ATTRIBUTES);
  if (groups.length !== 1) return undefined;
  const value = oneValue(groups[0]!, "status-message");
  if ("problem" in value) return undefined;
  const text = readText(value.value);
  return "problem" in text ? undefined : sanitizeIppMessage(text.value);
}

/** IPP/1.1 by default. A transport call is always attempted at most once. */
export class IppClient {
  private readonly version: [number, number];
  private readonly requestingUserName: string;
  private readonly naturalLanguage: string;
  private readonly requestDeadlineMs: number;
  private readonly printJobDeadlineMs: number;
  private readonly maxResponseBytes: number;
  private readonly target: URL;
  private requestId = 1;

  constructor(private readonly config: IppClientConfig) {
    this.version = config.version ? [...config.version] : [1, 1];
    this.requestingUserName = config.requestingUserName ?? "pcc-kernel";
    this.naturalLanguage = config.naturalLanguage ?? "en";
    this.requestDeadlineMs = config.requestDeadlineMs ?? 15_000;
    this.printJobDeadlineMs = config.printJobDeadlineMs ?? 120_000;
    this.maxResponseBytes = config.maxResponseBytes ?? 1024 * 1024;
    this.target = new URL(config.printerUri);
  }

  private nextRequestId(): number {
    if (this.config.nextRequestId) return this.config.nextRequestId();
    const id = this.requestId;
    this.requestId = id === IPP_INT_MAX ? 1 : id + 1;
    return id;
  }

  private operationAttributes(): IppAttribute[] {
    return [
      { name: "attributes-charset", values: [charsetValue("utf-8")] },
      { name: "attributes-natural-language", values: [naturalLanguageValue(this.naturalLanguage)] },
      { name: "printer-uri", values: [uriValue(this.config.printerUri)] },
    ];
  }

  private userAttribute(): IppAttribute {
    return { name: "requesting-user-name", values: [nameValue(this.requestingUserName)] };
  }

  private async exchange(operation: number, attributes: IppAttribute[], data?: Uint8Array, signal?: AbortSignal): Promise<IppClientResult> {
    let requestId: number;
    let body: Uint8Array;
    try {
      requestId = this.nextRequestId();
      body = encodeIppMessage({
        version: this.version, code: operation, requestId,
        groups: [{ tag: IPP_TAG.OPERATION_ATTRIBUTES, attributes: [...this.operationAttributes(), ...attributes] }],
        ...(data === undefined ? {} : { data }),
      });
    } catch {
      return { ok: false, kind: "encode", sent: false, message: "Cannot encode IPP request" };
    }
    let answer: IppTransportResult;
    try {
      answer = await this.config.transport({
        host: this.target.hostname.replace(/^\[|\]$/g, ""),
        port: this.target.port ? Number(this.target.port) : 631,
        path: this.target.pathname || "/", body,
        deadlineMs: operation === IPP_OPERATION.PRINT_JOB ? this.printJobDeadlineMs : this.requestDeadlineMs,
        maxResponseBytes: this.maxResponseBytes,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      // A seam violating the transport's non-throwing contract must not leak its error or retry.
      return { ok: false, kind: "io", sent: true, message: "IPP transport failed" };
    }
    if (!answer.ok) {
      return { ok: false, kind: answer.kind, sent: answer.sent, message: sanitizeIppMessage(`IPP transport ${answer.kind} failure`) };
    }
    const fail = (kind: string, message: string, statusCode?: number): IppClientFailure => ({
      ok: false, kind, sent: true, httpStatus: answer.httpStatus,
      ...(statusCode === undefined ? {} : { statusCode }), message: sanitizeIppMessage(message),
    });
    if (answer.httpStatus !== 200) return fail("http", `HTTP ${answer.httpStatus} carries no IPP answer`);
    let decoded: IppMessage;
    try { decoded = decodeIppMessage(answer.body); }
    catch { return fail("decode", "Malformed IPP response"); }
    if (decoded.version[0] !== this.version[0] || decoded.version[1] !== this.version[1]) {
      return fail("version", `IPP response version ${decoded.version.join(".")} does not match requested version ${this.version.join(".")}`, decoded.code);
    }
    if (decoded.requestId !== requestId) return fail("request_id", "IPP response request-id does not match ours", decoded.code);
    if (decoded.code > IPP_STATUS.SUCCESS_MAX) {
      const detail = statusMessage(decoded);
      return fail("ipp_status", `IPP ${ippStatusName(decoded.code)}${detail ? `: ${detail}` : ""}`, decoded.code);
    }
    return { ok: true, message: decoded, httpStatus: 200, statusCode: decoded.code };
  }

  async printJob(input: { jobName: string; documentFormat: string; document: Uint8Array }): Promise<IppPrintJobResult> {
    const answer = await this.exchange(IPP_OPERATION.PRINT_JOB, [
      this.userAttribute(),
      { name: "job-name", values: [nameValue(input.jobName)] },
      { name: "document-format", values: [mimeMediaTypeValue(input.documentFormat)] },
    ], input.document);
    if (!answer.ok) return answer;
    const id = readJobId(answer.message);
    if ("problem" in id) return { ok: false, kind: "job_id", sent: true, httpStatus: 200, statusCode: answer.statusCode, message: sanitizeIppMessage(id.problem) };
    return { ...answer, jobId: id.value };
  }

  async getJobAttributes(jobId: number, signal?: AbortSignal): Promise<IppGetJobAttributesResult> {
    if (!Number.isInteger(jobId) || jobId < 1 || jobId > IPP_INT_MAX) return { ok: false, kind: "encode", sent: false, message: "Invalid IPP job-id" };
    const answer = await this.exchange(IPP_OPERATION.GET_JOB_ATTRIBUTES, [
      { name: "job-id", values: [integerValue(jobId)] },
      { name: "requested-attributes", values: ["job-id", "job-state", "job-state-reasons", "job-impressions-completed"].map(keywordValue) },
    ], undefined, signal);
    if (!answer.ok) return answer;
    const id = readJobId(answer.message);
    if ("problem" in id) return { ok: false, kind: "job_id", sent: true, httpStatus: 200, statusCode: answer.statusCode, message: sanitizeIppMessage(id.problem) };
    if (id.value !== jobId) return { ok: false, kind: "wrong_job", sent: true, httpStatus: 200, statusCode: answer.statusCode, message: "IPP response names a different job" };
    // readJobId already proved there is exactly one job group.
    const group = jobGroup(answer.message);
    if ("problem" in group) return { ok: false, kind: "job_id", sent: true, message: "Unusable IPP job group" };
    const stateValue = oneValue(group.value, "job-state");
    const state = "problem" in stateValue ? stateValue : readEnum(stateValue.value);
    const reasons = readJobReasons(group.value);
    const completedValue = oneValue(group.value, "job-impressions-completed");
    const completed = "problem" in completedValue ? completedValue : readInteger(completedValue.value);
    return {
      ...answer, jobId: id.value,
      jobState: "problem" in state ? null : state.value,
      ...("problem" in state ? { jobStateProblem: "job-state must be exactly one four-octet enum" } : {}),
      jobStateReasons: "problem" in reasons ? null : reasons.value,
      ...("problem" in reasons ? { reasonsProblem: reasons.problem } : {}),
      ...("value" in completed && completed.value >= 0 ? { impressionsCompleted: completed.value } : {}),
    };
  }

  async cancelJob(jobId: number): Promise<IppClientResult> {
    if (!Number.isInteger(jobId) || jobId < 1 || jobId > IPP_INT_MAX) return { ok: false, kind: "encode", sent: false, message: "Invalid IPP job-id" };
    return this.exchange(IPP_OPERATION.CANCEL_JOB, [
      { name: "job-id", values: [integerValue(jobId)] }, this.userAttribute(),
    ]);
  }

  pausePrinter(): Promise<IppClientResult> {
    return this.exchange(IPP_OPERATION.PAUSE_PRINTER, [this.userAttribute()]);
  }

  resumePrinter(): Promise<IppClientResult> {
    return this.exchange(IPP_OPERATION.RESUME_PRINTER, [this.userAttribute()]);
  }

  getPrinterAttributes(requested: string[], signal?: AbortSignal): Promise<IppClientResult> {
    return this.exchange(IPP_OPERATION.GET_PRINTER_ATTRIBUTES, [
      this.userAttribute(), { name: "requested-attributes", values: requested.map(keywordValue) },
    ], undefined, signal);
  }
}
