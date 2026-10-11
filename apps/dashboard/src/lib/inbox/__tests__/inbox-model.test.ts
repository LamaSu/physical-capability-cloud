import { describe, expect, it } from "vitest";
import {
  ACK_LABEL, clampText, formatWhen, isAllowedActionRoute, isInternalLink,
  isPinned, orderForDisplay, type InboxAction, type InboxItem,
} from "../inbox-model.js";

const now = Date.parse("2026-10-10T12:00:00Z");
const iso = (delta: number) => new Date(now + delta).toISOString();
function item(id: string, patch: Partial<InboxItem> = {}): InboxItem {
  return {
    id, sourceId: "fake", kind: "mail_this", urgency: "act_now", createdAt: iso(-60_000),
    decideBy: null, title: id, detail: null, link: null, task: null, actions: [], read: null, ...patch,
  };
}
function action(op: InboxAction["op"], path: string): InboxAction {
  return { op, allowed: true, reasonIfNot: null, route: { method: "POST", path } };
}

describe("internal inbox links", () => {
  it.each(["/jobs/a%20b", "/operator", "/"])('accepts %s', (v) => {
    expect(isInternalLink(v)).toBe(true);
  });
  it.each(["//evil.example", "/\\evil", "https://x", "javascript:alert(1)", " /x", "/x\n", "/x y", "", 7, null, "/" + "x".repeat(512), "/x\u007f", "/x\t", "/x://y"])(
    "rejects %j", (v) => expect(isInternalLink(v)).toBe(false),
  );
});

describe("action routes belong to their own operation", () => {
  it.each([".", "..", ".a", "a/b", "a%2Fb", "a b", "a?", "a#", "a+", "", "a".repeat(201)].flatMap((id) => [
    action("approve", `/api/operator/approvals/${id}/approve`),
    action("reject", `/api/operator/approvals/${id}/reject`),
    action("approve", `/api/operator/scopes/${id}/accept`),
  ]))("rejects non-server id in $op $route.path", (v) => expect(isAllowedActionRoute(v)).toBe(false));
  it.each([
    action("approve", "/api/operator/approvals/a/approve"),
    action("approve", "/api/operator/scopes/a/accept"),
    action("reject", "/api/operator/approvals/a/reject"),
    action("approve", "/api/operator/approvals/A0._~:-/approve"),
    action("approve", `/api/operator/approvals/${"a".repeat(200)}/approve`),
  ])("allows $op $route.path", (v) => expect(isAllowedActionRoute(v)).toBe(true));

  it.each([
    { ...action("approve", "/api/operator/approvals/a/approve"), route: { method: "GET", path: "/api/operator/approvals/a/approve" } },
    action("reject", "/api/operator/approvals/a/approve"),
    action("approve", "/api/operator/approvals/a/reject"),
    action("reject", "/api/operator/scopes/a/accept"),
    action("approve", "/api/operator/approvals/a/approve?x=1"),
    action("approve", "/api/operator/approvals/a/approve#x"),
    action("approve", "/api/operator/approvals/../approve"),
    action("approve", "/api/operator/approvals/a..b/approve"),
    action("approve", "/api/operator/approvals/a%2Fb/approve"),
    action("approve", "/api/operator/approvals/a%2fb/approve"),
    action("approve", "/api/admin/x"),
    action("approve", "/api/operator/approvals/a/b/approve"),
    action("approve", "/api/operator/approvals/a/approve/"),
    action("approve", "/api/operator/approvals/a/approve\n"),
    action("reject", "/api/operator/approvals/a/reject\n"),
    action("approve", "/api/operator/scopes/a/accept\n"),
    action("approve", "/api/operator/approvals//approve"),
    action("approve", `/api/operator/approvals/${"a".repeat(201)}/approve`),
  ])("refuses $op $route.path", (v) => expect(isAllowedActionRoute(v)).toBe(false));
});

