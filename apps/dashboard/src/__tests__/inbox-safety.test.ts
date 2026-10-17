import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
interface Source { rel: string; text: string }
function productionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : productionFiles(full);
    return /\.[cm]?[jt]sx?$/.test(name) && !/\.(test|spec)\.[jt]sx?$/.test(name) && !name.endsWith(".d.ts") ? [full] : [];
  });
}
const files = productionFiles(SRC).map((full) => ({ rel: relative(SRC, full).split(sep).join("/"), text: readFileSync(full, "utf8") }));
const OWNERS = {
  ackTask: ["stores/inbox-store.ts", "components/inbox/TaskCard.tsx"],
  decideItem: ["stores/inbox-store.ts", "components/inbox/InboxItemCard.tsx"],
  markItemsRead: ["stores/inbox-store.ts", "components/inbox/InboxItemCard.tsx"],
};
const FORBIDDEN = /dangerouslySetInnerHTML|innerHTML|outerHTML|EventSource|\/sse\/|broadcastNotification|localStorage|sessionStorage/;
const isInbox = (rel: string) => rel.startsWith("lib/inbox/") || rel === "stores/inbox-store.ts" || rel.startsWith("components/inbox/");
function violations(sources: Source[]): string[] {
  return sources.flatMap(({ rel, text }) => {
    const hits: string[] = [];
    for (const [name, owners] of Object.entries(OWNERS)) {
      if (new RegExp(`\\b${name}\\b`).test(text) && !owners.includes(rel)) hits.push(`${rel}: ${name} outside its click/store owners`);
    }
    if (isInbox(rel) && FORBIDDEN.test(text)) hits.push(`${rel}: forbidden inbox mechanism`);
    return hits;
  });
}

describe("inbox safety call sites and rendering", () => {
  it("checks the production tree and pins every click action to its two owners", () => {
    expect(files.map((v) => v.rel)).toEqual(expect.arrayContaining([
      "lib/inbox/inbox-model.ts", "lib/inbox/operator-work-source.ts", "stores/inbox-store.ts",
      "components/inbox/InboxPanel.tsx", "components/inbox/InboxItemCard.tsx", "components/inbox/TaskCard.tsx",
    ]));
    for (const [name, owners] of Object.entries(OWNERS)) {
      expect(files.filter((v) => new RegExp(`\\b${name}\\b`).test(v.text)).map((v) => v.rel).sort(), name).toEqual([...owners].sort());
    }
    expect(violations(files)).toEqual([]);
  });
  it("catches an extra acknowledgment call site in a fixture", () => {
    expect(violations([{ rel: "hooks/use-inbox.ts", text: 'store.getState().ackTask("id", "mailed");' }])).toEqual(["hooks/use-inbox.ts: ackTask outside its click/store owners"]);
  });
  it("catches HTML rendering in an otherwise allowed fixture", () => {
    expect(violations([{ rel: "components/inbox/InboxItemCard.tsx", text: '<div dangerouslySetInnerHTML={{ __html: item.title }} />' }])).toEqual(["components/inbox/InboxItemCard.tsx: forbidden inbox mechanism"]);
  });
  it.each(["innerHTML", "outerHTML", "EventSource", "/sse/", "broadcastNotification", "localStorage", "sessionStorage"])("catches %s in inbox production fixtures", (text) => {
    expect(violations([{ rel: "lib/inbox/probe.ts", text }])).toHaveLength(1);
  });
});
