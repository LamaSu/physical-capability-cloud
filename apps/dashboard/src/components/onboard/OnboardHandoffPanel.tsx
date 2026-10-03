import React, { useState } from "react";
import { Link } from "react-router-dom";
import { ONBOARD_CHAT_PATH, onboardChatState } from "../../lib/onboard-handoff.js";

export interface OnboardHandoffPanelProps {
  /** The machine as the user named it, if they did. */
  machineLabel?: string;
  /** From buildOnboardChatDraft: only what the user entered. */
  draft: string;
}

/**
 * The honest end of an onboarding page that cannot register a machine yet
 * (PX-10 Wave 0): nothing was registered; continue in /onboard/chat.
 */
export function OnboardHandoffPanel({ machineLabel, draft }: OnboardHandoffPanelProps) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  };

  return (
    <div role="status" data-onboard-handoff="" className="space-y-4 text-left">
      <div className="rounded-xl border border-amber-400/30 bg-amber-400/[0.06] p-4 space-y-1">
        <p className="text-sm font-semibold text-amber-200">Nothing was registered</p>
        <p className="text-xs text-white/50">
          {machineLabel ? `${machineLabel} is not on the network. ` : "Your machine is not on the network. "}
          This page can't register machines yet. Continue in the onboarding chat and paste the
          details below.
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-xs text-white/40">Your details</p>
        <pre className="whitespace-pre-wrap break-words rounded-xl border border-white/[0.08] bg-white/[0.03] p-3 font-mono text-xs text-white/70">
          {draft}
        </pre>
        <button
          type="button"
          onClick={handleCopy}
          className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-xs text-white/60 transition-colors hover:bg-white/[0.08]"
        >
          {copy === "copied"
            ? "Copied"
            : copy === "failed"
              ? "Copy failed: select the text above"
              : "Copy details"}
        </button>
      </div>

      <Link
        to={ONBOARD_CHAT_PATH}
        state={onboardChatState(draft)}
        className="block w-full rounded-xl bg-emerald-500 py-3 text-center text-sm font-semibold text-black transition-all hover:bg-emerald-400"
      >
        Continue in the onboarding chat
      </Link>
    </div>
  );
}