describe("pinning and display order", () => {
  const task = (dueAt: string | null, at: string | null = null): InboxItem["task"] => ({
    id: "task", dueAt, ackKinds: ["mailed"], ack: at ? { kind: "mailed", at } : null,
  });
  it("pins only unacknowledged act-now items, including those without tasks", () => {
    expect(isPinned(item("no-task"))).toBe(true);
    expect(isPinned(item("open", { task: task(null) }))).toBe(true);
    expect(isPinned(item("done", { task: task(null, iso(-1000)) }))).toBe(false);
    expect(isPinned(item("decision", { urgency: "decide_soon" }))).toBe(false);
  });
  it("sorts each section honestly, null/invalid dates last, then id; never mutates input", () => {
    const items = [
      item("z", { task: task(iso(1000)) }), item("a", { task: task(iso(1000)) }),
      item("urgent", { task: task(iso(-1000)) }), item("no-task"),
      item("invalid", { task: task("invalid"), createdAt: "invalid" }),
      item("done-old", { task: task(null, iso(-2000)) }),
      item("done-new", { task: task(null, iso(-1000)) }),
      item("done-invalid", { task: task(null, "invalid") }),
      item("decision-null", { urgency: "decide_soon", createdAt: null }),
      item("decision-late", { urgency: "decide_soon", decideBy: iso(5000) }),
      item("decision-early", { urgency: "decide_soon", decideBy: iso(2000) }),
      item("decision-invalid", { urgency: "decide_soon", decideBy: "bad" }),
      item("fyi-old", { urgency: "fyi", createdAt: iso(-5000) }),
      item("fyi-new", { urgency: "fyi", createdAt: iso(-1000) }),
      item("fyi-invalid", { urgency: "fyi", createdAt: "bad" }),
    ];
    const before = items.map((v) => v.id);
    const grouped = orderForDisplay(items, now);
    expect(grouped.actNow.map((v) => v.id)).toEqual(["urgent", "a", "z", "no-task", "invalid"]);
    expect(grouped.decideSoon.map((v) => v.id)).toEqual(["decision-early", "decision-late", "decision-invalid", "decision-null"]);
    expect(grouped.fyi.map((v) => v.id)).toEqual(["fyi-new", "fyi-old", "fyi-invalid"]);
    expect(grouped.done.map((v) => v.id)).toEqual(["done-new", "done-old", "done-invalid"]);
    expect(items.map((v) => v.id)).toEqual(before);
  });
  it("uses createdAt as the secondary order and id for all ties", () => {
    const grouped = orderForDisplay([
      item("b"), item("a"), item("new", { createdAt: iso(0) }),
      item("db", { urgency: "decide_soon" }), item("da", { urgency: "decide_soon" }),
      item("fb", { urgency: "fyi" }), item("fa", { urgency: "fyi" }),
      item("xb", { task: task(null, iso(-1000)) }), item("xa", { task: task(null, iso(-1000)) }),
    ], now);
    expect(grouped.actNow.map((v) => v.id)).toEqual(["new", "a", "b"]);
    expect(grouped.decideSoon.map((v) => v.id)).toEqual(["da", "db"]);
    expect(grouped.fyi.map((v) => v.id)).toEqual(["fa", "fb"]);
    expect(grouped.done.map((v) => v.id)).toEqual(["xa", "xb"]);
  });
});

describe("plain text and fixed time copy", () => {
  it("clamps strings after stripping controls and trimming", () => {
    expect(clampText(7, 80)).toBeNull();
    expect(clampText(null, 80)).toBeNull();
    expect(clampText(" \u0000hello\nworld\u007f ", 80)).toBe("helloworld");
    expect(clampText("abcdefghi", 8)).toBe("abcde...");
    expect(clampText("eight123", 8)).toBe("eight123");
    expect(clampText("<script>", 80)).toBe("<script>");
    expect(clampText("   ", 80)).toBe("");
    expect(ACK_LABEL).toEqual({ mailed: "Mailed", not_mailed: "Not mailed", resolved: "Fixed", acknowledged: "Seen" });
  });
  it.each([
    [null, "time not reported"], ["invalid", "time not reported"],
    [iso(-1000), "just now"], [iso(1000), "just now"],
    [iso(-5 * 60_000), "5m ago"], [iso(5 * 60_000), "in 5m"],
    [iso(-3 * 3_600_000), "3h ago"], [iso(3 * 3_600_000), "in 3h"],
    [iso(-2 * 86_400_000), "2d ago"], [iso(2 * 86_400_000), "in 2d"],
  ])("formats %s as %s", (v, copy) => expect(formatWhen(v, now)).toBe(copy));
});
