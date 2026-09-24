import { describe, it, expect } from "vitest";
import {
  APP_HOME,
  WORKSPACE_HOME,
  legacyRedirect,
  nextWorkspace,
  workspaceForPath,
} from "../workspaces.js";

describe("workspaceForPath", () => {
  it("maps /app and /spatial to the spatial workspace", () => {
    expect(workspaceForPath("/app")).toBe("spatial");
    expect(workspaceForPath("/app/jobs")).toBe("spatial");
    expect(workspaceForPath("/spatial")).toBe("spatial");
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

describe("legacyRedirect", () => {
  it("strips the /legacy prefix", () => {
    expect(legacyRedirect("/legacy/jobs")).toBe("/jobs");
    expect(legacyRedirect("/legacy/jobs/job-9")).toBe("/jobs/job-9");
  });

  it("sends a bare /legacy to the app home", () => {
    expect(legacyRedirect("/legacy")).toBe(APP_HOME);
    expect(legacyRedirect("/legacy/")).toBe(APP_HOME);
  });

  it("leaves other paths alone", () => {
    expect(legacyRedirect("/jobs")).toBeNull();
    expect(legacyRedirect("/legacyish")).toBeNull();
  });
});
