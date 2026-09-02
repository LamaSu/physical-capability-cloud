/**
 * Print-job path — the PRINT leg of `document.print-and-mail`.
 *
 * Drives the EXISTING IPP 2D-printer adapter (`./adapters/ipp-adapter.ts`)
 * through one document print, collects the device's own evidence events, and
 * finalises a kernel-signed EvidenceBundle. Nothing here is a new adapter, a
 * new event type, or a new signing scheme — every moving part is reused:
 *
 *   - Device                 → IppAdapter (packages/kernel/src/adapters/ipp-adapter.ts)
 *   - Evidence bundling/sign  → EvidenceEmitter (packages/kernel/src/evidence-emitter.ts)
 *   - Event hashing           → hashEvent/hashBundle in @pcc/spec (canonical.ts)
 *   - Ed25519 signature       → tweetnacl `nacl.sign.detached`, byte-identical to
 *                               digital/accounting-kernel.ts + @pcc/kernel-sdk's
 *                               job-handler.ts. A bundle signed here verifies
 *                               under @pcc/kernel-sdk's `verifyBundleSignature`
 *                               and against a signing key registered via
 *                               POST /api/kernels {signingKeyAlgorithm:"ed25519"}.
 *
 * Completion vocabulary: the adapter already emits `execution_completed` — a
 * value in the FIXED EVIDENCE_EVENT_TYPES (packages/spec/src/types/evidence.ts).
 * There is no printer-specific completion type, so we use `execution_completed`
 * (same event the FDM/OctoPrint/digital kernels use). We NEVER mutate the
 * device's emitted payload before hashing it — the bundle hash must reflect what
 * the device actually said. The {jobId, pageCount, printerId} the caller usually
 * wants is surfaced as the returned `PrintCompletion` summary, derived from that
 * verbatim event (pageCount ← payload.totalPages, printerId ← source.deviceId).
 *
 * Mock mode: when the IppAdapter runs in mock mode (explicit `mockMode:true`, or
 * the optional `ipp` npm package is absent), every event carries
 * `payload.mock:true` and `source.simulated:true`, and `PrintCompletion.simulated`
 * is true. This leg fabricates NOTHING silently — a simulated print is always
 * labelled, exactly like the mail leg's `mock`→`source.simulated` convention
 * (packages/gateway/src/services/carrier-shipment-store.ts).
 */

import nacl from "tweetnacl";
import type { Address, AssuranceTier, EvidenceBundle, EvidenceEvent, Signature } from "@pcc/spec";
import { EvidenceEmitter } from "./evidence-emitter.js";
import { IppAdapter, type IppAdapterConfig } from "./adapters/ipp-adapter.js";
import type { MachineAdapter } from "./adapters/types.js";

// ---------------------------------------------------------------------------
// Ed25519 kernel signer (the way this repo signs any device evidence)
// ---------------------------------------------------------------------------

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * An Ed25519 signing function plus the public material needed to register and
 * verify it. The `signFn` is exactly the shape `EvidenceEmitter` expects
 * (`(bundleHash: string) => Promise<Signature>`).
 */
export interface KernelEd25519Signer {
  /** Pass to `new EvidenceEmitter(kernelId, signer.signFn)`. */
  signFn: (bundleHash: string) => Promise<Signature>;
  /** Raw 32-byte Ed25519 public key, hex (64 chars, no 0x). */
  publicKeyHex: string;
  /**
   * `"0x"+publicKeyHex` — the value to send as `signingPublicKey` on
   * POST /api/kernels (the ed25519 signing-key registration lane).
   */
  signingPublicKey: string;
  /** 64-byte tweetnacl secret key (keep private; never emit into evidence). */
  secretKey: Uint8Array;
}

/**
 * Build a kernel Ed25519 signer.
 *
 * The produced `kernelSignature` is byte-identical in construction to
 * `digital/accounting-kernel.ts` and `@pcc/kernel-sdk`'s job-handler:
 *   value  = hex( nacl.sign.detached( utf8(bundleHash), secretKey ) )
 *   signer = "0x" + publicKeyHex[..40]   (the repo's address-shaped label)
 *   algorithm = "ed25519"
 *
 * @param seed Optional 32-byte Ed25519 seed for a deterministic key (tests /
 *   reproducible kernel identity). Omit for a fresh random key.
 */
