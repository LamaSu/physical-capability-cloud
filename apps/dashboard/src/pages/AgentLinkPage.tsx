import React, { useState, useEffect, useCallback } from "react";
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

type Phase = "register" | "provisioned";

export function AgentLinkPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const capability = params.get("q") || "";

  // Registration state
  const [phase, setPhase] = useState<Phase>("register");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [provisioning, setProvisioning] = useState(false);
  const [provisionError, setProvisionError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyId, setKeyId] = useState("");

  // Package state
  const [copied, setCopied] = useState<"package" | "claude" | "openai" | "key" | null>(null);
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

  // Fetch the real agent package
  useEffect(() => {
    fetch("/agent-package.json")
      .then((r) => r.json())
      .then((data: AgentPackage) => setPkg(data))
      .catch(() => {});
  }, []);

  // ── Provision API key ───────────────────────────────────────────
  const handleProvision = async (e: React.FormEvent) => {
    e.preventDefault();
    setProvisionError("");
    setProvisioning(true);

    try {
      const res = await fetch(`${API_BASE}/api/auth/provision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name: name || undefined, capability: capability || undefined }),
      });

      const data = await res.json();

      if (!res.ok) {
        setProvisionError(data.message || data.error || "Provisioning failed");
        return;
      }

      setApiKey(data.api_key);
      setKeyId(data.key_id);
      setPhase("provisioned");
    } catch {
      setProvisionError("Network error — is the gateway running?");
    } finally {
      setProvisioning(false);
    }
  };

  // ── Build outputs with API key embedded ─────────────────────────
  const buildFullPackage = useCallback(() => {
    if (!pkg || !apiKey) return "";
    const onboardingPackage = {
      ...pkg,
      api_base: API_BASE,
      auth: {
        api_key: apiKey,
        header: `Authorization: Bearer ${apiKey}`,
        warning: "This key is tied to your account. Do not share it publicly. You can revoke it at any time.",
        key_id: keyId,
        operator: email,
      },
      operator: {
        capability_description: capability || "(not specified — update this)",
        email,
        name: name || undefined,
        setup_url: `${API_BASE}/api/setup/status`,
      },
      setup: {
        description:
          "Use these endpoints to fully onboard. Call them in order: detect -> generate-config -> validate -> register-device -> test-job -> status. All require your API key.",
        endpoints: {
          detect: { method: "GET", path: "/api/setup/detect", description: "Auto-detect current config state" },
          generate_config: { method: "POST", path: "/api/setup/generate-config", description: "Generate KERNEL_CONFIG JSON from device descriptions" },
          validate: { method: "POST", path: "/api/setup/validate", description: "Validate a kernel config (20+ checks)" },
          register_device: { method: "POST", path: "/api/setup/register-device", description: "Register a device with adapter config and capabilities" },
          test_job: { method: "POST", path: "/api/setup/test-job", description: "Submit a test job to verify the full pipeline end-to-end" },
          status: { method: "GET", path: "/api/setup/status", description: "Comprehensive setup status across 6 categories" },
        },
      },
      onboarding: {
        register_machine: { method: "POST", path: "/api/onboard/register", description: "Register a new machine with name, category, manufacturer, model, capabilities" },
        analyze_docs: { method: "POST", path: "/api/onboard/analyze", description: "Upload machine docs — AI extracts capabilities, specs, materials, tolerances" },
        redeem_invite: { method: "POST", path: "/api/onboard/redeem", description: "One-click onboarding with invite code" },
        check_invite: { method: "GET", path: "/api/onboard/check/{code}", description: "Validate an invite code before redeeming" },
      },
      a2a: {
        description: "Agents communicate via typed intents over the A2A message bus.",
        setup_intents: ["setup_detect", "setup_detect_result", "setup_configure", "setup_configure_result", "setup_validate", "setup_validate_result"],
        core_intents: ["discover_capabilities", "request_quote", "build_contract", "submit_workflow", "payment_request"],
      },
      guide: {
        step_1: "Give this entire JSON to your AI agent (Claude, GPT-4, or any LLM with tool-use support)",
        step_2: "Your agent reads the system_prompt to understand PCC, and the tools array to know what it can call",
        step_3: `All requests must include the Authorization header: Bearer ${apiKey.slice(0, 20)}...`,
        step_4: "To register your machine: call onboard.register_machine with your device details",
        step_5: "Once registered, your machine appears on the network. Other agents can discover it and send jobs.",
        step_6: "For on-chain settlement: configure a wallet, deploy escrow contracts, and register an ERC-8004 identity",
      },
    };
    return JSON.stringify(onboardingPackage, null, 2);
  }, [pkg, capability, apiKey, keyId, email, name]);

  const buildClaudeQuickstart = useCallback(() => {
    return `// PCC Agent — Claude quickstart
// 1. npm install @anthropic-ai/sdk
// 2. Set ANTHROPIC_API_KEY in your environment
// 3. Save agent-package.json next to this file
// 4. Run: node pcc-agent.js

const Anthropic = require("@anthropic-ai/sdk");
const pkg = require("./agent-package.json");

const PCC_BASE = "${API_BASE}";
const PCC_API_KEY = pkg.auth.api_key; // Your provisioned API key
const client = new Anthropic();

const tools = pkg.tools.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema,
}));

