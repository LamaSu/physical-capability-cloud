import { describe, it, expect } from "vitest";
import { ok, err, Errors, type Result } from "../types/result.js";

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
