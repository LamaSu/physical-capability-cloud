// ---------------------------------------------------------------------------
// Agent Chat Types
// ---------------------------------------------------------------------------

export type ChatRole = "user" | "assistant" | "system";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  result: unknown;
  isError?: boolean;
}

export type UICardType =
  | "capability_card"
  | "capability_grid"
  | "kernel_card"
  | "contract_summary"
  | "milestone_timeline"
  | "evidence_timeline"
  | "price_breakdown"
  | "job_progress"
  | "escrow_summary"
  | "wallet_connect"
  | "sensor_chart"
  | "depin_stats";

export interface UICard {
  type: UICardType;
  data: Record<string, unknown>;
}

export interface SuggestedAction {
  label: string;
  message: string;
}

export interface AgentMessage {
  id: string;
  role: ChatRole;
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  cards?: UICard[];
  suggestedActions?: SuggestedAction[];
  timestamp: number;
}

export type ChatState = "idle" | "sending" | "tool_executing" | "streaming";

export interface ConversationSummary {
  role: string;
  userType: "requester" | "operator" | null;
  topicsSoFar: string[];
}
