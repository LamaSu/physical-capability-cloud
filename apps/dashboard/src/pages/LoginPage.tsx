import React from "react";
import { GlassPanel } from "@pcc/ui";
import { useAuthStore } from "../stores/auth-store.js";
import { ParticleBackground } from "@pcc/ui";

export function LoginPage() {
  const login = useAuthStore((s) => s.login);
  const [key, setKey] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim() || loading) return;

    setError(null);
    setLoading(true);

    const success = await login(key.trim());

    if (!success) {
      setError("Invalid API key. Check your key and try again.");
    }
    setLoading(false);
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-black/95">
      <ParticleBackground />

      <div className="relative z-10 w-full max-w-md px-4">
        <GlassPanel padding="lg" glow="green">
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Title */}
            <div className="text-center space-y-2">
              <h1 className="text-xl font-semibold text-white/90 tracking-wide">
                Physical Capability Cloud
              </h1>
              <p className="text-xs text-white/30">
                Enter your API key to access the operator dashboard
              </p>
            </div>

            {/* API Key Input */}
            <div className="space-y-2">
              <label
                htmlFor="api-key"
                className="text-[10px] text-white/30 uppercase tracking-wider block"
              >
                API Key
              </label>
              <input
                id="api-key"
                type="password"
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  if (error) setError(null);
                }}
                placeholder="pcc_..."
                autoFocus
                disabled={loading}
                className="w-full bg-white/[0.04] border border-white/[0.10] rounded-lg px-4 py-3 text-sm font-mono text-white/80 outline-none focus:border-green-500/30 transition-colors placeholder:text-white/15 disabled:opacity-50"
              />
            </div>

            {/* Error */}
            {error && (
              <div className="text-xs text-red-400 bg-red-400/[0.06] border border-red-400/20 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={!key.trim() || loading}
              className={`w-full py-3 rounded-lg text-sm font-medium transition-all ${
                key.trim() && !loading
                  ? "bg-green-500/20 border border-green-500/30 text-green-400 hover:bg-green-500/30"
                  : "bg-white/[0.02] border border-white/[0.06] text-white/20 cursor-not-allowed"
              }`}
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="inline-block w-3 h-3 border-2 border-green-400/40 border-t-green-400 rounded-full animate-spin" />
                  Validating...
                </span>
              ) : (
                "Connect"
              )}
            </button>

            {/* Help text */}
            <div className="text-center">
              <p className="text-[10px] text-white/20">
                API keys are provisioned via the gateway API.{" "}
                <span className="text-white/30">
                  POST /api/auth/keys to create one.
                </span>
              </p>
            </div>
          </form>
        </GlassPanel>
      </div>
    </div>
  );
}
