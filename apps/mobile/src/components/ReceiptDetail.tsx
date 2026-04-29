/**
 * ReceiptDetail — Week 4 mobile UI for receipt verification.
 *
 * After a session settles via the centralized substrate (see
 * `packages/gateway/src/routes/centralized-settle.ts`), the user can pull up
 * the receipt for any session they participated in. This component:
 *
 *   1. Fetches /api/receipts/:id which returns
 *        { signedReceipt, leafJson, merklePath, serverPublicKey, leafIndex,
 *          settledAt, anchorTxHash? }
 *   2. Verifies on-device:
 *        - the Ed25519 signature against the server's public key, and
 *        - the Merkle inclusion proof against the proof's announced root
 *      so the user does NOT have to trust the server's claim.
 *   3. Renders a plain-language summary, the verification panel, and the
 *      anchor link (or "Anchoring pending" when no tx is bound yet).
 *
 * The approach matches `15-MOBILE-APP-FIRST-PRINCIPLES.md` v3 §6: the user
 * holds receipts the server cannot retroactively rewrite, and the device
 * verifies the cryptographic chain on its own.
 *
 * UI conventions:
 *   - Same dependency-light pattern as Week 3 ApprovalSheet: vanilla JSX,
 *     inline styles, no framer-motion / no @testing-library / no @pcc/ui.
 *   - data-testid attributes on everything the tests need to reach.
 *   - The component owns no global state; the caller passes a receiptId
 *     and onClose handler. Multiple instances can mount in parallel.
 */

import { useEffect, useState, type ReactElement } from "react";
import {
  verifyReceipt,
  verifyProof,
  type SignedReceipt,
  type MerkleProof,
} from "@pcc/transparency-log";

// ── Types ─────────────────────────────────────────────────────────────

/**
 * Response shape from `GET /api/receipts/:id`. Mirrors what
 * `centralized-settle.ts` returns plus an optional anchorTxHash that a
 * later iteration will populate when the daily Merkle anchor lands
 * on Anchor.sol. v1 returns no anchorTxHash, so the UI falls back to
 * "Anchoring pending".
 */
export interface ReceiptApiResponse {
  signedReceipt: SignedReceipt;
  /** Canonical JSON bytes of the leaf — what the proof was computed against. */
  leafJson: string;
  merklePath: MerkleProof;
  serverPublicKey: string;
  leafIndex: number;
  settledAt: string;
  /**
   * Hex transaction hash of the anchor publication, when present.
   * Format: 0x-prefixed 64-char hex.
   */
  anchorTxHash?: string;
}

export interface ReceiptDetailProps {
  receiptId: string;
  onClose: () => void;
  /**
   * Override the global fetch (DI for tests). Default is window.fetch /
   * globalThis.fetch. The function must return a Response-like object;
   * the test harness fakes one with .json() / .ok / .status.
   */
  fetchImpl?: typeof globalThis.fetch;
  /**
   * Override for the verifyReceipt + verifyProof pair (DI for tests).
   * Both default to the imports from @pcc/transparency-log.
   */
  verifiers?: {
    verifyReceipt: (signed: SignedReceipt, expectedPub?: string) => boolean;
    verifyProof: (
      leaf: string | Uint8Array,
      proof: MerkleProof,
      root: string,
    ) => boolean;
  };
}

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; receipt: ReceiptApiResponse; sigOk: boolean; proofOk: boolean }
  | { kind: "error"; message: string };

// ── Component ─────────────────────────────────────────────────────────

