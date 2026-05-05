import React, { useCallback, useEffect, useRef, useState } from "react";
import { useParams, Navigate } from "react-router-dom";
import { useUIStore } from "../../../../stores/ui-store.js";
import { getAuthHeaders } from "../../../../stores/auth-store.js";
import { ChatThread, type ChatMessage } from "../../../../components/onboard/ChatThread.js";
import { ActivityFeed } from "../../../../components/onboard/ActivityFeed.js";
import type { OnboardEvent } from "../../../../components/onboard/activity-feed-logic.js";
import { parseInputIntent } from "../../../../components/onboard/input-parser.js";
import { TEMPLATES } from "../../templates.js";

const API_ROOT = (import.meta.env.VITE_PCC_URL ?? "");

/**
 * Generalized orchestrator chat console — runs ANY template's conversational
 * flow. Reads the template slug from the route, looks up its manifest in
 * apps/dashboard/src/routes/orchestrator/templates.ts, and drives the same
 * UX patterns bravo built for /onboard/chat:
 *   - 3-pane layout: chat thread + drag-drop zone + activity feed sidebar
 *   - input-parser routes URL paste / connection string / file drop / "build"
 *   - all sponsor calls stream into the activity feed via /api/events
 *
 * The only template-specific bits are:
 *   - the greeting message (template.greeting)
 *   - the API route prefix (template.api_base)
 *   - the page title (template.display_name)
 *
 * If the slug is unknown, we redirect to /orchestrator (the picker).
 */
export function OrchestratorChatPage() {
  const { slug } = useParams<{ slug: string }>();
  const template = slug ? TEMPLATES[slug] : undefined;
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  const apiBase = `${API_ROOT}${template?.api_base ?? ""}`;

  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    { id: "intro", role: "bot", text: template?.greeting ?? "" }
  ]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lastEventTs = useRef(0);
  const [events, setEvents] = useState<OnboardEvent[]>([]);

  useEffect(() => {
    if (template) {
      setPageMeta(template.display_name, template.description);
    }
  }, [setPageMeta, template]);

  // Poll integration feed
  useEffect(() => {
    const tick = async () => {
      try {
        const res = await fetch(`${API_ROOT}/api/events?since=${lastEventTs.current}`, {
          headers: { ...getAuthHeaders() }
        });
        if (!res.ok) return;
        const data = (await res.json()) as { events?: OnboardEvent[] };
        const incoming = data.events ?? [];
        if (incoming.length) {
          setEvents((prev) => [...incoming, ...prev].slice(0, 80));
          lastEventTs.current = incoming.reduce((max, ev) => Math.max(max, ev.t), lastEventTs.current);
        }
      } catch {
        // best-effort; backend may be offline in dev
      }
    };
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, []);

  const post = useCallback(
    async (path: string, body: unknown): Promise<unknown> => {
      const res = await fetch(`${apiBase}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
      return res.json();
    },
    [apiBase]
  );

  const append = useCallback((m: Omit<ChatMessage, "id">) => {
    setMessages((prev) => [...prev, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ...m }]);
  }, []);

  const onSend = useCallback(
    async (text: string) => {
      append({ role: "you", text });
      setBusy(true);
      try {
        const intent = parseInputIntent(text, sessionId !== null);
        if (!sessionId) {
          // first message = bootstrap (name + optional URL)
          if (intent.kind !== "bootstrap") {
            append({ role: "bot", text: "Tell me your company / data-product name first." });
            return;
          }
          const j = (await post("/start", {
            name: intent.name,
            ...(intent.url ? { url: intent.url } : {})
          })) as { session_id: string; state: string };
          setSessionId(j.session_id);
          append({ role: "bot", text: `Got it — session ${j.session_id.slice(0, 8)} for ${intent.name}. Activity feed on the right shows every backend call.` });
          if (intent.url) {
            const r = (await post(`/${j.session_id}/scrape`, { url: intent.url })) as Record<string, unknown>;
            append({ role: "bot", text: `Scrape kicked off. ${JSON.stringify(r).slice(0, 280)}` });
          }
          return;
        }

        switch (intent.kind) {
          case "scrape_url":
            await post(`/${sessionId}/scrape`, { url: intent.url });
            append({ role: "bot", text: `Scraping ${intent.url}…` });
            return;
          case "scrape_many":
            for (const u of intent.urls) {
              await post(`/${sessionId}/scrape`, { url: u });
            }
            if (intent.docs.length) {
              await post(`/${sessionId}/ingest-docs`, { doc_urls: intent.docs });
            }
            append({ role: "bot", text: `Processed ${intent.urls.length} URL(s) and ${intent.docs.length} doc(s).` });
            return;
          case "ingest_docs":
            await post(`/${sessionId}/ingest-docs`, { doc_urls: intent.urls });
            append({ role: "bot", text: `Ingesting ${intent.urls.length} doc(s)…` });
            return;
          case "connections":
            for (const c of intent.connections) {
              await post(`/${sessionId}/scrape`, { url: c });
            }
            append({ role: "bot", text: `Wired ${intent.connections.length} connection(s).` });
            return;
          case "build": {
            const j = await post(`/${sessionId}/build-agent`, {});
            append({ role: "bot", text: `Built. ${JSON.stringify(j).slice(0, 400)}` });
            return;
          }
          case "bootstrap":
          case "noop":
          default:
            append({ role: "bot", text: `Noted. Drop a URL or say "build" when ready.` });
        }
      } catch (e) {
        append({ role: "bot", text: `error: ${e instanceof Error ? e.message : String(e)}` });
      } finally {
        setBusy(false);
      }
    },
    [sessionId, post, append]
  );

  const onDrop = useCallback(
    (files: File[]) => {
      if (!sessionId) {
        append({ role: "bot", text: "Tell me your company / data-product name first, then drop docs." });
        return;
      }
      const urls = files.map((f) => `local://${f.name}`);
      post(`/${sessionId}/ingest-docs`, { doc_urls: urls }).catch(() => {});
      append({ role: "you", text: files.map((f) => `📄 ${f.name}`).join("\n") });
    },
    [sessionId, post, append]
  );

  // Hooks must run before any conditional return; redirect after they're set up.
  if (!template) {
    return <Navigate to="/orchestrator" replace />;
  }

  return (
    <div className="orchestrator-chat">
      <ChatThread messages={messages} onSend={onSend} onDropFiles={onDrop} disabled={busy} />
      <ActivityFeed events={events} />
    </div>
  );
}

export default OrchestratorChatPage;
