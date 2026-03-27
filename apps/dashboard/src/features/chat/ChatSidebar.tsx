import React, { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useSpatialChatStore } from "./ChatStore.js";
import { usePanelStore } from "../spatial/PanelStore.js";
import { panelRegistry } from "../spatial/PanelRegistry.js";

// ---------------------------------------------------------------------------
// ChatSidebar — toggleable conversation history on the left
// ---------------------------------------------------------------------------

export function ChatSidebar() {
  const { messages, sidebarOpen, setSidebarOpen } = useSpatialChatStore();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  return (
    <AnimatePresence>
      {sidebarOpen && (
        <motion.div
          initial={{ x: -320, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: -320, opacity: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="fixed left-0 top-0 bottom-14 w-80 z-[9998] flex flex-col bg-black/80 backdrop-blur-xl border-r border-white/[0.06]"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
            <span className="text-xs font-medium text-white/50 tracking-wider uppercase">
              Chat History
            </span>
            <button
              onClick={() => setSidebarOpen(false)}
              className="p-1 rounded hover:bg-white/[0.06] text-white/40 hover:text-white/70 transition-colors"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              >
                <path d="M4 4L10 10M10 4L4 10" />
              </svg>
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} msg={msg} />
            ))}
            <div ref={messagesEndRef} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// Single message bubble
// ---------------------------------------------------------------------------

function MessageBubble({ msg }: { msg: { role: string; content: string; panelId?: string } }) {
  const isUser = msg.role === "user";

  const handleClickReopen = () => {
    if (!msg.panelId) return;
    const entry = panelRegistry[msg.panelId];
    if (entry) {
      usePanelStore.getState().openPanel(msg.panelId, entry.title, entry.component);
    }
  };

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[90%] px-3 py-2 rounded-xl text-xs leading-relaxed whitespace-pre-wrap ${
          isUser
            ? "bg-emerald-500/15 text-emerald-300/90 border border-emerald-500/10"
            : "bg-white/[0.04] text-white/60 border border-white/[0.06]"
        } ${msg.panelId ? "cursor-pointer hover:bg-white/[0.08] transition-colors" : ""}`}
        onClick={msg.panelId ? handleClickReopen : undefined}
        title={msg.panelId ? "Click to reopen panel" : undefined}
      >
        {msg.content}
      </div>
    </div>
  );
}
