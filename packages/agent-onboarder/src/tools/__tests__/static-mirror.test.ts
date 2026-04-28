import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  slugify,
  renderOperatorHtml,
  writeOperatorMirror,
  renderDirectoryHtml,
  writeOperatorDirectory,
} from "../static-mirror.js";
import type { DiscoveryProfile } from "../pcc-discovery.js";

const sampleProfile: DiscoveryProfile = {
  enterprise_id: "ent-abc123",
  name: "Oakland Titanium Mills",
  url: "https://example.com",
  city: "Oakland",
  capabilities: ["Ti-6Al-4V machining", "Inconel 718 turning", "5-axis mill-turn"],
  materials: ["Ti-6Al-4V", "Inconel 718"],
  certifications: ["AS9100 Rev D", "ISO 9001:2015"],
  hours: "24/7",
  agent_url: "https://guild.ai/agents/abc",
  contact_email: "ops@example.com",
};

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pcc-mirror-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("slugify", () => {
  it("lowercases, hyphenates, and strips special chars", () => {
    expect(slugify("Oakland Titanium Mills")).toBe("oakland-titanium-mills");
    expect(slugify("Acme/Co. — Ltd.")).toBe("acme-co-ltd");
    expect(slugify("   ")).toBe("operator");
    expect(slugify("Single")).toBe("single");
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugify("---X---")).toBe("x");
  });

  it("caps slug length at 80 chars", () => {
    const long = "a".repeat(200);
    expect(slugify(long).length).toBe(80);
  });
});

describe("renderOperatorHtml", () => {
  const html = renderOperatorHtml(sampleProfile, "2026-04-24T00:00:00Z");

  it("includes the operator name as title and h1", () => {
    expect(html).toContain("<title>Oakland Titanium Mills — PCC operator</title>");
    expect(html).toContain("<h1>Oakland Titanium Mills</h1>");
  });

  it("embeds parseable JSON-LD with schema.org/Organization", () => {
    const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    const jsonLd = JSON.parse(match![1]);
    expect(jsonLd["@context"]).toBe("https://schema.org");
    expect(jsonLd["@type"]).toBe("Organization");
    expect(jsonLd.name).toBe("Oakland Titanium Mills");
    expect(jsonLd.knowsAbout).toEqual(sampleProfile.capabilities);
    expect(jsonLd.hasCredential).toEqual(["AS9100 Rev D", "ISO 9001:2015"]);
    expect(jsonLd.potentialAction).toEqual({
      "@type": "OfferAction",
      target: "https://guild.ai/agents/abc",
    });
    expect(jsonLd.address).toEqual({ "@type": "PostalAddress", addressLocality: "Oakland" });
  });

  it("escapes user input", () => {
    const malicious: DiscoveryProfile = {
      enterprise_id: "x",
      name: '<script>alert("xss")</script>',
      capabilities: ["a&b", '"quote"'],
    };
    const out = renderOperatorHtml(malicious);
    expect(out).not.toContain('<script>alert("xss")</script>');
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("a&amp;b");
  });

  it("renders capabilities, materials, certifications as list items", () => {
    expect(html).toContain("<li>Ti-6Al-4V machining</li>");
    expect(html).toContain("<li>Inconel 718</li>");
    expect(html).toContain("<li>AS9100 Rev D</li>");
  });

  it("omits sections that are not provided", () => {
    const minimal: DiscoveryProfile = {
      enterprise_id: "x",
      name: "Min Op",
      capabilities: ["c1"],
    };
    const out = renderOperatorHtml(minimal);
    expect(out).not.toContain("Materials</h2>");
    expect(out).not.toContain("Certifications</h2>");
    expect(out).not.toContain("Hours</h2>");
  });
});

describe("writeOperatorMirror", () => {
  it("writes file at the slugged path", async () => {
    const r = await writeOperatorMirror(sampleProfile, { outDir: tmpDir });
    expect(r.slug).toBe("oakland-titanium-mills");
    expect(r.url_path).toBe("/operators/oakland-titanium-mills.html");
    expect(r.path).toBe(path.join(tmpDir, "oakland-titanium-mills.html"));

    const content = await fs.readFile(r.path, "utf8");
    expect(content).toContain("<h1>Oakland Titanium Mills</h1>");
    expect(content).toContain('"@type": "Organization"');
  });

  it("creates the output directory if missing", async () => {
    const nested = path.join(tmpDir, "nested", "deeper");
    const r = await writeOperatorMirror(sampleProfile, { outDir: nested });
    const stat = await fs.stat(r.path);
    expect(stat.isFile()).toBe(true);
  });
});

describe("renderDirectoryHtml + writeOperatorDirectory", () => {
  it("renders entries as anchor list", () => {
    const html = renderDirectoryHtml([
      { name: "Op One", slug: "op-one", capabilities: ["a", "b"], city: "SF" },
      { name: "Op Two", slug: "op-two" },
    ]);
    expect(html).toContain('href="/operators/op-one.html"');
    expect(html).toContain('href="/operators/op-two.html"');
    expect(html).toContain("Op One");
    expect(html).toContain("(SF)");
    expect(html).toContain("a, b");
    expect(html).toContain("2 operators");
  });

  it("uses singular form for one operator", () => {
    const html = renderDirectoryHtml([{ name: "Solo", slug: "solo" }]);
    expect(html).toContain("1 operator registered");
  });

  it("escapes operator names in the directory", () => {
    const html = renderDirectoryHtml([{ name: "<bad>name</bad>", slug: "bad", capabilities: [] }]);
    expect(html).not.toContain("<bad>name</bad>");
    expect(html).toContain("&lt;bad&gt;");
  });

  it("writes the directory file to disk", async () => {
    const r = await writeOperatorDirectory([{ name: "X", slug: "x" }], { outDir: tmpDir });
    expect(r.path).toBe(path.join(tmpDir, "index.html"));
    const content = await fs.readFile(r.path, "utf8");
    expect(content).toContain("PCC operator directory");
    expect(content).toContain('href="/operators/x.html"');
  });
});
