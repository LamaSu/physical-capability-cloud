import { describe, it, expect } from "vitest";
import { ok, err, errRich, stampTrace, Errors, type Result } from "../types/result.js";

// ── Helper ─────────────────────────────────────────────────────────────────

function isWithin(actual: number, expected: number, toleranceMs: number): boolean {
  return Math.abs(actual - expected) <= toleranceMs;
}

// ── ok() ───────────────────────────────────────────────────────────────────

describe("ok()", () => {
  it("returns success=true with data and timestamp", () => {
    const result = ok("hello");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("hello");
      expect(typeof result.timestamp).toBe("number");
    }
  });

  it("timestamp is approximately Date.now()", () => {
    const before = Date.now();
    const result = ok(42);
    const after = Date.now();
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(after);
  });

  it("data is preserved exactly (including objects and arrays)", () => {
    const data = { a: 1, b: [2, 3], c: null };
    const result = ok(data);
    if (result.success) {
      expect(result.data).toBe(data); // same reference
    }
  });

  it("discriminates: result.success is true → data accessible", () => {
    const result: Result<number> = ok(99);
    if (result.success) {
      // TypeScript narrows: result.data is number
      expect(result.data).toBe(99);
    } else {
      throw new Error("should not reach here");
    }
  });
});

// ── err() ─────────────────────────────────────────────────────────────────

describe("err()", () => {
  it("returns success=false with error.code, message, httpStatus", () => {
    const result = err("MY_CODE", "something broke", 422);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("MY_CODE");
      expect(result.error.message).toBe("something broke");
      expect(result.error.httpStatus).toBe(422);
    }
  });

  it("defaults httpStatus to 500", () => {
    const result = err("CODE", "msg");
    if (!result.success) {
      expect(result.error.httpStatus).toBe(500);
    }
  });

  it("defaults retryable to false", () => {
    const result = err("CODE", "msg", 400);
    if (!result.success) {
      expect(result.error.retryable).toBe(false);
    }
  });

  it("accepts opts.details and opts.retryable", () => {
    const details = { field: "email", reason: "invalid" };
    const result = err("VALIDATION", "bad email", 400, { details, retryable: true });
    if (!result.success) {
      expect(result.error.details).toEqual(details);
      expect(result.error.retryable).toBe(true);
    }
  });

  it("discriminates: result.success is false → error accessible", () => {
    const result: Result<string> = err("ERR", "msg");
    if (!result.success) {
      expect(result.error.code).toBe("ERR");
    } else {
      throw new Error("should not reach here");
    }
  });
});

// ── Errors.notFound() ─────────────────────────────────────────────────────

describe("Errors.notFound()", () => {
  it("returns code=ENTITY_NOT_FOUND (entity uppercased)", () => {
    const result = Errors.notFound("capability", "cap-001");
    if (!result.success) {
      expect(result.error.code).toBe("CAPABILITY_NOT_FOUND");
    }
  });

  it("returns httpStatus=404", () => {
    const result = Errors.notFound("job", "job-999");
    if (!result.success) {
      expect(result.error.httpStatus).toBe(404);
    }
  });

  it("message includes entity name and id", () => {
    const result = Errors.notFound("kernel", "kernel-abc");
    if (!result.success) {
      expect(result.error.message).toContain("kernel");
      expect(result.error.message).toContain("kernel-abc");
    }
  });

  it("retryable=false", () => {
    const result = Errors.notFound("thing", "id");
    if (!result.success) {
      expect(result.error.retryable).toBe(false);
    }
  });
});

// ── Errors.badRequest() ───────────────────────────────────────────────────

describe("Errors.badRequest()", () => {
  it("returns code=BAD_REQUEST, httpStatus=400", () => {
    const result = Errors.badRequest("missing field");
    if (!result.success) {
      expect(result.error.code).toBe("BAD_REQUEST");
      expect(result.error.httpStatus).toBe(400);
    }
  });

  it("accepts optional details object", () => {
    const result = Errors.badRequest("invalid", { field: "price" });
    if (!result.success) {
      expect(result.error.details).toEqual({ field: "price" });
    }
  });

  it("retryable=false", () => {
    const result = Errors.badRequest("bad");
    if (!result.success) {
      expect(result.error.retryable).toBe(false);
    }
  });
});

// ── Errors.unauthorized() ─────────────────────────────────────────────────

describe("Errors.unauthorized()", () => {
  it("default message='Authentication required', httpStatus=401", () => {
    const result = Errors.unauthorized();
    if (!result.success) {
      expect(result.error.message).toBe("Authentication required");
      expect(result.error.httpStatus).toBe(401);
    }
  });

  it("accepts custom message", () => {
    const result = Errors.unauthorized("Token expired");
    if (!result.success) {
      expect(result.error.message).toBe("Token expired");
    }
  });
});

// ── Errors.forbidden() ────────────────────────────────────────────────────

describe("Errors.forbidden()", () => {
  it("default message='Insufficient permissions', httpStatus=403", () => {
    const result = Errors.forbidden();
    if (!result.success) {
      expect(result.error.message).toBe("Insufficient permissions");
      expect(result.error.httpStatus).toBe(403);
    }
  });

  it("accepts custom message", () => {
    const result = Errors.forbidden("Admin only");
    if (!result.success) {
      expect(result.error.message).toBe("Admin only");
    }
  });
});