export function ReceiptDetail(props: ReceiptDetailProps): ReactElement {
  const { receiptId, onClose, fetchImpl, verifiers } = props;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fetcher = fetchImpl ?? globalThis.fetch;
        if (typeof fetcher !== "function") {
          throw new Error("fetch is not available in this runtime");
        }
        const res = await fetcher(`/api/receipts/${encodeURIComponent(receiptId)}`);
        if (!res.ok) {
          throw new Error(`Receipt fetch failed: ${res.status}`);
        }
        const json = (await res.json()) as ReceiptApiResponse;
        if (cancelled) return;

        // Verify both layers on-device. We deliberately don't conflate
        // signature failure with proof failure — surfacing them
        // independently helps users + auditors diagnose issues.
        const verifyReceiptFn = verifiers?.verifyReceipt ?? verifyReceipt;
        const verifyProofFn = verifiers?.verifyProof ?? verifyProof;
        const sigOk = verifyReceiptFn(json.signedReceipt, json.serverPublicKey);
        const proofOk = verifyProofFn(
          json.leafJson,
          json.merklePath,
          json.merklePath.root,
        );

        if (!cancelled) {
          setState({ kind: "loaded", receipt: json, sigOk, proofOk });
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            kind: "error",
            message: (err as Error)?.message ?? String(err),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [receiptId, fetchImpl, verifiers]);

  // Header always renders.
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="receipt-detail-title"
      data-testid="receipt-detail"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#0A1A0F",
        color: "#E5F4EA",
        fontFamily: "system-ui, -apple-system, sans-serif",
        animation: "receipt-fade-in 160ms ease-out",
      }}
    >
      <style>
        {`
          @keyframes receipt-fade-in {
            from { opacity: 0; }
            to { opacity: 1; }
          }
        `}
      </style>

      {/* Header */}
      <header
        style={{
          padding: "calc(env(safe-area-inset-top, 0px) + 14px) 18px 14px 18px",
          borderBottom: "1px solid rgba(16, 185, 129, 0.18)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div>
          <p
            style={{
              margin: 0,
              fontSize: 11,
              opacity: 0.55,
              textTransform: "uppercase",
              letterSpacing: 0.6,
            }}
          >
            Receipt
          </p>
          <h2
            id="receipt-detail-title"
            data-testid="receipt-title"
            style={{
              fontSize: 18,
              fontWeight: 600,
              margin: "2px 0 0 0",
              fontFamily: "monospace",
            }}
          >
            #{shortId(receiptId)}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          data-testid="receipt-close"
          aria-label="Close receipt"
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: "1px solid rgba(229, 244, 234, 0.2)",
            backgroundColor: "transparent",
            color: "#E5F4EA",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          Close
        </button>
      </header>

      {/* Body */}
      <div
        style={{
          flex: 1,
          padding: "16px 18px calc(env(safe-area-inset-bottom, 0px) + 24px) 18px",
          overflowY: "auto",
        }}
      >
        {state.kind === "loading" && (
          <div data-testid="receipt-loading" style={{ opacity: 0.6, padding: 20 }}>
            Loading receipt…
          </div>
        )}

        {state.kind === "error" && (
          <div
            data-testid="receipt-error"
            role="alert"
            style={{
              backgroundColor: "rgba(239, 68, 68, 0.10)",
              border: "1px solid rgba(239, 68, 68, 0.35)",
              borderRadius: 10,
              padding: "14px 16px",
              fontSize: 13,
              color: "#FCA5A5",
            }}
          >
            <p style={{ margin: 0, fontWeight: 600 }}>Could not load receipt</p>
            <p style={{ margin: "6px 0 0 0", opacity: 0.85 }}>
              {state.message}
            </p>
          </div>
        )}

        {state.kind === "loaded" && (
          <LoadedView
            receipt={state.receipt}
            sigOk={state.sigOk}
            proofOk={state.proofOk}
            showRaw={showRaw}
            onToggleRaw={() => setShowRaw((s) => !s)}
          />
        )}
      </div>
    </div>
  );
}

// ── Loaded view (extracted for clarity) ───────────────────────────────

interface LoadedViewProps {
  receipt: ReceiptApiResponse;
  sigOk: boolean;
  proofOk: boolean;
  showRaw: boolean;
  onToggleRaw: () => void;
}

