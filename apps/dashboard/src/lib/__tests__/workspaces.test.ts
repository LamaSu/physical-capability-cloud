import { describe, it, expect } from "vitest";
import {
  APP_HOME,
  WORKSPACE_HOME,
  canonicalRedirect,
  nextWorkspace,
  workspaceForPath,
} from "../workspaces.js";

describe("workspaceForPath", () => {
  it("maps /app to the spatial workspace", () => {
    expect(workspaceForPath("/app")).toBe("spatial");
    expect(workspaceForPath("/app/jobs")).toBe("spatial");
  });

  it("maps /agent to the agent workspace", () => {
    expect(workspaceForPath("/agent")).toBe("agent");
  });

  it("maps every page route to the dashboard workspace", () => {
    for (const p of ["/dashboard", "/jobs", "/jobs/job-123", "/settings", "/kernels/k-1", "/applesauce"]) {
      expect(workspaceForPath(p)).toBe("dashboard");
    }
  });
});

describe("workspace switching", () => {
  it("cycles spatial -> agent -> dashboard -> spatial", () => {
    expect(nextWorkspace("spatial")).toBe("agent");
    expect(nextWorkspace("agent")).toBe("dashboard");
    expect(nextWorkspace("dashboard")).toBe("spatial");
  });

  it("each workspace home maps back to that workspace", () => {
    for (const [ws, home] of Object.entries(WORKSPACE_HOME)) {
      expect(workspaceForPath(home)).toBe(ws);
    }
  });

  it("the signed-in home is the Command Center route, not the public landing", () => {
    expect(APP_HOME).toBe("/dashboard");
  });
});

describe("canonicalRedirect", () => {
  it("sends /spatial to /app, so each workspace has one address", () => {
    expect(canonicalRedirect("/spatial")).toBe("/app");
  });

  it("strips the /legacy prefix", () => {
    expect(canonicalRedirect("/legacy/jobs")).toBe("/jobs");
    expect(canonicalRedirect("/legacy/jobs/job-9")).toBe("/jobs/job-9");
  });

  it("sends a bare /legacy to the app home", () => {
    expect(canonicalRedirect("/legacy")).toBe(APP_HOME);
    expect(canonicalRedirect("/legacy/")).toBe(APP_HOME);
  });

  it("leaves canonical paths alone", () => {
    for (const p of ["/jobs", "/legacyish", "/app", "/agent", "/dashboard"]) {
      expect(canonicalRedirect(p)).toBeNull();
    }
  });
});
