import React, { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useUIStore } from "../stores/ui-store.js";
import { useChatStore } from "../stores/chat-store.js";
import { sendAgentMessage, executeToolCall } from "../agent/agent-client.js";
import { extractCards } from "../agent/card-registry.js";
import { ChatMessageList } from "../components/chat/ChatMessageList.js";
import { ChatInput } from "../components/chat/ChatInput.js";
import { useAgentSSE } from "../hooks/use-agent-sse.js";
import type { AgentMessage, ToolCall, SuggestedAction } from "../agent/agent-types.js";

export function AgentChatPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const { messages, chatState, streamingText, addMessage, updateMessage, appendStreamingText, clearStreamingText, setChatState } = useChatStore();

  React.useEffect(() => {
    setPageMeta("PCC Agent", "AI-powered interface");
  }, [setPageMeta]);

  // Inject SSE events as system messages
  useAgentSSE(true);

  const handleSend = useCallback(async (text: string) => {
    // Add user message
    addMessage({ role: "user", content: text });
    setChatState("sending");
    clearStreamingText();

    // Build full message list including the new user message
    const allMessages = [...useChatStore.getState().messages];

    let assistantId = "";
    let collectedText = "";
    const collectedToolCalls: ToolCall[] = [];

    await sendAgentMessage(allMessages, {
      onText: (delta) => {
        if (!assistantId) {
          setChatState("streaming");
        }
        collectedText += delta;
        appendStreamingText(delta);
      },

      onToolCall: async (toolCall) => {
        collectedToolCalls.push(toolCall);

        // Finalize the assistant message with text so far + tool calls
        clearStreamingText();
        if (!assistantId) {
          assistantId = addMessage({
            role: "assistant",
            content: collectedText,
            toolCalls: [toolCall],
          });
        } else {
          updateMessage(assistantId, {
            content: collectedText,
            toolCalls: collectedToolCalls,
          });
        }

        // Execute the tool
        setChatState("tool_executing");
        const result = await executeToolCall(
          toolCall,
          (path) => {
            navigate(path);
            // Switch to dashboard mode for navigation
            useUIStore.getState().setMode("dashboard");
          },
          { connected: false }, // TODO: wire to actual wallet state
        );

        // Extract cards from the result
        const cards = extractCards(toolCall.name, result);

        // Add tool result as a message (for context) and render cards
        addMessage({
          role: "assistant",
          content: "",
          toolResults: [{ toolCallId: toolCall.id, name: toolCall.name, result }],
          cards,
        });

        // Continue the conversation with tool results
        const updatedMessages = useChatStore.getState().messages;
        collectedText = "";
        assistantId = "";

        await sendAgentMessage(updatedMessages, {
          onText: (delta) => {
            setChatState("streaming");
            collectedText += delta;
            appendStreamingText(delta);
          },
          onToolCall: () => {
            // Nested tool calls — for simplicity, just log
            console.warn("Nested tool call — not yet supported in single-turn");
          },
          onDone: () => {
            // Handled below
          },
          onError: (err) => {
            clearStreamingText();
            addMessage({ role: "system", content: `Error: ${err}` });
            setChatState("idle");
          },
        });

        // Finalize after tool result follow-up
        clearStreamingText();
        if (collectedText) {
          addMessage({
            role: "assistant",
            content: collectedText,
            suggestedActions: inferSuggestedActions(collectedText),
          });
        }
        setChatState("idle");
      },

      onDone: () => {
        clearStreamingText();
        if (collectedText && collectedToolCalls.length === 0) {
          addMessage({
            role: "assistant",
            content: collectedText,
            suggestedActions: inferSuggestedActions(collectedText),
          });
        }
        setChatState("idle");
      },

      onError: (err) => {
        clearStreamingText();
        addMessage({ role: "system", content: `Error: ${err}` });
        setChatState("idle");
      },
    });
  }, [addMessage, updateMessage, appendStreamingText, clearStreamingText, setChatState, navigate]);

  return (
    <div className="flex flex-col h-full">
      <ChatMessageList
        messages={messages}
        streamingText={streamingText}
        chatState={chatState}
        onQuickAction={handleSend}
      />
      <ChatInput
        onSend={handleSend}
        disabled={chatState !== "idle"}
        placeholder={chatState === "idle" ? "Ask PCC anything..." : "Thinking..."}
      />
    </div>
  );
}

/** Simple heuristic to suggest next actions based on response content */
function inferSuggestedActions(text: string): SuggestedAction[] {
  const actions: SuggestedAction[] = [];
  const lower = text.toLowerCase();

  if (lower.includes("capability") || lower.includes("available")) {
    actions.push({ label: "Build a contract", message: "Help me build a contract for this capability" });
  }
  if (lower.includes("contract") || lower.includes("price")) {
    actions.push({ label: "Submit workflow", message: "Submit this as a workflow" });
  }
  if (lower.includes("job") || lower.includes("submitted")) {
    actions.push({ label: "Check job status", message: "Show me the status of my active jobs" });
  }
  if (lower.includes("kernel")) {
    actions.push({ label: "View capabilities", message: "What capabilities does this kernel offer?" });
  }

  // Always offer these
  if (actions.length === 0) {
    actions.push(
      { label: "Search capabilities", message: "What capabilities are available?" },
      { label: "My jobs", message: "Show my active jobs" },
    );
  }

  return actions.slice(0, 4);
}
