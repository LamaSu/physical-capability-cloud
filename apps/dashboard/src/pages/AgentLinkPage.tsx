import React, { useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";

// The live gateway — all tool endpoints resolve relative to this
const API_BASE = "https://pcc-gateway-production.up.railway.app";

type AgentPackage = {
  schema: string;
  name: string;
  description: string;
  version: string;
  homepage: string;
  system_prompt: string;
  tools: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
    endpoint: { method: string; path: string };
  }>;
  quickstart: { claude: string; openai: string };
};

export function AgentLinkPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [copied, setCopied] = useState<"package" | "claude" | "openai" | null>(null);
  const [mousePos, setMousePos] = useState({ x: 50, y: 50 });
  const [pkg, setPkg] = useState<AgentPackage | null>(null);
  const [activeTab, setActiveTab] = useState<"package" | "claude" | "openai">("package");
  const capability = params.get("q") || "";

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      setMousePos({
        x: (e.clientX / window.innerWidth) * 100,
        y: (e.clientY / window.innerHeight) * 100,
      });
    };
    window.addEventListener("mousemove", handler);
    return () => window.removeEventListener("mousemove", handler);
  }, []);

  // Fetch the real agent package
  useEffect(() => {
    fetch("/agent-package.json")
      .then((r) => r.json())
      .then((data: AgentPackage) => setPkg(data))
      .catch(() => {
        // fallback: minimal package if fetch fails
      });
  }, []);

  // Build the complete onboarding package
  const buildFullPackage = useCallback(() => {
    if (!pkg) return "";
    const onboardingPackage = {
      ...pkg,
      // Inject live API base so every endpoint is resolvable
      api_base: API_BASE,
      // What the operator said they do
      operator: {
        capability_description: capability || "(not specified — update this)",
        registered: false,
        setup_url: `${API_BASE}/api/setup/status`,
      },
      // Add setup tools to the package (these exist in the gateway but weren't in the original 73)
      setup: {
        description:
          "Use these endpoints to fully onboard. Call them in order: detect → generate-config → validate → register-device → test-job → status",
        endpoints: {
          detect: {
            method: "GET",
            path: "/api/setup/detect",
            description: "Auto-detect current config state (env vars, DB, adapters, chain, storage)",
          },
          generate_config: {
            method: "POST",
            path: "/api/setup/generate-config",
            description: "Generate KERNEL_CONFIG JSON from device descriptions",
          },
          validate: {
            method: "POST",
            path: "/api/setup/validate",
            description: "Validate a kernel config (20+ checks)",
          },
          register_device: {
            method: "POST",
            path: "/api/setup/register-device",
            description: "Register a device with adapter config and capabilities",
          },
          test_job: {
            method: "POST",
            path: "/api/setup/test-job",
            description: "Submit a test job to verify the full pipeline end-to-end",
          },
          status: {
            method: "GET",
            path: "/api/setup/status",
            description: "Comprehensive setup status across 6 categories",
          },
        },
      },
      // Onboarding shortcuts
      onboarding: {
        register_machine: {
          method: "POST",
          path: "/api/onboard/register",
          description: "Register a new machine with name, category, manufacturer, model, capabilities",
        },
        analyze_docs: {
          method: "POST",
          path: "/api/onboard/analyze",
          description: "Upload machine docs — AI extracts capabilities, specs, materials, tolerances",
        },
        redeem_invite: {
          method: "POST",
          path: "/api/onboard/redeem",
          description: "One-click onboarding with invite code: provisions wallet, identity, LLM access, PCC tools",
        },
        check_invite: {
          method: "GET",
          path: "/api/onboard/check/{code}",
          description: "Validate an invite code before redeeming",
        },
      },
      // Agent-to-Agent protocol info
      a2a: {
        description:
          "Agents communicate via typed intents over the A2A message bus. Your agent can discover, negotiate, and transact with other agents on the network.",
        setup_intents: [
          "setup_detect",
          "setup_detect_result",
          "setup_configure",
          "setup_configure_result",
          "setup_validate",
          "setup_validate_result",
        ],
        core_intents: [
          "discover_capabilities",
          "request_quote",
          "build_contract",
          "submit_workflow",
          "payment_request",
        ],
      },
      // Quick-start guide
      guide: {
        step_1:
          "Copy this entire JSON and give it to your AI agent (Claude, GPT-4, or any LLM with tool-use support)",
        step_2: `Your agent reads the system_prompt to understand PCC, and the tools array to know what it can call`,
        step_3: `All tool endpoints resolve against api_base: ${API_BASE}. For example, GET ${API_BASE}/api/capabilities/types`,
        step_4:
          "To register your machine: call onboard.register_machine with your device details, or use setup.endpoints in order",
        step_5:
          "Once registered, your machine appears on the network. Other agents can discover it, send jobs, and pay via escrow.",
        step_6:
          "For on-chain settlement: configure a wallet, deploy escrow contracts, and register an ERC-8004 identity",
      },
    };
    return JSON.stringify(onboardingPackage, null, 2);
  }, [pkg, capability]);

  const buildClaudeQuickstart = useCallback(() => {
    return `// PCC Agent — Claude quickstart
// 1. npm install @anthropic-ai/sdk
// 2. Set ANTHROPIC_API_KEY in your environment
// 3. Save agent-package.json next to this file
// 4. Run: node pcc-agent.js

const Anthropic = require("@anthropic-ai/sdk");
const pkg = require("./agent-package.json");

const PCC_BASE = "${API_BASE}";
const client = new Anthropic();

// Convert PCC tools to Claude tool format
const tools = pkg.tools.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema,
}));

async function callPCCTool(toolName, input) {
  const tool = pkg.tools.find((t) => t.name === toolName);
  if (!tool) throw new Error(\`Unknown tool: \${toolName}\`);

  let path = tool.endpoint.path;
  // Replace path params like {jobId} with input values
  for (const [key, val] of Object.entries(input)) {
    path = path.replace(\`{\${key}}\`, String(val));
  }

  const url = \`\${PCC_BASE}\${path}\`;
  const res = await fetch(url, {
    method: tool.endpoint.method,
    headers: { "Content-Type": "application/json" },
    body: tool.endpoint.method === "POST" ? JSON.stringify(input) : undefined,
  });
  return res.json();
}

async function chat(userMessage) {
  let messages = [{ role: "user", content: userMessage }];

  while (true) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: pkg.system_prompt,
      tools,
      messages,
    });

    // Collect text and tool calls
    const toolCalls = response.content.filter((b) => b.type === "tool_use");
    if (toolCalls.length === 0) {
      // No more tool calls — print final text
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      console.log(text);
      return text;
    }

    // Execute each tool call
    messages.push({ role: "assistant", content: response.content });
    const results = [];
    for (const call of toolCalls) {
      const result = await callPCCTool(call.name, call.input);
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: "user", content: results });
  }
}

// Example: discover what's available
chat("${capability ? `I have ${capability}. Register it on the network and find matching jobs.` : "What capabilities are available on the network? Show me the marketplace."}");
`;
  }, [capability]);

  const buildOpenAIQuickstart = useCallback(() => {
    return `// PCC Agent — OpenAI quickstart
// 1. npm install openai
// 2. Set OPENAI_API_KEY in your environment
// 3. Save agent-package.json next to this file
// 4. Run: node pcc-agent-openai.js

const OpenAI = require("openai");
const pkg = require("./agent-package.json");

const PCC_BASE = "${API_BASE}";
const client = new OpenAI();

// Convert PCC tools to OpenAI function format
const tools = pkg.tools.map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  },
}));

async function callPCCTool(toolName, args) {
  const tool = pkg.tools.find((t) => t.name === toolName);
  if (!tool) throw new Error(\`Unknown tool: \${toolName}\`);

  let path = tool.endpoint.path;
  const input = JSON.parse(args);
  for (const [key, val] of Object.entries(input)) {
    path = path.replace(\`{\${key}}\`, String(val));
  }

  const url = \`\${PCC_BASE}\${path}\`;
  const res = await fetch(url, {
    method: tool.endpoint.method,
    headers: { "Content-Type": "application/json" },
    body: tool.endpoint.method === "POST" ? args : undefined,
  });
  return JSON.stringify(await res.json());
}

async function chat(userMessage) {
  let messages = [
    { role: "system", content: pkg.system_prompt },
    { role: "user", content: userMessage },
  ];

  while (true) {
    const response = await client.chat.completions.create({
      model: "gpt-4o",
      tools,
      messages,
    });

    const choice = response.choices[0];
    if (choice.finish_reason === "stop") {
      console.log(choice.message.content);
      return choice.message.content;
    }

    if (choice.message.tool_calls) {
      messages.push(choice.message);
      for (const call of choice.message.tool_calls) {
        const result = await callPCCTool(call.function.name, call.function.arguments);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result,
        });
      }
    }
  }
}

chat("${capability ? `I have ${capability}. Register it on the network and find matching jobs.` : "What capabilities are available on the network? Show me the marketplace."}");
`;
  }, [capability]);

  const getActiveContent = () => {
    switch (activeTab) {
      case "claude":
        return buildClaudeQuickstart();
      case "openai":
        return buildOpenAIQuickstart();
      default:
        return buildFullPackage();
    }
  };

  const handleCopy = async () => {
    const content = getActiveContent();
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = content;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(activeTab);
    setTimeout(() => setCopied(null), 3000);
  };

  const handleDownload = () => {
    const content = getActiveContent();
    const ext = activeTab === "package" ? "json" : "js";
    const name =
      activeTab === "package"
        ? "agent-package.json"
        : activeTab === "claude"
          ? "pcc-agent.js"
          : "pcc-agent-openai.js";
    const blob = new Blob([content], { type: ext === "json" ? "application/json" : "text/javascript" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const toolCount = pkg?.tools?.length ?? 0;

  const STEPS = [
    {
      num: "01",
      title: "Copy or download",
      desc: "Get the full agent package — 73 tools, system prompt, setup endpoints, quickstart code.",
      accent: "#D8A01B",
    },
    {
      num: "02",
      title: "Give it to your agent",
      desc: "Claude, GPT-4, or any LLM with tool-use. The system_prompt teaches it PCC. The tools array gives it hands.",
      accent: "#B57BDB",
    },
    {
      num: "03",
      title: "Your agent onboards you",
      desc: "It calls setup/detect, registers your machine, runs a test job, and connects you to the network. You just confirm.",
      accent: "#00D4D4",
    },
  ];

  return (
    <div className="relative min-h-screen overflow-x-hidden" style={{ background: "#030308" }}>
      {/* Holographic background */}
      <div
        className="fixed inset-0 pointer-events-none z-0"
        style={{
          background: `
            radial-gradient(ellipse 50% 40% at ${30 + (mousePos.x - 50) * 0.08}% ${20 + (mousePos.y - 50) * 0.06}%, rgba(38,97,156,0.12) 0%, transparent 70%),
            radial-gradient(ellipse 40% 50% at ${70 + (mousePos.x - 50) * 0.06}% ${80 + (mousePos.y - 50) * 0.04}%, rgba(181,123,219,0.10) 0%, transparent 70%),
            radial-gradient(ellipse 30% 30% at ${50 + (mousePos.x - 50) * 0.03}% ${50 + (mousePos.y - 50) * 0.03}%, rgba(216,160,27,0.06) 0%, transparent 60%),
            #030308
          `,
        }}
      />

      <div className="relative z-10 min-h-screen flex flex-col items-center px-6 py-16">
        <div className="max-w-3xl w-full mx-auto space-y-12">
          {/* Header */}
          <div className="text-center space-y-4">
            <h1
              className="text-[13px] tracking-[0.35em] uppercase font-medium"
              style={{ color: "#7B7B9A", fontFamily: "'Space Grotesk', sans-serif" }}
            >
              capability.network
            </h1>

            {capability && (
              <p
                className="text-2xl font-semibold"
                style={{ color: "#E8E8F0", fontFamily: "'Space Grotesk', sans-serif" }}
              >
                {capability}
              </p>
            )}

            <p className="text-sm leading-relaxed max-w-lg mx-auto" style={{ color: "#7B7B9A" }}>
              {pkg
                ? `Your complete onboarding package: ${toolCount} tools, setup endpoints, quickstart code, and everything your agent needs to register your machine on the Physical Capability Cloud.`
                : "Loading agent package..."}
            </p>
          </div>

          {/* How it works — 3 steps */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {STEPS.map((step) => (
              <div
                key={step.num}
                className="rounded-xl p-5 border"
                style={{ background: "#0A0A1A", borderColor: "rgba(255,255,255,0.06)" }}
              >
                <div
                  className="text-xs font-mono font-bold mb-2"
                  style={{ color: step.accent, opacity: 0.6 }}
                >
                  {step.num}
                </div>
                <div
                  className="text-sm font-semibold mb-1"
                  style={{ color: "#E8E8F0", fontFamily: "'Space Grotesk', sans-serif" }}
                >
                  {step.title}
                </div>
                <div className="text-xs leading-relaxed" style={{ color: "#7B7B9A" }}>
                  {step.desc}
                </div>
              </div>
            ))}
          </div>

          {/* Tab bar */}
          <div className="flex gap-1 rounded-xl p-1" style={{ background: "#0A0A1A" }}>
            {(
              [
                { id: "package" as const, label: `Full Package (${toolCount} tools)` },
                { id: "claude" as const, label: "Claude Quickstart" },
                { id: "openai" as const, label: "OpenAI Quickstart" },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className="flex-1 py-2.5 px-3 rounded-lg text-xs font-medium transition-all duration-200"
                style={{
                  background: activeTab === tab.id ? "#1A1A2E" : "transparent",
                  color: activeTab === tab.id ? "#E8E8F0" : "#7B7B9A",
                  fontFamily: "'Space Grotesk', sans-serif",
                  border: activeTab === tab.id ? "1px solid rgba(255,255,255,0.08)" : "1px solid transparent",
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Code preview */}
          <div
            className="rounded-2xl p-[1px]"
            style={{
              background: "linear-gradient(135deg, #D8A01B33, #26619C33, #B57BDB33, #D8A01B33)",
            }}
          >
            <div className="rounded-2xl overflow-auto" style={{ background: "#0A0A1A", maxHeight: "400px" }}>
              {/* File header */}
              <div
                className="sticky top-0 flex items-center justify-between px-5 py-3 border-b"
                style={{
                  background: "#0A0A1Aee",
                  backdropFilter: "blur(8px)",
                  borderColor: "rgba(255,255,255,0.06)",
                }}
              >
                <span className="text-xs font-mono" style={{ color: "#7B7B9A" }}>
                  {activeTab === "package"
                    ? "agent-package.json"
                    : activeTab === "claude"
                      ? "pcc-agent.js"
                      : "pcc-agent-openai.js"}
                </span>
                <span className="text-xs" style={{ color: "#7B7B9A", opacity: 0.5 }}>
                  {activeTab === "package"
                    ? `${toolCount} tools + setup + onboarding + a2a`
                    : "ready to run"}
                </span>
              </div>
              <pre
                className="text-xs leading-relaxed whitespace-pre-wrap break-all p-5"
                style={{ color: "#7B7B9A", fontFamily: "'JetBrains Mono', monospace" }}
              >
                {getActiveContent() || "Loading..."}
              </pre>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex gap-3">
            <button
              onClick={handleCopy}
              className="flex-1 py-4 rounded-2xl font-semibold text-base transition-all duration-300"
              style={{
                background:
                  copied === activeTab
                    ? "linear-gradient(135deg, #00D4D4, #26619C)"
                    : "linear-gradient(135deg, #D8A01B, #B57BDB)",
                color: "#030308",
                fontFamily: "'Space Grotesk', sans-serif",
                boxShadow:
                  copied === activeTab
                    ? "0 0 30px rgba(0,212,212,0.2)"
                    : "0 0 30px rgba(216,160,27,0.2)",
              }}
            >
              {copied === activeTab ? "Copied to clipboard" : "Copy to clipboard"}
            </button>
            <button
              onClick={handleDownload}
              className="py-4 px-6 rounded-2xl font-semibold text-base transition-all duration-300 border"
              style={{
                background: "transparent",
                color: "#E8E8F0",
                fontFamily: "'Space Grotesk', sans-serif",
                borderColor: "rgba(255,255,255,0.12)",
              }}
            >
              Download
            </button>
          </div>

          {/* What's inside breakdown */}
          <div
            className="rounded-2xl p-6 border space-y-4"
            style={{ background: "#0A0A1A", borderColor: "rgba(255,255,255,0.06)" }}
          >
            <h3
              className="text-sm font-semibold"
              style={{ color: "#E8E8F0", fontFamily: "'Space Grotesk', sans-serif" }}
            >
              What's inside the package
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[
                {
                  label: "System Prompt",
                  detail: "Teaches your agent what PCC is, how capabilities work, and how to guide operators",
                },
                {
                  label: `${toolCount} API Tools`,
                  detail:
                    "Discovery, contracts, jobs, escrow, evidence, logistics, marketplace, sensors, settlement",
                },
                {
                  label: "6 Setup Endpoints",
                  detail: "detect → generate-config → validate → register-device → test-job → status",
                },
                {
                  label: "4 Onboarding Endpoints",
                  detail: "Register machine, analyze docs (AI), redeem invite, check invite code",
                },
                {
                  label: "A2A Protocol",
                  detail: "Agent-to-agent intents for discovery, negotiation, contracts, and payments",
                },
                {
                  label: "Quickstart Code",
                  detail: "Copy-paste Node.js scripts for Claude SDK and OpenAI SDK with tool-use loops",
                },
              ].map((item) => (
                <div key={item.label} className="space-y-1">
                  <div className="text-xs font-semibold" style={{ color: "#D8A01B" }}>
                    {item.label}
                  </div>
                  <div className="text-xs leading-relaxed" style={{ color: "#7B7B9A" }}>
                    {item.detail}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* API Base URL callout */}
          <div
            className="rounded-xl px-5 py-3 flex items-center gap-3 border"
            style={{ background: "#0D1117", borderColor: "rgba(0,212,212,0.15)" }}
          >
            <div className="text-xs font-mono" style={{ color: "#00D4D4" }}>
              API
            </div>
            <div className="text-xs font-mono flex-1 select-all" style={{ color: "#7B7B9A" }}>
              {API_BASE}
            </div>
            <div className="text-xs" style={{ color: "#7B7B9A", opacity: 0.5 }}>
              live
            </div>
          </div>

          {/* Links */}
          <div className="flex flex-wrap items-center justify-center gap-6">
            <button
              onClick={() => navigate("/")}
              className="text-xs tracking-wide transition-colors duration-300"
              style={{ color: "#7B7B9A", background: "none", border: "none" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#D8A01B")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#7B7B9A")}
            >
              &larr; back
            </button>
            <a
              href="/whitepaper.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs tracking-wide transition-colors duration-300"
              style={{ color: "#7B7B9A" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#B57BDB")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#7B7B9A")}
            >
              Whitepaper
            </a>
            <a
              href="https://github.com/wingdingspenpal/poop"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs tracking-wide transition-colors duration-300"
              style={{ color: "#7B7B9A" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#00D4D4")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#7B7B9A")}
            >
              GitHub
            </a>
            <button
              onClick={() => navigate("/feedback")}
              className="text-xs tracking-wide transition-colors duration-300"
              style={{ color: "#7B7B9A", background: "none", border: "none" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#E89AC7")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#7B7B9A")}
            >
              Feedback
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
