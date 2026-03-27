import React from "react";
import { GlassPanel, GlowBadge, DataCell, EmptyState } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { getAuthHeaders } from "../stores/auth-store.js";

const API = import.meta.env.VITE_PCC_URL ?? "";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface KernelSummary {
  id: string;
  name: string;
  status?: string;
}

interface AgentTool {
  name: string;
  description: string;
  category?: string;
}

interface AgentPackage {
  kernelId: string;
  kernelName?: string;
  deviceCount?: number;
  toolCount?: number;
  tools?: AgentTool[];
  wizardPrompt?: string;
  url?: string;
}

// ---------------------------------------------------------------------------
// Tool Category Groups
// ---------------------------------------------------------------------------

function groupToolsByCategory(tools: AgentTool[]): Record<string, AgentTool[]> {
  const groups: Record<string, AgentTool[]> = {};
  for (const tool of tools) {
    const cat = tool.category ?? "other";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(tool);
  }
  return groups;
}

const CATEGORY_COLORS: Record<string, string> = {
  platform: "text-green-400/70",
  device: "text-cyan-400/70",
  batch: "text-yellow-400/70",
  operator: "text-purple-400/70",
  other: "text-white/40",
};

// ---------------------------------------------------------------------------
// SDK Snippet Tabs
// ---------------------------------------------------------------------------