export function makeKernelEd25519Signer(seed?: Uint8Array): KernelEd25519Signer {
  const keyPair =
    seed && seed.length === 32 ? nacl.sign.keyPair.fromSeed(seed) : nacl.sign.keyPair();
  const publicKeyHex = toHex(keyPair.publicKey);
  const signer = `0x${publicKeyHex.slice(0, 40)}` as Address;

  const signFn = async (bundleHash: string): Promise<Signature> => ({
    signer,
    algorithm: "ed25519",
    value: toHex(nacl.sign.detached(new TextEncoder().encode(bundleHash), keyPair.secretKey)),
  });

  return {
    signFn,
    publicKeyHex,
    signingPublicKey: `0x${publicKeyHex}`,
    secretKey: keyPair.secretKey,
  };
}

// ---------------------------------------------------------------------------
// Print job
// ---------------------------------------------------------------------------

export interface PrintJobOptions {
  /** The device to drive — an IppAdapter (or any MachineAdapter). */
  adapter: MachineAdapter;
  /** Evidence collector; construct it with a real signFn to get real signatures. */
  emitter: EvidenceEmitter;
  /** PCC job id — correlates this print with the mail leg (courier record.jobId). */
  jobId: string;
  /** Evidence step id (defaults to jobId). */
  stepId?: string;
  /** Human-readable document name, e.g. "invoice.pdf". */
  jobName: string;
  /** Number of pages to print (mock mode paces one page ≈ 1.2s). */
  totalPages: number;
  /** Real-mode document bytes. Required for a real IPP Print-Job; ignored in mock. */
  documentData?: Buffer | string;
  /** Assurance tier for the bundle (default 0 — the printer CSD's tier-0 floor). */
  assuranceTier?: AssuranceTier;
  /** Guard timeout waiting for the device's completion event (default 120s). */
  timeoutMs?: number;
}

/**
 * Normalised completion summary. Derived from the device's verbatim
 * `execution_completed` event — NOT a second evidence event.
 */
export interface PrintCompletion {
  /** PCC job id (the one passed in) — use this to join with the mail leg. */
  jobId: string;
  /** The printer's own internal job id from the device event payload, if any. */
  printerJobId?: string | number;
  /** Pages printed (← execution_completed payload.totalPages). */
  pageCount: number;
  /** The printer device id (← source.deviceId). */
  printerId: string;
  /** True when the print was simulated (mock adapter / no reachable printer). */
  simulated: boolean;
  jobName: string;
}

export interface PrintJobResult {
  success: boolean;
  /** The kernel-signed evidence bundle (present on success). */
  bundle?: EvidenceBundle;
  /** Normalised {jobId, pageCount, printerId, simulated} completion. */
  completion?: PrintCompletion;
  /** Every evidence event collected for the step (verbatim, hashed). */
  events: EvidenceEvent[];
  error?: string;
  durationMs: number;
}

/**
 * Run one print job through a machine adapter and return a kernel-signed bundle.
 *
 * Event-driven: it waits for the device's own `execution_completed` (or
 * `execution_failed`) rather than fabricating a completion, so a bundle only
 * exists when the device actually reported done.
 */
