import { describe, it, expect } from "vitest";
import {
  EscrowLedger,
  InsufficientBalanceError,
  EscrowEmptyError,
  userAccount,
  operatorAccount,
  escrowAccount,
} from "./ledger.js";
import type { Actor } from "./types.js";

const user: Actor = { id: "u1", kind: "user" };
const op: Actor = { id: "o1", kind: "operator" };

describe("EscrowLedger atomic ops", () => {
  it("deposit + lock + release nets to operator with zero left in escrow", () => {
    const ledger = new EscrowLedger();
    ledger.deposit(user, 10_000);
    expect(ledger.getBalance(userAccount(user))).toBe(10_000);

    const lock = ledger.lock("sess-1", user, 7_500);
    expect(lock.newBalance.from).toBe(2_500);
    expect(lock.newBalance.escrow).toBe(7_500);
    expect(ledger.getBalance(escrowAccount("sess-1"))).toBe(7_500);

    const release = ledger.release("sess-1", op);
    expect(release.newBalance.escrow).toBe(0);
    expect(release.newBalance.to).toBe(7_500);
    expect(ledger.getBalance(operatorAccount(op))).toBe(7_500);
  });

  it("refund returns escrow to user, escrow then empty", () => {
    const ledger = new EscrowLedger();
    ledger.deposit(user, 5_000);
    ledger.lock("sess-2", user, 5_000);
    const refund = ledger.refund("sess-2", user);
    expect(refund.newBalance.escrow).toBe(0);
    expect(refund.newBalance.to).toBe(5_000); // user got their money back
  });

  it("lock fails atomically when user is short — no entry, no balance change", () => {
    const ledger = new EscrowLedger();
    ledger.deposit(user, 1_000);

    const before = ledger.getStore().history().length;
    expect(() => ledger.lock("sess-3", user, 5_000)).toThrow(InsufficientBalanceError);
    expect(ledger.getStore().history().length).toBe(before); // no entry written
    expect(ledger.getBalance(userAccount(user))).toBe(1_000); // intact
    expect(ledger.getBalance(escrowAccount("sess-3"))).toBe(0);
  });

  it("release on empty escrow throws and writes no entry", () => {
    const ledger = new EscrowLedger();
    const before = ledger.getStore().history().length;
    expect(() => ledger.release("nonexistent", op)).toThrow(EscrowEmptyError);
    expect(ledger.getStore().history().length).toBe(before);
  });

  it("rejects negative amounts on deposit + lock", () => {
    const ledger = new EscrowLedger();
    expect(() => ledger.deposit(user, -1)).toThrow();
    ledger.deposit(user, 100);
    expect(() => ledger.lock("sess-x", user, -50)).toThrow();
  });

  it("history is append-only and contains the right kind sequence", () => {
    const ledger = new EscrowLedger();
    ledger.deposit(user, 1_000);
    ledger.lock("sess-h", user, 600);
    ledger.release("sess-h", op);
    const kinds = ledger.getStore().history().map((e) => e.kind);
    expect(kinds).toEqual(["deposit", "lock", "release"]);
  });

  it("multiple sessions are isolated — locking on one does not drain another's escrow", () => {
    const ledger = new EscrowLedger();
    ledger.deposit(user, 10_000);
    ledger.lock("sess-A", user, 4_000);
    ledger.lock("sess-B", user, 3_000);
    expect(ledger.getBalance(escrowAccount("sess-A"))).toBe(4_000);
    expect(ledger.getBalance(escrowAccount("sess-B"))).toBe(3_000);
    expect(ledger.getBalance(userAccount(user))).toBe(3_000);

    ledger.release("sess-A", op);
    expect(ledger.getBalance(escrowAccount("sess-A"))).toBe(0);
    expect(ledger.getBalance(escrowAccount("sess-B"))).toBe(3_000); // untouched
    expect(ledger.getBalance(operatorAccount(op))).toBe(4_000);
  });

  it("conservation: sum of all account balances equals total deposits", () => {
    const ledger = new EscrowLedger();
    ledger.deposit(user, 10_000);
    ledger.deposit(user, 5_000); // 15k total in
    ledger.lock("sess-C", user, 12_000);
    ledger.release("sess-C", op); // moved to operator

    const total = Object.values(ledger.getStore().snapshot()).reduce((a, b) => a + b, 0);
    expect(total).toBe(15_000);
  });

  it("operator deposits a different actor kind without colliding with user accounts", () => {
    const ledger = new EscrowLedger();
    const arbiter: Actor = { id: "arb-1", kind: "arbiter" };
    ledger.deposit(arbiter, 999);
    expect(ledger.getBalance("acct:arbiter:arb-1")).toBe(999);
    expect(ledger.getBalance("acct:user:arb-1")).toBe(0);
  });

  it("entries are well-formed: ids unique, timestamps ISO-8601, sessionId set on lock/release/refund", () => {
    const ledger = new EscrowLedger();
    ledger.deposit(user, 1_000);
    ledger.lock("sess-D", user, 1_000);
    ledger.release("sess-D", op);

    const history = ledger.getStore().history();
    const ids = new Set(history.map((e) => e.id));
    expect(ids.size).toBe(history.length);

    for (const entry of history) {
      expect(Date.parse(entry.at)).toBeGreaterThan(0);
    }
    expect(history.find((e) => e.kind === "deposit")?.sessionId).toBeNull();
    expect(history.find((e) => e.kind === "lock")?.sessionId).toBe("sess-D");
    expect(history.find((e) => e.kind === "release")?.sessionId).toBe("sess-D");
  });
});
