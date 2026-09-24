/**
 * EconomicAgreementsPage — Inspect an agreement before accepting it (PX-12). Route: /economics
 *
 * Pick a template, or paste an agreement an agent proposed, and the gateway compiles it with the
 * server's own fee, sealed rate schedules and forbidden recipients (POST /api/economics/preview).
 * This page renders that answer: who gets paid what, when, and why, with what-if scenarios. It is a
 * preview (Layer C): nothing here accepts, funds or pays anything.
 *
 * It replaces the IP revenue pages, which showed fabricated revenue beside a live Claim button.
 */
import React from "react";
import { EmptyState, GlassPanel, Skeleton } from "@pcc/ui";
import type { economics } from "@pcc/spec";
import { apiGet, apiPost } from "../lib/api.js";
import { useUIStore } from "../stores/ui-store.js";
import { EconomicAgreementView } from "../components/economics/EconomicAgreementView.js";

interface Template {
  templateId: string;
  title: string;
  summary: string;
}

type Source = { kind: "template"; templateId: string } | { kind: "pasted"; text: string };

export function EconomicAgreementsPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const [templates, setTemplates] = React.useState<Template[] | null>(null);
  const [templatesError, setTemplatesError] = React.useState<string | null>(null);
  const [source, setSource] = React.useState<Source | null>(null);
  const [pasted, setPasted] = React.useState("");
  const [preview, setPreview] = React.useState<economics.EconomicPreviewDTO | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setPageMeta("Agreements", "who gets paid what, when, and why");
  }, [setPageMeta]);

  React.useEffect(() => {
    let cancelled = false;
    apiGet<{ templates: Template[] }>("/economics/templates")
      .then((r) => {
        if (!cancelled) setTemplates(r.templates);
      })
      .catch((e: unknown) => {
        if (!cancelled) setTemplatesError(e instanceof Error ? e.message : "templates unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (source === null) return;
    let cancelled = false;
    let body: unknown;
    if (source.kind === "template") {
      body = { templateId: source.templateId };
    } else {
      try {
        body = { agreement: JSON.parse(source.text) };
      } catch {
        setError("That is not valid JSON.");
        setPreview(null);
        return;
      }
    }
    setLoading(true);
    setError(null);
    apiPost<{ preview: economics.EconomicPreviewDTO }>("/economics/preview", body)
      .then((r) => {
        if (!cancelled) setPreview(r.preview);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setPreview(null);
          setError(e instanceof Error ? e.message : "preview unavailable");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  return (
    <div className="space-y-4 max-w-5xl">
      <GlassPanel padding="md">
        <p className="text-xs text-white/50 mb-3">
          A preview, computed by the server from its own fee and published rate schedules. Nothing here accepts, funds or pays anything.
        </p>
        {templatesError ? (
          <p className="text-xs text-red-300">Templates are unavailable: {templatesError}</p>
        ) : templates === null ? (
          <Skeleton className="h-10" />
        ) : (
          <div className="flex flex-wrap gap-2">
            {templates.map((t) => (
              <button
                key={t.templateId}
                type="button"
                title={t.summary}
                onClick={() => setSource({ kind: "template", templateId: t.templateId })}
                className={`px-3 py-1.5 rounded text-xs border ${
                  source?.kind === "template" && source.templateId === t.templateId
                    ? "border-white/40 text-white"
                    : "border-white/10 text-white/60 hover:text-white/90"
                }`}
              >
                {t.title}
              </button>
            ))}
          </div>
        )}
        <details className="mt-3">
          <summary className="text-xs text-white/50 cursor-pointer">Preview an agreement an agent proposed</summary>
          <textarea
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            rows={6}
            className="mt-2 w-full bg-black/30 border border-white/10 rounded p-2 text-[11px] font-mono text-white/80"
            placeholder='{"schema":"pcc.economic-agreement.v1", ...}'
          />
          <button
            type="button"
            onClick={() => setSource({ kind: "pasted", text: pasted })}
            className="mt-2 px-3 py-1.5 rounded text-xs border border-white/10 text-white/70 hover:text-white"
          >
            Preview
          </button>
        </details>
      </GlassPanel>

      {loading ? (
        <GlassPanel padding="md">
          <Skeleton className="h-40" />
        </GlassPanel>
      ) : error ? (
        <GlassPanel padding="lg">
          <EmptyState title="No preview" description={`${error}. Nothing is shown rather than an estimate.`} />
        </GlassPanel>
      ) : preview ? (
        <EconomicAgreementView preview={preview} />
      ) : (
        <GlassPanel padding="lg">
          <EmptyState title="Pick an agreement" description="Choose a template above, or paste one an agent proposed, to see who gets paid what, when, and why." />
        </GlassPanel>
      )}
    </div>
  );
}
