import { useRef, useState } from "react";
import { decideWalletLink, getWalletLinkRequest, walletLinkErrorMessage } from "../lib/wallet-link-api.js";
import { useAuthStore } from "../stores/auth-store.js";

type PageState =
  | { step: "code"; input: string }
  | { step: "consent"; userCode: string; request: Awaited<ReturnType<typeof getWalletLinkRequest>>; confirmed: boolean; keyEpoch: number }
  | { step: "result"; result: Awaited<ReturnType<typeof decideWalletLink>> };

const BUTTON = "rounded-lg border border-white/20 px-5 py-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40";
const SIGN_IN_CHANGED = "Your sign-in changed; enter the code again.";

export function WalletLinkPage() {
  const [state, setState] = useState<PageState>({ step: "code", input: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const normalizedCode = state.step === "code" ? state.input.toUpperCase().replace(/[\s-]/g, "") : "";
  const validCode = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/.test(normalizedCode);
  const displayCode = state.step === "consent" ? `${state.userCode.slice(0, 4)}-${state.userCode.slice(4)}` : "";

  async function loadRequest() {
    if (state.step !== "code" || !validCode || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const keyEpoch = useAuthStore.getState().keyEpoch;
    try {
      const request = await getWalletLinkRequest(normalizedCode);
      // Consent belongs to the sign-in that loaded it, including a pending lookup.
      if (useAuthStore.getState().keyEpoch !== keyEpoch) {
        setState({ step: "code", input: "" });
        setError(SIGN_IN_CHANGED);
        return;
      }
      setState({ step: "consent", userCode: normalizedCode, request, confirmed: false, keyEpoch });
    } catch (failure) {
      setError(walletLinkErrorMessage(failure));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function decide(decision: "approve" | "deny") {
    if (state.step !== "consent" || inFlight.current || (decision === "approve" && !state.confirmed)) return;
    if (useAuthStore.getState().keyEpoch !== state.keyEpoch) {
      setState({ step: "code", input: "" });
      setError(SIGN_IN_CHANGED);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await decideWalletLink(state.request.requestId, state.userCode, decision, state.request.consent.sha256);
      // Drop the code, request and confirmation after the decision; retain only its result.
      setState({ step: "result", result });
    } catch (failure) {
      // A retry must reload the consent and require a new confirmation.
      setState({ step: "code", input: "" });
      setError(walletLinkErrorMessage(failure, decision));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    // Exclude the entire ceremony from the dashboard's autocapture and session replay.
    <main className="ph-no-capture sentry-block min-h-screen bg-[#0B0D12] px-6 py-12 text-white">
      <div className="mx-auto max-w-2xl space-y-6" aria-busy={busy}>
        <h1 className="text-2xl font-semibold">Link a wallet to your PCC account</h1>
        {error && <p role="alert" className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-4 text-amber-100">{error}</p>}

        {state.step === "code" && (
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void loadRequest(); }}>
            <label htmlFor="wallet-link-code" className="block text-sm text-white/70">Code from your terminal</label>
            <input
              id="wallet-link-code"
              type="text"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={state.input}
              onChange={(event) => setState({ step: "code", input: event.target.value })}
              disabled={busy}
              className="w-full rounded-lg border border-white/20 bg-white/5 px-4 py-3 font-mono text-xl"
            />
            <button type="submit" disabled={!validCode || busy} className={BUTTON}>Continue</button>
            {busy && <p role="status" className="text-sm text-white/70">Loading request…</p>}
          </form>
        )}

        {state.step === "consent" && (
          <>
            <p className="font-mono text-3xl font-semibold">Code {displayCode}</p>
            <section aria-label="Wallet link consent" className="space-y-4 text-white/85">
              {state.request.consent.text.split(/\r?\n(?:[\t ]*\r?\n)+/).map((paragraph, index) => (
                <p key={index} className="whitespace-pre-wrap break-words">{paragraph}</p>
              ))}
            </section>
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={state.confirmed}
                disabled={busy}
                onChange={(event) => setState({ ...state, confirmed: event.target.checked })}
                className="mt-1"
              />
              <span>My terminal shows this same code: {displayCode}</span>
            </label>
            <div className="flex flex-wrap gap-3">
              <button type="button" disabled={!state.confirmed || busy} onClick={() => void decide("approve")} className={`${BUTTON} bg-emerald-500/20`}>Approve and link</button>
              <button type="button" disabled={busy} onClick={() => void decide("deny")} className={BUTTON}>Deny</button>
            </div>
            {busy && <p role="status" className="text-sm text-white/70">Sending your decision…</p>}
          </>
        )}

        {state.step === "result" && (
          <div role="status" className="space-y-3">
            {state.result.status === "approved" ? (
              <>
                <p>Linked. Go back to your terminal; it continues on its own.</p>
                <p className="break-all font-mono text-sm text-white/70">Link ID: {state.result.linkId}</p>
              </>
            ) : <p>Denied. Nothing was linked.</p>}
          </div>
        )}
      </div>
    </main>
  );
}
