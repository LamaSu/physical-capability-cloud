// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PUBLISHED_SURFACES } from "../../lib/public-claims";

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const PUBLIC = "apps/dashboard/public/";
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const prompt = read(PUBLIC + "pizza-llm-agent-prompt.md");
const raw = read(PUBLIC + "pcc-agent-package-pizza.json");
const pkg = JSON.parse(raw);
const TEXT_OFF = "The pizza demo is off on this deployment.";
const TEXT_CHECK = "Before any other call, check that the demo is on: GET {BASE}/sse/demo/firehose. It needs no key. A 404 means the pizza demo is off on that deployment: make no other call, and tell the user: \"The pizza demo is off on this deployment.\" A 200 means it's on: close the stream and continue. Any other answer, or none, means you couldn't confirm it: make no other call, and tell the user: \"I couldn't confirm that the pizza demo is on.\"";
const TEXT_KEY = "Every /api call here needs an API key except GET /api/capabilities/types and POST /api/auth/provision. Get one with POST /api/auth/provision (send an email or a wallet address), then send it as Authorization: Bearer pcc_live_.... The /sse/demo streams need no key.";
const TEXT_BASE = "BASE = the address (scheme and host) of the site you got this prompt from. If you don't know it, ask the user.";
const TEXT_CURL = "No HTTP tool? Ask the user to run: curl -s -o /dev/null -w '%{http_code}\\n' --max-time 5 {BASE}/sse/demo/firehose — it prints 404 when the demo is off; when it's on, it prints 200 after 5 seconds. Anything else means you couldn't confirm it.";
const TEXT_404 = "- `404 not_found` (the body is exactly {\"error\":\"not_found\"}) — run the check again. If it answers 404, the demo is off on this deployment: stop, and tell the user: \"The pizza demo is off on this deployment.\" Don't offer to change the order. If it answers 200, the order id is wrong: use the id from the plan. Any other answer, or none, means you couldn't confirm it: make no other call, and tell the user: \"I couldn't confirm that the pizza demo is on.\"";
const TEXT_401 = "- `401 api_key_required` — you sent no key. Provision one (POST /api/auth/provision), send it as Authorization: Bearer, and retry once.";
const unconfirmed = "Any other answer, or none, means you couldn't confirm it: make no other call, and tell the user: \"I couldn't confirm that the pizza demo is on.\"";

describe("pizza agent documents", () => {
  it("the prompt checks the demo before its first demo call", () => {
    expect(prompt).toContain(TEXT_CHECK);
    expect(prompt.indexOf(TEXT_CHECK)).toBeLessThan(prompt.indexOf("/api/demo/"));
    const reference = prompt.slice(prompt.indexOf("## Quick reference")).split("\n").filter((line) => /^\d+\./.test(line));
    expect(reference[0]).toBe("0. GET  /sse/demo/firehose                     → 404: the demo is off, stop; 200: on, close the stream; anything else: you couldn't confirm it, stop");
    expect(reference[1].split("→")[0].trimEnd()).toBe("1. GET  /api/csd/suggest?q=make-pizza");
  });
  it("the prompt tells the agent what to say when the demo is off or unconfirmed", () => {
    expect(prompt.split(TEXT_OFF).length - 1).toBeGreaterThanOrEqual(2);
    expect(prompt.split(unconfirmed).length - 1).toBe(2);
  });
  it("the prompt's no-tools check ends with the unconfirmed case", () => {
    expect(prompt).toContain(TEXT_CURL);
  });
  it("the prompt stops on not_found and api_key_required without changing the order", () => {
    const section = prompt.slice(prompt.indexOf("## SECTION 6"), prompt.indexOf("## Quick reference"));
    expect(section).toContain(TEXT_404);
    expect(section).toContain(TEXT_401);
    const bullets = section.split("\n").filter((line) => /^- `(?:404 not_found|401 api_key_required)`/.test(line));
    expect(bullets).toHaveLength(2);
    for (const bullet of bullets) expect(bullet).not.toMatch(/relax|widen|raise the budget/i);
  });
  it("the prompt makes no keyless claim and names no fixed host", () => {
    expect(prompt).not.toMatch(/keyless/i);
    expect(prompt).not.toContain("capability.network");
    expect(prompt).not.toContain("AWS for the physical world");
    expect(prompt.split(TEXT_BASE).length - 1).toBe(2);
    expect(prompt).toContain("    -H 'authorization: Bearer pcc_live_...' \\");
    expect(prompt).toContain("`curl -s -H 'authorization: Bearer pcc_live_...' {BASE}/api/demo/orders/<id>`");
    expect(prompt).not.toContain("curl -s {BASE}/api/demo/");
  });
  it("the package starts with the demo check", () => {
    expect(pkg.tools[0].name).toBe("check_demo_available");
    expect(pkg.tools[0].endpoint).toEqual({ method: "GET", path: "/sse/demo/firehose" });
    expect(pkg.system_prompt).toContain(TEXT_CHECK);
    expect(pkg.system_prompt.indexOf(TEXT_CHECK)).toBeLessThan(pkg.system_prompt.indexOf("/api/demo/"));
  });
  it("the package's check covers off and unconfirmed", () => {
    for (const text of [pkg.tools[0].description, pkg.system_prompt, pkg.quickstart.availability]) {
      expect(text).toContain(TEXT_OFF);
      expect(text).toContain(unconfirmed);
    }
  });
  it("the package claims no key is needed only for its open endpoints", () => {
    const open = ["GET /sse/demo/order/{id}", "GET /api/capabilities/types", "POST /api/auth/provision"];
    for (const tool of pkg.tools) if (/keyless|PUBLIC/.test(tool.description)) expect(open).toContain(tool.endpoint.method + " " + tool.endpoint.path);
    for (const text of ["needs no API key", "endpoints are keyless", "public (keyless)", "NOT required for the pizza demo", "PUBLIC for the demo gateway"]) expect(raw).not.toContain(text);
    expect(pkg.quickstart).not.toHaveProperty("keyless");
    expect(pkg.quickstart.curl_relay).toContain("curl -s -H 'authorization: Bearer pcc_live_...' {BASE}/api/demo/orders/<id>");
  });
  it("the package names no fixed host for its own files and calls", () => {
    expect(pkg.api_base).toBe("{BASE}");
    expect(pkg.api_base_rule).toBe("BASE is the address (scheme and host) of the site you fetched this file from. If you don't know it, ask the user.");
    expect(raw.match(/https:\/\/capability\.network/g)).toHaveLength(2);
    expect(raw.match(/https:\/\/capability\.network\/agent-package\.json/g)).toHaveLength(2);
  });
});

