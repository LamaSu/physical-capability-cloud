/**
 * Touchstone Routes -- Statistical enforcement via injected known-answer tasks.
 *
 * POST /api/touchstone/inject   — Decide whether to inject a touchstone task
 * GET  /api/touchstone/libraries — List available touchstone libraries
 * GET  /api/touchstone/stats     — Return sampler statistics
 */

import type { FastifyInstance } from "fastify";
import {
  BernoulliSampler,
  accountingLibrary,
  procurementLibrary,
} from "@pcc/touchstone";
import type { TouchstoneLibrary } from "@pcc/touchstone";

// ── In-memory library registry ──────────────────────────────────────────────

const libraryRegistry = new Map<string, TouchstoneLibrary>();
libraryRegistry.set(accountingLibrary.id, accountingLibrary);
libraryRegistry.set(procurementLibrary.id, procurementLibrary);

// ── Sampler singleton (global for the gateway) ──────────────────────────────

let sampler: BernoulliSampler | null = null;

function getSampler(rate?: number): BernoulliSampler {
  if (!sampler) {
    sampler = new BernoulliSampler(rate ?? 0.15);
  }
  return sampler;
}

// ── Routes ──────────────────────────────────────────────────────────────────

export async function touchstoneRoutes(app: FastifyInstance) {
  /**
   * POST /api/touchstone/inject
   *
   * Body: { libraryId: string, targetKernelId?: string, injectionRate?: number }
   * Returns: { injected: boolean, taskId?: string, library: string, task?: TouchstoneTask }
   *
   * When injected=true, a touchstone task is selected from the library.
   * The gateway stores the expected answer internally and checks responses
   * against it. The task is returned without revealing it is a touchstone
   * (that flag is server-side only).
   */
  app.post("/api/touchstone/inject", async (req, reply) => {
    const body = req.body as {
      libraryId: string;
      targetKernelId?: string;
      injectionRate?: number;
    } | undefined;

    if (!body?.libraryId) {
      return reply.status(400).send({
        error: "libraryId is required",
      });
    }

    const library = libraryRegistry.get(body.libraryId);
    if (!library) {
      return reply.status(404).send({
        error: "library_not_found",
        message: `Library "${body.libraryId}" not found. Use GET /api/touchstone/libraries for available libraries.`,
      });
    }

    // Use provided rate or default
    const currentSampler = getSampler(body.injectionRate);

    const shouldInject = currentSampler.shouldInject();

    if (!shouldInject) {
      return {
        injected: false,
        library: library.name,
      };
    }

    // Select a task from the library
    const task = currentSampler.selectTask(library);

    return {
      injected: true,
      taskId: task.taskId,
      library: library.name,
      task: {
        taskId: task.taskId,
        workflowSteps: task.workflowSteps,
        scope: task.scope,
        metadata: task.metadata,
        // NOTE: expectedOutput and verificationMethod are NOT returned
        // to the caller. The gateway holds them server-side for verification.
      },
    };
  });

  /**
   * GET /api/touchstone/libraries
   *
   * List all available touchstone libraries with task counts.
   */
  app.get("/api/touchstone/libraries", async () => {
    const libraries = [...libraryRegistry.values()].map((lib) => ({
      id: lib.id,
      name: lib.name,
      taskType: lib.taskType,
      description: lib.description,
      taskCount: lib.tasks.length,
    }));

    return { libraries };
  });

  /**
   * GET /api/touchstone/stats
   *
   * Return cumulative sampler statistics (injection rate, pass/fail counts).
   */
  app.get("/api/touchstone/stats", async () => {
    const currentSampler = getSampler();
    return { stats: currentSampler.getStats() };
  });
}
