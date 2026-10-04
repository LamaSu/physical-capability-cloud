/**
 * Base Facade class — shared infrastructure for all PCC facades.
 *
 * Provides:
 * - Access to repositories (never raw DB)
 * - Standardized error handling via Result<T>
 * - Population context management
 * - Telemetry integration
 * - RBAC enforcement hooks
 */

import { getRepos } from "../db.js";
import { pipelineTelemetry } from "../telemetry.js";
import { type Result, ok, err, Errors } from "@pcc/spec";
import type { PopulationContext, AgentContext, AgentRole } from "./types.js";
import type { IRepositories } from "@pcc/store";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { getReputationService } from "../services/reputation-service.js";
import { isTransientError, TRANSIENT_ERROR_CODE } from "./transient-error.js";
import {
  NotFoundError,
  BadRequestError,
  ForbiddenError,
  ConflictError,
  WriteDisabledError,
  BatchDisabledError,
} from "./facade-errors.js";

/** Shared tracer for all facade spans */
const facadeTracer = trace.getTracer("pcc-gateway-facades", "2.0.0");

export abstract class BaseFacade {
  protected readonly facadeName: string;

  /** Roles that are allowed to call methods on this facade */
  protected abstract readonly allowedRoles: readonly AgentRole[];

  constructor(facadeName: string) {
    this.facadeName = facadeName;
  }

  /** Get repositories — facades never call the DB directly */
  protected get repos(): IRepositories {
    return getRepos();
  }

  /**
   * Wrap a facade operation in standardized error handling.
   * All facade methods should use this.
   *
   * Wraps the operation in an OTel span so every facade call is traced.
   * The pipelineTelemetry SSE emission is preserved inside the span.
   */
  protected async execute<T>(
    operation: string,
    fn: () => Promise<T>,
  ): Promise<Result<T>> {
    return facadeTracer.startActiveSpan(
      `${this.facadeName}.${operation}`,
      async (span) => {
        span.setAttribute("facade.name", this.facadeName);
        span.setAttribute("facade.operation", operation);
        try {
          const data = await fn();
          span.setAttribute("facade.result", "success");
          span.setStatus({ code: SpanStatusCode.OK });
          this.emitTelemetry(operation, "completed");
          return ok(data);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          span.setAttribute("facade.result", "error");

          // N71 round 5 (astra pack 83d, HIGH #3 + #4): classify the error into its
          // final Result FIRST; touch the span LAST, with the classification's own
          // CODE only — never the original error object, never its message, for ANY
          // branch below, typed or not. Round 4 proved a typed error's message is
          // safe-by-construction (instanceof-proven, facade-authored) for the
          // RESPONSE and pipelineTelemetry — that proof says nothing about the span,
          // which exports to OTLP in production (otel.ts) regardless of which branch
          // matched. THE SINK IS THE BOUNDARY: a span is an output sink exactly like
          // a response or a log line, so it gets a fixed code, nothing else, for
          // every path, including the typed-error ones. recordException is gone
          // entirely — there is no synthetic exception event either, to keep the
          // boundary at one place (setStatus) instead of two.
          //
          // Detect well-known error CLASSES (never `.name` — see facade-errors.ts,
          // N71 round 4 / astra pack 83c HIGH #3: `.name` is a writable string any
          // thrown value can forge; `instanceof` against these exported classes
          // cannot be forged by Object.assign, since that cannot rewrite an object's
          // prototype chain) and map to proper HTTP status codes. A typed error's
          // message is authored by the facade itself (e.g. "job 'x' not found") —
          // safe by construction, PROVEN by instanceof — so it is STILL disclosed in
          // the response and pipelineTelemetry exactly as before. Only the SPAN's
          // treatment changes this round.
          let code: string;
          let outcome: Result<T>;

          if (error instanceof NotFoundError) {
            // Use attached code if present, otherwise derive from facade name
            code = error.code ?? `${this.facadeName.toUpperCase()}_NOT_FOUND`;
            this.emitTelemetry(operation, "failed", { error: message });
            outcome = err(code, message, 404) as Result<T>;
          } else if (error instanceof BadRequestError) {
            // Preserve the specific error code if one was attached (e.g. "missing_step_id")
            code = error.code ?? "BAD_REQUEST";
            this.emitTelemetry(operation, "failed", { error: message });
            outcome = err(code, message, 400) as Result<T>;
          } else if (error instanceof ForbiddenError) {
            code = "FORBIDDEN";
            this.emitTelemetry(operation, "failed", { error: message });
            outcome = err("FORBIDDEN", message, 403) as Result<T>;
          } else if (error instanceof ConflictError) {
            code = "SIGNER_ALREADY_BOUND";
            this.emitTelemetry(operation, "failed", { error: message });
            outcome = err("SIGNER_ALREADY_BOUND", message, 409) as Result<T>;
          } else if (error instanceof WriteDisabledError) {
            code = "WRITE_DISABLED";
            this.emitTelemetry(operation, "failed", { error: message });
            outcome = err("WRITE_DISABLED", message, 503) as Result<T>;
          } else if (error instanceof BatchDisabledError) {
            code = "BATCH_DISABLED";
            this.emitTelemetry(operation, "failed", { error: message });
            outcome = err("BATCH_DISABLED", message, 503) as Result<T>;
          } else if (isTransientError(error)) {
            // E2: a transient transport/RPC/mempool failure is retryable. Tag it
            // with a distinct code so activity wrappers retry (rather than wrapping
            // it as a permanent FacadeError). Positive-match only — reverts /
            // business errors fall through to the permanent path below.
            //
            // N71 round 3 (astra pack 83b): an UNTYPED error's message is whatever a
            // dependency threw — a DB driver string, a fetch error quoting the URL a
            // device was configured with, userinfo included. "Scrubbed, not generic"
            // is not a confidentiality boundary (astra's words) — free text like
            // "password=..." was never caught by any scrubber either. Neither the
            // response, telemetry, NOR (as of round 5) the span repeats it anywhere.
            code = TRANSIENT_ERROR_CODE;
            this.emitTelemetry(operation, "failed", { error: "transient_error" });
            outcome = err(TRANSIENT_ERROR_CODE, "transient_error", 503, {
              retryable: true,
              details: { facade: this.facadeName, operation },
            }) as Result<T>;
          } else if (
            // A SQLite UNIQUE-constraint violation (better-sqlite3 / Drizzle) is
            // detected the same way as round 3 (its own driver `code`, or its fixed
            // message prefix) — those are PROVENANCE signals about the driver that
            // threw, not text that is safe to show. N71 round 4 (astra pack 83c,
            // HIGH #4): round 3 reasoned the message was safe because it "names only
            // the table.column" — but nothing proves an arbitrary thrown value's
            // message actually came from the driver rather than merely LOOKING like
            // its prefix (`new Error("UNIQUE constraint failed: devices.id
            // value=<secret>")`), or that its mutable `code` wasn't set by something
            // else entirely. So the message itself is NEVER disclosed, even when the
            // heuristic matches — only a fixed, generic conflict code.
            // routes/job-submit.ts maps THIS CODE (never message text) to its
            // specific `device_already_exists` 409 for device registration. N71
            // round 5 (astra pack 83d, HIGH #4): the message used to reach the span
            // regardless, via the unconditional recordException/setStatus above —
            // closed now too.
            (error as { code?: unknown } | null)?.code === "SQLITE_CONSTRAINT_UNIQUE" ||
            /^UNIQUE constraint failed:/i.test(message)
          ) {
            code = "CONFLICT";
            this.emitTelemetry(operation, "failed", { error: "duplicate_entry" });
            outcome = Errors.conflict("duplicate_entry", {
              facade: this.facadeName,
              operation,
            }) as Result<T>;
          } else {
            code = "internal_error";
            this.emitTelemetry(operation, "failed", { error: "internal_error" });
            outcome = Errors.internal("internal_error", { facade: this.facadeName, operation });
          }

          span.setAttribute("facade.error_code", code);
          span.setStatus({ code: SpanStatusCode.ERROR, message: code });
          return outcome;
        } finally {
          span.end();
        }
      },
    );
  }

