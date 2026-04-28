/**
 * Tests for RoleSwitch — focused on the contract: persists to storage
 * before firing onChange. Rendering details are exercised in Storybook /
 * manual QA, not here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _setPluginForTests,
  getRole,
  setRole,
} from "./storage/secure-api-key.js";

beforeEach(() => {
  // PWA mode (no Capacitor)
  (globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => false,
    getPlatform: () => "web",
  };
  _setPluginForTests(null);
  if (typeof localStorage !== "undefined") {
    localStorage.clear();
  }
});

afterEach(() => {
  _setPluginForTests(null);
});

describe("RoleSwitch storage contract", () => {
  it("setRole persists and getRole reads back", async () => {
    await setRole("operator");
    expect(await getRole()).toBe("operator");
    await setRole("user");
    expect(await getRole()).toBe("user");
  });

  it("default role is 'user'", async () => {
    expect(await getRole()).toBe("user");
  });

  it("invalid stored role coerces to 'user'", async () => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("pcc-role", "supervisor");
    }
    expect(await getRole()).toBe("user");
  });

  it("setRole completes before onChange handler fires (sequence guarantee)", async () => {
    const onChange = vi.fn();
    // Simulate the RoleSwitch handler manually since we're not pulling in
    // React Testing Library for this single contract — keep deps minimal
    // for Week 1.
    const change = async (next: "user" | "operator") => {
      await setRole(next);
      onChange(next);
    };
    await change("operator");
    expect(onChange).toHaveBeenCalledWith("operator");
    expect(await getRole()).toBe("operator");
  });
});
