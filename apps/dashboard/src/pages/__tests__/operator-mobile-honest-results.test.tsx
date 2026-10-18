// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorizedFetch } from "../../lib/authorized-fetch.js";
import { OperatorMobilePage } from "../OperatorMobilePage.js";

vi.mock("../../lib/authorized-fetch.js", () => ({ authorizedFetch: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SERVER_TEXT = "private gateway diagnostic";
const LOCAL_HASH = "ab".repeat(32);
const job = {
  id: "server-job", title: "Server fabrication run", status: "active",
  progress: 37, startedAt: "2026-10-16T11:58:00Z",
};
const upload = { cid: "server-stored-photo", antiSpoofScore: 0.73 };
const comparison = { match: false, similarity: 0.42 };
const issue = { issueId: "server-ticket-42" };
const operations = {
  jobs: {
    path: "/api/jobs?status=active", error: "Active jobs couldn't be loaded.",
    valid: [job], wrong: [{ ...job, title: 123 }],
  },
  upload: {
    path: "/api/photo/upload", error: "The photo couldn't be confirmed as stored.",
    valid: upload, wrong: { ...upload, cid: 123 },
  },
  compare: {
    path: "/api/photo/compare", error: "No comparison result came back.",
    valid: comparison, wrong: { ...comparison, match: "false" },
  },
  issue: {
    path: "/api/issues", error: "The issue couldn't be confirmed as submitted.",
    valid: issue, wrong: { issueId: 123 },
  },
} as const;
type Operation = keyof typeof operations;

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
const fetchMock = vi.mocked(authorizedFetch);

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

async function settle() {
  // Advance past the original fabrication delays too, so tests catch fake results.
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
}

function button(label: string) {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  expect(found, `button: ${label}`).toBeDefined();
  return found!;
}

async function click(label: string) {
  await act(async () => button(label).click());
  await settle();
}

async function render() {
  await act(async () => root.render(
    <QueryClientProvider client={client}><OperatorMobilePage /></QueryClientProvider>,
  ));
}

async function start(operation: Operation) {
  await render();
  if (operation === "jobs") {
    await click("Jobs");
    return;
  }
  if (operation === "compare") await click("Verify Print");
  if (operation === "issue") await click("Report Issue");
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["photo"], "print.png")] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  await settle();
  if (operation === "issue") {
    const textarea = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Surface defect");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  await submit(operation);
}

async function submit(operation: Operation) {
  const label = { jobs: "Retry", upload: "Record photo", compare: "Compare to Reference", issue: "Send Report" }[operation];
  await click(label);
}

function expectNoFabrication() {
  const text = host.textContent ?? "";
  expect(text).not.toMatch(/bafybei|0\.94|94%|91|job-00[123]|issue-\d+/);
  expect(text).not.toMatch(/FDM Print|CNC Mill|Laser Engrave/);
  expect(text).not.toContain(SERVER_TEXT);
}

function expectFailure(operation: Operation) {
  expectNoFabrication();
  expect(host.textContent).toContain(operations[operation].error);
  for (const value of ["Photo recorded", "Photo ID", "Uploaded", "IPFS CID", "Anti-spoof Score", "Similarity", "Matches Reference", "Mismatch Detected", "Issue Reported"]) {
    expect(host.textContent).not.toContain(value);
  }
  for (const value of [upload.cid, issue.issueId, job.title]) expect(host.textContent).not.toContain(value);
  if (operation === "jobs") {
    button("Retry");
    expect(host.textContent).not.toContain("No active jobs");
    expect([...host.querySelectorAll("button")].some((b) => b.textContent?.includes("Progress"))).toBe(false);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
  fetchMock.mockReset();
  vi.stubGlobal("crypto", { subtle: { digest: vi.fn(async () => new Uint8Array(32).fill(0xab).buffer) } });
  vi.stubGlobal("FileReader", class {
    onload: ((event: { target: { result: string } }) => void) | null = null;
    readAsDataURL() { this.onload?.({ target: { result: "data:image/png;base64,cGhvdG8=" } }); }
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("operator mobile honest results", () => {
  it("jobs rejects a valid jobs array returned with 503", async () => {
    fetchMock.mockResolvedValue(response([job], 503));
    await start("jobs");
    expectFailure("jobs");
  });

  it("jobs rejects a malformed second job after a valid first job", async () => {
    fetchMock.mockResolvedValue(response([job, { ...job, id: "server-job-2", title: 123 }]));
    await start("jobs");
    expectFailure("jobs");
  });

  it("expanded server job shows no invented evidence timeline", async () => {
    fetchMock.mockResolvedValue(response([job]));
    await start("jobs");
    await click(`${job.title}${job.status}Progress37%Elapsed: 2m`);
    expect(host.textContent).toContain(job.title);
    for (const entry of ["Evidence Timeline", "Job queued", "Material loaded", "Printing started", "Layer 42 snapshot", "Layer 88 snapshot"]) {
      expect(host.textContent).not.toContain(entry);
    }
    expect(host.textContent).toContain("No evidence timeline is available here.");
  });

  it.each(["upload", "compare", "issue"] as const)("%s reports an unconfirmed malformed 2xx without denying server action", async (operation) => {
    fetchMock.mockResolvedValue(response({}));
    await start(operation);
    expectFailure(operation);
    expect(host.textContent).not.toMatch(/wasn't stored|didn't run|wasn't submitted/);
  });

  it("photo recording action uses Record photo", async () => {
    fetchMock.mockResolvedValue(response({}, 503));
    await start("upload");
    button("Record photo");
    expect(host.textContent).not.toContain("Upload to IPFS");
  });

  it("photo success labels the server hash as Photo ID", async () => {
    const photoId = `photo:${LOCAL_HASH}`;
    fetchMock.mockResolvedValue(response({ ...upload, cid: photoId }));
    await start("upload");
    expect(host.textContent).toContain(photoId);
    expect(host.textContent).not.toContain("IPFS CID");
    expect(host.textContent).not.toContain("Uploaded");
    expect(host.textContent).toContain("Photo recorded");
    expect(host.textContent).toContain("Photo ID");
  });

  for (const operation of Object.keys(operations) as Operation[]) {
    it(`${operation} rejects non-2xx without inventing success`, async () => {
      fetchMock.mockResolvedValue(response({ ...operations[operation].valid, error: SERVER_TEXT }, 503));
      await start(operation);
      expect(fetchMock).toHaveBeenCalledWith(operations[operation].path, ...(operation === "jobs" ? [] : [expect.any(Object)]));
      expectFailure(operation);
    });

    it(`${operation} rejects network failure without inventing success`, async () => {
      fetchMock.mockRejectedValue(new TypeError(SERVER_TEXT));
      await start(operation);
      expectFailure(operation);
    });

    it(`${operation} rejects missing fields in a 2xx body`, async () => {
      fetchMock.mockResolvedValue(response({}));
      await start(operation);
      expectFailure(operation);
    });

    it(`${operation} rejects wrong-typed fields in a 2xx body`, async () => {
      fetchMock.mockResolvedValue(response(operations[operation].wrong));
      await start(operation);
      expectFailure(operation);
    });

    it(`${operation} rejects a null 2xx body`, async () => {
      fetchMock.mockResolvedValue(response(null));
      await start(operation);
      expectFailure(operation);
    });

    it(`${operation} rejects unreadable 2xx JSON`, async () => {
      fetchMock.mockResolvedValue({ ...response({}), json: async () => { throw new SyntaxError(SERVER_TEXT); } });
      await start(operation);
      expectFailure(operation);
    });
  }

  it.each([
    ["missing title", [{ ...job, title: undefined }]],
    ["blank ID", [{ ...job, id: " " }]],
    ["invalid status", [{ ...job, status: "invented" }]],
    ["wrong-typed progress", [{ ...job, progress: "37" }]],
    ["negative progress", [{ ...job, progress: -1 }]],
    ["excess progress", [{ ...job, progress: 101 }]],
    ["nonfinite progress", [{ ...job, progress: Infinity }]],
    ["invalid timestamp", [{ ...job, startedAt: "invalid" }]],
    ["wrong envelope", { jobs: [job] }],
  ])("jobs rejects %s in a 2xx body", async (_name, body) => {
    fetchMock.mockResolvedValue(response(body));
    await start("jobs");
    expectFailure("jobs");
  });

  it.each([
    ["empty CID", { ...upload, cid: "" }],
    ["blank CID", { ...upload, cid: "  " }],
    ["missing score", { cid: upload.cid }],
    ["wrong-typed score", { ...upload, antiSpoofScore: "0.73" }],
    ["negative score", { ...upload, antiSpoofScore: -0.1 }],
    ["excess score", { ...upload, antiSpoofScore: 1.1 }],
    ["infinite score", { ...upload, antiSpoofScore: Infinity }],
    ["NaN score", { ...upload, antiSpoofScore: NaN }],
  ])("upload rejects %s in a 2xx body", async (_name, body) => {
    fetchMock.mockResolvedValue(response(body));
    await start("upload");
    expectFailure("upload");
    expect(host.textContent).toContain("SHA-256");
    expect(host.textContent).toContain(LOCAL_HASH);
  });

  it.each([
    ["missing match", { similarity: 0.42 }],
    ["missing similarity", { match: false }],
    ["wrong-typed similarity", { ...comparison, similarity: "0.42" }],
    ["negative similarity", { ...comparison, similarity: -0.1 }],
    ["excess similarity", { ...comparison, similarity: 1.1 }],
    ["infinite similarity", { ...comparison, similarity: Infinity }],
    ["NaN similarity", { ...comparison, similarity: NaN }],
  ])("compare rejects %s in a 2xx body", async (_name, body) => {
    fetchMock.mockResolvedValue(response(body));
    await start("compare");
    expectFailure("compare");
  });

  it.each(["", "  "])("issue rejects empty or blank ID %j in a 2xx body", async (issueId) => {
    fetchMock.mockResolvedValue(response({ issueId }));
    await start("issue");
    expectFailure("issue");
  });

  // Start with a failure so success tests also fail on master, and cover retry/error clearing.
  it("jobs Retry shows exactly the server job and clears a later failed poll", async () => {
    fetchMock.mockResolvedValue(response({}, 503));
    await start("jobs");
    expectFailure("jobs");
    fetchMock.mockResolvedValue(response([job]));
    await submit("jobs");
    expect(host.textContent).not.toContain(operations.jobs.error);
    expect(host.textContent).toContain("1 active job");
    const card = [...host.querySelectorAll("button")].filter((b) => b.textContent?.includes("Progress"));
    expect(card).toHaveLength(1);
    expect(card[0].textContent).toBe(`${job.title}${job.status}Progress37%Elapsed: 2m`);
    expectNoFabrication();
    fetchMock.mockRejectedValue(new TypeError(SERVER_TEXT));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await settle();
    expectFailure("jobs");
    fetchMock.mockResolvedValue(response([]));
    await submit("jobs");
    expect(host.textContent).toContain("No active jobs");
    expect(host.textContent).not.toContain(operations.jobs.error);
  });

  it.each([0, 0.73, 1])("upload retry shows only the server photo ID and score %s", async (antiSpoofScore) => {
    fetchMock.mockResolvedValue(response({}, 503));
    await start("upload");
    expectFailure("upload");
    fetchMock.mockResolvedValue(response({ ...upload, antiSpoofScore }));
    await submit("upload");
    expect(host.textContent).not.toContain(operations.upload.error);
    expect(host.textContent).toContain("Photo recorded");
    expect(host.textContent).toContain("Photo ID");
    expect(host.textContent).not.toContain("Uploaded");
    expect(host.textContent).not.toContain("IPFS CID");
    expect(host.textContent).toContain(upload.cid);
    expect(host.textContent).toContain(`${antiSpoofScore * 100}%`);
    expect(host.textContent).not.toContain(LOCAL_HASH);
    expectNoFabrication();
  });

  it.each([[false, 0], [false, 0.42], [true, 1]] as const)("compare retry shows only server match %s and similarity %s", async (match, similarity) => {
    fetchMock.mockResolvedValue(response({}, 503));
    await start("compare");
    expectFailure("compare");
    fetchMock.mockResolvedValue(response({ match, similarity }));
    await submit("compare");
    expect(host.textContent).not.toContain(operations.compare.error);
    expect(host.textContent).toContain(match ? "Matches Reference" : "Mismatch Detected");
    expect(host.textContent).not.toContain(match ? "Mismatch Detected" : "Matches Reference");
    expect(host.textContent).toContain(`${similarity * 100}%`);
    expectNoFabrication();
  });

  it("issue retry shows exactly the server issue ID", async () => {
    fetchMock.mockResolvedValue(response({}, 503));
    await start("issue");
    expectFailure("issue");
    fetchMock.mockResolvedValue(response(issue));
    await submit("issue");
    expect(host.textContent).not.toContain(operations.issue.error);
    expect(host.textContent).toContain("Issue Reported");
    expect(host.textContent?.split(issue.issueId)).toHaveLength(2);
    expectNoFabrication();
  });
});
