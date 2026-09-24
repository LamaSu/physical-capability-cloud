import { describe, it, expect } from "vitest";
import {
  buildOnboardChatDraft,
  onboardChatState,
  ONBOARD_CHAT_PATH,
  ONBOARD_DRAFT_STATE_KEY,
} from "../onboard-handoff.js";

describe("buildOnboardChatDraft", () => {
  it("lists what the user entered under the intro, in order", () => {
    const draft = buildOnboardChatDraft("I want to offer a machine on PCC.", [
      { label: "Machine name", value: "Shop Prusa" },
      { label: "Rate", value: "$12 per hour" },
    ]);
    expect(draft).toBe(
      "I want to offer a machine on PCC.\n- Machine name: Shop Prusa\n- Rate: $12 per hour",
    );
  });

  it("leaves out empty, blank, null and undefined values instead of inventing them", () => {
    const draft = buildOnboardChatDraft("Intro", [
      { label: "A", value: "" },
      { label: "B", value: "   " },
      { label: "C", value: null },
      { label: "D", value: undefined },
      { label: "E", value: "kept" },
    ]);
    expect(draft).toBe("Intro\n- E: kept");
  });

  it("keeps a zero, which the user may have typed", () => {
    expect(buildOnboardChatDraft("Intro", [{ label: "Minimum", value: 0 }])).toBe("Intro\n- Minimum: 0");
  });

  it("returns only the intro when nothing was entered", () => {
    expect(buildOnboardChatDraft("Intro", [])).toBe("Intro");
  });
});

describe("hand-off target", () => {
  it("goes to the canonical onboarding entry", () => {
    expect(ONBOARD_CHAT_PATH).toBe("/onboard/chat");
  });

  it("carries the draft in router state under one key", () => {
    expect(onboardChatState("draft text")).toEqual({ [ONBOARD_DRAFT_STATE_KEY]: "draft text" });
  });
});
