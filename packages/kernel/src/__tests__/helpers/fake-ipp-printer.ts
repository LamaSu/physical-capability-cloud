/** Scripted IPP byte transport. Replies settle through promises, never timers. */
import {
  IPP_OPERATION, IPP_TAG, booleanValue, decodeIppMessage, encodeIppMessage,
  enumValue, integerValue, keywordValue,
  type IppGroup, type IppMessage,
} from "../../adapters/ipp-codec.js";
import type { IppTransport, IppTransportRequest, IppTransportResult } from "../../adapters/ipp-transport.js";

export type FakeIppHandler = (request: IppMessage, raw: IppTransportRequest) => IppTransportResult | Promise<IppTransportResult>;
export type FakeIppReply = IppTransportResult | FakeIppHandler;

export function ippResponse(request: IppMessage, input: {
  statusCode?: number;
  groups?: IppGroup[];
  httpStatus?: number;
  version?: [number, number];
  requestId?: number;
  data?: Uint8Array;
} = {}): IppTransportResult {
  return {
    ok: true, httpStatus: input.httpStatus ?? 200,
    body: encodeIppMessage({
      version: input.version ?? request.version,
      code: input.statusCode ?? 0,
      requestId: input.requestId ?? request.requestId,
      groups: input.groups ?? [],
      ...(input.data === undefined ? {} : { data: input.data }),
    }),
  };
}

export function jobResponse(request: IppMessage, input: {
  jobId?: number;
  jobState?: number;
  jobStateReasons?: string[] | null;
  impressionsCompleted?: number;
  statusCode?: number;
} = {}): IppTransportResult {
  const attributes = [{ name: "job-id", values: [integerValue(input.jobId ?? 77)] }];
  if (input.jobState !== undefined) attributes.push({ name: "job-state", values: [enumValue(input.jobState)] });
  if (input.jobStateReasons !== null) {
    const reasons = input.jobStateReasons ?? (input.jobState === 9 ? ["job-completed-successfully"] : ["job-printing"]);
    attributes.push({ name: "job-state-reasons", values: reasons.map(keywordValue) });
  }
  if (input.impressionsCompleted !== undefined) attributes.push({ name: "job-impressions-completed", values: [integerValue(input.impressionsCompleted)] });
  return ippResponse(request, { statusCode: input.statusCode, groups: [{ tag: IPP_TAG.JOB_ATTRIBUTES, attributes }] });
}

export function printerResponse(request: IppMessage, input: {
  printerState?: number;
  acceptingJobs?: boolean;
  printerStateReasons?: string[];
  statusCode?: number;
} = {}): IppTransportResult {
  return ippResponse(request, { statusCode: input.statusCode, groups: [{
    tag: IPP_TAG.PRINTER_ATTRIBUTES,
    attributes: [
      { name: "printer-state", values: [enumValue(input.printerState ?? 3)] },
      { name: "printer-state-reasons", values: (input.printerStateReasons ?? ["none"]).map(keywordValue) },
      { name: "printer-is-accepting-jobs", values: [booleanValue(input.acceptingJobs ?? true)] },
    ],
  }] });
}

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

export class FakeIppPrinter {
  readonly requests: IppMessage[] = [];
  readonly transportRequests: IppTransportRequest[] = [];
  private readonly handlers = new Map<number, FakeIppHandler>();
  private readonly queues = new Map<number, FakeIppReply[]>();

  constructor(private readonly handler?: FakeIppHandler) {}

  readonly transport: IppTransport = async (raw) => {
    const request = decodeIppMessage(raw.body);
    this.requests.push(request);
    this.transportRequests.push(raw);
    // Fake timers do not drive this path: the same promise boundary as an async transport.
    await Promise.resolve();
    const queue = this.queues.get(request.code);
    const queued = queue?.shift();
    if (queued) return typeof queued === "function" ? queued(request, raw) : queued;
    const handler = this.handlers.get(request.code) ?? this.handler;
    if (handler) return handler(request, raw);
    if (request.code === IPP_OPERATION.GET_PRINTER_ATTRIBUTES) return printerResponse(request);
    if (request.code === IPP_OPERATION.PRINT_JOB) return jobResponse(request);
    if (request.code === IPP_OPERATION.GET_JOB_ATTRIBUTES) return jobResponse(request, { jobState: 5 });
    return ippResponse(request);
  };

  setHandler(operation: number, handler: FakeIppHandler): this {
    this.handlers.set(operation, handler);
    return this;
  }

  enqueue(operation: number, reply: FakeIppReply): this {
    const queue = this.queues.get(operation) ?? [];
    queue.push(reply);
    this.queues.set(operation, queue);
    return this;
  }

  operationRequests(operation: number): IppMessage[] {
    return this.requests.filter(request => request.code === operation);
  }
}
