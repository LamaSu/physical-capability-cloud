import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, Navigate } from "react-router-dom";
import { useUIStore } from "../../../../stores/ui-store.js";
import { getAuthHeaders } from "../../../../stores/auth-store.js";
import { ChatThread, type ChatMessage } from "../../../../components/onboard/ChatThread.js";
import { ActivityFeed } from "../../../../components/onboard/ActivityFeed.js";
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

  if (!template) {
    return <Navigate to="/orchestrator" replace />;
  }

  const apiBase = `${API_ROOT}${template.api_base}`;

  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: "intro", role: "bot", text: template.greeting }
  ]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lastEventTs = useRef(0);
  const [events, setEvents] = useState<{ t: number; kind: string; sponsor?: string; text: string; level?: string; payload?: unknown }[]>([]);

  useEffect(() => {
    setPageMeta({
      title: template.display_name,
      subtitle: template.description
    });
  }, [setPageMeta, template]);

  // Poll integration feed
  useEffect(() => {
    const tick = async () => {
      try {
        const res = await fetch(`${API_ROOT}/api/events?since=${lastEventTs.current}`, {
          headers: { ...getAuthHeaders() }
        });
        if (!res.ok) return;
        const data = (await res.json()) as { events: typeof events };
        if (data.events?.length) {
          setEvents((prev) => [...data.events, ...prev].slice(0, 80));
          lastEventTs.current = Math.max(...data.events.map((e) => e.t), lastEventTs.current);
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
      append({ role: "user", text });
      setBusy(true);
      try {
        const intent = parseInputIntent(text);
        if (!sessionId) {
          // first message = name (+ optional URL)
          const m = text.match(/^(.+?)\s+(?:at|@|—|-)\s+(https?:\/\/\S+)/i);
          const name = m ? m[1] : text;
          const url = m ? m[2] : undefined;
          const j = (await post("/start", { name, url })) as { session_id: string; state: string };
          setSessionId(j.session_id);
          append({ role: "bot", text: `Got it — session ${j.session_id.slice(0, 8)} for ${name}. Activity feed on the right shows every backend call.` });
          if (url) {
            const r = (await post(`/${j.session_id}/scrape`, { url })) as Record<string, unknown>;
            append({ role: "bot", text: `Scrape kicked off. ${JSON.stringify(r).slice(0, 280)}` });
          }
          return;
        }

        switch (intent.kind) {
          case "url":
            await post(`/${sessionId}/scrape`, { url: intent.url });
            append({ role: "bot", text: `Scraping ${intent.url}…` });
            return;
          case "doc-urls":
            await post(`/${sessionId}/ingest-docs`, { doc_urls: intent.urls });
            append({ role: "bot", text: `Ingesting ${intent.urls.length} doc(s)…` });
            return;
          case "build":
            const j = await post(`/${sessionId}/build-agent`, {});
            append({ role: "bot", text: `Built. ${JSON.stringify(j).slice(0, 400)}` });
            return;
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
      append({ role: "user", text: files.map((f) => `📄 ${f.name}`).join("\n") });
    },
    [sessionId, post, append]
  );

  return (
    <div className="orchestrator-chat">
      <ChatThread messages={messages} onSend={onSend} busy={busy} onDrop={onDrop} />
      <ActivityFeed events={events} />
    </div>
  );
}

export default OrchestratorChatPage;
