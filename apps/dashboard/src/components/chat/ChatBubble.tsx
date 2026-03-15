import React from "react";
import { cn } from "@pcc/ui";
import type { AgentMessage } from "../../agent/agent-types.js";
import { UICardRenderer } from "./UICardRenderer.js";

interface ChatBubbleProps {
  message: AgentMessage;
}

export function ChatBubble({ message }: ChatBubbleProps) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  return (
    <div className={cn("flex gap-3 max-w-[85%]", isUser ? "ml-auto flex-row-reverse" : "mr-auto")}>
      {/* Avatar */}
      <div
        className={cn(
          "flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm border",
          isUser
            ? "bg-teal-500/15 border-teal-500/20"
            : isSystem
              ? "bg-amber-500/15 border-amber-500/20"
              : "bg-cyan-500/15 border-cyan-500/20",
        )}
      >
        {isUser ? "You" : isSystem ? "!" : "AI"}
      </div>

      <div className="flex flex-col gap-2 min-w-0">
        {/* Text bubble */}
        {message.content && (
          <div
            className={cn(
              "rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap",
              isUser
                ? "bg-teal-500/10 border border-teal-500/15 text-white/80"
                : isSystem
                  ? "bg-amber-500/8 border border-amber-500/12 text-amber-200/70 text-xs"
                  : "bg-white/[0.03] border border-white/[0.06] text-white/70",
            )}
          >
            {renderMarkdownLite(message.content)}
          </div>
        )}

        {/* Inline cards */}
        {message.cards && message.cards.length > 0 && (
          <div className="flex flex-col gap-2">
            {message.cards.map((card, i) => (
              <UICardRenderer key={i} card={card} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Minimal markdown: **bold** and `code` only */
function renderMarkdownLite(text: string): React.ReactNode {
  const parts = text.split(/(\*\*.*?\*\*|`.*?`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="text-white/90 font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={i} className="text-teal-400/80 bg-teal-500/8 rounded px-1.5 py-0.5 text-xs font-mono">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}
