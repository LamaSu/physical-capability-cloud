/**
 * EarnFromYourWorkPage — zero-friction contributor signup.
 *
 * Three inputs (email, what you contribute, your %), one button. The
 * server-side POST /api/contributors/quickstart bundles wallet creation,
 * API key provisioning, contributor profile registration, and default
 * RateSchedule publishing into a single response.
 *
 * Designed for someone who has never written code, never installed
 * MetaMask, and does not know what a seed phrase is. No wallet pre-install
 * required. The flow:
 *   1. Form          (email + role + rate %)
 *   2. Backup gate   (only when the demo adapter returned a mnemonic — the
 *                     Privy adapter omits this step entirely)
 *   3. Done          (API key, wallet address, schedule link, onramp CTA)
 *
 * The page is unauthenticated — it IS the signup endpoint.
 */

import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";

const API_BASE =
  (import.meta as { env?: { VITE_API_URL?: string; PROD?: boolean } }).env
    ?.VITE_API_URL ??
  ((import.meta as { env?: { PROD?: boolean } }).env?.PROD
    ? "https://capability.network"
    : "http://localhost:3200");

const sg = "'Space Grotesk', sans-serif";
const inter = "'Inter', sans-serif";
const mono = "'Space Mono', monospace";

const BLUE = "#60a5fa";
const BG_DARK = "#050a0e";
const BG_MID = "#0a1628";
const BG_PANEL = "#0f1f33";
const BORDER = "#1a2c44";
const TEXT_PRIMARY = "#f0f4f0";
const TEXT_MUTED = "#8a9a8a";
const TEXT_DIM = "#4a5a4a";
const AMBER = "#f5a623";
const GREEN = "#10b981";

type Role =
  | "operator"
  | "verifier"
  | "insurer"
  | "integrator"
  | "protocol-author"
  | "model-author"
  | "dataset-contributor"
  | "curator"
  | "assembler";

const ROLE_OPTIONS: { value: Role; label: string; example: string }[] = [
  { value: "operator", label: "I run a machine", example: "3D printer, CNC, lab equipment" },
  { value: "model-author", label: "I trained an AI model", example: "vision, control, scheduling" },
  { value: "dataset-contributor", label: "I shared data", example: "training images, sensor logs" },
  { value: "protocol-author", label: "I wrote a recipe", example: "G-code, wash protocol, cutting plan" },
  { value: "verifier", label: "I check evidence", example: "QC inspector, photo reviewer" },
  { value: "integrator", label: "I built an adapter", example: "OctoPrint plugin, Modbus driver" },
  { value: "curator", label: "I curate a registry", example: "approved suppliers, parts library" },
  { value: "assembler", label: "I assemble parts into a product", example: "PCB assembly, kit packaging" },
  { value: "insurer", label: "I insure jobs", example: "liability coverage for tier-2 work" },
];

type QuickstartResponse = {
  apiKey: string;
  keyId: string;
  walletAddress: string;
  walletProvider: "demo" | "privy" | string;
  walletProviderUserId: string;
  mnemonic: string | null;
  mnemonicWarning: string | null;
  scheduleHash: string;
  ratePercent: number;
  bps: number;
  role: Role;
  contributionDescription: string | null;
  profileId: string;
  links: { viewSchedule: string; addUsdc: string; agentPackage: string };
};

type Stage = "form" | "loading" | "backup" | "done" | "error";

