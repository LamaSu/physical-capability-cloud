import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUIStore } from "../../../stores/ui-store.js";
import { getAuthHeaders } from "../../../stores/auth-store.js";
import { ChatThread, type ChatMessage } from "../../../components/onboard/ChatThread.js";
import { ActivityFeed } from "../../../components/onboard/ActivityFeed.js";
import { parseInputIntent } from "../../../components/onboard/input-parser.js";

const API = (import.meta.env.VITE_PCC_URL ?? "") + "/api";
const ONBOARD = `${API}/onboard`;

/**
 * Onboard chat console — React port of navi v1 packages/backend/public/index.html.
 *
 * Layout (desktop): chat thread (1fr) | activity feed sidebar (380px)
 * Layout (mobile):  chat thread only; activity feed hidden.
 *
 * Behavioural mapping vs navi v1:
 *   - bootstrap (no session) → POST /api/onboard/start { name, url? }
 *   - scrape_url             → POST /api/onboard/:id/scrape { url, goal }
 *   - ingest_docs            → POST /api/onboard/:id/ingest-docs { doc_urls }
 *   - connections            → POST /api/onboard/:id/scrape per connection string
 *   - build                  → POST /api/onboard/:id/build-agent
 *   - drag-drop files        → ingest-docs with local:// URLs
 *
 * The actual gateway routes are wired by wave2-alpha; if any return 404 the
 * chat surfaces an "agent unreachable" bubble rather than crashing.
 */