// ── Errors.conflict() ─────────────────────────────────────────────────────

describe("Errors.conflict()", () => {
  it("httpStatus=409, code=CONFLICT", () => {
    const result = Errors.conflict("already exists");
    if (!result.success) {
      expect(result.error.httpStatus).toBe(409);
      expect(result.error.code).toBe("CONFLICT");
    }
  });

  it("accepts optional details", () => {
    const result = Errors.conflict("dup", { existingId: "abc" });
    if (!result.success) {
      expect(result.error.details).toEqual({ existingId: "abc" });
    }
  });
});

// ── Errors.internal() ─────────────────────────────────────────────────────

describe("Errors.internal()", () => {
  it("httpStatus=500, retryable=true", () => {
    const result = Errors.internal();
    if (!result.success) {
      expect(result.error.httpStatus).toBe(500);
      expect(result.error.retryable).toBe(true);
    }
  });

  it("accepts details", () => {
    const result = Errors.internal("db crash", { query: "SELECT *" });
    if (!result.success) {
      expect(result.error.details).toEqual({ query: "SELECT *" });
    }
  });

  it("default message is 'Internal error'", () => {
    const result = Errors.internal();
    if (!result.success) {
      expect(result.error.message).toBe("Internal error");
    }
  });
});

// ── Errors.serviceUnavailable() ───────────────────────────────────────────

describe("Errors.serviceUnavailable()", () => {
  it("httpStatus=503, retryable=true", () => {
    const result = Errors.serviceUnavailable("MyService");
    if (!result.success) {
      expect(result.error.httpStatus).toBe(503);
      expect(result.error.retryable).toBe(true);
    }
  });

  it("message includes service name", () => {
    const result = Errors.serviceUnavailable("PaymentGateway");
    if (!result.success) {
      expect(result.error.message).toContain("PaymentGateway");
    }
  });
});

// ── Errors.rateLimited() ──────────────────────────────────────────────────

describe("Errors.rateLimited()", () => {
  it("httpStatus=429, retryable=true", () => {
    const result = Errors.rateLimited();
    if (!result.success) {
      expect(result.error.httpStatus).toBe(429);
      expect(result.error.retryable).toBe(true);
    }
  });

  it("includes retryAfterMs in details when provided", () => {
    const result = Errors.rateLimited(5000);
    if (!result.success) {
      expect(result.error.details).toEqual({ retryAfterMs: 5000 });
    }
  });

  it("details is undefined when retryAfterMs not provided", () => {
    const result = Errors.rateLimited();
    if (!result.success) {
      expect(result.error.details).toBeUndefined();
    }
  });
});

// ── TypeScript discriminated union ────────────────────────────────────────

describe("TypeScript discriminated union", () => {
  it("Result<string> data is string when ok", () => {
    const result: Result<string> = ok("test");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(typeof result.data).toBe("string");
    }
  });

  it("Result<never> from err has no data property", () => {
    const result: Result<never> = err("E", "m");
    expect(result.success).toBe(false);
    expect("data" in result).toBe(false);
  });
});

// ── errRich() ─────────────────────────────────────────────────────────────
// New in feat/agent-onboarding-observability — rich agent-readable errors
// with hint + docs + trace_id.

describe("errRich()", () => {
  it("returns the same shape as err() when no rich opts are passed", () => {
    const result = errRich("BASIC", "plain old error", 400);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("BASIC");
      expect(result.error.message).toBe("plain old error");
      expect(result.error.httpStatus).toBe(400);
      expect(result.error.retryable).toBe(false);
      expect(result.error.hint).toBeUndefined();
      expect(result.error.docs).toBeUndefined();
      expect(result.error.trace_id).toBeUndefined();
    }
  });

  it("attaches hint when provided", () => {
    const result = errRich("X", "y", 400, { hint: "try Z first" });
    if (!result.success) {
      expect(result.error.hint).toBe("try Z first");
    }
  });

  it("attaches docs when provided", () => {
    const result = errRich("X", "y", 400, {
      hint: "see docs",
      docs: "/docs/AGENT_INTEGRATION.md#auth",
    });
    if (!result.success) {
      expect(result.error.docs).toBe("/docs/AGENT_INTEGRATION.md#auth");
    }
  });

  it("attaches trace_id when provided", () => {
    const result = errRich("X", "y", 400, { trace_id: "tr_abc123" });
    if (!result.success) {
      expect(result.error.trace_id).toBe("tr_abc123");
    }
  });

  it("accepts retryable + details just like err()", () => {
    const result = errRich("X", "y", 500, {
      retryable: true,
      details: { foo: "bar" },
    });
    if (!result.success) {
      expect(result.error.retryable).toBe(true);
      expect(result.error.details).toEqual({ foo: "bar" });
    }
  });

  it("backward-compat: PCCError consumers that destructure {code,message,httpStatus} still work", () => {
    const result = errRich("OLD_CONSUMER", "msg", 422, {
      hint: "this is ignored by old code",
    });
    if (!result.success) {
      const { code, message, httpStatus } = result.error;
      expect(code).toBe("OLD_CONSUMER");
      expect(message).toBe("msg");
      expect(httpStatus).toBe(422);
    }
  });
});

