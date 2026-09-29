/**
 * WP-A round 7 (wpa-326-admingates-r2-astra AG-10): no request path can mint an
 * `admin` key. The review could not verify the old N/A ("rejecting '*' does not
 * establish that initial issuance cannot grant admin"). So it is now STRUCTURAL:
 *   - provisionApiKey, the only mint function, refuses a scope set containing
 *     `admin` unless the caller passes allowAdmin: true;
 *   - allowAdmin appears nowhere in gateway source except api-key-auth.ts itself
 *     (the out-of-band procedure is docs/security/WILDCARD_KEY_ROTATION.md);
 *   - self-service provisioning ignores a body that asks for `admin` or "*".
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { provisionRoutes } from "../routes/provision.js";
import { initStore, closeStore } from "../db.js";

vi.mock("../telemetry.js", () => ({ pipelineTelemetry: { emit: vi.fn() } }));
vi.mock("../services/audit-service.js", () => ({ auditService: { log: vi.fn() } }));
vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn() }));
vi.mock("../middleware/security-hardening.js", () => ({ canProvision: vi.fn(() => true) }));

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
let app: FastifyInstance;

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  app = Fastify({ logger: false });
  await app.register(provisionRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeStore();
});

describe("admin is never minted by a request path", () => {
  it("[neg] provisionApiKey refuses `admin` without allowAdmin, and persists nothing", () => {
    for (const scopes of [["admin"], ["operator", "admin"]]) {
      expect(() => provisionApiKey({ operatorId: "mint-probe@x.test", scopes })).toThrow(/never minted by a request path/);
    }
  });

  it("control: the out-of-band procedure (allowAdmin: true) still works", () => {
    const r = provisionApiKey({ operatorId: "ops-oob@x.test", scopes: ["admin"], allowAdmin: true, expiresInDays: 1 });
    expect(JSON.parse(r.record.scopes as unknown as string)).toEqual(["admin"]);
  });

  it("[neg] no gateway source other than api-key-auth.ts passes allowAdmin", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== "__tests__" && name !== "node_modules") walk(p);
        } else if (/\.ts$/.test(name) && !p.endsWith(join("auth", "api-key-auth.ts")) && readFileSync(p, "utf8").includes("allowAdmin")) {
          offenders.push(p.slice(SRC.length + 1));
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });

  it("[neg] self-service provisioning ignores a body that asks for `admin` or '*'", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      payload: { email: `admin-ask-${Date.now()}@example.com`, scopes: ["admin", "*"], role: "admin" },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { scopes: string[] }).scopes).toEqual(["operator"]);
  });
});
