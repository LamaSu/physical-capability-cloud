import React, { useState, useRef, useCallback } from "react";
import { useSpatialChatStore } from "./ChatStore.js";
import { processInput } from "./ChatEngine.js";

// ---------------------------------------------------------------------------
// ChatBar — fixed at the bottom of the spatial interface
// ---------------------------------------------------------------------------

export function ChatBar() {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const addMessage = useSpatialChatStore((s) => s.addMessage);
  const toggleSidebar = useSpatialChatStore((s) => s.toggleSidebar);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return;

    // Add user message
    addMessage({ role: "user", content: trimmed });

    // Process
    const result = processInput(trimmed);

    // Add system response
    if (result.response) {
      addMessage({
        role: "system",
        content: result.response,
        panelId: result.panelId,
      });
    }

    setValue("");
    inputRef.current?.focus();
  }, [value, addMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  return (
    <div className="fixed bottom-0 left-0 right-0 z-[10000] bg-black/60 backdrop-blur-md border-t border-white/[0.06]">
      <div className="flex items-center gap-3 px-4 py-3 max-w-5xl mx-auto">
        {/* Toggle sidebar button */}
        <button
          onClick={toggleSidebar}
          className="shrink-0 p-2 rounded-lg hover:bg-white/[0.06] transition-colors text-white/40 hover:text-white/70"
          title="Toggle chat history"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </button>

        {/* Input */}
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Open a panel... (try 'jobs', 'revenue', '/help')"
          className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-white/90 placeholder:text-white/30 focus:outline-none focus:border-emerald-500/40 focus:ring-1 focus:ring-emerald-500/20 transition-all"
          autoComplete="off"
          spellCheck={false}
        />

        {/* Send button */}
        <button
          onClick={handleSubmit}
          disabled={!value.trim()}
          className="shrink-0 px-4 py-2.5 rounded-xl bg-emerald-500/20 text-emerald-400 text-sm font-medium hover:bg-emerald-500/30 disabled:opacity-30 disabled:cursor-not-allowed transition-all border border-emerald-500/20"
        >
          Send
        </button>
      </div>
    </div>
  );
}