// ── stampTrace() ──────────────────────────────────────────────────────────

describe("stampTrace()", () => {
  it("adds trace_id to an Err result", () => {
    const before = err("CODE", "msg", 400);
    const after = stampTrace(before, "tr_xyz");
    if (!after.success) {
      expect(after.error.trace_id).toBe("tr_xyz");
      expect(after.error.code).toBe("CODE");
      expect(after.error.message).toBe("msg");
    }
  });

  it("preserves all other fields on the error", () => {
    const before = err("CODE", "msg", 422, {
      details: { foo: "bar" },
      retryable: true,
    });
    const after = stampTrace(before, "tr_xyz");
    if (!after.success) {
      expect(after.error.code).toBe("CODE");
      expect(after.error.httpStatus).toBe(422);
      expect(after.error.details).toEqual({ foo: "bar" });
      expect(after.error.retryable).toBe(true);
    }
  });

  it("does not mutate the original Err", () => {
    const before = err("CODE", "msg", 400);
    stampTrace(before, "tr_mutated");
    if (!before.success) {
      expect(before.error.trace_id).toBeUndefined();
    }
  });

  it("overwrites an existing trace_id", () => {
    const before = errRich("CODE", "msg", 400, { trace_id: "tr_old" });
    const after = stampTrace(before, "tr_new");
    if (!after.success) {
      expect(after.error.trace_id).toBe("tr_new");
    }
  });

  it("returns Ok unchanged (no trace_id on the success branch)", () => {
    const before = ok({ hello: "world" });
    const after = stampTrace(before, "tr_xyz");
    expect(after).toBe(before); // same reference
    if (after.success) {
      expect(after.data).toEqual({ hello: "world" });
    }
  });

  it("preserves the original timestamp", () => {
    const before = err("CODE", "msg");
    const after = stampTrace(before, "tr_xyz");
    expect(after.timestamp).toBe(before.timestamp);
  });
});

// ── Errors.notFoundWithHint() ─────────────────────────────────────────────

describe("Errors.notFoundWithHint()", () => {
  it("returns code=ENTITY_NOT_FOUND + hint + docs", () => {
    const result = Errors.notFoundWithHint(
      "capability",
      "cap-001",
      "Call list_capability_types first to find valid IDs.",
      "/docs/AGENT_INTEGRATION.md#capabilities",
    );
    if (!result.success) {
      expect(result.error.code).toBe("CAPABILITY_NOT_FOUND");
      expect(result.error.httpStatus).toBe(404);
      expect(result.error.hint).toContain("list_capability_types");
      expect(result.error.docs).toBe("/docs/AGENT_INTEGRATION.md#capabilities");
    }
  });

  it("docs is optional", () => {
    const result = Errors.notFoundWithHint("job", "job-x", "Check ID format.");
    if (!result.success) {
      expect(result.error.hint).toBe("Check ID format.");
      expect(result.error.docs).toBeUndefined();
    }
  });
});

// ── Errors.badRequestWithHint() ───────────────────────────────────────────

describe("Errors.badRequestWithHint()", () => {
  it("returns BAD_REQUEST + 400 + hint + docs + details", () => {
    const result = Errors.badRequestWithHint(
      "missing capability type",
      "Pass `type` in the body — e.g. {\"type\": \"3d-printing\"}.",
      "/docs/AGENT_INTEGRATION.md#contract-building",
      { received_keys: ["selections"] },
    );
    if (!result.success) {
      expect(result.error.code).toBe("BAD_REQUEST");
      expect(result.error.httpStatus).toBe(400);
      expect(result.error.hint).toContain("type");
      expect(result.error.docs).toContain("contract-building");
      expect(result.error.details).toEqual({ received_keys: ["selections"] });
    }
  });
});

// ── Errors.unauthorizedWithHint() / forbiddenWithHint() ───────────────────

describe("Errors.unauthorizedWithHint()", () => {
  it("401 + hint pointing at auth flow", () => {
    const result = Errors.unauthorizedWithHint(
      "Provision an API key via POST /api/auth/provision first.",
      "/docs/AGENT_INTEGRATION.md#auth",
    );
    if (!result.success) {
      expect(result.error.code).toBe("UNAUTHORIZED");
      expect(result.error.httpStatus).toBe(401);
      expect(result.error.hint).toContain("provision");
    }
  });
});

describe("Errors.forbiddenWithHint()", () => {
  it("403 + hint + docs", () => {
    const result = Errors.forbiddenWithHint(
      "Operator role required for this route",
      "Call provision_api_key to upgrade your role.",
      "/docs/AGENT_INTEGRATION.md#roles",
    );
    if (!result.success) {
      expect(result.error.code).toBe("FORBIDDEN");
      expect(result.error.httpStatus).toBe(403);
      expect(result.error.message).toContain("Operator role");
      expect(result.error.hint).toContain("provision_api_key");
    }
  });
});