function LoadedView(props: LoadedViewProps): ReactElement {
  const { receipt, sigOk, proofOk, showRaw, onToggleRaw } = props;
  const payload = receipt.signedReceipt.payload;

  return (
    <>
      {/* Plain-language summary */}
      <section
        data-testid="receipt-summary"
        style={{
          backgroundColor: "rgba(16, 185, 129, 0.08)",
          border: "1px solid rgba(16, 185, 129, 0.2)",
          borderRadius: 12,
          padding: "16px",
          marginBottom: 14,
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: 16,
            lineHeight: 1.45,
          }}
        >
          <span style={{ fontWeight: 600 }}>{formatAmount(payload.amountCents)}</span>{" "}
          settled for{" "}
          <span style={{ fontWeight: 600 }}>{payload.capability}</span>.
        </p>
        <p
          style={{
            margin: "8px 0 0 0",
            fontSize: 12,
            opacity: 0.7,
          }}
        >
          User{" "}
          <span style={{ fontFamily: "monospace" }}>
            {shortHash(payload.actorsHashed.user)}
          </span>{" "}
          → operator{" "}
          <span style={{ fontFamily: "monospace" }}>
            {shortHash(payload.actorsHashed.operator)}
          </span>
        </p>
        <p
          style={{
            margin: "4px 0 0 0",
            fontSize: 12,
            opacity: 0.7,
          }}
        >
          Settled at{" "}
          <span style={{ fontFamily: "monospace" }}>{receipt.settledAt}</span>{" "}
          via {payload.settlementMode}.
        </p>
      </section>

      {/* Verification panel */}
      <section
        data-testid="receipt-verification"
        style={{
          border: "1px solid rgba(229, 244, 234, 0.12)",
          borderRadius: 12,
          padding: "14px 16px",
          marginBottom: 14,
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: 11,
            opacity: 0.55,
            textTransform: "uppercase",
            letterSpacing: 0.6,
          }}
        >
          On-device verification
        </p>
        <ul
          style={{
            listStyle: "none",
            margin: "10px 0 0 0",
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <li
            data-testid="receipt-verify-signature"
            data-status={sigOk ? "pass" : "fail"}
            style={{
              fontSize: 14,
              color: sigOk ? "#34D399" : "#FCA5A5",
            }}
          >
            {sigOk ? "✓" : "✗"} Signature{" "}
            {sigOk ? "valid" : "invalid"}
          </li>
          <li
            data-testid="receipt-verify-merkle"
            data-status={proofOk ? "pass" : "fail"}
            style={{
              fontSize: 14,
              color: proofOk ? "#34D399" : "#FCA5A5",
            }}
          >
            {proofOk ? "✓" : "✗"} Merkle proof{" "}
            {proofOk ? "valid" : "invalid"}
          </li>
        </ul>
      </section>

      {/* Anchor */}
      <section
        data-testid="receipt-anchor"
        style={{
          border: "1px solid rgba(229, 244, 234, 0.12)",
          borderRadius: 12,
          padding: "14px 16px",
          marginBottom: 14,
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: 11,
            opacity: 0.55,
            textTransform: "uppercase",
            letterSpacing: 0.6,
          }}
        >
          Anchor
        </p>
        {receipt.anchorTxHash ? (
          <a
            href={`https://sepolia.basescan.org/tx/${receipt.anchorTxHash}`}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="receipt-anchor-link"
            style={{
              display: "inline-block",
              marginTop: 8,
              color: "#10B981",
              fontFamily: "monospace",
              fontSize: 13,
              textDecoration: "underline",
              wordBreak: "break-all",
            }}
          >
            {shortHash(receipt.anchorTxHash)}
          </a>
        ) : (
          <p
            data-testid="receipt-anchor-pending"
            style={{
              margin: "8px 0 0 0",
              fontSize: 13,
              opacity: 0.7,
            }}
          >
            Anchoring pending. Once the daily Merkle root is published to
            Anchor.sol you'll see a Base Sepolia transaction here.
          </p>
        )}
      </section>

      {/* Raw JSON (debug) */}
      <section data-testid="receipt-raw">
        <button
          type="button"
          onClick={onToggleRaw}
          data-testid="receipt-raw-toggle"
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            border: "1px solid rgba(229, 244, 234, 0.2)",
            backgroundColor: "transparent",
            color: "#E5F4EA",
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          {showRaw ? "Hide raw JSON" : "Show raw JSON"}
        </button>
        {showRaw && (
          <pre
            data-testid="receipt-raw-content"
            style={{
              marginTop: 12,
              padding: "12px 14px",
              borderRadius: 10,
              backgroundColor: "rgba(0, 0, 0, 0.35)",
              border: "1px solid rgba(229, 244, 234, 0.10)",
              fontSize: 11,
              overflowX: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              color: "#A7F3D0",
            }}
          >
            {JSON.stringify(receipt, null, 2)}
          </pre>
        )}
      </section>
    </>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Compact a long id to a 6-char head + 4-char tail. */
function shortId(id: string): string {
  if (!id) return "";
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

/** Compact a hex hash similarly to ApprovalSheet. */
function shortHash(hash: string): string {
  if (!hash) return "—";
  if (hash.length <= 18) return hash;
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

/** Format integer cents as $X.YY USD. */
function formatAmount(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${sign}$${dollars}.${remainder.toString().padStart(2, "0")}`;
}
