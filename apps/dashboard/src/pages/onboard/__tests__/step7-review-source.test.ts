import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(here, "../Step7_Review.tsx");
const source = readFileSync(sourcePath, "utf-8");

describe("Step7_Review — registration states", () => {
  it("does not retain the fabricated offline success path", () => {
    expect(source).not.toContain('status: "success"');
    expect(source).not.toContain("treat as offline success");
  });

  it("retains the registered screen for confirmed registration", () => {
    expect(source).toContain("Machine Registered");
    expect(source).toContain('if (submit.status === "confirmed")');
  });

  it("includes a distinct unconfirmed registration screen", () => {
    expect(source).toContain("Couldn't reach the network to confirm");
  });

  it("uses PCC without the old PCCP spelling", () => {
    expect(source).not.toContain("PCCP");
  });

  it("imports the registration orchestrator", () => {
    expect(source).toMatch(
      /import\s*\{[^}]*\bregisterMachine\b[^}]*\}\s*from\s*"\.\/register-machine\.js";/,
    );
  });
});
