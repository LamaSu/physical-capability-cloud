/**
 * R39 cold start on Linux. These tests spawn real child processes (a missing
 * interpreter and /bin/false), never Python and never pylabrobot.
 *
 * Before the fix:
 *  - the default interpreter was "python", which many Linux hosts lack;
 *  - a spawn failure was re-emitted as an EventEmitter "error", which throws
 *    and takes the host down when nobody listens;
 *  - the restart counter reset as soon as a spawn call returned, so a child
 *    that exits at once was restarted forever.
 */

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { SidecarClient, SidecarError, defaultPythonPath } from "../sidecar-client.js";
import { RPC_ERROR_CODES } from "../protocol.js";

function once<T = unknown>(client: SidecarClient, event: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no "${event}" within ${timeoutMs}ms`)), timeoutMs);
    client.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

describe("defaultPythonPath", () => {
  it("is python3 off Windows and python on Windows", () => {
    expect(defaultPythonPath("linux")).toBe("python3");
    expect(defaultPythonPath("darwin")).toBe("python3");
    expect(defaultPythonPath("win32")).toBe("python");
  });
});

describe("SidecarClient cold start", () => {
  it("a missing interpreter fails the call with a typed error, does not throw, and is not retried", async () => {
    const client = new SidecarClient({
      pythonPath: "/nonexistent/pcc-python-for-tests",
      initialBackoffMs: 5,
      maxRestarts: 3,
    });
    // Deliberately no "error" listener: an unhandled "error" emit would throw here.
    const gaveUp = once<{ reason?: string }>(client, "gave_up");
    const spawnError = once<SidecarError>(client, "spawn_error");
    await client.start();
    const call = client.call("health.ping", {}, 5000);

    const err = await spawnError;
    expect(err).toBeInstanceOf(SidecarError);
    expect(err.code).toBe(RPC_ERROR_CODES.HARDWARE_UNREACHABLE);
    await expect(call).rejects.toMatchObject({ code: RPC_ERROR_CODES.HARDWARE_UNREACHABLE });
    expect((await gaveUp).reason).toBe("spawn_failed");
    expect(client.isAlive()).toBe(false);
  });

  it.runIf(existsSync("/bin/false"))(
    "a child that exits at once is restarted maxRestarts times, then given up on",
    async () => {
      const client = new SidecarClient({ pythonPath: "/bin/false", initialBackoffMs: 5, maxBackoffMs: 20, maxRestarts: 2 });
      let restarts = 0;
      client.on("restart_scheduled", () => {
        restarts += 1;
      });
      const gaveUp = once<{ attempts: number }>(client, "gave_up", 5000);
      await client.start();
      const result = await gaveUp;
      expect(result.attempts).toBe(2);
      expect(restarts).toBe(2);
      await client.stop();
    },
  );
});
