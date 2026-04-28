/**
 * input-parser unit tests.
 * Covers all URL/connection/doc detection regex + the parseInputIntent
 * dispatcher decision tree.
 */

import { describe, it, expect } from "vitest";
import {
  looksLikeUrl,
  looksLikeConnString,
  looksLikeDoc,
  looksLikeBuildCommand,
  parseBootstrap,
  parseInputIntent,
} from "../input-parser.js";

describe("looksLikeUrl", () => {
  it("matches http URLs", () => {
    expect(looksLikeUrl("http://example.com")).toBe(true);
  });
  it("matches https URLs", () => {
    expect(looksLikeUrl("https://example.com/foo")).toBe(true);
  });
  it("trims leading whitespace", () => {
    expect(looksLikeUrl("   https://example.com")).toBe(true);
  });
  it("rejects FTP", () => {
    expect(looksLikeUrl("ftp://example.com")).toBe(false);
  });
  it("rejects bare domain", () => {
    expect(looksLikeUrl("example.com")).toBe(false);
  });
  it("rejects empty", () => {
    expect(looksLikeUrl("")).toBe(false);
  });
});

describe("looksLikeConnString", () => {
  it("matches postgres", () => {
    expect(looksLikeConnString("postgres://user:pw@host/db")).toBe(true);
  });
  it("matches postgresql", () => {
    expect(looksLikeConnString("postgresql://host/db")).toBe(true);
  });
  it("matches mysql", () => {
    expect(looksLikeConnString("mysql://localhost")).toBe(true);
  });
  it("matches mongodb", () => {
    expect(looksLikeConnString("mongodb://atlas.mongodb.net")).toBe(true);
  });
  it("matches redis", () => {
    expect(looksLikeConnString("redis://cache:6379")).toBe(true);
  });
  it("matches s3", () => {
    expect(looksLikeConnString("s3://bucket-name")).toBe(true);
  });
  it("matches sharepoint", () => {
    expect(looksLikeConnString("sharepoint://acme.sharepoint.com")).toBe(true);
  });
  it("rejects http URL", () => {
    expect(looksLikeConnString("https://example.com")).toBe(false);
  });
  it("is case-insensitive", () => {
    expect(looksLikeConnString("POSTGRES://h")).toBe(true);
  });
});

describe("looksLikeDoc", () => {
  it("matches .pdf", () => {
    expect(looksLikeDoc("https://acme.com/spec.pdf")).toBe(true);
  });
  it("matches .docx", () => {
    expect(looksLikeDoc("https://acme.com/sop.docx")).toBe(true);
  });
  it("matches .html ending", () => {
    expect(looksLikeDoc("https://acme.com/page.html")).toBe(true);
  });
  it("matches .htm ending", () => {
    expect(looksLikeDoc("https://acme.com/page.htm")).toBe(true);
  });
  it("matches Google Drive", () => {
    expect(looksLikeDoc("https://drive.google.com/file/d/abc/view")).toBe(true);
  });
  it("matches SharePoint .pdf path", () => {
    expect(
      looksLikeDoc("https://acme.sharepoint.com/sites/x/shared/manual.pdf"),
    ).toBe(true);
  });
  it("rejects bare website", () => {
    expect(looksLikeDoc("https://example.com")).toBe(false);
  });
  it("rejects deep website without doc extension", () => {
    expect(looksLikeDoc("https://example.com/about/team")).toBe(false);
  });
});

describe("looksLikeBuildCommand", () => {
  it.each([
    ["build", true],
    ["BUILD", true],
    ["deploy", true],
    ["ship", true],
    ["go live", true],
    ["finish", true],
    ["done", true],
    ["build it", false],
    ["please build", false],
    ["", false],
    ["random", false],
  ])("%s → %s", (input, expected) => {
    expect(looksLikeBuildCommand(input)).toBe(expected);
  });
});

describe("parseBootstrap", () => {
  it("parses 'name at URL'", () => {
    expect(parseBootstrap("Acme Co at https://acme.example")).toEqual({
      name: "Acme Co",
      url: "https://acme.example",
    });
  });
  it("parses 'name @ URL'", () => {
    expect(parseBootstrap("Foo @ https://foo.com")).toEqual({
      name: "Foo",
      url: "https://foo.com",
    });
  });
  it("parses 'name — URL' (em dash)", () => {
    expect(parseBootstrap("Name — https://x.com")).toEqual({
      name: "Name",
      url: "https://x.com",
    });
  });
  it("parses 'name - URL' (hyphen)", () => {
    expect(parseBootstrap("Acme - https://acme.com")).toEqual({
      name: "Acme",
      url: "https://acme.com",
    });
  });
  it("returns null for plain text", () => {
    expect(parseBootstrap("just text")).toBeNull();
  });
  it("returns null for URL only", () => {
    expect(parseBootstrap("https://x.com")).toBeNull();
  });
});

describe("parseInputIntent — no session", () => {
  it("treats 'name at URL' as bootstrap with URL", () => {
    expect(parseInputIntent("Acme Co at https://acme.com", false)).toEqual({
      kind: "bootstrap",
      name: "Acme Co",
      url: "https://acme.com",
    });
  });
  it("treats plain text as bootstrap without URL", () => {
    expect(parseInputIntent("Just My Company", false)).toEqual({
      kind: "bootstrap",
      name: "Just My Company",
      url: null,
    });
  });
  it("returns noop for empty input even without session", () => {
    expect(parseInputIntent("   ", false)).toEqual({ kind: "noop" });
  });
});

describe("parseInputIntent — with session", () => {
  it("routes a single URL to scrape_url", () => {
    expect(parseInputIntent("https://acme.com", true)).toEqual({
      kind: "scrape_url",
      url: "https://acme.com",
    });
  });
  it("routes a single doc URL to ingest_docs", () => {
    expect(parseInputIntent("https://acme.com/spec.pdf", true)).toEqual({
      kind: "ingest_docs",
      urls: ["https://acme.com/spec.pdf"],
    });
  });
  it("routes connection strings to connections", () => {
    const result = parseInputIntent(
      "postgres://h/db redis://c:6379",
      true,
    );
    expect(result).toEqual({
      kind: "connections",
      connections: ["postgres://h/db", "redis://c:6379"],
    });
  });
  it("routes 'build' to build", () => {
    expect(parseInputIntent("build", true)).toEqual({ kind: "build" });
  });
  it("routes 'deploy' to build", () => {
    expect(parseInputIntent("DEPLOY", true)).toEqual({ kind: "build" });
  });
  it("splits multiple URLs into docs + scrape", () => {
    const text =
      "https://acme.com https://docs.example.com/manual.pdf https://other.com";
    const result = parseInputIntent(text, true);
    expect(result.kind).toBe("scrape_many");
    if (result.kind === "scrape_many") {
      expect(result.docs).toEqual(["https://docs.example.com/manual.pdf"]);
      expect(result.urls).toEqual([
        "https://acme.com",
        "https://other.com",
      ]);
    }
  });
  it("returns noop for free text", () => {
    expect(parseInputIntent("hello there", true)).toEqual({ kind: "noop" });
  });
  it("prefers connection-string parse over scrape when both are present", () => {
    // Connection strings take priority — onboard wires DBs first.
    const result = parseInputIntent(
      "postgres://h/db https://other.com",
      true,
    );
    expect(result.kind).toBe("connections");
  });
});