async function callPCCTool(toolName, input) {
  const tool = pkg.tools.find((t) => t.name === toolName);
  if (!tool) throw new Error(\`Unknown tool: \${toolName}\`);

  let path = tool.endpoint.path;
  for (const [key, val] of Object.entries(input)) {
    path = path.replace(\`{\${key}}\`, String(val));
  }

  const url = \`\${PCC_BASE}\${path}\`;
  const res = await fetch(url, {
    method: tool.endpoint.method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": \`Bearer \${PCC_API_KEY}\`,
    },
    body: tool.endpoint.method === "POST" ? JSON.stringify(input) : undefined,
  });

  if (res.status === 401) throw new Error("API key invalid or revoked — provision a new one at capability.network");
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

    const toolCalls = response.content.filter((b) => b.type === "tool_use");
    if (toolCalls.length === 0) {
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      console.log(text);
      return text;
    }

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
const PCC_API_KEY = pkg.auth.api_key; // Your provisioned API key
const client = new OpenAI();

const tools = pkg.tools.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.input_schema },
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
    headers: {
      "Content-Type": "application/json",
      "Authorization": \`Bearer \${PCC_API_KEY}\`,
    },
    body: tool.endpoint.method === "POST" ? args : undefined,
  });

  if (res.status === 401) throw new Error("API key invalid or revoked — provision a new one at capability.network");
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
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
  }
}

chat("${capability ? `I have ${capability}. Register it on the network and find matching jobs.` : "What capabilities are available on the network? Show me the marketplace."}");
`;
  }, [capability]);

  const getActiveContent = () => {
    switch (activeTab) {
      case "claude": return buildClaudeQuickstart();
      case "openai": return buildOpenAIQuickstart();
      default: return buildFullPackage();
    }
  };

  const copyText = async (text: string, label: typeof copied) => {
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

  const handleCopyKey = () => copyText(apiKey, "key");

  const handleDownload = () => {
    const content = getActiveContent();
    const ext = activeTab === "package" ? "json" : "js";
    const fname =
      activeTab === "package" ? "agent-package.json"
        : activeTab === "claude" ? "pcc-agent.js"
          : "pcc-agent-openai.js";
    const blob = new Blob([content], { type: ext === "json" ? "application/json" : "text/javascript" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fname;
    a.click();
    URL.revokeObjectURL(url);
  };

  const toolCount = pkg?.tools?.length ?? 0;

  // ── Shared styles ─────────────────────────────────────────────────
  const fontGS = { fontFamily: "'Space Grotesk', sans-serif" };
  const fontMono = { fontFamily: "'JetBrains Mono', monospace" };

  // ── Holographic background (shared between phases) ────────────────
  const holoBackground = (
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
  );

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 1: REGISTRATION
  // ═══════════════════════════════════════════════════════════════════
  if (phase === "register") {
    return (
      <div className="relative min-h-screen overflow-x-hidden" style={{ background: "#030308" }}>
        {holoBackground}
        <div className="relative z-10 min-h-screen flex flex-col items-center justify-center px-6">
          <div className="max-w-lg w-full mx-auto space-y-10">
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
              <p className="text-sm leading-relaxed" style={{ color: "#7B7B9A" }}>
                Register to get your API key. Your agent needs it to access the network — {toolCount || 73} tools, setup endpoints, jobs, escrow, and everything else.
              </p>
            </div>

            {/* What you get */}
            <div className="grid grid-cols-3 gap-3">
              {[
                { num: "73", label: "API tools", accent: "#D8A01B" },
                { num: "6", label: "Setup endpoints", accent: "#B57BDB" },
                { num: "1", label: "API key", accent: "#00D4D4" },
              ].map((s) => (
                <div key={s.label} className="text-center py-4 rounded-xl border" style={{ background: "#0A0A1A", borderColor: "rgba(255,255,255,0.06)" }}>
                  <div className="text-2xl font-bold" style={{ color: s.accent, ...fontGS }}>{s.num}</div>
                  <div className="text-xs mt-1" style={{ color: "#7B7B9A" }}>{s.label}</div>
                </div>
              ))}
            </div>

            {/* Registration form */}
            <form onSubmit={handleProvision} className="space-y-4">
              <div
                className="rounded-2xl p-[1px]"
                style={{ background: "linear-gradient(135deg, #D8A01B44, #26619C44, #B57BDB44, #D8A01B44)" }}
              >
                <div className="rounded-2xl overflow-hidden" style={{ background: "#0A0A1A" }}>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Email address"
                    required
                    className="w-full px-6 py-4 text-base bg-transparent border-none outline-none placeholder:opacity-30"
                    style={{ color: "#E8E8F0", ...fontGS, caretColor: "#D8A01B" }}
                    autoFocus
                  />
                </div>
              </div>

              <div className="rounded-2xl overflow-hidden border" style={{ background: "#0A0A1A", borderColor: "rgba(255,255,255,0.06)" }}>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name (optional)"
                  className="w-full px-6 py-4 text-base bg-transparent border-none outline-none placeholder:opacity-30"
                  style={{ color: "#E8E8F0", ...fontGS, caretColor: "#D8A01B" }}
                />
              </div>

              {provisionError && (
                <div className="rounded-xl px-5 py-3 text-sm" style={{ background: "rgba(255,60,60,0.1)", color: "#FF6B6B", border: "1px solid rgba(255,60,60,0.2)" }}>
                  {provisionError}
                </div>
              )}

              <button
                type="submit"
                disabled={provisioning || !email}
                className="w-full py-4 rounded-2xl font-semibold text-base transition-all duration-300 disabled:opacity-50"
                style={{
                  background: "linear-gradient(135deg, #D8A01B, #B57BDB)",
                  color: "#030308",
                  ...fontGS,
                  boxShadow: "0 0 30px rgba(216,160,27,0.2)",
                }}
              >
                {provisioning ? "Provisioning..." : "Get your API key"}
              </button>
            </form>

            {/* Fine print */}
            <p className="text-center text-xs leading-relaxed" style={{ color: "#7B7B9A", opacity: 0.5 }}>
              Your API key is unique to you. It's required on every request. We can revoke it if misused. The package is useless without it.
            </p>

            {/* Back link */}
            <div className="text-center">
              <button
                onClick={() => navigate("/")}
                className="text-xs tracking-wide transition-colors duration-300"
                style={{ color: "#7B7B9A", background: "none", border: "none" }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "#D8A01B")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "#7B7B9A")}
              >
                &larr; back
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 2: PROVISIONED — show package with key
  // ═══════════════════════════════════════════════════════════════════
  const STEPS = [
    { num: "01", title: "Save your API key", desc: "It's shown once. Your agent needs it on every request. Without it, the network returns 401.", accent: "#00D4D4" },
    { num: "02", title: "Give the package to your agent", desc: "Claude, GPT-4, or any LLM with tool-use. The key is already embedded. Just copy and paste.", accent: "#D8A01B" },
    { num: "03", title: "Your agent onboards you", desc: "It calls setup/detect, registers your machine, runs a test job, and connects you to the network.", accent: "#B57BDB" },
  ];

  return (
    <div className="relative min-h-screen overflow-x-hidden" style={{ background: "#030308" }}>
      {holoBackground}

      <div className="relative z-10 min-h-screen flex flex-col items-center px-6 py-16">
        <div className="max-w-3xl w-full mx-auto space-y-10">
          {/* Header */}
          <div className="text-center space-y-4">
            <h1 className="text-[13px] tracking-[0.35em] uppercase font-medium" style={{ color: "#7B7B9A", ...fontGS }}>
              capability.network
            </h1>
            {capability && (
              <p className="text-xl font-semibold" style={{ color: "#E8E8F0", ...fontGS }}>
                {capability}
              </p>
            )}
            <p className="text-sm" style={{ color: "#7B7B9A" }}>
              Provisioned for <span style={{ color: "#E8E8F0" }}>{email}</span>
            </p>
          </div>

          {/* API Key callout — the crucial thing */}
          <div
            className="rounded-2xl p-[1px]"
            style={{ background: "linear-gradient(135deg, #00D4D4, #26619C, #00D4D4)" }}
          >
            <div className="rounded-2xl p-5 space-y-3" style={{ background: "#0A0A1A" }}>
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold tracking-wide uppercase" style={{ color: "#00D4D4", ...fontGS }}>
                  Your API Key
                </div>
                <div className="text-xs" style={{ color: "#FF6B6B" }}>
                  Shown once — save it now
                </div>
              </div>
              <div
                className="rounded-xl px-4 py-3 text-sm select-all break-all cursor-pointer"
                style={{ background: "#030308", color: "#E8E8F0", ...fontMono }}
                onClick={handleCopyKey}
                title="Click to copy"
              >
                {apiKey}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleCopyKey}
                  className="flex-1 py-2 rounded-xl text-xs font-semibold transition-all duration-300"
                  style={{
                    background: copied === "key" ? "rgba(0,212,212,0.2)" : "rgba(0,212,212,0.1)",
                    color: "#00D4D4",
                    border: "1px solid rgba(0,212,212,0.2)",
                    ...fontGS,
                  }}
                >
                  {copied === "key" ? "Copied" : "Copy key"}
                </button>
                <div className="flex-1 py-2 rounded-xl text-xs text-center" style={{ color: "#7B7B9A", ...fontMono }}>
                  Authorization: Bearer {apiKey.slice(0, 16)}...
                </div>
              </div>
            </div>
          </div>

          {/* Steps */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {STEPS.map((step) => (
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
          <div
            className="rounded-2xl p-[1px]"
            style={{ background: "linear-gradient(135deg, #D8A01B33, #26619C33, #B57BDB33, #D8A01B33)" }}
          >
            <div className="rounded-2xl overflow-auto" style={{ background: "#0A0A1A", maxHeight: "400px" }}>
              <div
                className="sticky top-0 flex items-center justify-between px-5 py-3 border-b"
                style={{ background: "#0A0A1Aee", backdropFilter: "blur(8px)", borderColor: "rgba(255,255,255,0.06)" }}
              >
                <span className="text-xs font-mono" style={{ color: "#7B7B9A" }}>
                  {activeTab === "package" ? "agent-package.json" : activeTab === "claude" ? "pcc-agent.js" : "pcc-agent-openai.js"}
                </span>
                <span className="text-xs" style={{ color: "#00D4D4", opacity: 0.7 }}>
                  API key embedded
                </span>
              </div>
              <pre className="text-xs leading-relaxed whitespace-pre-wrap break-all p-5" style={{ color: "#7B7B9A", ...fontMono }}>
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
                color: "#030308",
                ...fontGS,
                boxShadow: copied === activeTab
                  ? "0 0 30px rgba(0,212,212,0.2)"
                  : "0 0 30px rgba(216,160,27,0.2)",
              }}
            >
              {copied === activeTab ? "Copied to clipboard" : "Copy to clipboard"}
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
            <h3 className="text-sm font-semibold" style={{ color: "#E8E8F0", ...fontGS }}>What's inside the package</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[
                { label: "Your API Key", detail: "Embedded in auth.api_key — every request uses it automatically" },
                { label: `${toolCount} API Tools`, detail: "Discovery, contracts, jobs, escrow, evidence, logistics, marketplace, sensors, settlement" },
                { label: "6 Setup Endpoints", detail: "detect -> generate-config -> validate -> register-device -> test-job -> status" },
                { label: "4 Onboarding Endpoints", detail: "Register machine, analyze docs (AI), redeem invite, check invite code" },
                { label: "A2A Protocol", detail: "Agent-to-agent intents for discovery, negotiation, contracts, and payments" },
                { label: "Quickstart Code", detail: "Working Node.js scripts for Claude SDK and OpenAI SDK with auth headers" },
              ].map((item) => (
                <div key={item.label} className="space-y-1">
                  <div className="text-xs font-semibold" style={{ color: "#D8A01B" }}>{item.label}</div>
                  <div className="text-xs leading-relaxed" style={{ color: "#7B7B9A" }}>{item.detail}</div>
                </div>
              ))}
            </div>
          </div>

          {/* API Base URL */}
          <div className="rounded-xl px-5 py-3 flex items-center gap-3 border" style={{ background: "#0D1117", borderColor: "rgba(0,212,212,0.15)" }}>
            <div className="text-xs font-mono" style={{ color: "#00D4D4" }}>API</div>
            <div className="text-xs font-mono flex-1 select-all" style={{ color: "#7B7B9A" }}>{API_BASE}</div>
            <div className="text-xs" style={{ color: "#7B7B9A", opacity: 0.5 }}>live</div>
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
            <a href="/whitepaper.md" target="_blank" rel="noopener noreferrer"
              className="text-xs tracking-wide transition-colors duration-300"
              style={{ color: "#7B7B9A" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#B57BDB")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#7B7B9A")}
            >Whitepaper</a>
            <a href="https://github.com/wingdingspenpal/poop" target="_blank" rel="noopener noreferrer"
              className="text-xs tracking-wide transition-colors duration-300"
              style={{ color: "#7B7B9A" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#00D4D4")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#7B7B9A")}
            >GitHub</a>
            <button
              onClick={() => navigate("/feedback")}
              className="text-xs tracking-wide transition-colors duration-300"
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
