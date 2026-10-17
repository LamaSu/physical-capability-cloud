// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorizedFetch } from "../../lib/authorized-fetch.js";
import { OperatorMobilePage } from "../OperatorMobilePage.js";

vi.mock("../../lib/authorized-fetch.js", () => ({ authorizedFetch: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchMock = vi.mocked(authorizedFetch);
const PHOTO_A = "data:image/png;base64,cGhvdG8tQQ==";
const PHOTO_B = "data:image/png;base64,cGhvdG8tQg==";
const SERVER_TEXT = "private gateway delivery diagnostic";
const CHOSEN_JOB_ID = "operator-chosen-job-73";
const operationConfig = {
  compare: {
    mode: "Verify Print", submit: "Compare to Reference", path: "/api/photo/compare",
    result: { match: true, similarity: 0.97 }, error: "No comparison result came back.",
    forbidden: ["Matches Reference", "Mismatch Detected", "Similarity", "97%"],
  },
  upload: {
    mode: "Upload Photo", submit: "Record photo", path: "/api/photo/upload",
    result: { cid: "held-photo-A", antiSpoofScore: 0.73 }, error: "The photo couldn't be confirmed as stored.",
    forbidden: ["Photo recorded", "Photo ID", "held-photo-A", "Anti-spoof Score", "73%"],
  },
  issue: {
    mode: "Report Issue", submit: "Send Report", path: "/api/issues",
    result: { issueId: "held-issue-A" }, error: "The issue couldn't be confirmed as submitted.",
    forbidden: ["Issue Reported", "held-issue-A", "Your report was recorded"],
  },
} as const;
type Operation = keyof typeof operationConfig;

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
}

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  expect(found, `button: ${label}`).toBeDefined();
  return found!;
}

async function click(label: string) {
  await act(async () => button(label).click());
  await settle();
}

async function forceModeSwitch(label: string) {
  const target = button(label);
  const propsKey = Object.keys(target).find((key) => key.startsWith("__reactProps$"));
  expect(propsKey, "React button props for isolated stale-request probe").toBeDefined();
  const props = (target as unknown as Record<string, { onClick: () => void }>)[propsKey!];
  // Deliberately bypass the disabled DOM button: this isolates the request-tag
  // safeguard. Separate cases below exercise the actual disabled buttons.
  await act(async () => props.onClick());
  await settle();
}

async function render() {
  await act(async () => root.render(
    <QueryClientProvider client={client}><OperatorMobilePage /></QueryClientProvider>,
  ));
}

async function takePhoto(name: "A" | "B") {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File([name], `photo-${name}.png`)] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  await settle();
  expect(host.querySelector("img")?.getAttribute("src")).toBe(name === "A" ? PHOTO_A : PHOTO_B);
}

