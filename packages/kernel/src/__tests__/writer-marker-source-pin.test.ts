import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const kernelSrc = fileURLToPath(new URL("../", import.meta.url));
const packagesRoot = fileURLToPath(new URL("../../../", import.meta.url));

function sourceFiles(src: string): string[] {
  return readdirSync(src, { recursive: true, encoding: "utf8" })
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => path.endsWith(".ts"))
    .filter((path) => !path.split("/").some((part) =>
      part === "__tests__" || part === "node_modules" || part === "dist"))
    .filter((path) => !path.endsWith(".test.ts") && !path.endsWith(".spec.ts"))
    .map((path) => join(src, path));
}

function rel(src: string, path: string): string {
  return relative(src, path).replaceAll("\\", "/");
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

const stampPatterns = [
  /\bwriter\s*:/,
  /\.writer\s*=(?!=)/,
  /\[\s*(["'`])writer\1\s*\]\s*=(?!=)/,
  /defineProperty\s*\([^)]*(["'`])writer\1/,
];

describe("writer marker authoring source pins", () => {
  it("S1 only evidence-emitter.ts calls hashKernelWrittenEvent, exactly once", () => {
    const files = sourceFiles(kernelSrc);
    const occurrences = files.filter((path) =>
      stripComments(readFileSync(path, "utf8")).includes("hashKernelWrittenEvent"));

    expect(occurrences.map((path) => rel(kernelSrc, path))).toStrictEqual([
      "evidence-emitter.ts",
    ]);

    const emitter = stripComments(readFileSync(
      join(kernelSrc, "evidence-emitter.ts"), "utf8",
    ));
    expect([...emitter.matchAll(/\bhashKernelWrittenEvent\s*\(/g)]).toHaveLength(1);
  });

  it("S2 exactly one addKernelWrittenEvent call exists across all packages/*/src", () => {
    const occurrences: string[] = [];
    const packages = readdirSync(packagesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());

    for (const entry of packages) {
      const src = join(packagesRoot, entry.name, "src");
      if (!existsSync(src)) continue;
      for (const path of sourceFiles(src)) {
        const text = stripComments(readFileSync(path, "utf8"));
        for (const _match of text.matchAll(/\.addKernelWrittenEvent\s*\(/g)) {
          occurrences.push(`${entry.name}/src/${rel(src, path)}`);
        }
      }
    }

    expect(occurrences).toStrictEqual([
      "kernel/src/job-runner.ts",
    ]);
  });

  it("S3 only the emitter contains a writer-stamping expression in kernel source", () => {
    const files = sourceFiles(kernelSrc);
    const scanned = files.map((path) => rel(kernelSrc, path));
    expect(scanned).toContain("evidence-emitter.ts");
    expect(scanned).toContain("job-runner.ts");
    expect(scanned).toContain("printer-job.ts");
    expect(scanned).toContain("digital/accounting-kernel.ts");

    const stamped = files.filter((path) => {
      const text = stripComments(readFileSync(path, "utf8"));
      return stampPatterns.some((pattern) => pattern.test(text));
    });

    expect(stamped.map((path) => rel(kernelSrc, path))).toStrictEqual([
      "evidence-emitter.ts",
    ]);
  });
});
