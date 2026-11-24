// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { authorizedFetch } = vi.hoisted(() => ({ authorizedFetch: vi.fn() }));
vi.mock("../../../lib/authorized-fetch.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/authorized-fetch.js")>(),
  authorizedFetch,
}));

import { EditDeleteBar } from "../EditDeleteBar.js";
import { OPERATOR_SIGN_IN_NOTICE } from "../../../lib/auth-notices.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACTIONS = ["edit", "delete"] as const;
type Action = typeof ACTIONS[number];
const CODE = "explicit_credential_required";
const EXPLICIT_CREDENTIAL_REQUIRED = {
  error: CODE,
  message: "This decision needs an API key or a session key in the Authorization header; the sign-in cookie alone can't authorize it.",
};
const OWNER_COPY = {
  edit: "Only the registration owner can edit this.",
  delete: "Only the registration owner can delete this.",
};
const SIGN_IN_COPY = {
  edit: "Sign in to edit this registration.",
  delete: "Sign in to delete this registration.",
};
const COPIES = [OPERATOR_SIGN_IN_NOTICE, ...Object.values(OWNER_COPY), ...Object.values(SIGN_IN_COPY)];
let container: HTMLDivElement | undefined;
let root: Root | undefined;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function cleanup() {
  if (root) act(() => root!.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  authorizedFetch.mockReset();
}

beforeEach(() => authorizedFetch.mockReset());
afterEach(cleanup);

async function click(button: HTMLButtonElement) {
  await act(async () => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

function statusLines() {
  return [...container!.querySelectorAll("div")].filter((element) => element.className === "text-xs text-red-400/70");
}

async function expectRefusal(action: Action, response: Response, expected: string) {
  cleanup();
  const jsonRead = vi.spyOn(response, "json");
  const textRead = vi.spyOn(response, "text");
  const arrayBufferRead = vi.spyOn(response, "arrayBuffer");
  const blobRead = vi.spyOn(response, "blob");
  const formDataRead = vi.spyOn(response, "formData");
  const clone = vi.spyOn(response, "clone");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<EditDeleteBar operatorId="reg-md-1" />); });
  const opener = [...container.querySelectorAll("button")].find((button) => button.textContent === (action === "edit" ? "Edit" : "Delete"));
  expect(opener, action).toBeDefined();
  await click(opener!);
  const submit = [...container.querySelectorAll("button")].filter((button) => button.textContent !== "Cancel");
  expect(submit, action).toHaveLength(1);
  authorizedFetch.mockResolvedValueOnce(response);
  await click(submit[0]);
  for (let n = 0; n < 10 && statusLines().length === 0; n++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  expect(authorizedFetch, action).toHaveBeenCalledTimes(1);
  expect(authorizedFetch, action).toHaveBeenCalledWith(
    "/api/onboard/registrations/reg-md-1",
    expect.objectContaining({ method: action === "edit" ? "PATCH" : "DELETE" }),
  );
  expect(statusLines(), action).toHaveLength(1);
  expect(statusLines()[0].textContent, action).toBe(expected);
  for (const copy of COPIES.filter((copy) => copy !== expected)) {
    expect(container.textContent, action).not.toContain(copy);
  }
  expect(jsonRead, action).toHaveBeenCalledTimes(1);
  expect(textRead, action).not.toHaveBeenCalled();
  expect(arrayBufferRead, action).not.toHaveBeenCalled();
  expect(blobRead, action).not.toHaveBeenCalled();
  expect(formDataRead, action).not.toHaveBeenCalled();
  expect(clone, action).not.toHaveBeenCalled();
}

describe("EditDeleteBar refusal notices", () => {
  it("EB1 an explicit-credential 403 shows the sign-in notice on edit and on delete", async () => {
    for (const action of ACTIONS) {
      for (const body of [EXPLICIT_CREDENTIAL_REQUIRED, { error: CODE }]) {
        await expectRefusal(action, json(body, 403), OPERATOR_SIGN_IN_NOTICE);
      }
    }
  });

  it("EB2 any other 403 keeps the owner-only copy on edit and on delete", async () => {
    for (const action of ACTIONS) {
      for (const body of [
        { error: "forbidden" }, { error: CODE + "_extra" }, { error: CODE.toUpperCase() },
        { message: CODE }, CODE, null,
      ]) {
        await expectRefusal(action, json(body, 403), OWNER_COPY[action]);
      }
      for (const body of ["not json", ""]) {
        await expectRefusal(action, new Response(body, { status: 403 }), OWNER_COPY[action]);
      }
    }
  });

  it("EB3 a 401 keeps the sign-in copy on edit and on delete, whatever its body", async () => {
    for (const action of ACTIONS) {
      for (const body of [{ error: CODE }, EXPLICIT_CREDENTIAL_REQUIRED, { error: "unauthorized" }]) {
        await expectRefusal(action, json(body, 401), SIGN_IN_COPY[action]);
      }
      await expectRefusal(action, new Response("not json", { status: 401 }), SIGN_IN_COPY[action]);
    }
  });

  it("EB4 any other refusal keeps the reply's own message", async () => {
    for (const action of ACTIONS) {
      await expectRefusal(action, json({ error: "deleted", message: "Registration was soft-deleted" }, 410), "Registration was soft-deleted");
      await expectRefusal(action, json({ error: CODE }, 400), CODE);
      await expectRefusal(action, json({ error: "not_found" }, 404), "not_found");
      await expectRefusal(action, new Response("not json", { status: 500 }), "HTTP 500");
    }
  });

  it("EB5 each refusal reads the reply body once", async () => {
    for (const action of ACTIONS) {
      await expectRefusal(action, json(EXPLICIT_CREDENTIAL_REQUIRED, 403), OPERATOR_SIGN_IN_NOTICE);
      await expectRefusal(action, json({ error: "forbidden" }, 403), OWNER_COPY[action]);
      await expectRefusal(action, json(null, 403), OWNER_COPY[action]);
      await expectRefusal(action, new Response("not json", { status: 403 }), OWNER_COPY[action]);
      await expectRefusal(action, json({ error: "unauthorized" }, 401), SIGN_IN_COPY[action]);
      await expectRefusal(action, json({ error: "deleted", message: "Registration was soft-deleted" }, 410), "Registration was soft-deleted");
      await expectRefusal(action, new Response("not json", { status: 500 }), "HTTP 500");
    }
  });

  it("EB6 each owner-only literal appears once in the edit bar", () => {
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../EditDeleteBar.tsx"), "utf-8");
    for (const copy of Object.values(OWNER_COPY)) {
      expect(source.split(copy).length - 1, copy).toBe(1);
    }
  });
});