export function OnboardChatPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "intro",
      role: "bot",
      text:
        "Hi — I'm Navi. While you're on the phone with the voice agent, drop docs and connections here. The right side shows every sponsor call landing in real time. What's your company name? (e.g. \"Oakland Titanium Mills at https://oakland-titanium-mills.example\")",
    },
  ]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idCounter = useRef(0);

  useEffect(() => {
    setPageMeta("Agent Onboarder", "live integration console");
  }, [setPageMeta]);

  const pushMessage = useCallback(
    (role: ChatMessage["role"], text: string, meta?: string) => {
      setMessages((prev) => {
        idCounter.current += 1;
        return [
          ...prev,
          {
            id: `m${Date.now()}-${idCounter.current}`,
            role,
            text,
            meta,
          },
        ];
      });
    },
    [],
  );

  /** Common fetch wrapper that surfaces failures into the chat thread. */
  const callOnboard = useCallback(
    async <T,>(
      path: string,
      init?: RequestInit,
    ): Promise<T | null> => {
      try {
        const res = await fetch(`${ONBOARD}${path}`, {
          ...init,
          headers: {
            "Content-Type": "application/json",
            ...getAuthHeaders(),
            ...(init?.headers ?? {}),
          },
        });
        if (!res.ok) {
          pushMessage(
            "bot",
            `Gateway error ${res.status} on ${path}. Try again or check gateway health.`,
          );
          return null;
        }
        return (await res.json()) as T;
      } catch (err) {
        pushMessage(
          "bot",
          `Network error on ${path}: ${err instanceof Error ? err.message : "unknown"}`,
        );
        return null;
      }
    },
    [pushMessage],
  );

  const startSession = useCallback(
    async (name: string, url: string | null) => {
      type Started = { session_id: string };
      const body: Record<string, unknown> = { name };
      if (url) body.url = url;
      const j = await callOnboard<Started>("/start", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!j) return null;
      setSessionId(j.session_id);
      pushMessage(
        "bot",
        `Got it — session ${j.session_id.slice(0, 8)} for ${name}.`,
        `op dashboard: ${window.location.origin}/operator/${j.session_id}`,
      );
      return j.session_id;
    },
    [callOnboard, pushMessage],
  );

  const scrapeUrl = useCallback(
    async (sid: string, url: string) => {
      pushMessage("bot", `Scraping ${url} via web-extract…`);
      type ScrapeResult = {
        machines?: { name?: string; kind?: string }[];
        tinyfish_draft?: { machines?: { name?: string; kind?: string }[] };
      };
      const j = await callOnboard<ScrapeResult>(`/${sid}/scrape`, {
        method: "POST",
        body: JSON.stringify({ url, goal: "extract enterprise capabilities" }),
      });
      if (!j) return;
      const machines = (j.tinyfish_draft?.machines ?? j.machines ?? [])
        .map((m) => `• ${m.name ?? m.kind ?? "(unknown)"}`)
        .join("\n");
      pushMessage(
        "bot",
        machines.length > 0
          ? `Extracted:\n${machines}`
          : "Scrape returned no structured machines yet.",
      );
    },
    [callOnboard, pushMessage],
  );

  const ingestDocs = useCallback(
    async (sid: string, urls: string[]) => {
      pushMessage("bot", `Ingesting ${urls.length} doc(s) into the verifier DB…`);
      type IngestResult = { indexed_docs?: number };
      const j = await callOnboard<IngestResult>(`/${sid}/ingest-docs`, {
        method: "POST",
        body: JSON.stringify({ doc_urls: urls }),
      });
      if (!j) return;
      pushMessage(
        "bot",
        `Indexed ${j.indexed_docs ?? urls.length} docs · pgvectorscale + BM25.`,
      );
    },
    [callOnboard, pushMessage],
  );

  const buildAgent = useCallback(
    async (sid: string) => {
      pushMessage(
        "bot",
        "Building your PCC agent — fanning out sponsor integrations.",
      );
      type BuildResult = {
        agent?: { url?: string; marketplace_url?: string };
        cited?: { url?: string };
        backend?: { project_url?: string };
      };
      const j = await callOnboard<BuildResult>(`/${sid}/build-agent`, {
        method: "POST",
      });
      if (!j) return;
      pushMessage(
        "bot",
        [
          "🎉 Done. Your agent is live.",
          "",
          `Operator dashboard: ${window.location.origin}/operator/${sid}`,
          `Guild: ${j.agent?.url ?? "—"}`,
          `agentic.market: ${j.agent?.marketplace_url ?? "—"}`,
          `cited.md: ${j.cited?.url ?? "—"}`,
          `Backend: ${j.backend?.project_url ?? "—"}`,
        ].join("\n"),
      );
    },
    [callOnboard, pushMessage],
  );

  /** Operator typed a message. Route to the matching gateway action. */
  const handleSend = useCallback(
    async (text: string) => {
      pushMessage("you", text);
      if (busy) return;
      setBusy(true);
      try {
        const intent = parseInputIntent(text, sessionId !== null);
        if (intent.kind === "bootstrap") {
          const sid = await startSession(intent.name, intent.url);
          if (sid && intent.url) {
            await scrapeUrl(sid, intent.url);
          } else if (sid) {
            pushMessage(
              "bot",
              "Drop your website URL next, or paste a connection string for your ERP / CMMS, or attach an SOP doc.",
            );
          }
          return;
        }
        if (!sessionId) {
          // Defensive: should not happen given parseInputIntent's contract.
          return;
        }
        if (intent.kind === "connections") {
          pushMessage(
            "bot",
            `Connection string detected (${intent.connections.length}) — wiring sources…`,
          );
          for (const c of intent.connections) {
            await scrapeUrl(sessionId, c);
          }
          return;
        }
        if (intent.kind === "ingest_docs") {
          await ingestDocs(sessionId, intent.urls);
          return;
        }
        if (intent.kind === "scrape_url") {
          await scrapeUrl(sessionId, intent.url);
          return;
        }
        if (intent.kind === "scrape_many") {
          if (intent.docs.length > 0) {
            await ingestDocs(sessionId, intent.docs);
          }
          for (const u of intent.urls) {
            await scrapeUrl(sessionId, u);
          }
          return;
        }
        if (intent.kind === "build") {
          await buildAgent(sessionId);
          return;
        }
        // noop
        pushMessage(
          "bot",
          "Noted. Say \"build\" when you're ready, or paste more docs/connections.",
        );
      } finally {
        setBusy(false);
      }
    },
    [
      busy,
      sessionId,
      pushMessage,
      startSession,
      scrapeUrl,
      ingestDocs,
      buildAgent,
    ],
  );

  /** Operator dropped files onto the chat surface. */
  const handleDropFiles = useCallback(
    async (files: File[]) => {
      const summary = files.map((f) => `📄 ${f.name}`).join("\n");
      pushMessage("you", summary);
      if (!sessionId) {
        pushMessage("bot", "Tell me your company name first.");
        return;
      }
      // Mirror navi v1: surface the file list as local:// URLs so the gateway
      // treats them as a doc batch. Real upload (multipart) is alpha's
      // territory — once the route accepts FormData we'll switch to that.
      await ingestDocs(
        sessionId,
        files.map((f) => `local://${f.name}`),
      );
    },
    [sessionId, pushMessage, ingestDocs],
  );

  // Activity feed endpoint — wave2-alpha mounts this under /api/onboard/events.
  const feedEndpoint = useMemo(() => `${ONBOARD}/events`, []);

  return (
    <div className="h-full flex gap-3 px-4 py-3 min-h-0">
      <div className="flex-1 min-w-0">
        <ChatThread
          messages={messages}
          onSend={handleSend}
          onDropFiles={handleDropFiles}
          disabled={busy}
        />
      </div>
      <div className="w-[380px] shrink-0 hidden lg:block min-h-0">
        <ActivityFeed endpoint={feedEndpoint} />
      </div>
    </div>
  );
}
