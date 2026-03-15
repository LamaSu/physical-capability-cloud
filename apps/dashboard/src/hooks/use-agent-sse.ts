import { useEffect } from "react";
import { useChatStore } from "../stores/chat-store.js";
import { useSSEStream } from "./use-sse-stream.js";

/**
 * Injects relevant SSE events (job_progress, evidence, milestone) into the chat
 * as system messages so the user stays informed without leaving the conversation.
 */
export function useAgentSSE(enabled: boolean) {
  const addMessage = useChatStore((s) => s.addMessage);

  useSSEStream({
    url: "/sse/notifications",
    enabled,
    onEvent: (type, data) => {
      if (type === "job_progress") {
        const d = data as Record<string, unknown>;
        addMessage({
          role: "system",
          content: `Job **${d.jobId ?? "unknown"}** progress: ${d.progress ?? 0}% — ${d.status ?? "running"}`,
        });
      } else if (type === "evidence") {
        const d = data as Record<string, unknown>;
        addMessage({
          role: "system",
          content: `Evidence bundle submitted for job **${d.jobId ?? "unknown"}** (${d.type ?? "sensor"})`,
        });
      } else if (type === "milestone") {
        const d = data as Record<string, unknown>;
        addMessage({
          role: "system",
          content: `Milestone **${d.milestoneId ?? "unknown"}** reached for escrow ${d.escrowId ?? ""}`,
        });
      }
    },
  });
}
