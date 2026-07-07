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
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message });
          this.emitTelemetry(operation, "failed", { error: message });
          // Detect well-known error names and map to proper HTTP status codes.
          if (error instanceof Error) {
            if (error.name === "NotFoundError") {
              // Use attached code if present, otherwise derive from facade name
              const code = (error as any).code ?? `${this.facadeName.toUpperCase()}_NOT_FOUND`;
              span.setAttribute("facade.error_code", code);
              return err(code, message, 404) as Result<T>;
            }
            if (error.name === "BadRequestError") {
              // Preserve the specific error code if one was attached (e.g. "missing_step_id")
              const code = (error as any).code ?? "BAD_REQUEST";
              span.setAttribute("facade.error_code", code);
              return err(code, message, 400) as Result<T>;
            }
            if (error.name === "WriteDisabledError") {
              span.setAttribute("facade.error_code", "WRITE_DISABLED");
              return err("WRITE_DISABLED", message, 503) as Result<T>;
            }
            if (error.name === "BatchDisabledError") {
              span.setAttribute("facade.error_code", "BATCH_DISABLED");
              return err("BATCH_DISABLED", message, 503) as Result<T>;
            }
          }
          // E2: a transient transport/RPC/mempool failure is retryable. Tag it
          // with a distinct code so activity wrappers retry (rather than
          // wrapping it as a permanent FacadeError). Positive-match only —
          // reverts / business errors fall through to the permanent path below.
          if (isTransientError(error)) {
            span.setAttribute("facade.error_code", TRANSIENT_ERROR_CODE);
            return err(TRANSIENT_ERROR_CODE, message, 503, {
              retryable: true,
              details: { facade: this.facadeName, operation },
            }) as Result<T>;
          }
          return Errors.internal(message, { facade: this.facadeName, operation });
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
   * Prevents N+1 queries when populating lists.
   */
  protected async preloadReputations(kernelIds: string[]): Promise<Map<string, number>> {
    const cache = new Map<string, number>();
    try {
      const reputationService = getReputationService();
      for (const id of kernelIds) {
        const kernel = this.repos.kernels.findById(id);
        if (kernel) {
          const effective = reputationService.computeEffectiveReputation(
            kernel.reputation ?? 500,
            (kernel as Record<string, unknown>).reputationUpdatedAt as string | null | undefined,
            (kernel.totalJobsCompleted as number | undefined) ?? 0,
          );
          cache.set(id, effective);
        }
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
