import { describe, expect, it } from "vitest";
import { formatCount, isKernelOnline } from "../live-list.js";

describe("isKernelOnline", () => {
  it("counts only online kernels with an explicitly fresh heartbeat", () => {
    expect(isKernelOnline({ status: "online", isStale: false })).toBe(true);
    expect(isKernelOnline({ status: "online", isStale: true })).toBe(false);
    for (const status of ["offline", "maintenance", "suspended", "expired", "unknown"]) {
      expect(isKernelOnline({ status, isStale: false } as Parameters<typeof isKernelOnline>[0]), status).toBe(false);
    }
    expect(isKernelOnline({ status: "online" } as Parameters<typeof isKernelOnline>[0])).toBe(false);
    expect(isKernelOnline({ status: "online", isStale: null } as unknown as Parameters<typeof isKernelOnline>[0])).toBe(false);
  });
});

describe("formatCount", () => {
  it("formats exact counts and lower bounds including zero", () => {
    expect(formatCount(12, false)).toBe("12");
    expect(formatCount(12, true)).toBe("12+");
    expect(formatCount(0, false)).toBe("0");
    expect(formatCount(0, true)).toBe("0+");
  });
});
