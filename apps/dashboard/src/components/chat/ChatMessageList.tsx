import React, { useEffect, useRef } from "react";
import type { AgentMessage, ChatState } from "../../agent/agent-types.js";
import { ChatBubble } from "./ChatBubble.js";
import { QuickActions } from "./QuickActions.js";

interface ChatMessageListProps {
  messages: AgentMessage[];
  streamingText: string;
  chatState: ChatState;
  onQuickAction: (message: string) => void;
}

export function ChatMessageList({ messages, streamingText, chatState, onQuickAction }: ChatMessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  const lastMessage = messages[messages.length - 1];
  const showQuickActions =
    chatState === "idle" && lastMessage?.role === "assistant" && lastMessage.suggestedActions?.length;

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
      {messages.map((msg) => (
        <ChatBubble key={msg.id} message={msg} />
      ))}

      {/* Streaming indicator */}
      {streamingText && (
        <div className="flex gap-3 max-w-[85%] mr-auto">
          <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm border bg-cyan-500/15 border-cyan-500/20">
            AI
          </div>
          <div className="rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap bg-white/[0.03] border border-white/[0.06] text-white/70">
            {streamingText}
            <span className="inline-block w-1.5 h-4 bg-teal-400/60 ml-0.5 animate-pulse" />
          </div>
        </div>
      )}

      {/* Tool execution indicator */}
      {chatState === "tool_executing" && !streamingText && (
        <div className="flex gap-3 max-w-[85%] mr-auto">
          <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm border bg-cyan-500/15 border-cyan-500/20">
            AI
          </div>
          <div className="rounded-2xl px-3 py-2 text-xs bg-white/[0.02] border border-white/[0.05] text-white/40 flex items-center gap-2">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-teal-400/60 animate-pulse" />
            Querying PCC network...
          </div>
        </div>
      )}

      {/* Quick actions */}
      {showQuickActions && (
        <div className="pl-11">
          <QuickActions
            actions={lastMessage.suggestedActions!}
            onSelect={onQuickAction}
            disabled={chatState !== "idle"}
          />
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
