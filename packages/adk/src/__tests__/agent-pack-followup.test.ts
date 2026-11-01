import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SOURCE } from "../../scripts/generate-agent-pin.mjs";
import { AGENT_TOOLS } from "../agent-package.js";

const AMOUNT_TEXT = "number, or null when the poster stated none";
const SKILL_COPIES = [
  "apps/dashboard/public/skills/pcc.md",
  "skills/pcc/SKILL.md",
  ".claude/skills/pcc/SKILL.md",
];
const PRICING_EXAMPLE = /"pricing":\s*\{[^}]*\}|\bpricing=\{[^}]*\}/g;
const PLACEHOLDER_ZERO = /\bamount"?\s*:\s*0\s*[,}]/;
const DROPPED = { name: "pcc_dht_announce", method: "POST", path: "/api/dht/announce" };
const PIZZA_REQUEST = "Order me a pizza for delivery to 728 Geary St SF.";
const COURIER_POST = /\bpost(?:s|ing)? the courier\b/i;

const REPO = resolve(dirname(SOURCE), "../../..");

type Tool = { name: string; endpoint: { method: string; path: string } };
type Example = { user_request: string; what_claude_does: string };
type Pack = {
  tools: Tool[];
  examples: Example[];
  dtos: { JobOffer: { shape: { pricing: { amount: string } } } };
};

function readPack(): Pack {
  return JSON.parse(readFileSync(SOURCE, "utf8")) as Pack;
}

function packStrings(value: unknown, path = ""): [string, string][] {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((item, i) => packStrings(item, `${path}/${i}`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) =>
      path === "" && key === "system_prompt" ? [] : packStrings(item, `${path}/${key}`),
    );
  }
  return [];
}

describe("CODE #53 agent pack follow-up", () => {
  it("FT1 the JobOffer DTO says the amount is a number, or null when the poster stated none", () => {
    expect(readPack().dtos.JobOffer.shape.pricing.amount).toBe(AMOUNT_TEXT);
  });

  it("FT2 every pricing example in the skill copies and the pack's examples carries an amount and a currency, and a quote-required one uses the placeholder 0", () => {
    const texts: [string, string][] = SKILL_COPIES.map((file) => [file, readFileSync(resolve(REPO, file), "utf8")]);
    texts.push(["agent-package.json examples", readPack().examples.map((example) => example.what_claude_does).join("\n")]);
    const problems: string[] = [];
    for (const [file, text] of texts) {
      const examples = [...text.matchAll(PRICING_EXAMPLE)].map((match) => match[0]);
      expect(examples.length, `${file}: no pricing examples found`).toBeGreaterThan(0);
      for (const example of examples) {
        const reasons: string[] = [];
        if (!/\bamount\b/.test(example)) reasons.push("missing amount");
        if (!/\bcurrency\b/.test(example)) reasons.push("missing currency");
        if (example.includes("quote-required") && !PLACEHOLDER_ZERO.test(example)) reasons.push("missing placeholder amount 0");
        if (reasons.length) problems.push(`${file}: ${reasons.join(", ")}: ${example}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("FT3 pcc_dht_announce is gone from the pack, the pin and the root fixture, by name and by endpoint, and the other DHT tools stay", () => {
    const raw = readFileSync(SOURCE, "utf8");
    const pkg = JSON.parse(raw) as Pack;
    const fixture = JSON.parse(readFileSync(resolve(REPO, "agent-package-test.json"), "utf8")) as { tools: Tool[] };
    const problems: string[] = [];
    const droppedEndpoint = (tool: { method: string; path: string }) => tool.method === DROPPED.method && tool.path === DROPPED.path;
    if (pkg.tools.some((tool) => tool.name === DROPPED.name)) problems.push("pack still has the dropped tool name");
    if (pkg.tools.some((tool) => droppedEndpoint(tool.endpoint))) problems.push("pack still has the dropped endpoint");
    if (raw.includes('"pcc_dht_announce"')) problems.push("pack raw text still names the dropped tool");
    if (Object.prototype.hasOwnProperty.call(AGENT_TOOLS, DROPPED.name)) problems.push("pin still has the dropped tool name");
    if (Object.values(AGENT_TOOLS).some(droppedEndpoint)) problems.push("pin still has the dropped endpoint");
    if (fixture.tools.some((tool) => tool.name === DROPPED.name)) problems.push("root fixture still has the dropped tool name");
    if (fixture.tools.some((tool) => droppedEndpoint(tool.endpoint))) problems.push("root fixture still has the dropped endpoint");
    for (const name of ["pcc_dht_query", "pcc_dht_peers", "pcc_dht_metrics"]) {
      if (!pkg.tools.some((tool) => tool.name === name)) problems.push(`pack is missing ${name}`);
      if (!Object.prototype.hasOwnProperty.call(AGENT_TOOLS, name)) problems.push(`pin is missing ${name}`);
    }
    for (const name of ["pcc_dht_query", "pcc_dht_peers"]) {
      if (!fixture.tools.some((tool) => tool.name === name)) problems.push(`root fixture is missing ${name}`);
    }
    expect(problems).toEqual([]);
  });

  it("FT5 every flow that looks up courier.dispatch, and every pack string outside the system prompt that posts the courier offer, shows the user the driver's price and posts the courier offer only after they confirm it", () => {
    const pkg = readPack();
    const problems: string[] = [];
    const flows: [string, string][] = [[SKILL_COPIES[0], readFileSync(resolve(REPO, SKILL_COPIES[0]), "utf8")]];
    const pizza = pkg.examples.find((example) => example.user_request === PIZZA_REQUEST);
    if (pizza) flows.push(["agent-package.json pizza example", pizza.what_claude_does]);
    else problems.push("pack is missing the pizza example");
    for (const [i, example] of pkg.examples.entries()) {
      if (example !== pizza && example.what_claude_does.includes("?type=courier.dispatch")) {
        flows.push([`agent-package.json examples[${i}]`, example.what_claude_does]);
      }
    }
    for (const [file, text] of flows) {
      const lookup = text.indexOf("?type=courier.dispatch");
      const post = lookup < 0 ? -1 : text.indexOf("POST /api/job-offers", lookup);
      if (lookup < 0 || post < 0) {
        problems.push(`${file}: missing courier lookup or job-offers post`);
      } else {
        const beforePost = text.slice(lookup, post);
        if (!/\bprice\b/i.test(beforePost) || !/\bconfirm/i.test(beforePost)) {
          problems.push(`${file}: courier post does not follow the driver's price and confirmation: ${beforePost}`);
        }
      }
    }
    const courierStrings = packStrings(pkg).filter(([, text]) => COURIER_POST.test(text));
    if (!courierStrings.length) problems.push("pack has no string posting the courier offer outside the system prompt");
    for (const [path, text] of courierStrings) {
      const match = COURIER_POST.exec(text)!;
      const dispatchAt = text.indexOf("dispatchAt", match.index);
      const beforeDispatch = text.slice(match.index, dispatchAt < 0 ? text.length : dispatchAt);
      if (!/\bprice\b/i.test(beforeDispatch) || !/\bconfirm/i.test(beforeDispatch)) {
        problems.push(`agent-package.json ${path}: courier post does not require the driver's price and confirmation: ${beforeDispatch}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
