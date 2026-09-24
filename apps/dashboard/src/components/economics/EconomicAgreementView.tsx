/**
 * EconomicAgreementView — the approval preview (PX-12): who gets paid what, when, and why.
 *
 * It renders the server's EconomicPreviewDTO and computes nothing. Every amount and every sentence
 * comes from the gateway's one economics compiler (POST /api/economics/preview). The view is a
 * prediction (Layer C) and says so: accepting and funding happen elsewhere, and money that is
 * actually reserved or paid is shown from the escrow's read model, never from here.
 */
import React from "react";
import { GlassPanel, GlowBadge } from "@pcc/ui";
import type { economics } from "@pcc/spec";

type Preview = economics.EconomicPreviewDTO;

const STATUS_BADGE: Record<Preview["status"], { color: "green" | "gold" | "red"; label: string }> = {
  fundable: { color: "green", label: "Fundable" },
  "not-acceptable-now": { color: "gold", label: "Cannot be accepted now" },
  refused: { color: "red", label: "Refused" },
};

const CATEGORY_COLOR: Record<string, "green" | "cyan" | "gold" | "teal"> = {
  provider: "green",
  upstream: "cyan",
  fee: "gold",
  margin: "teal",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <GlassPanel padding="md">
      <h3 className="text-xs uppercase tracking-wider text-white/40 mb-3">{title}</h3>
      {children}
    </GlassPanel>
  );
}

export function EconomicAgreementView({ preview }: { preview: Preview }) {
  const p = preview;
  return (
    <div className="space-y-4" data-testid="economic-agreement-view">
      <GlassPanel padding="md">
        <div className="flex items-center gap-2 mb-2">
          <GlowBadge color={STATUS_BADGE[p.status].color}>{STATUS_BADGE[p.status].label}</GlowBadge>
          <GlowBadge color="gray">Preview, not a deal</GlowBadge>
          {p.protocolFee && !p.protocolFee.verified ? <GlowBadge color="gold">Fee not checked</GlowBadge> : null}
        </div>
        <p className="text-sm text-white/80" data-testid="headline">{p.headline}</p>
        {p.agreement.agreementHash ? (
          <p className="mt-2 text-[10px] font-mono text-white/40">Accepting binds {p.agreement.agreementHash}</p>
        ) : null}
      </GlassPanel>

      {p.refusals.length > 0 ? (
        <Section title="Why this cannot be funded">
          <ul className="space-y-1">
            {p.refusals.map((r, i) => (
              <li key={i} className="text-xs text-red-300">{r.explanation}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      {p.totals ? (
        <Section title="Where the money goes">
          <table className="w-full text-xs">
            <tbody>
              {p.byCategory.map((c) => (
                <tr key={c.category} className="border-b border-white/[0.04]">
                  <td className="py-1.5 pr-3"><GlowBadge color={CATEGORY_COLOR[c.category] ?? "gray"}>{c.label}</GlowBadge></td>
                  <td className="py-1.5 text-right font-mono text-white/70">{c.amount.display}</td>
                </tr>
              ))}
              <tr className="border-b border-white/[0.04]">
                <td className="py-1.5 pr-3 text-white/60">PCC protocol fee ({p.protocolFee?.percent})</td>
                <td className="py-1.5 text-right font-mono text-white/70">{p.totals.protocolFee.display}</td>
              </tr>
              <tr>
                <td className="py-1.5 pr-3 text-white/80 font-medium">Most you pay</td>
                <td className="py-1.5 text-right font-mono text-white">{p.totals.maxSpend.display}</td>
              </tr>
            </tbody>
          </table>
        </Section>
      ) : null}

      {p.payees.length > 0 ? (
        <Section title="Who gets paid what, and why">
          <div className="space-y-3">
            {p.payees.map((payee) => (
              <div key={payee.partyId}>
                <div className="flex justify-between text-xs">
                  <span className="text-white/80">{payee.label}</span>
                  <span className="font-mono text-white/80">{payee.total.display}</span>
                </div>
                <ul className="mt-1 space-y-0.5">
                  {payee.lines.map((l, i) => (
                    <li key={i} className="flex justify-between gap-3 text-[11px] text-white/50">
                      <span>{l.stepLabel}: {l.why}</span>
                      <span className="font-mono shrink-0">{l.amount.display}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {p.steps.length > 0 ? (
        <Section title="When each step is paid">
          <ul className="space-y-2">
            {p.steps.map((s) => (
              <li key={s.unitRef} className="text-xs">
                <div className="flex justify-between text-white/80">
                  <span>{s.label}</span>
                  <span className="font-mono">{s.gross.display}</span>
                </div>
                <p className="text-white/50">{s.whenPaid} {s.ifItFails}</p>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] text-white/40" data-testid="money-state">{p.moneyState.note}</p>
        </Section>
      ) : null}

      {p.obligations.length > 0 || p.rights.length > 0 || p.rates.length > 0 ? (
        <Section title="Licenses and what they require">
          <ul className="space-y-1 text-xs text-white/60">
            {p.rights.map((r, i) => (
              <li key={`r${i}`}>
                {r.license}, from {r.licensor} ({r.class}
                {r.attributionRequired ? ", credit required" : ""}
                {r.validUntil ? `, valid until ${r.validUntil.slice(0, 10)}` : ""})
              </li>
            ))}
            {p.obligations.map((o, i) => (
              <li key={`o${i}`}>{o.clause}: {o.amount.display}</li>
            ))}
            {p.rates.map((r, i) => (
              <li key={`p${i}`}>{r.clause}: {r.percent}. {r.note}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      {p.notOwed.length > 0 ? (
        <Section title="Not owed in this agreement">
          <ul className="space-y-1 text-xs text-white/50">
            {p.notOwed.map((n, i) => (
              <li key={i}>{n.clause}: {n.why}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      {p.scenarios.length > 0 ? (
        <Section title="What if">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-white/40 text-left">
                <th className="py-1 pr-3 font-normal">Scenario</th>
                <th className="py-1 pr-3 font-normal text-right">You spend</th>
                <th className="py-1 pr-3 font-normal text-right">Refunded</th>
                <th className="py-1 font-normal">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {p.scenarios.map((s) => (
                <tr key={s.scenarioId} className="border-t border-white/[0.04] align-top">
                  <td className="py-1.5 pr-3 text-white/80">{s.label}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{s.fundable ? s.payer.spent.display : "-"}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{s.fundable ? s.payer.refunded.display : "-"}</td>
                  <td className="py-1.5 text-white/50">
                    {s.fundable ? s.paid.map((x) => `${x.label} ${x.amount.display}`).join("; ") || "Nobody is paid" : s.reasons.join(" ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ) : null}

      {p.terms ? (
        <Section title="Expiry and changes">
          <ul className="space-y-1 text-xs text-white/60">
            <li>Priced as of {p.terms.asOf.slice(0, 16).replace("T", " ")} UTC.</li>
            <li>{p.terms.deadline}</li>
            {p.terms.timing ? <li className="text-amber-300" data-testid="timing">{p.terms.timing}</li> : null}
            <li>{p.terms.changePolicy}</li>
          </ul>
        </Section>
      ) : null}
    </div>
  );
}
