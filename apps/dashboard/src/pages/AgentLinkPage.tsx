import React, { useState, useEffect, useCallback } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";

const API_BASE = "https://capability.network";

type AgentPackage = {
  schema: string;
  name: string;
  description: string;
  version: string;
  api_base: string;
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
  const capability = params.get("q") || "";

  const [copied, setCopied] = useState<string | null>(null);
  const [mousePos, setMousePos] = useState({ x: 50, y: 50 });
  const [pkg, setPkg] = useState<AgentPackage | null>(null);
  const [activeTab, setActiveTab] = useState<"package" | "claude" | "openai">("package");

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

  useEffect(() => {
    fetch("/agent-package.json")
      .then((r) => r.json())
      .then((data: AgentPackage) => setPkg(data))
      .catch(() => {});
  }, []);

  // The package IS the thing you hand to your agent — complete, self-onboarding.
  // The agent provisions its own key by calling provision_api_key first.
  const buildFullPackage = useCallback(() => {
    if (!pkg) return "";
    return JSON.stringify(pkg, null, 2);
  }, [pkg]);

  const buildClaudeQuickstart = useCallback(() => {
    return `// PCC Agent — hand this + agent-package.json to Claude
// npm install @anthropic-ai/sdk && node pcc-agent.js

const Anthropic = require("@anthropic-ai/sdk");
const pkg = require("./agent-package.json");

const PCC_BASE = pkg.api_base;
let PCC_API_KEY = null; // Agent provisions this itself

const client = new Anthropic();
const tools = pkg.tools.map((t) => ({
  name: t.name, description: t.description, input_schema: t.input_schema,
}));

async function callPCC(toolName, input) {
  const tool = pkg.tools.find((t) => t.name === toolName);
  if (!tool) throw new Error(\`Unknown tool: \${toolName}\`);

  let path = tool.endpoint.path;
  for (const [key, val] of Object.entries(input)) {
    path = path.replace(\`{\${key}}\`, String(val));
  }

  const headers = { "Content-Type": "application/json" };
  if (PCC_API_KEY) headers["Authorization"] = \`Bearer \${PCC_API_KEY}\`;

  const res = await fetch(\`\${PCC_BASE}\${path}\`, {
    method: tool.endpoint.method,
    headers,
    body: tool.endpoint.method === "POST" ? JSON.stringify(input) : undefined,
  });

  const data = await res.json();

  // Auto-capture the API key when provision_api_key is called
  if (toolName === "provision_api_key" && data.api_key) {
    PCC_API_KEY = data.api_key;
    console.log("API key provisioned — all subsequent calls are authenticated.");
  }

  return data;
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

    const toolCalls = response.content.filter((b) => b.type === "tool_use");
    if (toolCalls.length === 0) {
      const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      console.log(text);
      return text;
    }

    messages.push({ role: "assistant", content: response.content });
    const results = [];
    for (const call of toolCalls) {
      const result = await callPCC(call.name, call.input);
      results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(result) });
    }
    messages.push({ role: "user", content: results });
  }
}

// The agent will provision its own key, then do whatever you ask
chat("${capability || "I have equipment to put on the network. Help me get set up."}");
`;
  }, [capability]);

  const buildOpenAIQuickstart = useCallback(() => {
    return `// PCC Agent — hand this + agent-package.json to GPT-4
// npm install openai && node pcc-agent-openai.js

const OpenAI = require("openai");
const pkg = require("./agent-package.json");

const PCC_BASE = pkg.api_base;
let PCC_API_KEY = null; // Agent provisions this itself

const client = new OpenAI();
const tools = pkg.tools.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

async function callPCC(toolName, args) {
  const tool = pkg.tools.find((t) => t.name === toolName);
  if (!tool) throw new Error(\`Unknown tool: \${toolName}\`);

  let path = tool.endpoint.path;
  const input = JSON.parse(args);
  for (const [key, val] of Object.entries(input)) {
    path = path.replace(\`{\${key}}\`, String(val));
  }

  const headers = { "Content-Type": "application/json" };
  if (PCC_API_KEY) headers["Authorization"] = \`Bearer \${PCC_API_KEY}\`;

  const res = await fetch(\`\${PCC_BASE}\${path}\`, {
    method: tool.endpoint.method,
    headers,
    body: tool.endpoint.method === "POST" ? args : undefined,
  });

  const data = await res.json();
  if (toolName === "provision_api_key" && data.api_key) {
    PCC_API_KEY = data.api_key;
    console.log("API key provisioned.");
  }
  return JSON.stringify(data);
}

async function chat(userMessage) {
  let messages = [
    { role: "system", content: pkg.system_prompt },
    { role: "user", content: userMessage },
  ];

  while (true) {
    const response = await client.chat.completions.create({ model: "gpt-4o", tools, messages });
    const choice = response.choices[0];

    if (choice.finish_reason === "stop") {
      console.log(choice.message.content);
      return choice.message.content;
    }

    if (choice.message.tool_calls) {
      messages.push(choice.message);
      for (const call of choice.message.tool_calls) {
        const result = await callPCC(call.function.name, call.function.arguments);
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
  }
}

chat("${capability || "I have equipment to put on the network. Help me get set up."}");
`;
  }, [capability]);

  const getActiveContent = () => {
    switch (activeTab) {
      case "claude": return buildClaudeQuickstart();
      case "openai": return buildOpenAIQuickstart();
      default: return buildFullPackage();
    }
  };

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(label);
    setTimeout(() => setCopied(null), 3000);
  };

  const handleCopy = () => copyText(getActiveContent(), activeTab);

  const handleDownload = () => {
    const content = getActiveContent();
    const fname = activeTab === "package" ? "agent-package.json"
      : activeTab === "claude" ? "pcc-agent.js" : "pcc-agent-openai.js";
    const mime = activeTab === "package" ? "application/json" : "text/javascript";
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fname;
    a.click();
    URL.revokeObjectURL(url);
  };

  const toolCount = pkg?.tools?.length ?? 0;
  const fontGS = { fontFamily: "'Space Grotesk', sans-serif" } as const;

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
        <div className="max-w-3xl w-full mx-auto space-y-10">

          {/* Header */}
          <div className="text-center space-y-4">
            <h1 className="text-[13px] tracking-[0.35em] uppercase font-medium" style={{ color: "#7B7B9A", ...fontGS }}>
              capability.network
            </h1>
            {capability && (
              <p className="text-2xl font-semibold" style={{ color: "#E8E8F0", ...fontGS }}>
                {capability}
              </p>
            )}
            <p className="text-sm leading-relaxed max-w-lg mx-auto" style={{ color: "#7B7B9A" }}>
              {pkg
                ? `Hand this to your agent. ${toolCount} tools, self-provisioning, live network access. It handles everything.`
                : "Loading..."}
            </p>
          </div>

          {/* How it works */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              { num: "01", title: "Copy this package", desc: "Give it to any LLM with tool-use — Claude, GPT-4, your own agent. It's one file.", accent: "#D8A01B" },
              { num: "02", title: "Agent provisions itself", desc: "Its first call is provision_api_key — gets its own key from the network. No signup needed from you.", accent: "#00D4D4" },
              { num: "03", title: "It runs your business", desc: "Discovers jobs, registers your machines, negotiates contracts, collects proof, gets you paid via escrow.", accent: "#B57BDB" },
            ].map((step) => (
              <div key={step.num} className="rounded-xl p-5 border" style={{ background: "#0A0A1A", borderColor: "rgba(255,255,255,0.06)" }}>
                <div className="text-xs font-mono font-bold mb-2" style={{ color: step.accent, opacity: 0.6 }}>{step.num}</div>
                <div className="text-sm font-semibold mb-1" style={{ color: "#E8E8F0", ...fontGS }}>{step.title}</div>
                <div className="text-xs leading-relaxed" style={{ color: "#7B7B9A" }}>{step.desc}</div>
              </div>
            ))}
          </div>

          {/* Tab bar */}
          <div className="flex gap-1 rounded-xl p-1" style={{ background: "#0A0A1A" }}>
            {([
              { id: "package" as const, label: `Full Package (${toolCount} tools)` },
              { id: "claude" as const, label: "Claude Quickstart" },
              { id: "openai" as const, label: "OpenAI Quickstart" },
            ]).map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className="flex-1 py-2.5 px-3 rounded-lg text-xs font-medium transition-all duration-200"
                style={{
                  background: activeTab === tab.id ? "#1A1A2E" : "transparent",
                  color: activeTab === tab.id ? "#E8E8F0" : "#7B7B9A",
                  ...fontGS,
                  border: activeTab === tab.id ? "1px solid rgba(255,255,255,0.08)" : "1px solid transparent",
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Code preview */}
          <div className="rounded-2xl p-[1px]" style={{ background: "linear-gradient(135deg, #D8A01B33, #26619C33, #B57BDB33, #D8A01B33)" }}>
            <div className="rounded-2xl overflow-auto" style={{ background: "#0A0A1A", maxHeight: "420px" }}>
              <div
                className="sticky top-0 flex items-center justify-between px-5 py-3 border-b"
                style={{ background: "#0A0A1Aee", backdropFilter: "blur(8px)", borderColor: "rgba(255,255,255,0.06)" }}
              >
                <span className="text-xs font-mono" style={{ color: "#7B7B9A" }}>
                  {activeTab === "package" ? "agent-package.json" : activeTab === "claude" ? "pcc-agent.js" : "pcc-agent-openai.js"}
                </span>
                <span className="text-xs" style={{ color: "#00D4D4", opacity: 0.7 }}>
                  self-provisioning
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
                background: copied === activeTab
                  ? "linear-gradient(135deg, #00D4D4, #26619C)"
                  : "linear-gradient(135deg, #D8A01B, #B57BDB)",
                color: "#030308", ...fontGS,
                boxShadow: copied === activeTab ? "0 0 30px rgba(0,212,212,0.2)" : "0 0 30px rgba(216,160,27,0.2)",
              }}
            >
              {copied === activeTab ? "Copied" : "Copy to clipboard"}
            </button>
            <button
              onClick={handleDownload}
              className="py-4 px-6 rounded-2xl font-semibold text-base transition-all duration-300 border"
              style={{ background: "transparent", color: "#E8E8F0", ...fontGS, borderColor: "rgba(255,255,255,0.12)" }}
            >
              Download
            </button>
          </div>

          {/* What's inside */}
          <div className="rounded-2xl p-6 border space-y-4" style={{ background: "#0A0A1A", borderColor: "rgba(255,255,255,0.06)" }}>
            <h3 className="text-sm font-semibold" style={{ color: "#E8E8F0", ...fontGS }}>What your agent gets</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[
                { label: "Self-provisioning", detail: "Agent calls provision_api_key itself — gets its own key from the network, no human signup" },
                { label: `${toolCount} live tools`, detail: "Discovery, contracts, jobs, escrow, evidence, logistics, marketplace, sensors, settlement — all hitting the real network" },
                { label: "7 setup tools", detail: "detect → generate-config → validate → register-device → test-job → status — full machine onboarding" },
                { label: "System prompt", detail: "Teaches the agent PCC concepts, the provisioning flow, and how to guide operators step by step" },
                { label: "A2A protocol", detail: "Agent-to-agent communication — your agent discovers, negotiates, and transacts with other agents" },
                { label: "Quickstart scripts", detail: "Working Node.js for Claude and OpenAI — auto-captures API key on first provision call" },
              ].map((item) => (
                <div key={item.label} className="space-y-1">
                  <div className="text-xs font-semibold" style={{ color: "#D8A01B" }}>{item.label}</div>
                  <div className="text-xs leading-relaxed" style={{ color: "#7B7B9A" }}>{item.detail}</div>
                </div>
              ))}
            </div>
          </div>

          {/* API Base */}
          <div className="rounded-xl px-5 py-3 flex items-center gap-3 border" style={{ background: "#0D1117", borderColor: "rgba(0,212,212,0.15)" }}>
            <div className="text-xs font-mono" style={{ color: "#00D4D4" }}>API</div>
            <div className="text-xs font-mono flex-1 select-all" style={{ color: "#7B7B9A" }}>{API_BASE}</div>
            <div className="text-xs" style={{ color: "#7B7B9A", opacity: 0.5 }}>live</div>
          </div>

          {/* Links */}
          <div className="flex flex-wrap items-center justify-center gap-6">
            <button onClick={() => navigate("/")} className="text-xs tracking-wide transition-colors duration-300"
              style={{ color: "#7B7B9A", background: "none", border: "none" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#D8A01B")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#7B7B9A")}
            >&larr; back</button>
            <a href="/whitepaper.md" target="_blank" rel="noopener noreferrer" className="text-xs tracking-wide transition-colors duration-300"
              style={{ color: "#7B7B9A" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#B57BDB")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#7B7B9A")}
            >Whitepaper</a>
            <a href="https://github.com/global-mysterysnailrevolution/physical-capability-cloud" target="_blank" rel="noopener noreferrer" className="text-xs tracking-wide transition-colors duration-300"
              style={{ color: "#7B7B9A" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#00D4D4")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#7B7B9A")}
            >GitHub</a>
            <button onClick={() => navigate("/feedback")} className="text-xs tracking-wide transition-colors duration-300"
              style={{ color: "#7B7B9A", background: "none", border: "none" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#E89AC7")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#7B7B9A")}
            >Feedback</button>
          </div>
        </div>
      </div>
    </div>
  );
}
