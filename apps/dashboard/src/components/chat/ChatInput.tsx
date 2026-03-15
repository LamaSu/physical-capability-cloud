import React, { useState, useRef, useEffect } from "react";

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function ChatInput({ onSend, disabled, placeholder = "Ask PCC anything..." }: ChatInputProps) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleSubmit() {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  return (
    <div className="flex items-end gap-2 p-3 bg-black/20 border-t border-white/[0.06]">
      <textarea
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={placeholder}
        rows={1}
        className="flex-1 resize-none bg-white/[0.03] border border-white/[0.08] rounded-xl
          px-4 py-2.5 text-sm text-white/80 placeholder-white/25
          focus:outline-none focus:border-teal-500/30 focus:ring-1 focus:ring-teal-500/15
          disabled:opacity-40 transition-all"
        style={{ maxHeight: "120px" }}
        onInput={(e) => {
          const target = e.target as HTMLTextAreaElement;
          target.style.height = "auto";
          target.style.height = Math.min(target.scrollHeight, 120) + "px";
        }}
      />
      <button
        onClick={handleSubmit}
        disabled={disabled || !text.trim()}
        className="flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center
          bg-teal-500/15 border border-teal-500/20 text-teal-300
          hover:bg-teal-500/25 hover:text-teal-200
          disabled:opacity-30 disabled:cursor-not-allowed
          transition-all duration-200"
        aria-label="Send"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="22" y1="2" x2="11" y2="13" />
          <polygon points="22 2 15 22 11 13 2 9 22 2" />
        </svg>
      </button>
    </div>
  );
}