function SDKSnippets({ kernelId }: { kernelId: string }) {
  const [activeTab, setActiveTab] = React.useState<"python" | "javascript" | "curl">("python");
  const [snippets, setSnippets] = React.useState<Record<string, string>>({});
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!kernelId) return;
    setLoading(true);
    const langs = ["python", "javascript", "curl"] as const;
    Promise.all(
      langs.map((lang) =>
        fetch(`${API}/api/kernels/${kernelId}/sdk/${lang}`, {
          headers: { ...getAuthHeaders() },
        })
          .then((r) => (r.ok ? r.text() : `# Failed to load ${lang} snippet`))
          .then((text) => [lang, text] as const)
          .catch(() => [lang, `# Error loading ${lang} snippet`] as const),
      ),
    )
      .then((results) => {
        const obj: Record<string, string> = {};
        for (const [lang, text] of results) obj[lang] = text;
        setSnippets(obj);
      })
      .finally(() => setLoading(false));
  }, [kernelId]);

  const tabs = [
    { id: "python" as const, label: "Python" },
    { id: "javascript" as const, label: "JavaScript" },
    { id: "curl" as const, label: "curl" },
  ];

  return (
    <div className="space-y-2">
      <div className="flex gap-1 border-b border-white/[0.06] pb-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`px-3 py-1.5 rounded-t-lg text-[10px] transition-all ${
              activeTab === t.id
                ? "bg-white/[0.04] text-green-400 border-b-2 border-green-400/30"
                : "text-white/30 hover:text-white/50"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-3 overflow-x-auto">
        {loading ? (
          <div className="text-xs text-white/30 animate-pulse">Loading snippet...</div>
        ) : (
          <pre className="text-xs font-mono text-white/60 whitespace-pre-wrap leading-relaxed">
            {snippets[activeTab] ?? "No snippet available"}
          </pre>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export function AgentPackagePage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  const [kernels, setKernels] = React.useState<KernelSummary[]>([]);
  const [selectedKernelId, setSelectedKernelId] = React.useState("");
  const [agentPackage, setAgentPackage] = React.useState<AgentPackage | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [kernelsLoading, setKernelsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [wizardPrompt, setWizardPrompt] = React.useState<string | null>(null);
  const [wizardLoading, setWizardLoading] = React.useState(false);
  const [wizardExpanded, setWizardExpanded] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    setPageMeta("Agent Package", "Agent tool packages and SDK integration");
  }, [setPageMeta]);

  // Fetch kernels list
  React.useEffect(() => {
    setKernelsLoading(true);
    fetch(`${API}/api/kernels`, {
      headers: { ...getAuthHeaders() },
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        setKernels(data.kernels ?? data ?? []);
      })
      .catch(() => setKernels([]))
      .finally(() => setKernelsLoading(false));
  }, []);

  // Fetch agent package when kernel selected
  React.useEffect(() => {
    if (!selectedKernelId) {
      setAgentPackage(null);
      return;
    }
    setLoading(true);
    setError(null);
    setAgentPackage(null);
    fetch(`${API}/api/kernels/${selectedKernelId}/agent-package`, {
      headers: { ...getAuthHeaders() },
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        setAgentPackage(data.package ?? data);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [selectedKernelId]);

  // Copy URL
  function copyPackageUrl() {
    const url = agentPackage?.url ?? `${API}/api/kernels/${selectedKernelId}/agent-package`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  // Fetch wizard prompt
  function fetchWizardPrompt() {
    setWizardLoading(true);
    fetch(`${API}/api/onboard/wizard-prompt`, {
      headers: { ...getAuthHeaders() },
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        setWizardPrompt(text);
        setWizardExpanded(true);
      })
      .catch((err) => setWizardPrompt(`Error: ${err.message}`))
      .finally(() => setWizardLoading(false));
  }

  const tools = agentPackage?.tools ?? [];
  const grouped = groupToolsByCategory(tools);

  return (
    <div className="space-y-6">
      {/* Kernel selector */}
      <GlassPanel padding="md">
        <div className="flex items-center gap-4">
          <label className="text-[10px] text-white/30 uppercase tracking-wider flex-shrink-0">Select Kernel</label>
          <select
            value={selectedKernelId}
            onChange={(e) => setSelectedKernelId(e.target.value)}
            className="flex-1 bg-white/[0.04] border border-white/[0.10] rounded px-3 py-2 text-sm font-mono text-white/80 outline-none focus:border-green-500/30 appearance-none cursor-pointer"
          >
            <option value="" className="bg-gray-900">
              {kernelsLoading ? "Loading kernels..." : "-- Select a kernel --"}
            </option>
            {kernels.map((k) => (
              <option key={k.id} value={k.id} className="bg-gray-900">
                {k.name ?? k.id}
              </option>
            ))}
          </select>
          {selectedKernelId && agentPackage && (
            <button
              onClick={copyPackageUrl}
              className={`px-4 py-2 rounded-lg text-xs font-medium transition-all ${
                copied
                  ? "bg-green-500/30 border border-green-500/50 text-green-300"
                  : "bg-white/[0.04] border border-white/[0.08] text-white/50 hover:text-white/70 hover:bg-white/[0.06]"
              }`}
            >
              {copied ? "Copied!" : "Copy Agent Package URL"}
            </button>
          )}
        </div>
      </GlassPanel>

      {/* Error */}
      {error && (
        <GlassPanel padding="md">
          <div className="text-xs text-red-400">Error: {error}</div>
        </GlassPanel>
      )}

      {/* Loading */}
      {loading && (
        <GlassPanel padding="lg">
          <div className="text-center py-8 text-white/30 text-sm animate-pulse">Loading agent package...</div>
        </GlassPanel>
      )}

      {/* Empty state */}
      {!loading && !agentPackage && !error && !selectedKernelId && (
        <GlassPanel padding="lg">
          <EmptyState
            title="Select a kernel"
            description="Choose a kernel above to view its agent package, tools, and SDK snippets."
          />
        </GlassPanel>
      )}

      {/* Agent package details */}
      {agentPackage && (
        <div className="space-y-6">
          {/* KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <GlassPanel padding="md" glow="green">
              <DataCell
                label="Kernel"
                value={agentPackage.kernelName ?? selectedKernelId}
                mono
              />
            </GlassPanel>
            {agentPackage.deviceCount !== undefined && (
              <GlassPanel padding="md">
                <DataCell label="Devices" value={agentPackage.deviceCount} mono />
              </GlassPanel>
            )}
            <GlassPanel padding="md">
              <DataCell label="Tools" value={agentPackage.toolCount ?? tools.length} mono />
            </GlassPanel>
            <GlassPanel padding="md">
              <DataCell label="Categories" value={Object.keys(grouped).length} sub="tool groups" mono />
            </GlassPanel>
          </div>

          {/* Tool list by category */}
          <GlassPanel padding="md">
            <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-4">Tools by Category</h3>
            {Object.keys(grouped).length === 0 ? (
              <div className="text-xs text-white/30 py-4 text-center">No tools in this package</div>
            ) : (
              <div className="space-y-4">
                {Object.entries(grouped).map(([category, catTools]) => (
                  <div key={category}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`text-xs font-semibold uppercase tracking-wider ${CATEGORY_COLORS[category] ?? "text-white/40"}`}>
                        {category}
                      </span>
                      <GlowBadge color="gray">{catTools.length}</GlowBadge>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      {catTools.map((tool, i) => (
                        <div
                          key={i}
                          className="px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.06] hover:border-white/[0.12] transition-all"
                        >
                          <div className="text-xs font-mono text-white/70">{tool.name}</div>
                          <div className="text-[10px] text-white/30 mt-0.5 line-clamp-2">{tool.description}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </GlassPanel>

          {/* SDK Snippets */}
          <GlassPanel padding="md">
            <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-3">SDK Snippets</h3>
            <SDKSnippets kernelId={selectedKernelId} />
          </GlassPanel>

          {/* Wizard Prompt */}
          <GlassPanel padding="md">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider">Wizard Prompt</h3>
              <button
                onClick={fetchWizardPrompt}
                disabled={wizardLoading}
                className="px-3 py-1.5 rounded-lg text-[10px] font-medium bg-white/[0.04] border border-white/[0.08] text-white/50 hover:text-white/70 hover:bg-white/[0.06] transition-all disabled:opacity-50"
              >
                {wizardLoading ? "Loading..." : "Get Wizard Prompt"}
              </button>
            </div>

            {wizardPrompt && (
              <div>
                <button
                  onClick={() => setWizardExpanded(!wizardExpanded)}
                  className="text-[10px] text-white/30 hover:text-white/50 mb-2 transition-colors"
                >
                  {wizardExpanded ? "Collapse" : "Expand"} prompt preview
                </button>
                <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-3 overflow-x-auto">
                  <pre className="text-xs font-mono text-white/60 whitespace-pre-wrap leading-relaxed">
                    {wizardExpanded ? wizardPrompt : wizardPrompt.slice(0, 500) + (wizardPrompt.length > 500 ? "..." : "")}
                  </pre>
                </div>
              </div>
            )}

            {!wizardPrompt && !wizardLoading && (
              <div className="text-xs text-white/25">Click "Get Wizard Prompt" to load the onboarding prompt.</div>
            )}
          </GlassPanel>
        </div>
      )}
    </div>
  );
}
