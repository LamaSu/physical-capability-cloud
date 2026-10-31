// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("operator installation copy", () => {
  it("T12: pins the kernel page and typed operations sentence", () => {
    const source = readFileSync(new URL("../../public/install.html", import.meta.url), "utf8");
    const approved = "When done, your kernel page will be at <code>capability.network/operator/&lt;your-kernel-id&gt;</code>. The node keeps your kernel online and does not take jobs: your devices run only through your operating agent's typed operations.";

    expect(source).toContain(`<p style="margin-top:18px;color:#9aa3b2">${approved}</p>`);
    expect(source).not.toContain("accepting jobs");
  });
});
