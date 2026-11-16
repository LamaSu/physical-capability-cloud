import { useEffect, useRef, useState } from "react";
import { WalletPageSignInAgain } from "../components/WalletPageSignInAgain.js";
import { useAuth } from "../hooks/use-auth.js";
import { FundingReadError, readFunding, readPrepare, requestPrepare } from "../lib/fund-api.js";
import { FUND_COPY } from "../lib/fund-copy.js";
import { PCC_BETA_STATUS } from "../lib/positioning.js";
import { walletLinkSignInRemedy } from "../lib/wallet-link-api.js";
import { useAuthStore } from "../stores/auth-store.js";

type Prepare = Awaited<ReturnType<typeof readPrepare>>;
type Terms = Extract<Prepare, { kind: "terms" }>;
type View =
  | { kind: "loading" }
  | { kind: "message"; message: string; checkAgain?: boolean }
  | { kind: "prepare"; scopeId: string }
  | { kind: "terms"; terms: Terms }
  | { kind: "verified"; escrow?: string; fundedAt?: string };

const BUTTON = "rounded-lg border border-white/20 px-5 py-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40";

export function FundPage({ jobId }: { jobId: string | null }) {
  const { address } = useAuth();
  const sessionToken = useAuthStore((state) => state.sessionToken);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prepareFlight = useRef<number | null>(null);
  const signInFlight = useRef(false);
  const mounted = useRef(false);
  const reload = useRef<() => void>(() => {});
  const prepareClick = useRef<(scopeId: string) => void>(() => {});
  const [view, setView] = useState<View>({ kind: "loading" });
  const [preparing, setPreparing] = useState(false);
  const [signIn, setSignIn] = useState({ attempted: false, pending: false, failedBeforeMint: false, error: null as string | null, notice: null as string | null });

  useEffect(() => {
    mounted.current = true;
    const current = ++generation.current;
    const firstRead = Date.now();
    let firstPending: number | null = null;
    let pendingTimedOut = false;
    const active = () => mounted.current && generation.current === current;
    const stopTimer = () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
    const message = (text: string, checkAgain = false) => setView({ kind: "message", message: text, checkAgain });
    const failed = (error: unknown) => {
      if (active()) message(error instanceof FundingReadError ? error.message : FUND_COPY.L4);
    };
    const schedule = (delay: number, callback: () => void) => {
      stopTimer();
      timer.current = setTimeout(() => {
        timer.current = null;
        if (active()) callback();
      }, delay);
    };

    async function loadPrepare(scopeId: string, post = false, poll = false) {
      const timedOut = () => {
        pendingTimedOut = true;
        message(FUND_COPY.L10b);
      };
      if (poll && firstPending !== null) {
        const remaining = firstPending + 600_000 - Date.now();
        if (remaining <= 0) { timedOut(); return; }
        // Keep the deadline live while a poll's response is still in flight.
        schedule(remaining, timedOut);
      }
      try {
        const answer = await (post ? requestPrepare(scopeId) : readPrepare(scopeId));
        if (!active() || pendingTimedOut) return;
        stopTimer();
        if (answer.kind === "no-prepare") setView({ kind: "prepare", scopeId });
        else if (answer.kind === "terms") setView({ kind: "terms", terms: answer });
        else {
          firstPending ??= Date.now();
          const deadline = firstPending + 600_000;
          if (Date.now() >= deadline) {
            timedOut();
            return;
          }
          message(FUND_COPY.L9);
          const interval = Math.min(60, Math.max(5, answer.retryAfterSeconds)) * 1000;
          schedule(Math.min(interval, deadline - Date.now()), () => {
            if (Date.now() >= deadline) timedOut();
            else void loadPrepare(scopeId, false, true);
          });
        }
      } catch (error) {
        if (active() && !pendingTimedOut) {
          stopTimer();
          failed(error);
        }
      }
    }

    async function loadFunding(showLoading = true) {
      stopTimer();
      if (jobId === null) {
        message(FUND_COPY.L7);
        return;
      }
      if (showLoading) setView({ kind: "loading" });
      try {
        const scopes = await readFunding(jobId);
        if (!active()) return;
        const newest = scopes.at(-1);
        if (!newest) message(FUND_COPY.L22);
        else if (newest.state === "cancelled") message(FUND_COPY.L12);
        else if (newest.state === "expired") message(FUND_COPY.L11);
        else if (newest.state === "unknown") message(FUND_COPY.L21, true);
        else if (newest.state === "funded_verified") {
          const verification = newest.verification;
          const fundedAt = typeof verification?.fundedAt === "number" ? new Date(verification.fundedAt * 1000) : null;
          setView({ kind: "verified", escrow: typeof verification?.escrowAddress === "string" ? verification.escrowAddress : undefined,
            fundedAt: fundedAt && Number.isFinite(fundedAt.getTime()) ? fundedAt.toISOString() : undefined });
        } else if (newest.state === "prepared") {
          message(FUND_COPY.L3);
          const deadline = Math.min(Date.parse(newest.expiresAt), firstRead + 3_600_000);
          if (Date.now() < deadline) schedule(Math.min(15_000, deadline - Date.now()), () => {
            if (Date.now() < deadline) void loadFunding(false);
          });
        } else await loadPrepare(newest.scopeId);
      } catch (error) {
        failed(error);
      }
    }

    prepareFlight.current = null;
    setPreparing(false);
    reload.current = () => { if (active()) void loadFunding(); };
    prepareClick.current = (scopeId) => {
      if (!active() || prepareFlight.current !== null) return;
      prepareFlight.current = current;
      setPreparing(true);
      void loadPrepare(scopeId, true).finally(() => {
        if (active()) {
          prepareFlight.current = null;
          setPreparing(false);
        }
      });
    };
    void loadFunding();
    return () => {
      mounted.current = false;
      generation.current++;
      stopTimer();
    };
  }, [jobId, address, sessionToken]);

  async function signInAgain(login: () => Promise<void>) {
    if (signInFlight.current) return;
    signInFlight.current = true;
    setSignIn({ attempted: true, pending: true, failedBeforeMint: false, error: null, notice: null });
    try {
      await login();
    } catch {
      // The auth hook records its error; never display a thrown wallet value.
    } finally {
      signInFlight.current = false;
      const settled = useAuthStore.getState();
      if (mounted.current) setSignIn({ attempted: true, pending: false, failedBeforeMint: settled.error !== null,
        error: settled.error, notice: settled.error === null ? settled.authNotice : null });
    }
  }

  const remedy = walletLinkSignInRemedy(view.kind === "message" ? view.message : null);
  return (
    <main className="ph-no-capture sentry-block min-h-screen bg-[#0B0D12] px-6 py-12 text-white">
      <div className="mx-auto max-w-2xl space-y-6">
        <h1 className="text-2xl font-semibold">Order funding</h1>
        {view.kind === "loading" && <p role="status">Loading order…</p>}
        {view.kind === "message" && <>
          <p role="status">{view.message}</p>
          {view.checkAgain && <button className={BUTTON} onClick={() => reload.current()}>Check again</button>}
        </>}
        {remedy && <div className="space-y-3">
          <button className={BUTTON} onClick={() => void useAuthStore.getState().signOutWallet()}>Sign out</button>
          {remedy === "sign-in-again" && <>
            {/* The shared component stays a pure move; this page owns its settled attempt facts. */}
            <WalletPageSignInAgain attempted={false} pagePending={signIn.pending} failedBeforeMint={signIn.failedBeforeMint} signIn={signInAgain} />
            {signIn.attempted && !signIn.pending && signIn.failedBeforeMint && signIn.error && <p role="alert">{signIn.error}</p>}
            {signIn.attempted && !signIn.pending && !signIn.failedBeforeMint && signIn.notice && <p role="status">{signIn.notice}</p>}
          </>}
        </div>}
        {view.kind === "prepare" && <>
          <button className={BUTTON} disabled={preparing} onClick={() => prepareClick.current(view.scopeId)}>{FUND_COPY.L8}</button>
          <p>{FUND_COPY.L8_HELP}</p>
        </>}
        {view.kind === "verified" && <>
          <p>{FUND_COPY.L17}</p>
          {view.escrow && <p className="break-all">{view.escrow}</p>}
          {view.fundedAt && <time dateTime={view.fundedAt}>{view.fundedAt}</time>}
        </>}
        {view.kind === "terms" && <>
          <p>{FUND_COPY.L19}</p>
          <dl className="space-y-2">
            <dt>Amount</dt><dd>{view.terms.amount}</dd>
            <dt>Escrow</dt><dd className="break-all">{view.terms.escrow}</dd>
            <dt>Fund by</dt><dd><time dateTime={view.terms.fundBy}>{view.terms.fundBy}</time></dd>
          </dl>
          <p>{FUND_COPY.L20}</p>
          <p>{PCC_BETA_STATUS}</p>
          <button className={BUTTON} onClick={() => reload.current()}>Check again</button>
        </>}
      </div>
    </main>
  );
}