describe("links into the demo", () => {
  it("no page outside the demo links to a demo page", () => {
    const names = ["order.html", "driver.html", "operator.html", "operator-capture.html", "pizza-observability.html", "pizza-llm-bootstrap.html", "pizza-onboard-driver.html", "pizza-onboard-shop.html", "pizza-onboard-user.html", "pizza-llm-agent-prompt.html", "pizza-demo-index.html", "pizza-llm-agent-prompt.md", "pcc-agent-package-pizza.json", "driver-capture.html", "demo-gate.js"];
    const skipped = new Set(names.map((name) => PUBLIC + name));
    const links: string[] = [];
    function walk(relative: string) {
      for (const entry of readdirSync(join(ROOT, relative), { withFileTypes: true })) {
        if (entry.name === "__tests__") continue;
        const path = relative + "/" + entry.name;
        if (entry.isDirectory()) { walk(path); continue; }
        if (!entry.isFile() || skipped.has(path)) continue;
        const text = read(path);
        const urls = text.matchAll(/(?:href|src)=["']([^"']+)["']|\]\(([^)]+)\)|https?:\/\/[^\s"'<>`)]+/g);
        for (const match of urls) {
          const url = match[1] || match[2] || match[0];
          const last = basename(url.split(/[?#]/)[0]);
          if (names.includes(last)) links.push(path + ": " + url);
        }
      }
    }
    for (const path of ["apps/dashboard/public", "apps/dashboard/src", "docs"]) walk(path);
    expect(links).toEqual([]);
  });
  it("lists every demo file as a published surface", () => {
    for (const path of [
      "apps/dashboard/public/order.html",
      "apps/dashboard/public/driver.html",
      "apps/dashboard/public/operator.html",
      "apps/dashboard/public/operator-capture.html",
      "apps/dashboard/public/pizza-observability.html",
      "apps/dashboard/public/pizza-llm-bootstrap.html",
      "apps/dashboard/public/pizza-onboard-driver.html",
      "apps/dashboard/public/pizza-onboard-shop.html",
      "apps/dashboard/public/pizza-llm-agent-prompt.md",
      "apps/dashboard/public/pcc-agent-package-pizza.json",
      "apps/dashboard/public/pizza-demo-index.html",
      "apps/dashboard/public/pizza-onboard-user.html",
      "apps/dashboard/public/pizza-llm-agent-prompt.html",
      "apps/dashboard/public/demo-gate.js",
    ]) expect(PUBLISHED_SURFACES).toContain(path);
  });
});
