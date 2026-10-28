import React from "react";
import { Link } from "react-router-dom";

export function OnboardChatHandoff() {
  return (
    <div
      data-testid="onboard-chat-handoff"
      className="rounded-xl border border-emerald-400/25 bg-emerald-500/10 p-5 space-y-3"
    >
      <h3 className="text-base font-semibold text-white/90">Registration isn't available here yet</h3>
      <p className="text-sm leading-relaxed text-white/70">
        This page didn't register your machine. You can describe it in the onboarding chat instead.
      </p>
      <Link to="/onboard/chat" className="inline-block text-sm font-medium text-emerald-300 underline underline-offset-4 hover:text-emerald-200">
        Continue in the onboarding chat
      </Link>
    </div>
  );
}