export async function runPrintJob(opts: PrintJobOptions): Promise<PrintJobResult> {
  const {
    adapter,
    emitter,
    jobId,
    stepId = jobId,
    jobName,
    totalPages,
    documentData,
    assuranceTier = 0,
    timeoutMs = 120_000,
  } = opts;

  const startTime = Date.now();
  emitter.registerStep(jobId, stepId, assuranceTier);

  // Collect every emitted event verbatim. addEvent() is async (hashEvent), so we
  // track the promises and drain them before finalising the bundle hash.
  const pendingAdds: Array<Promise<EvidenceEvent>> = [];
  let lastKnownPages = totalPages;
  let completedEvent: Omit<EvidenceEvent, "id" | "hash"> | null = null;
  let failedEvent: Omit<EvidenceEvent, "id" | "hash"> | null = null;

  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  adapter.onEvidence((event) => {
    // NEVER mutate device evidence — the bundle hash must reflect what the
    // device said. Store it as-is.
    pendingAdds.push(emitter.addEvent(jobId, stepId, event));

    if (event.type === "execution_progress") {
      const tp = (event.payload as Record<string, unknown> | undefined)?.totalPages;
      if (typeof tp === "number") lastKnownPages = tp;
    } else if (event.type === "execution_completed") {
      completedEvent = event;
      resolveDone();
    } else if (event.type === "execution_failed") {
      failedEvent = event;
      resolveDone();
    }
  });

  // Kick off the print. Mock mode uses {jobName, totalPages}; real IPP mode also
  // needs documentData (the adapter fails start() without it — we surface that
  // honestly rather than pretending a print happened).
  const startResult = await adapter.execute({
    type: "start",
    payload: {
      jobName,
      totalPages,
      ...(documentData !== undefined ? { documentData } : {}),
    },
  });
  if (!startResult.success) {
    return {
      success: false,
      events: emitter.getEvents(jobId, stepId),
      error: startResult.message ?? "print start failed",
      durationMs: Date.now() - startTime,
    };
  }

  // Wait for the device's own terminal event. No polling — the adapter drives it.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`print job ${jobId} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    (timer as unknown as { unref?: () => void })?.unref?.();
  });

  try {
    await Promise.race([done, timeout]);
  } catch (err) {
    return {
      success: false,
      events: emitter.getEvents(jobId, stepId),
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }

  // Make sure every emitted event is hashed + stored before hashing the bundle.
  await Promise.all(pendingAdds);

  if (failedEvent && !completedEvent) {
    return {
      success: false,
      events: emitter.getEvents(jobId, stepId),
      error: `printer reported failure: ${JSON.stringify(
        (failedEvent as Omit<EvidenceEvent, "id" | "hash">).payload ?? {},
      )}`,
      durationMs: Date.now() - startTime,
    };
  }

  // Finalise + sign — the one and only signing step, identical to every other
  // device bundle in the kernel: hashBundle(events) → signFn → kernelSignature.
  const bundle = await emitter.finalizeBundle(jobId, stepId);

  const cp = ((completedEvent as Omit<EvidenceEvent, "id" | "hash"> | null)?.payload ?? {}) as Record<
    string,
    unknown
  >;
  const pageCount =
    typeof cp.totalPages === "number"
      ? cp.totalPages
      : typeof cp.pageCount === "number"
        ? cp.pageCount
        : lastKnownPages;
  const printerId =
    (completedEvent as Omit<EvidenceEvent, "id" | "hash"> | null)?.source.deviceId ??
    adapter.source.deviceId;
  const simulated =
    (completedEvent as Omit<EvidenceEvent, "id" | "hash"> | null)?.source.simulated === true ||
    cp.mock === true ||
    adapter.source.simulated === true;

  const completion: PrintCompletion = {
    jobId,
    printerJobId:
      typeof cp.jobId === "string" || typeof cp.jobId === "number"
        ? (cp.jobId as string | number)
        : undefined,
    pageCount,
    printerId,
    simulated,
    jobName,
  };

  return {
    success: true,
    bundle,
    completion,
    events: bundle.events,
    durationMs: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// Convenience: turnkey IPP print kernel
// ---------------------------------------------------------------------------

export interface IppPrintKernelOptions {
  /** Kernel id used on evidence sources + the bundle. */
  kernelId: string;
  /** Device id for the printer (becomes source.deviceId / printerId). */
  deviceId: string;
  /** IPP printer URI (default ipp://localhost:631/ipp/print). */
  uri?: string;
  /**
   * Mock mode. Defaults to true (safe — no reachable printer required), mirroring
   * the adapter-factory `buildIpp` default. Set false only with the optional
   * `ipp` npm package installed AND a reachable printer.
   */
  mockMode?: boolean;
  /** Deterministic 32-byte Ed25519 seed for the kernel signing key. */
  seed?: Uint8Array;
  /** Bring your own signer (overrides `seed`). */
  signer?: KernelEd25519Signer;
  /** Extra IppAdapter config passthrough. */
  adapterConfig?: Partial<IppAdapterConfig>;
}

export interface IppPrintKernel {
  adapter: IppAdapter;
  emitter: EvidenceEmitter;
  signer: KernelEd25519Signer;
  /** Run one print job. */
  print(job: Omit<PrintJobOptions, "adapter" | "emitter">): Promise<PrintJobResult>;
  /** Release adapter timers/listeners. */
  dispose(): Promise<void>;
}

/**
 * Wire the EXISTING IppAdapter + EvidenceEmitter + an Ed25519 kernel signer into
 * a ready-to-run print kernel. This is the turnkey entry point used by the
 * onboarding/e2e script and the tests.
 */
export function createIppPrintKernel(opts: IppPrintKernelOptions): IppPrintKernel {
  const signer = opts.signer ?? makeKernelEd25519Signer(opts.seed);
  const mockMode = opts.mockMode ?? true;

  const adapter = new IppAdapter(opts.deviceId, {
    uri: opts.uri ?? "ipp://localhost:631/ipp/print",
    kernelId: opts.kernelId,
    mockMode,
    ...opts.adapterConfig,
  });

  const emitter = new EvidenceEmitter(opts.kernelId, signer.signFn);

  return {
    adapter,
    emitter,
    signer,
    print: (job) => runPrintJob({ ...job, adapter, emitter }),
    dispose: () => adapter.dispose(),
  };
}
