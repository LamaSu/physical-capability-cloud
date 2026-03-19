Generate or update the PCC Agent Chat interface — a conversational UI for interacting with PCC broker agents.

Pattern source: Virtuals Butler (chat + job dashboard + hire flow + Pro Mode)

## Component Spec

Generate a `AgentChatPanel` component enhancing the existing `/agents` page with:

- **Chat interface**: Message bubbles (user=right/green, agent=left/teal), timestamp, typing indicator
- **Inline job cards**: When agent finds capabilities, show CapabilityCard inline in chat
- **Quick actions bar**: "Find HPLC", "Check job status", "Show escrow", "Browse capabilities"
- **Job status cards**: Embedded progress cards when discussing active jobs
- **Pro Mode toggle**: Plan → Review → Execute workflow (like Virtuals Butler Pro)
  - Step 1: Agent researches and proposes a plan with suitable capabilities
  - Step 2: User reviews and can request modifications
  - Step 3: Agent executes autonomously, reports complete results
- **Hire flow**: "I want to hire this capability" → auto-initiated quote request

## Design
- Chat container: `flex flex-col h-[calc(100vh-200px)]` with scroll
- Messages: `max-w-[80%]`, rounded-xl, user=`bg-green-400/10 border-green-400/20`, agent=`bg-teal-400/10 border-teal-400/20`
- Input: Bottom-fixed, GlassPanel with textarea + send button
- Quick actions: Horizontal scroll pills below input