async function enter(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

function jobIdInput() {
  const input = [...host.querySelectorAll<HTMLInputElement>('input:not([type="file"])')]
    .find((candidate) => candidate.placeholder.includes("Job ID"));
  expect(input, "Job ID input").toBeDefined();
  return input!;
}

async function prepare(operation: Operation) {
  await render();
  await click(operationConfig[operation].mode);
  await takePhoto("A");
  if (operation === "compare") await enter(jobIdInput(), CHOSEN_JOB_ID);
  if (operation === "issue") await enter(host.querySelector("textarea")!, "Operator-observed surface defect");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
  fetchMock.mockReset();
  vi.stubGlobal("crypto", { subtle: { digest: vi.fn(async () => new Uint8Array(32).fill(0xab).buffer) } });
  vi.stubGlobal("FileReader", class {
    onload: ((event: { target: { result: string } }) => void) | null = null;
    readAsDataURL(file: File) { this.onload?.({ target: { result: file.name === "photo-B.png" ? PHOTO_B : PHOTO_A } }); }
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

describe("operator mobile PR-3b", () => {
  it.each([
    ["Kernel ID", "kern-alpha-01"],
    ["Operator", "op-9f3a2b"],
    ["Network", "Base Sepolia"],
    ["Agent Status", "Online"],
    ["App Version", "v0.1.0-pwa"],
  ])("drops unsourced Settings %s", async (label, inventedValue) => {
    await render();
    await click("Settings");
    const leafTexts = [...host.querySelectorAll("span")].map((span) => span.textContent?.trim());
    expect(leafTexts).not.toContain(label);
    expect(host.textContent).not.toContain(inventedValue);
    expect(host.textContent).toContain("Quick Links");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops the Live badge without an open live connection", async () => {
    await render();
    const leafTexts = [...host.querySelectorAll("span")].map((span) => span.textContent?.trim());
    expect(leafTexts).not.toContain("Live");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("confirms an issue was recorded by ID without claiming agent delivery", async () => {
    fetchMock.mockResolvedValue(response({ issueId: "recorded-issue-73", message: SERVER_TEXT }));
    await prepare("issue");
    await click("Send Report");
    expect(host.textContent).toContain("Your report was recorded (ID recorded-issue-73).");
    expect(host.textContent).not.toContain("sent to the agent");
    expect(host.textContent).not.toContain(SERVER_TEXT);
  });

  it("counts accepted jobs without calling pending completed or failed jobs active", async () => {
    const jobs = ["active", "pending", "completed", "failed"].map((status, index) => ({
      id: `server-job-${index}`, title: `Server job ${status}`, status,
      progress: index * 20, startedAt: "2026-10-16T11:58:00Z",
    }));
    fetchMock.mockResolvedValue(response(jobs));
    await render();
    await click("Jobs");
    expect(host.textContent).toContain("4 jobs");
    expect(host.textContent).toContain("1 active job");
    expect(host.textContent).not.toContain("4 active jobs");
    expect([...host.querySelectorAll("button")].filter((candidate) => candidate.textContent?.includes("Progress"))).toHaveLength(4);
  });

  it("requires an operator-entered Job ID before Verify Print and sends that ID", async () => {
    fetchMock.mockResolvedValue(response({ match: false, similarity: 0.42 }));
    await render();
    await click("Verify Print");
    await takePhoto("A");
    await click("Compare to Reference");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(button("Compare to Reference").disabled || host.textContent?.includes("Enter the Job ID to verify against.")).toBe(true);
    await enter(jobIdInput(), "   ");
    await click("Compare to Reference");
    expect(fetchMock).not.toHaveBeenCalled();
    await enter(jobIdInput(), CHOSEN_JOB_ID);
    await click("Compare to Reference");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/photo/compare");
    expect(JSON.parse(String(init?.body))).toEqual({ image: PHOTO_A, jobId: CHOSEN_JOB_ID });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("default-job");
    expect(host.textContent).toContain("Mismatch Detected");
  });

  for (const operation of ["compare", "upload", "issue"] as const) {
    it(`${operation} disables all three mode buttons while its call is in flight`, async () => {
      const held = deferred<Response>();
      fetchMock.mockReturnValue(held.promise);
      await prepare(operation);
      await click(operationConfig[operation].submit);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      for (const config of Object.values(operationConfig)) expect(button(config.mode).disabled).toBe(true);
      const before = host.textContent;
      await click(operation === "upload" ? "Verify Print" : "Upload Photo");
      expect(host.textContent).toBe(before);
      held.resolve(response(operationConfig[operation].result));
      await settle();
      for (const config of Object.values(operationConfig)) expect(button(config.mode).disabled).toBe(false);
    });

    it(`${operation === "compare" ? "probe P4 compare" : operation} drops a held success after a mode switch and photo B`, async () => {
      const held = deferred<Response>();
      fetchMock.mockReturnValue(held.promise);
      await prepare(operation);
      await click(operationConfig[operation].submit);
      expect(fetchMock).toHaveBeenCalledWith(operationConfig[operation].path, expect.any(Object));
      await forceModeSwitch(operation === "upload" ? "Verify Print" : "Upload Photo");
      await takePhoto("B");
      held.resolve(response(operationConfig[operation].result));
      await settle();
      expect(host.querySelector("img")?.getAttribute("src")).toBe(PHOTO_B);
      for (const text of operationConfig[operation].forbidden) expect(host.textContent).not.toContain(text);
      expect(host.textContent).not.toContain(operationConfig[operation].error);
    });

    it(`${operation} drops a held failure after a mode switch and photo B`, async () => {
      const held = deferred<Response>();
      fetchMock.mockReturnValue(held.promise);
      await prepare(operation);
      await click(operationConfig[operation].submit);
      await forceModeSwitch(operation === "upload" ? "Verify Print" : "Upload Photo");
      await takePhoto("B");
      held.reject(new TypeError(SERVER_TEXT));
      await settle();
      expect(host.querySelector("img")?.getAttribute("src")).toBe(PHOTO_B);
      expect(host.textContent).not.toContain(operationConfig[operation].error);
      expect(host.textContent).not.toContain(SERVER_TEXT);
    });
  }
});

function stubDigest(holdA?: Promise<void>) {
  vi.stubGlobal("crypto", { subtle: { digest: vi.fn(async (_alg: string, bytes: Uint8Array) => {
    const isA = bytes[bytes.length - 1] === 0x41; // "photo-A"
    if (isA && holdA) await holdA;
    return new Uint8Array(32).fill(isA ? 0xaa : 0xbb).buffer;
  }) } });
}

async function choosePhoto(name: "A" | "B") {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File([name], `photo-${name}.png`)] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  await settle();
}

describe("operator mobile PR-3b photo read", () => {
  it("a late hash for photo A never replaces photo B", async () => {
    let releaseA!: () => void;
    stubDigest(new Promise<void>((resolve) => { releaseA = resolve; }));
    await render();
    await choosePhoto("A");
    await choosePhoto("B");
    releaseA();
    await settle();
    expect(host.querySelector("img")?.getAttribute("src")).toBe(PHOTO_B);
    expect(host.textContent).toContain("bb".repeat(32));
    expect(host.textContent).not.toContain("aa".repeat(32));
  });

  it("a mode switch while photo A is read drops photo A", async () => {
    let releaseA!: () => void;
    stubDigest(new Promise<void>((resolve) => { releaseA = resolve; }));
    await render();
    await choosePhoto("A");
    await click("Verify Print");
    releaseA();
    await settle();
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("Take Photo");
  });
});

describe("operator mobile PR-3b photo submission after a late hash", () => {
  it.each(["upload", "compare"] as const)("%s sends photo B after photo A finishes hashing", async (operation) => {
    let releaseA!: () => void;
    stubDigest(new Promise<void>((resolve) => { releaseA = resolve; }));
    fetchMock.mockResolvedValue(response(operationConfig[operation].result));
    await render();
    await click(operationConfig[operation].mode);
    await choosePhoto("A");
    await choosePhoto("B");
    releaseA();
    await settle();
    if (operation === "compare") await enter(jobIdInput(), CHOSEN_JOB_ID);
    await click(operationConfig[operation].submit);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe(operationConfig[operation].path);
    expect(JSON.parse(String(init?.body))).toEqual(operation === "upload"
      ? { image: PHOTO_B, sha256: "bb".repeat(32), notes: "" }
      : { image: PHOTO_B, jobId: CHOSEN_JOB_ID });
  });
});

describe("operator mobile PR-3b Job ID rules", () => {
  it("refuses a whitespace-only Job ID without sending a comparison", async () => {
    fetchMock.mockResolvedValue(response(operationConfig.compare.result));
    await prepare("compare");
    await enter(jobIdInput(), "   ");
    await click("Compare to Reference");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(button("Compare to Reference").disabled).toBe(true);
  });

  it("sends the trimmed operator-entered Job ID", async () => {
    fetchMock.mockResolvedValue(response(operationConfig.compare.result));
    await prepare("compare");
    await enter(jobIdInput(), `  ${CHOSEN_JOB_ID} `);
    await click("Compare to Reference");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe(operationConfig.compare.path);
    expect(JSON.parse(String(init?.body))).toEqual({ image: PHOTO_A, jobId: CHOSEN_JOB_ID });
  });

  it("locks the Job ID while a comparison is in flight and unlocks it after failure", async () => {
    const held = deferred<Response>();
    fetchMock.mockReturnValue(held.promise);
    await prepare("compare");
    expect(jobIdInput().disabled).toBe(false);
    await click("Compare to Reference");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jobIdInput().disabled).toBe(true);
    held.reject(new TypeError(SERVER_TEXT));
    await settle();
    expect(host.textContent).toContain(operationConfig.compare.error);
    expect(jobIdInput().disabled).toBe(false);
    expect(jobIdInput().value).toBe(CHOSEN_JOB_ID);
  });
});
