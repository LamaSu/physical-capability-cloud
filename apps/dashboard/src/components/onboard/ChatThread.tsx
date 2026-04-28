import React, { useEffect, useRef, useState } from "react";
import { cn } from "@pcc/ui";

/**
 * Three-actor chat used by the onboard console.
 *
 * Maps to navi v1's three message classes:
 *   - "bot"   → Navi (the assistant)
 *   - "you"   → the operator (typing)
 *   - "voice" → mirrored transcript from the live phone agent (read-only)
 *
 * The bubble + avatar styling is React-portable equivalent of the original
 * vanilla-CSS classes in packages/backend/public/index.html.
 */
export type ChatRole = "bot" | "you" | "voice";

export interface ChatMessage {
  /** Stable id for keys + scroll behaviour. */
  id: string;
  role: ChatRole;
  text: string;
  /** Optional muted meta line under the bubble (e.g. "op dashboard: …"). */
  meta?: string;
}

export interface ChatThreadProps {
  messages: ChatMessage[];
  /** Operator submitted a message. Trimmed string never empty. */
  onSend: (text: string) => void;
  /** Files dropped onto the chat surface. */
  onDropFiles?: (files: File[]) => void;
  /** Optional secondary "speak via voice" button. Hidden when omitted. */
  onSendToVoice?: (text: string) => void;
  /** Disable input (during tool execution). */
  disabled?: boolean;
  /** Placeholder text shown in the textarea. */
  placeholder?: string;
  /** Hint line under the input area. */
  hint?: string;
  /** Whether the voice button should be enabled (depends on active call). */
  voiceEnabled?: boolean;
}

const AVATAR_LABEL: Record<ChatRole, string> = {
  bot: "N",
  you: "U",
  voice: "V",
};

/**
 * 3-actor chat thread + input row + drag-drop zone.
 *
 * Intentionally headless re: state — the route page owns the message list,
 * session id, and gateway plumbing. This component only renders + emits.
 */
export function ChatThread({
  messages,
  onSend,
  onDropFiles,
  onSendToVoice,
  disabled = false,
  placeholder = "Type, paste a URL, drop files…",
  hint = "drag PDFs anywhere · paste URLs / connection strings · text routes automatically",
  voiceEnabled = false,
}: ChatThreadProps) {
  const [text, setText] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  function handleSubmit() {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
  }

  function handleSendToVoice() {
    const trimmed = text.trim();
    if (!trimmed || !voiceEnabled || !onSendToVoice) return;
    onSendToVoice(trimmed);
    setText("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(true);
  }

  function handleDragLeave() {
    setDragOver(false);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (!onDropFiles) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) onDropFiles(files);
  }

  return (
    <div
      ref={containerRef}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      data-testid="onboard-chat-thread"
      className={cn(
        "flex flex-col h-full bg-black/40 border border-white/[0.06] rounded-xl overflow-hidden transition-colors",
        dragOver && "border-emerald-400/40 bg-emerald-500/5",
      )}
    >
      {/* Message list */}
      <main
        className="flex-1 overflow-y-auto px-4 py-4 space-y-3"
        data-testid="onboard-chat-messages"
      >
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        <div ref={bottomRef} />
      </main>

      {/* Input row */}
      <footer className="border-t border-white/[0.06] bg-black/30 px-3 py-2.5">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            rows={1}
            placeholder={placeholder}
            className="flex-1 resize-none bg-white/[0.03] border border-white/[0.08] rounded-xl
              px-3 py-2 text-sm text-white/80 placeholder-white/25
              focus:outline-none focus:border-teal-500/30 focus:ring-1 focus:ring-teal-500/15
              disabled:opacity-40 transition-all"
            style={{ maxHeight: "120px" }}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = "auto";
              target.style.height =
                Math.min(target.scrollHeight, 120) + "px";
            }}
            data-testid="onboard-chat-input"
          />
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              onClick={handleSubmit}
              disabled={disabled || !text.trim()}
              className="px-3 py-1.5 rounded-lg text-xs font-medium
                bg-teal-500/15 border border-teal-500/20 text-teal-300
                hover:bg-teal-500/25 hover:text-teal-200
                disabled:opacity-30 disabled:cursor-not-allowed transition-all"
              data-testid="onboard-chat-send"
            >
              Send
            </button>
            {onSendToVoice && (
              <button
                type="button"
                onClick={handleSendToVoice}
                disabled={disabled || !text.trim() || !voiceEnabled}
                title="Inject this text into the active phone call"
                className="px-3 py-1.5 rounded-lg text-xs font-medium
                  bg-emerald-500/15 border border-emerald-500/20 text-emerald-300
                  hover:bg-emerald-500/25 hover:text-emerald-200
                  disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                data-testid="onboard-chat-voice"
              >
                Speak via voice
              </button>
            )}
          </div>
        </div>
        {hint && (
          <div className="text-[11px] text-white/30 mt-1.5 px-0.5">{hint}</div>
        )}
      </footer>
    </div>
  );
}

interface MessageBubbleProps {
  message: ChatMessage;
}

function MessageBubble({ message }: MessageBubbleProps) {
  const isYou = message.role === "you";
  const isVoice = message.role === "voice";

  return (
    <div
      className={cn(
        "flex gap-2 max-w-[92%]",
        isYou ? "ml-auto flex-row-reverse" : "mr-auto",
      )}
      data-testid={`onboard-chat-msg-${message.role}`}
    >
      <div
        className={cn(
          "flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold border",
          isYou && "bg-white/[0.05] border-white/[0.12] text-white/80",
          isVoice && "bg-emerald-500/20 border-emerald-500/30 text-emerald-200",
          !isYou &&
            !isVoice &&
            "bg-emerald-400/20 border-emerald-400/25 text-emerald-200",
        )}
        aria-hidden
      >
        {AVATAR_LABEL[message.role]}
      </div>

      <div className="flex flex-col gap-1 min-w-0">
        <div
          className={cn(
            "rounded-xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words",
            isYou && "bg-white/[0.06] border border-white/[0.10] text-white/85",
            isVoice && "bg-emerald-500/10 border border-emerald-500/20 text-emerald-100",
            !isYou &&
              !isVoice &&
              "bg-white/[0.03] border border-white/[0.06] text-white/75",
          )}
        >
          {message.text}
        </div>
        {message.meta && (
          <div className="text-[10px] text-white/30 px-1">{message.meta}</div>
        )}
      </div>
    </div>
  );
}
