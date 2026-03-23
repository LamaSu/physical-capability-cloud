import React, { useState, useEffect, useRef } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";

export function AgentLinkPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const [mousePos, setMousePos] = useState({ x: 50, y: 50 });
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

  // Build the agent config payload
  const agentConfig = JSON.stringify({
    network: "https://capability.network",
    capability: capability,
    endpoints: {
      setup: "https://capability.network/api/setup/register-device",
      jobs: "https://capability.network/api/jobs",
      photo: "https://capability.network/api/photo/upload",
      health: "https://capability.network/api/health",
    },
    protocol: "A2A",
    docs: "https://capability.network/whitepaper.pdf",
  }, null, 2);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(agentConfig);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = agentConfig;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

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

      <div className="relative z-10 min-h-screen flex flex-col items-center justify-center px-6">
        <div className="max-w-lg w-full mx-auto text-center space-y-8">

          {/* Wordmark */}
          <h1
            className="text-[13px] tracking-[0.35em] uppercase font-medium"
            style={{ color: "#7B7B9A", fontFamily: "'Space Grotesk', sans-serif" }}
          >
            capability.network
          </h1>

          {/* What they typed */}
          {capability && (
            <p
              className="text-lg font-medium"
              style={{ color: "#E8E8F0", fontFamily: "'Space Grotesk', sans-serif" }}
            >
              {capability}
            </p>
          )}

          {/* Agent config preview */}
          <div
            className="rounded-2xl p-[1px] text-left"
            style={{
              background: "linear-gradient(135deg, #D8A01B33, #26619C33, #B57BDB33, #D8A01B33)",
            }}
          >
            <div className="rounded-2xl p-5 overflow-auto max-h-64" style={{ background: "#0A0A1A" }}>
              <pre
                className="text-xs leading-relaxed whitespace-pre-wrap break-all"
                style={{ color: "#7B7B9A", fontFamily: "'JetBrains Mono', monospace" }}
              >
                {agentConfig}
              </pre>
            </div>
          </div>

          {/* Copy button */}
          <button
            onClick={handleCopy}
            className="w-full py-4 rounded-2xl font-semibold text-base transition-all duration-300"
            style={{
              background: copied
                ? "linear-gradient(135deg, #00D4D4, #26619C)"
                : "linear-gradient(135deg, #D8A01B, #B57BDB)",
              color: "#030308",
              fontFamily: "'Space Grotesk', sans-serif",
              boxShadow: copied
                ? "0 0 30px rgba(0,212,212,0.2)"
                : "0 0 30px rgba(216,160,27,0.2)",
            }}
          >
            {copied ? "Copied to clipboard" : "Copy config for your agent"}
          </button>

          {/* Back link */}
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
  );
}
