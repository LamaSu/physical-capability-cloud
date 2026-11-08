import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { listWallets, unlinkWallet, walletsErrorMessage } from "../lib/wallet-link-api.js";
import { onIdentityChange, useAuthStore } from "../stores/auth-store.js";

type Wallet = Awaited<ReturnType<typeof listWallets>>[number];
type ReadState =
  | { step: "loading" }
  | { step: "failed"; message: string }
  | { step: "loaded"; rows: Wallet[]; generation: number };

const BUTTON = "rounded-lg border border-white/20 px-5 py-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40";
const SIGN_IN_CHANGED = "Your sign-in changed, so nothing was unlinked. The list now shows this sign-in's wallets.";
const UNKNOWN_UNLINK = "PCC did not confirm the unlink. Reload this page to see whether it is still linked.";

export function WalletsPage() {
  const generation = useRef(0);
  const readSequence = useRef(0);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const confirmation = useRef<string | null>(null);
  const [read, setRead] = useState<ReadState>({ step: "loading" });
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ message: string; role: "alert" | "status" } | null>(null);

  function closeConfirm() {
    confirmation.current = null;
    setConfirm(null);
  }

  const reload = useCallback(async () => {
    const startedGeneration = generation.current;
    const sequence = ++readSequence.current;
    setRead({ step: "loading" });
    try {
      const rows = await listWallets();
      if (!mounted.current || generation.current !== startedGeneration || readSequence.current !== sequence) return;
      setRead({ step: "loaded", rows, generation: startedGeneration });
    } catch (error) {
      if (!mounted.current || generation.current !== startedGeneration || readSequence.current !== sequence) return;
      setRead({ step: "failed", message: walletsErrorMessage(error, "load") });
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = onIdentityChange(() => {
      generation.current++;
      const hadConfirm = confirmation.current !== null;
      closeConfirm();
      setNotice(hadConfirm && !inFlight.current ? { message: SIGN_IN_CHANGED, role: "alert" } : null);
      void reload();
    });
    void reload();
    return () => {
      unsubscribe();
      mounted.current = false;
      generation.current++;
    };
  }, [reload]);

  async function unlink(row: Wallet, loadedGeneration: number) {
    if (inFlight.current) return;
    const startedGeneration = generation.current;
    closeConfirm();
    if (startedGeneration !== loadedGeneration) {
      setNotice({ message: SIGN_IN_CHANGED, role: "alert" });
      void reload();
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setNotice(null);
    let outcome: { message: string; role: "alert" | "status" };
    try {
      await unlinkWallet(row.linkId);
      outcome = { message: `Unlinked ${row.label}.`, role: "status" };
    } catch (error) {
      outcome = { message: walletsErrorMessage(error, "unlink"), role: "alert" };
    }
    if (mounted.current) {
      // An identity change makes every POST outcome uncertain for this screen.
      setNotice(generation.current !== startedGeneration ? { message: UNKNOWN_UNLINK, role: "alert" } : outcome);
      setBusy(false);
      void reload();
    }
    inFlight.current = false;
  }

  const error = read.step === "failed" ? read.message : null;
  const needsSignOut = [error, notice?.message].some((message) =>
    message === "Your sign-in is no longer valid; sign in again." || message === "PCC refused this with your current sign-in.");

  return (
    <main className="ph-no-capture sentry-block min-h-screen bg-[#0B0D12] px-6 py-12 text-white">
      <div className="mx-auto max-w-2xl space-y-6">
        <h1 className="text-2xl font-semibold">Wallets</h1>
        <p>Wallets you can manage with this sign-in.</p>
        {notice && <p role={notice.role}>{notice.message}</p>}
        {error && <p role="alert">{error}</p>}
        {needsSignOut && <button type="button" onClick={() => void useAuthStore.getState().signOutWallet()} className={BUTTON}>Sign out</button>}
        {busy && <p role="status">Unlinking…</p>}
        {read.step === "loading" && <p role="status">Loading your wallets…</p>}
        {read.step === "loaded" && (read.rows.length === 0 ? <p>No wallets are linked with this sign-in.</p> : (
          <ul className="space-y-4">
            {read.rows.map((row) => (
              <li key={row.linkId} className="space-y-3 rounded-lg border border-white/20 p-5">
                <h2 className="text-lg font-semibold">{row.label}</h2>
                <p>{row.role === "agent" ? "Agent" : "Device"}</p>
                <p className="font-mono break-all">{row.keyType === "secp256k1" ? row.address : row.publicKey}</p>
                <p>Chain {row.chainId}</p>
                <p>{row.status === "active" ? "Linked" : row.status === "expired" ? "Expired" : "Unlinked"}</p>
                <p>Linked at <time dateTime={row.createdAt}>{row.createdAt}</time></p>
                {row.status === "active" && row.expiresAt !== null && <p>Expires at <time dateTime={row.expiresAt}>{row.expiresAt}</time></p>}
                {row.status === "expired" && row.expiresAt !== null && <p>Expired at <time dateTime={row.expiresAt}>{row.expiresAt}</time></p>}
                {row.status === "revoked" && row.revokedAt !== null && <p>Unlinked at <time dateTime={row.revokedAt}>{row.revokedAt}</time></p>}
                {row.status === "active" && (confirm === row.linkId ? (
                  <div className="space-y-3">
                    <p>Unlink {row.label}? Unlinking doesn't move funds. To link this wallet again, start a new link from its terminal.</p>
                    <div className="flex flex-wrap gap-3">
                      <button type="button" disabled={busy} onClick={() => void unlink(row, read.generation)} className={BUTTON}>Unlink</button>
                      <button type="button" onClick={closeConfirm} className={BUTTON}>Keep linked</button>
                    </div>
                  </div>
                ) : (
                  <button type="button" disabled={busy} onClick={() => {
                    if (inFlight.current) return;
                    confirmation.current = row.linkId;
                    setConfirm(row.linkId);
                    setNotice(null);
                  }} className={BUTTON}>Unlink</button>
                ))}
              </li>
            ))}
          </ul>
        ))}
        <Link to="/link" className="inline-block text-emerald-300 underline">Link a wallet</Link>
      </div>
    </main>
  );
}
