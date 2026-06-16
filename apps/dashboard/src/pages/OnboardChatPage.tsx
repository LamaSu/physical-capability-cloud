/**
 * Conversational no-code onboarding (closes coord dc4d1ec8).
 *
 * Layperson-friendly chat that talks to POST /api/onboard/chat on the gateway.
 * The gateway drives an Anthropic LLM with the v3 agent-pack system_prompt
 * (#154); we just render the back-and-forth and let the LLM make every
 * decision about what to call. No API key required to reach this page.
 *
 * Route: /onboard/chat (mounted as a public path in App.tsx)
 *
 * Why we don't reuse `AgentChatPage`: that file is a dashboard mock, not a
 * connected chat. This component is the actual user-facing chat.
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";

const API = (import.meta as any).env?.VITE_PCC_URL ?? "";

interface ToolCallTrace {
  name: string;
  args: Record<string, unknown>;
  status: number;
  result: unknown;
  durationMs: number;
}

interface ChatResponse {
  conversationId: string;
  assistant: string;
  toolCalls: ToolCallTrace[];
  done: boolean;
  doneReason?: string;
  turns?: number;
  needsApiKey?: boolean;
}

interface Message {
  role: "user" | "assistant" | "system";
  text: string;
  toolCalls?: ToolCallTrace[];
  ts: string;
}

interface HealthInfo {
  hasApiKey: boolean;
  hasSdk: boolean;
  agentPackageStatus?: { loaded: boolean; toolCount?: number; promptLength?: number };
  model?: string;
}

// Suggested opening lines so a first-time visitor has somewhere to start.
const STARTER_LINES = [
  "I run a pizza shop in Brooklyn. I make wood-fired margherita for $12 and pepperoni for $14, open Tuesday through Sunday 11 to 11.",
  "I'm a bike courier in Manhattan. $25 per delivery within 5 miles, available weekday afternoons.",
  "I have a Prusa MK4 3D printer in my garage. Charge $0.50/g for PLA prints, weekends only.",
  "I want to order a custom 12-inch pepperoni pizza delivered to 200 5th Ave by 7pm tonight.",
];

export function OnboardChatPage() {
  const navigate = useNavigate();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [showToolCalls, setShowToolCalls] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Health probe — informs the user before they type if the gateway can't drive the LLM.
  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/api/onboard/chat/health`)
      .then((r) => (r.ok ? r.json() : null))
      .then((h) => {
        if (!cancelled && h) setHealth(h);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Scroll to bottom on new message
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, busy]);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      setError(null);
      setBusy(true);

      const userMsg: Message = { role: "user", text: trimmed, ts: new Date().toISOString() };
      setMessages((prev) => [...prev, userMsg]);
      setInput("");

      try {
        const res = await fetch(`${API}/api/onboard/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conversationId, message: trimmed }),
        });
        const body = (await res.json()) as ChatResponse | { error: string; message?: string };
        if (!res.ok) {
          const errBody = body as { error: string; message?: string };
          setError(errBody.message ?? errBody.error ?? `HTTP ${res.status}`);
          return;
        }
        const ok = body as ChatResponse;
        if (!conversationId && ok.conversationId) setConversationId(ok.conversationId);
        const assistantMsg: Message = {
          role: "assistant",
          text: ok.assistant,
          toolCalls: ok.toolCalls,
          ts: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, assistantMsg]);

        if (ok.needsApiKey) {
          setError(
            "The gateway is up but the operator hasn't set ANTHROPIC_API_KEY. Chat will stay in demo mode until they do.",
          );
        }
      } catch (e) {
        setError(`Network error: ${(e as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [busy, conversationId],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void sendMessage(input);
  };

  const handleStarter = (line: string) => {
    setInput(line);
    void sendMessage(line);
  };

  const renderToolCalls = (calls?: ToolCallTrace[]) => {
    if (!calls || calls.length === 0) return null;
    if (!showToolCalls) return null;
    return (
      <div className="mt-2 space-y-1 border-l-2 border-emerald-500/30 pl-3">
        {calls.map((c, i) => (
          <div key={i} className="text-[11px] font-mono text-white/40">
            <span className="text-emerald-400/80">{c.name}</span>
            <span className="text-white/30"> → </span>
            <span className={c.status >= 200 && c.status < 300 ? "text-emerald-400/80" : "text-red-400/80"}>
              {c.status}
            </span>
            <span className="text-white/20"> ({c.durationMs}ms)</span>
          </div>
        ))}
      </div>
    );
  };

  const isReady =
    health === null || (health.hasApiKey && health.hasSdk && health.agentPackageStatus?.loaded);

  return (
    <div className="flex flex-col h-screen bg-gradient-to-b from-black via-zinc-950 to-black text-white/90">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06] bg-black/40 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("/onboard")}
            className="text-xs text-white/40 hover:text-white/70 transition-colors"
            aria-label="Back to onboard landing"
          >
            ←
          </button>
          <div>
            <h1 className="text-sm font-semibold text-white/90">No-Code Onboarding</h1>
            <p className="text-[11px] text-white/40">
              Tell me what you do and I'll register it. No CLI, no API key.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[11px] text-white/40 cursor-pointer">
            <input
              type="checkbox"
              checked={showToolCalls}
              onChange={(e) => setShowToolCalls(e.target.checked)}
              className="accent-emerald-500"
            />
            Show tool calls
          </label>
          {health && (
            <div className="flex items-center gap-1.5 text-[11px]">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  isReady ? "bg-emerald-400" : "bg-amber-400"
                }`}
                aria-hidden
              />
              <span className="text-white/40">
                {isReady ? `${health.model ?? "ready"}` : "demo mode"}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Message list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
        <div className="max-w-3xl mx-auto space-y-4">
          {messages.length === 0 && (
            <div className="space-y-6">
              <div className="text-center space-y-2">
                <h2 className="text-xl font-semibold text-white/80">What do you want to register?</h2>
                <p className="text-sm text-white/40 max-w-xl mx-auto">
                  Plain English works — a service you sell, a machine you own, or a job you want done.
                  I'll ask questions, then create the capability for you.
                </p>
              </div>
              <div className="grid gap-2 max-w-2xl mx-auto">
                {STARTER_LINES.map((line, i) => (
                  <button
                    key={i}
                    onClick={() => handleStarter(line)}
                    disabled={busy}
                    className="text-left px-4 py-3 rounded-lg border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.05] hover:border-emerald-500/30 transition-all text-sm text-white/70 disabled:opacity-50"
                  >
                    {line}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <div
              key={i}
              className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] sm:max-w-[75%] rounded-2xl px-4 py-3 ${
                  m.role === "user"
                    ? "bg-emerald-500/15 border border-emerald-500/30 text-white/90"
                    : "bg-white/[0.04] border border-white/[0.06] text-white/85"
                }`}
              >
                <div className="text-sm whitespace-pre-wrap leading-relaxed">{m.text}</div>
                {m.role === "assistant" && renderToolCalls(m.toolCalls)}
              </div>
            </div>
          ))}

          {busy && (
            <div className="flex justify-start">
              <div className="rounded-2xl px-4 py-3 bg-white/[0.04] border border-white/[0.06] flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-xs text-white/50">Thinking…</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-6 py-2 bg-amber-500/10 border-t border-amber-500/30">
          <div className="max-w-3xl mx-auto text-xs text-amber-400/90">{error}</div>
        </div>
      )}

      {/* Input */}
      <div className="px-4 sm:px-6 py-4 border-t border-white/[0.06] bg-black/40 backdrop-blur-sm">
        <form onSubmit={handleSubmit} className="max-w-3xl mx-auto flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              busy
                ? "Working…"
                : conversationId
                ? "Reply…"
                : "Tell me what you do, or what you need done"
            }
            disabled={busy}
            className="flex-1 px-4 py-3 rounded-lg bg-white/[0.04] border border-white/[0.06] focus:border-emerald-500/50 focus:outline-none text-sm text-white/90 placeholder-white/30 disabled:opacity-50"
            aria-label="Chat message"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="px-5 py-3 rounded-lg bg-emerald-500/20 border border-emerald-500/40 hover:bg-emerald-500/30 hover:border-emerald-400/60 transition-all text-sm font-medium text-emerald-300 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Send
          </button>
        </form>
        <div className="max-w-3xl mx-auto mt-2 text-[11px] text-white/30 text-center">
          Conversation history is saved on the gateway and survives a page reload.
          {conversationId && <span className="ml-1 font-mono opacity-60">#{conversationId.slice(0, 12)}</span>}
        </div>
      </div>
    </div>
  );
}