export function EarnFromYourWorkPage(): JSX.Element {
  const [stage, setStage] = useState<Stage>("form");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("operator");
  const [ratePercent, setRatePercent] = useState(1.5);
  const [contributionDescription, setContributionDescription] = useState("");
  const [name, setName] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [response, setResponse] = useState<QuickstartResponse | null>(null);
  const [mnemonicConfirmed, setMnemonicConfirmed] = useState(false);

  // Inject brand fonts once.
  useEffect(() => {
    const href =
      "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700;800&family=Inter:wght@400;500;600&family=Space+Mono:wght@400;700&display=swap";
    if (!document.head.querySelector(`link[href="${href}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      document.head.appendChild(link);
    }
  }, []);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setErrorMessage(null);
    setStage("loading");
    try {
      const res = await fetch(`${API_BASE}/api/contributors/quickstart`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          role,
          ratePercent,
          contributionDescription: contributionDescription || undefined,
          name: name || undefined,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(err.message ?? `Signup failed (${res.status})`);
      }
      const data = (await res.json()) as QuickstartResponse;
      setResponse(data);
      setStage(data.mnemonic ? "backup" : "done");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setStage("error");
    }
  }

  function downloadCredentials(): void {
    if (!response) return;
    const lines = [
      "# PCC Contributor Credentials",
      `# Saved: ${new Date().toISOString()}`,
      "",
      `EMAIL=${email}`,
      `ROLE=${response.role}`,
      `WALLET_ADDRESS=${response.walletAddress}`,
      `WALLET_PROVIDER=${response.walletProvider}`,
      `API_KEY=${response.apiKey}`,
      `API_KEY_ID=${response.keyId}`,
      `RATE_SCHEDULE_HASH=${response.scheduleHash}`,
      `RATE_PERCENT=${response.ratePercent}`,
      "",
    ];
    if (response.mnemonic) {
      lines.push("# RECOVERY PHRASE — write this on paper. Whoever has it controls the wallet.");
      lines.push(`MNEMONIC="${response.mnemonic}"`);
    }
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pcc-credentials-${response.walletAddress.slice(0, 8)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function openOnramp(): Promise<void> {
    if (!response) return;
    try {
      const res = await fetch(`${API_BASE}/api/fiat-ramp/onramp/session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${response.apiKey}`,
        },
        body: JSON.stringify({
          destinationAddress: response.walletAddress,
          amountUsd: 20,
          currency: "USDC",
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        url?: string;
        sessionUrl?: string;
        clientSecret?: string;
      };
      const onrampUrl = data.url ?? data.sessionUrl;
      if (onrampUrl) {
        window.open(onrampUrl, "_blank", "noopener,noreferrer");
      } else {
        alert(
          "Stripe onramp is in mock mode on this server (no STRIPE_SECRET_KEY configured). " +
            "On production, this button opens a card/ACH funding session.",
        );
      }
    } catch (err) {
      alert(`Couldn't start onramp: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Renderers ──────────────────────────────────────────────────────────

  const pageWrap: React.CSSProperties = {
    minHeight: "100vh",
    background: `linear-gradient(180deg, ${BG_DARK} 0%, ${BG_MID} 100%)`,
    color: TEXT_PRIMARY,
    fontFamily: inter,
    padding: "48px 16px 96px",
  };
  const card: React.CSSProperties = {
    maxWidth: 560,
    margin: "0 auto",
    background: BG_PANEL,
    border: `1px solid ${BORDER}`,
    borderRadius: 16,
    padding: 32,
    boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
  };
  const h1: React.CSSProperties = {
    fontFamily: sg,
    fontSize: 32,
    fontWeight: 800,
    margin: "0 0 8px",
    lineHeight: 1.1,
  };
  const sub: React.CSSProperties = { color: TEXT_MUTED, margin: "0 0 32px", fontSize: 16 };
  const label: React.CSSProperties = {
    display: "block",
    fontSize: 14,
    fontWeight: 600,
    margin: "20px 0 8px",
    color: TEXT_PRIMARY,
  };
  const input: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: "12px 14px",
    fontSize: 16,
    fontFamily: inter,
    background: BG_DARK,
    color: TEXT_PRIMARY,
    border: `1px solid ${BORDER}`,
    borderRadius: 10,
    outline: "none",
  };
  const button: React.CSSProperties = {
    width: "100%",
    padding: "14px 20px",
    fontSize: 16,
    fontWeight: 700,
    fontFamily: sg,
    background: BLUE,
    color: BG_DARK,
    border: "none",
    borderRadius: 10,
    cursor: "pointer",
    marginTop: 24,
  };
  const buttonGhost: React.CSSProperties = {
    ...button,
    background: "transparent",
    color: TEXT_PRIMARY,
    border: `1px solid ${BORDER}`,
    marginTop: 12,
  };
  const codeBlock: React.CSSProperties = {
    fontFamily: mono,
    fontSize: 13,
    background: BG_DARK,
    color: TEXT_PRIMARY,
    padding: 14,
    borderRadius: 8,
    border: `1px solid ${BORDER}`,
    wordBreak: "break-all",
    marginTop: 8,
  };

  if (stage === "loading") {
    return (
      <div style={pageWrap}>
        <div style={card}>
          <h1 style={h1}>Setting you up…</h1>
          <p style={sub}>Creating your wallet, your API key, and publishing your rate.</p>
          <div style={{ marginTop: 24, color: TEXT_MUTED, fontSize: 14 }}>This usually takes 1–2 seconds.</div>
        </div>
      </div>
    );
  }

  if (stage === "error") {
    return (
      <div style={pageWrap}>
        <div style={card}>
          <h1 style={{ ...h1, color: AMBER }}>Hit a snag</h1>
          <p style={sub}>{errorMessage ?? "Unknown error."}</p>
          <button type="button" style={button} onClick={() => setStage("form")}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (stage === "backup" && response?.mnemonic) {
    const words = response.mnemonic.split(/\s+/);
    return (
      <div style={pageWrap}>
        <div style={card}>
          <h1 style={h1}>Save this — it's your wallet key.</h1>
          <p style={sub}>
            12 words. Write them on paper. Whoever has these words can move your money. We don't keep
            them.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 8,
              marginTop: 16,
              marginBottom: 16,
            }}
          >
            {words.map((w, i) => (
              <div
                key={i}
                style={{
                  background: BG_DARK,
                  border: `1px solid ${BORDER}`,
                  borderRadius: 8,
                  padding: "10px 8px",
                  fontFamily: mono,
                  fontSize: 14,
                  textAlign: "center",
                }}
              >
                <span style={{ color: TEXT_DIM, fontSize: 11, marginRight: 6 }}>{i + 1}.</span>
                {w}
              </div>
            ))}
          </div>
          {response.mnemonicWarning && (
            <p style={{ color: AMBER, fontSize: 13, lineHeight: 1.5 }}>{response.mnemonicWarning}</p>
          )}
          <label
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              marginTop: 20,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={mnemonicConfirmed}
              onChange={(e) => setMnemonicConfirmed(e.target.checked)}
              style={{ marginTop: 3 }}
            />
            <span>I wrote it down on paper. I understand losing it means losing my wallet.</span>
          </label>
          <button
            type="button"
            style={{ ...button, opacity: mnemonicConfirmed ? 1 : 0.5, cursor: mnemonicConfirmed ? "pointer" : "not-allowed" }}
            disabled={!mnemonicConfirmed}
            onClick={() => setStage("done")}
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  if (stage === "done" && response) {
    return (
      <div style={pageWrap}>
        <div style={card}>
          <h1 style={{ ...h1, color: GREEN }}>You're set up.</h1>
          <p style={sub}>
            Your rate is live. Every job that uses your work pays you {response.ratePercent}% of the
            job value, automatically, on-chain.
          </p>

          <div style={label}>Your wallet (this is where you'll get paid)</div>
          <div style={codeBlock}>{response.walletAddress}</div>

          <div style={label}>Your API key (save it — we won't show it again)</div>
          <div style={codeBlock}>{response.apiKey}</div>

          <div style={label}>Your published rate</div>
          <div style={codeBlock}>
            {response.ratePercent}% / {response.bps} bps · {response.scheduleHash.slice(0, 18)}…
          </div>

          <button type="button" style={button} onClick={downloadCredentials}>
            Download credentials (.txt)
          </button>
          <button type="button" style={buttonGhost} onClick={openOnramp}>
            Add $20 USDC to your wallet (for gas)
          </button>
          <Link
            to={`/contributors/schedules/${response.scheduleHash}`}
            style={{ display: "block", textAlign: "center", marginTop: 16, color: BLUE, fontSize: 14 }}
          >
            View your published rate →
          </Link>

          <div
            style={{
              marginTop: 32,
              paddingTop: 20,
              borderTop: `1px solid ${BORDER}`,
              fontSize: 13,
              color: TEXT_MUTED,
              lineHeight: 1.6,
            }}
          >
            <strong style={{ color: TEXT_PRIMARY }}>What happens next:</strong> Operators run jobs that
            reference your work in their <code style={{ color: BLUE, fontFamily: mono }}>CompositionManifest</code>.
            When the job settles, the smart contract sends your cut directly to the wallet above.
            No invoices, no waiting on payouts.
          </div>
        </div>
      </div>
    );
  }

  // ── Default: form stage ────────────────────────────────────────────────

  return (
    <div style={pageWrap}>
      <div style={card}>
        <h1 style={h1}>Get paid every time your work is used.</h1>
        <p style={sub}>
          Pick what you do. Set your rate. We publish it on-chain. Every job that uses your work
          pays you, automatically.
        </p>

        <form onSubmit={handleSubmit}>
          <label style={label} htmlFor="email">
            Your email
          </label>
          <input
            id="email"
            type="email"
            required
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={input}
          />

          <label style={label} htmlFor="name">
            Your name (optional)
          </label>
          <input
            id="name"
            type="text"
            placeholder="What people should see on your profile"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={input}
          />

          <label style={label}>What do you do?</label>
          <div style={{ display: "grid", gap: 8 }}>
            {ROLE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setRole(opt.value)}
                style={{
                  textAlign: "left",
                  padding: "12px 14px",
                  background: role === opt.value ? BG_DARK : "transparent",
                  border: `1px solid ${role === opt.value ? BLUE : BORDER}`,
                  borderRadius: 10,
                  color: TEXT_PRIMARY,
                  fontFamily: inter,
                  fontSize: 15,
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}
              >
                <span style={{ fontWeight: 600 }}>{opt.label}</span>
                <span style={{ color: TEXT_MUTED, fontSize: 13 }}>{opt.example}</span>
              </button>
            ))}
          </div>

          <label style={label} htmlFor="contribution">
            What specifically? (optional, one line)
          </label>
          <input
            id="contribution"
            type="text"
            placeholder='e.g. "Prusa MK4 with PETG profile" or "ResNet-50 fine-tuned on Cu-pipe defects"'
            maxLength={280}
            value={contributionDescription}
            onChange={(e) => setContributionDescription(e.target.value)}
            style={input}
          />

          <label style={label} htmlFor="rate">
            Your cut: <strong style={{ color: BLUE }}>{ratePercent}%</strong> of every job
          </label>
          <input
            id="rate"
            type="range"
            min={0.1}
            max={10}
            step={0.1}
            value={ratePercent}
            onChange={(e) => setRatePercent(Number(e.target.value))}
            style={{ width: "100%", accentColor: BLUE }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: TEXT_MUTED }}>
            <span>0.1% (high volume)</span>
            <span>10% (high value)</span>
          </div>

          <button type="submit" style={button} disabled={!email}>
            Publish my rate
          </button>
        </form>

        <p
          style={{
            marginTop: 28,
            paddingTop: 20,
            borderTop: `1px solid ${BORDER}`,
            fontSize: 12,
            color: TEXT_MUTED,
            textAlign: "center",
          }}
        >
          Already have a wallet?{" "}
          <Link to="/login" style={{ color: BLUE, textDecoration: "none" }}>
            Connect MetaMask instead
          </Link>
        </p>
      </div>
    </div>
  );
}
