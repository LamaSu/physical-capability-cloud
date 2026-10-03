/**
 * A failed gateway read re-checks liveness at once, so the StatusBar does not
 * keep saying "Gateway online" until its next 30 s poll (operator-ux #2800).
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { recheckHealthOnReadFailure } from "../LiveStatusBar.js";

async function failQuery(client: QueryClient, key: string) {
  await client
    .fetchQuery({ queryKey: [key], queryFn: () => Promise.reject(new Error("Failed to fetch")), retry: false })
    .catch(() => undefined);
}

describe("recheckHealthOnReadFailure", () => {
  it("invalidates the health query when any other gateway read fails", async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    const unsubscribe = recheckHealthOnReadFailure(client);
    await failQuery(client, "kernels");
    expect(spy).toHaveBeenCalledWith({ queryKey: ["health"] });
    unsubscribe();
  });

  it("does not loop on a failed health read", async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    const unsubscribe = recheckHealthOnReadFailure(client);
    await failQuery(client, "health");
    expect(spy).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("stops after unsubscribe", async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    recheckHealthOnReadFailure(client)();
    await failQuery(client, "jobs");
    expect(spy).not.toHaveBeenCalled();
  });
});