  /**
   * Check if an agent context has permission to use this facade.
   * Call this at the start of any facade method that requires auth.
   */
  protected checkAccess(agent?: AgentContext): Result<void> | null {
    if (!agent) return null; // No auth context = public endpoint
    if (!this.allowedRoles.includes(agent.role)) {
      return Errors.forbidden(
        `Role '${agent.role}' cannot access ${this.facadeName}`,
      );
    }
    return null; // Access granted
  }

  /**
   * Build a default PopulationContext with sensible defaults.
   */
  protected defaultContext(partial?: Partial<PopulationContext>): PopulationContext {
    return {
      currency: "USDC",
      includeReputation: false,
      includeCompliance: false,
      includeHealth: false,
      ...partial,
    };
  }

  /**
   * Pre-load reputation scores for a batch of kernel IDs.
   * Prevents N+1 queries when populating lists: one IN-list query for the
   * whole id set (chunked inside the repo), then in-memory decay math.
   */
  protected async preloadReputations(kernelIds: string[]): Promise<Map<string, number>> {
    const cache = new Map<string, number>();
    try {
      const reputationService = getReputationService();
      const kernels = this.repos.kernels.findByIds([...new Set(kernelIds)]);
      for (const kernel of kernels) {
        const effective = reputationService.computeEffectiveReputation(
          kernel.reputation ?? 500,
          (kernel as Record<string, unknown>).reputationUpdatedAt as string | null | undefined,
          (kernel.totalJobsCompleted as number | undefined) ?? 0,
        );
        cache.set(kernel.id, effective);
      }
    } catch {
      // Reputation is optional enrichment — don't fail on it
    }
    return cache;
  }

  /** Emit telemetry for this facade operation */
  private emitTelemetry(
    operation: string,
    status: "completed" | "failed",
    metadata?: Record<string, unknown>,
  ): void {
    try {
      // facadeName is not a PipelinePhase but is used here for SSE dashboard context.
      // This is intentional: facade telemetry events are keyed by facade name, not phase.
      // The OTel span in execute() provides proper structured tracing.
      pipelineTelemetry.emit(
        `facade-${Date.now()}`,
        this.facadeName as import("../telemetry.js").PipelinePhase,
        status,
        { metadata: { operation, ...metadata } },
      );
    } catch {
      // Telemetry is best-effort
    }
  }
}
