import { useEffect, useRef, useState } from "react";
import { usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { WalletPageSignInAgain } from "../components/WalletPageSignInAgain.js";
import { useAuth } from "../hooks/use-auth.js";
import { FundingReadError, readFunding, readOrderOperator, readPrepare, requestPrepare } from "../lib/fund-api.js";
import { FUND_COPY } from "../lib/fund-copy.js";
import { checkOrder, fundOrder, runningFlight, type CheckedDisplay, type CheckedOrder, type CheckResult, type FundResult, type FundingIdentity } from "../lib/fund-send.js";
import { PCC_BETA_STATUS } from "../lib/positioning.js";
import { walletLinkSignInRemedy } from "../lib/wallet-link-api.js";
import { useAuthStore } from "../stores/auth-store.js";

type Prepare = Awaited<ReturnType<typeof readPrepare>>;
type Terms = Extract<Prepare, { kind: "terms" }>;
type View =
  | { kind: "loading" }
  | { kind: "message"; message: string; checkAgain?: boolean; switchOrder?: { scopeId: string; terms: Terms } }
  | { kind: "prepare"; scopeId: string }
  | { kind: "terms"; scopeId: string; terms: Terms }
  | { kind: "checked"; scopeId: string; display: CheckedDisplay; checked?: CheckedOrder }
  | { kind: "verified"; escrow?: string; fundedAt?: string };

const BUTTON = "rounded-lg border border-white/20 px-5 py-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40";

export function FundPage({ jobId }: { jobId: string | null }) {
  const { address } = useAuth();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: 84532 });
  const { mutateAsync } = useSwitchChain();
  const clients = useRef({ walletClient, publicClient, mutateAsync });
  clients.current = { walletClient, publicClient, mutateAsync };
  const sessionToken = useAuthStore((state) => state.sessionToken);
  const keyEpoch = useAuthStore((state) => state.keyEpoch);
  const generation = useRef(0);
  const identity = useRef({ jobId, address, sessionToken, keyEpoch });
  const keyRestartRead = useRef<number | null>(null);
  const stopGeneration = useRef<() => void>(() => {});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prepareFlight = useRef<number | null>(null);
  const signInFlight = useRef(false);
  const mounted = useRef(false);
  const reload = useRef<() => void>(() => {});
  const prepareClick = useRef<(scopeId: string) => void>(() => {});
  const checkClick = useRef<(scopeId: string, terms: Terms) => void>(() => {});
  const sendClick = useRef<(scopeId: string, checked: CheckedOrder) => void>(() => {});
  const switchClick = useRef<(scopeId: string, terms: Terms) => void>(() => {});
  const stepRunning = useRef(false);
  const [view, setView] = useState<View>({ kind: "loading" });
  const [preparing, setPreparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signIn, setSignIn] = useState({ attempted: false, pending: false, failedBeforeMint: false, error: null as string | null, notice: null as string | null });

  useEffect(() => {
    const previous = identity.current;
    identity.current = { jobId, address, sessionToken, keyEpoch };
    const keyRestart = previous.keyEpoch !== keyEpoch && previous.jobId === jobId &&
      previous.address === address && previous.sessionToken === sessionToken;
    if (keyRestart && (keyRestartRead.current !== null || stepRunning.current) && useAuthStore.getState().sessionKeyId !== null) {
      // Keep the active read, check, send or poll through key renewal,
      // including a first pass retry and its final 401 remedy.
      return;
    }
    stopGeneration.current();
    mounted.current = true;
    const current = ++generation.current;
    keyRestartRead.current = keyRestart && useAuthStore.getState().sessionKeyId !== null ? current : null;
    const firstRead = Date.now();
    let firstPending: number | null = null;
    let pendingTimedOut = false;
    let pollEpoch = 0;
    const active = () => mounted.current && generation.current === current;
    const stopTimer = () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
    const message = (text: string, checkAgain = false) => setView({ kind: "message", message: text, checkAgain: checkAgain || text === FUND_COPY.L1 });
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

    const verified = (verification: Record<string, unknown> | null) => {
      const fundedAt = typeof verification?.fundedAt === "number" ? new Date(verification.fundedAt * 1000) : null;
      setView({ kind: "verified", escrow: typeof verification?.escrowAddress === "string" ? verification.escrowAddress : undefined,
        fundedAt: fundedAt && Number.isFinite(fundedAt.getTime()) ? fundedAt.toISOString() : undefined });
    };
    function pollFunding(scopeId: string) {
      const epoch = ++pollEpoch, deadline = Date.now() + 2_400_000;
      stepRunning.current = true;
      const polling = () => active() && pollEpoch === epoch;
      const timeout = () => {
        if (!polling()) return;
        pollEpoch++;
        stepRunning.current = false;
        stopTimer();
        message(FUND_COPY.L1, true);
      };
      const next = () => schedule(Math.min(15_000, deadline - Date.now()), () => {
        if (!polling()) return;
        if (Date.now() >= deadline) { timeout(); return; }
        // Keep the cadence and cap live even while PCC's answer is in flight.
        next();
        void readFunding(jobId!).then((scopes) => {
          if (!polling()) return;
          const scope = scopes.find((row) => row.scopeId === scopeId);
          if (scope?.state === "funded_verified") {
            pollEpoch++;
            stepRunning.current = false;
            stopTimer();
            verified(scope.verification);
          }
        }).catch(() => {});
      });
      next();
    }
    function result(scopeId: string, terms: Terms | undefined, answer: CheckResult | FundResult) {
      if (!active()) return;
      if (answer.kind === "busy") { attach(scopeId, terms); return; }
      stepRunning.current = false;
      setBusy(false);
      if (answer.kind === "checked") setView({ kind: "checked", scopeId, checked: answer, display: answer.display });
      else if (answer.kind === "read_failed") failed(answer.reason);
      else if (answer.label === "L16" && terms) setView({ kind: "message", message: FUND_COPY.L16, checkAgain: true, switchOrder: { scopeId, terms } });
      else {
        message(answer.label === "L29" ? FUND_COPY.L29.replace("{held}", answer.held).replace("{needed}", answer.needed)
          : FUND_COPY[answer.label], answer.label !== "L18" && answer.label !== "L10a" && answer.label !== "L23");
        if (answer.label === "L18" || answer.label === "L1") pollFunding(scopeId);
      }
    }
    function attach(scopeId: string, terms?: Terms) {
      const flight = runningFlight(scopeId);
      if (!flight) { stepRunning.current = false; setBusy(false); return; }
      stepRunning.current = true;
      setBusy(true);
      const matches = flight.identity.jobId === jobId && flight.identity.address === address && flight.identity.sessionToken === sessionToken;
      if (matches && flight.kind === "send") setView({ kind: "checked", scopeId, display: flight.display });
      void flight.result.then((answer) => {
        if (!active()) return;
        if (matches) result(scopeId, flight.kind === "check" ? terms : undefined, answer);
        else { stepRunning.current = false; setBusy(false); }
      });
    }
    const buyerIdentity = (): FundingIdentity | undefined => jobId && address && sessionToken
      ? { jobId, address, sessionToken } : undefined;
    checkClick.current = (scopeId, terms) => {
      const identity = buyerIdentity(), { walletClient, publicClient } = clients.current;
      if (!active() || !identity || !walletClient || !publicClient) return;
      stepRunning.current = true;
      setBusy(true);
      void checkOrder({ scopeId, identity, payload: terms.payload, walletClient, publicClient,
        readOperator: () => readOrderOperator(identity.jobId) }).then((answer) => result(scopeId, terms, answer));
    };
    sendClick.current = (scopeId, checked) => {
      const identity = buyerIdentity(), { walletClient, publicClient } = clients.current;
      if (!active() || !identity || !walletClient || !publicClient) return;
      stepRunning.current = true;
      setBusy(true);
      void fundOrder({ scopeId, identity, checked, walletClient, publicClient }).then((answer) => result(scopeId, undefined, answer));
    };
    switchClick.current = (scopeId, terms) => {
      if (!active() || stepRunning.current) return;
      stepRunning.current = true;
      setBusy(true);
      void clients.current.mutateAsync({ chainId: 84532 }).then(() => {
        if (active()) checkClick.current(scopeId, terms);
      }).catch(() => {}).finally(() => {
        if (active() && !runningFlight(scopeId)) { stepRunning.current = false; setBusy(false); }
      });
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
        else if (answer.kind === "terms") {
          setView({ kind: "terms", scopeId, terms: answer });
          attach(scopeId, answer);
        }
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
          verified(newest.verification);
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
    stepRunning.current = false;
    setBusy(false);
    setPreparing(false);
    reload.current = () => {
      if (!active()) return;
      pollEpoch++;
      stepRunning.current = false;
      stopTimer();
      void loadFunding();
    };
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
    void loadFunding().finally(() => {
      if (keyRestartRead.current === current) keyRestartRead.current = null;
    });
    stopGeneration.current = () => {
      mounted.current = false;
      generation.current++;
      stopTimer();
    };
  }, [jobId, address, sessionToken, keyEpoch]);

  useEffect(() => () => stopGeneration.current(), []);

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
          {view.switchOrder && <button className={BUTTON} disabled={busy} onClick={() => switchClick.current(view.switchOrder!.scopeId, view.switchOrder!.terms)}>{FUND_COPY.L36}</button>}
          {view.checkAgain && <button className={BUTTON} disabled={busy} onClick={() => reload.current()}>Check again</button>}
        </>}
        {remedy && <div className="space-y-3">
          <button className={BUTTON} disabled={busy} onClick={() => void useAuthStore.getState().signOutWallet()}>Sign out</button>
          {remedy === "sign-in-again" && <>
            {/* The shared component stays a pure move; this page owns its settled attempt facts. */}
            <WalletPageSignInAgain attempted={false} pagePending={signIn.pending || busy} failedBeforeMint={signIn.failedBeforeMint} signIn={signInAgain} />
            {signIn.attempted && !signIn.pending && signIn.failedBeforeMint && signIn.error && <p role="alert">{signIn.error}</p>}
            {signIn.attempted && !signIn.pending && !signIn.failedBeforeMint && signIn.notice && <p role="status">{signIn.notice}</p>}
          </>}
        </div>}
        {view.kind === "prepare" && <>
          <button className={BUTTON} disabled={preparing || busy} onClick={() => prepareClick.current(view.scopeId)}>{FUND_COPY.L8}</button>
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
          {walletClient ? <button className={BUTTON} disabled={busy} onClick={() => checkClick.current(view.scopeId, view.terms)}>{FUND_COPY.L27}</button> : <p>{FUND_COPY.L25}</p>}
          <p>{FUND_COPY.L26}</p>
          <p>{PCC_BETA_STATUS}</p>
          <button className={BUTTON} disabled={busy} onClick={() => reload.current()}>Check again</button>
        </>}
        {view.kind === "checked" && <>
          <dl className="space-y-2">
            <dt>Amount</dt><dd>{view.display.amount}</dd>
            <dt>Escrow</dt><dd className="break-all">{view.display.escrow}</dd>
            <dt>Operator</dt><dd className="break-all">{view.display.operator}</dd>
            <dt>Fund by</dt><dd><time dateTime={view.display.fundBy}>{view.display.fundBy}</time></dd>
            <dt>Refundable from</dt><dd><time dateTime={view.display.refundableFrom}>{view.display.refundableFrom}</time></dd>
            <dt>Checked at block</dt><dd>{view.display.checkedAtBlock}</dd>
          </dl>
          <p>{FUND_COPY.L35}</p>
          {walletClient ? <button className={BUTTON} disabled={busy || !view.checked} onClick={() => sendClick.current(view.scopeId, view.checked!)}>{FUND_COPY.L28}</button> : <p>{FUND_COPY.L25}</p>}
          <p>{FUND_COPY.L26}</p>
          <p>{PCC_BETA_STATUS}</p>
          <button className={BUTTON} disabled={busy} onClick={() => reload.current()}>Check again</button>
        </>}
      </div>
    </main>
  );
}
