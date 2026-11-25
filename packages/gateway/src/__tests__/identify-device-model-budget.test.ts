import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  __resetIdentifyDeviceBudgetForTest,
  IDENTIFY_DEVICE_GLOBAL_LIMIT as LIMIT,
  IDENTIFY_DEVICE_GLOBAL_WINDOW_MS,
  identifyDeviceRoutes,
} from "../routes/identify-device.js";

const sdk = vi.hoisted(() => ({ create: vi.fn(), constructed: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropic {
    messages = { create: sdk.create };
    constructor(options: unknown) {
      sdk.constructed(options);
    }
  },
}));

const FAKE_KEY = "device-budget-test-key";
const VALID_BODY = { text: "Hamilton Microlab Prep liquid handler" };
const PHOTO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9z8AAAAASUVORK5CYII=";
const PER_ADDRESS_BODY = { error: "Too many identification requests, try again in an hour" };
const BUSY_BODY = {
  error: "Device identification is busy right now. Try again later.",
  retry_after_seconds: IDENTIFY_DEVICE_GLOBAL_WINDOW_MS / 1000,
};

function modelReply() {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        candidates: [{
          vendor: "Hamilton",
          model: "Microlab Prep",
          confidence: 0.95,
          mappedAdapterType: "hamilton",
          reasoning: "The description names the device.",
        }],
        clarifyingQuestions: [],
        askForPhoto: false,
      }),
    }],
  };
}

const apps: FastifyInstance[] = [];
let addressIndex = 0;

// Every generated address is unused in this cell and belongs to a documentation range.
function newAddress(): string {
  const prefixes = ["192.0.2", "198.51.100", "203.0.113"];
  const index = addressIndex++;
  if (index >= prefixes.length * 254) throw new Error("Documentation addresses exhausted");
  return `${prefixes[Math.floor(index / 254)]}.${index % 254 + 1}`;
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  app.register(identifyDeviceRoutes);
  await app.ready();
  return app;
}

function send(app: FastifyInstance, remoteAddress: string, payload: object = VALID_BODY) {
  return app.inject({
    method: "POST",
    url: "/api/onboard/identify-device",
    remoteAddress,
    payload,
  });
}

type Response = Awaited<ReturnType<typeof send>>;

function expectBusy(response: Response): void {
  expect(response.statusCode).toBe(429);
  expect(response.json()).toEqual(BUSY_BODY);
}

beforeEach(() => {
  __resetIdentifyDeviceBudgetForTest();
  sdk.create.mockReset();
  sdk.create.mockResolvedValue(modelReply());
  sdk.constructed.mockClear();
  addressIndex = 0;
  vi.stubEnv("ANTHROPIC_API_KEY", FAKE_KEY);
});

afterEach(async () => {
  try {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  } finally {
    __resetIdentifyDeviceBudgetForTest();
    sdk.create.mockReset();
    sdk.constructed.mockClear();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  }
});

describe("device identification model-call budget", () => {
  it("KD1 the model-call budget refuses calls past its limit across apps", async () => {
    const app = await buildApp();
    for (let i = 0; i < LIMIT; i++) {
      expect((await send(app, newAddress())).statusCode).toBe(200);
    }
    expect(sdk.create).toHaveBeenCalledTimes(LIMIT);
    expect(sdk.constructed).toHaveBeenCalledTimes(LIMIT);

    expectBusy(await send(app, newAddress()));
    expect(sdk.create).toHaveBeenCalledTimes(LIMIT);
    expect(sdk.constructed).toHaveBeenCalledTimes(LIMIT);

    const secondApp = await buildApp();
    expectBusy(await send(secondApp, newAddress()));
    expect(sdk.create).toHaveBeenCalledTimes(LIMIT);
    expect(sdk.constructed).toHaveBeenCalledTimes(LIMIT);
  });

  it("KD2 the model-call budget excludes requests refused by earlier gates", async () => {
    const app = await buildApp();
    const addressA = newAddress();
    for (let i = 0; i < 30; i++) {
      const response = await send(app, addressA, {});
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "Provide text, photoBase64, or both" });
    }
    const perAddress = await send(app, addressA);
    expect(perAddress.statusCode).toBe(429);
    expect(perAddress.json()).toEqual(PER_ADDRESS_BODY);

    const tooLong = await send(app, newAddress(), { text: "x".repeat(2001) });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json()).toEqual({ error: "Text too long (max 2000 chars)" });

    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const noKey = await send(app, newAddress());
    expect(noKey.statusCode).toBe(503);
    expect(noKey.json()).toEqual({ error: "Device identification temporarily unavailable" });
    vi.stubEnv("ANTHROPIC_API_KEY", FAKE_KEY);
    expect(sdk.create).not.toHaveBeenCalled();
    expect(sdk.constructed).not.toHaveBeenCalled();

    for (let i = 0; i < LIMIT; i++) {
      expect((await send(app, newAddress())).statusCode).toBe(200);
    }
    expectBusy(await send(app, newAddress()));
    expect(sdk.create).toHaveBeenCalledTimes(LIMIT);
    expect(sdk.constructed).toHaveBeenCalledTimes(LIMIT);
  });

  it("KD3 the model-call budget holds at the window boundary and then renews", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.UTC(2026, 0, 1);
    vi.setSystemTime(t0);
    const app = await buildApp();
    for (let i = 0; i < LIMIT; i++) {
      expect((await send(app, newAddress())).statusCode).toBe(200);
    }

    vi.setSystemTime(t0 + IDENTIFY_DEVICE_GLOBAL_WINDOW_MS);
    expectBusy(await send(app, newAddress()));
    expect(sdk.create).toHaveBeenCalledTimes(LIMIT);
    expect(sdk.constructed).toHaveBeenCalledTimes(LIMIT);

    vi.setSystemTime(t0 + IDENTIFY_DEVICE_GLOBAL_WINDOW_MS + 1);
    expect((await send(app, newAddress())).statusCode).toBe(200);
    for (let i = 0; i < LIMIT - 1; i++) {
      expect((await send(app, newAddress())).statusCode).toBe(200);
    }
    expectBusy(await send(app, newAddress()));
    expect(sdk.create).toHaveBeenCalledTimes(LIMIT * 2);
    expect(sdk.constructed).toHaveBeenCalledTimes(LIMIT * 2);
  });

  it("KD3b the model-call budget renews a whole window from its first call", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.UTC(2026, 0, 1);
    vi.setSystemTime(t0);
    const app = await buildApp();

    expect((await send(app, newAddress())).statusCode).toBe(200);
    expect(sdk.create).toHaveBeenCalledTimes(1);
    expect(sdk.constructed).toHaveBeenCalledTimes(1);

    vi.setSystemTime(t0 + IDENTIFY_DEVICE_GLOBAL_WINDOW_MS);
    for (let i = 0; i < LIMIT - 1; i++) {
      expect((await send(app, newAddress())).statusCode).toBe(200);
    }
    expectBusy(await send(app, newAddress()));
    expect(sdk.create).toHaveBeenCalledTimes(LIMIT);
    expect(sdk.constructed).toHaveBeenCalledTimes(LIMIT);

    vi.setSystemTime(t0 + IDENTIFY_DEVICE_GLOBAL_WINDOW_MS + 1);
    for (let i = 0; i < LIMIT; i++) {
      expect((await send(app, newAddress())).statusCode).toBe(200);
    }
    expectBusy(await send(app, newAddress()));
    expect(sdk.create).toHaveBeenCalledTimes(2 * LIMIT);
    expect(sdk.constructed).toHaveBeenCalledTimes(2 * LIMIT);

    vi.setSystemTime(t0 + 2 * IDENTIFY_DEVICE_GLOBAL_WINDOW_MS + 1);
    expectBusy(await send(app, newAddress()));
    expect(sdk.create).toHaveBeenCalledTimes(2 * LIMIT);
    expect(sdk.constructed).toHaveBeenCalledTimes(2 * LIMIT);

    vi.setSystemTime(t0 + 2 * IDENTIFY_DEVICE_GLOBAL_WINDOW_MS + 2);
    expect((await send(app, newAddress())).statusCode).toBe(200);
    expect(sdk.create).toHaveBeenCalledTimes(2 * LIMIT + 1);
    expect(sdk.constructed).toHaveBeenCalledTimes(2 * LIMIT + 1);
  });

  it("KD4 the model-call budget counts failed and unusable model replies", async () => {
    const app = await buildApp();
    const unparseable = "not JSON";
    const errors = [
      { error: "Identification model unavailable, try again" },
      { error: "Model returned no text" },
      { error: "Model returned unparseable output", raw: unparseable },
    ];
    for (let i = 0; i < LIMIT; i++) {
      const failure = i % errors.length;
      if (failure === 0) sdk.create.mockRejectedValueOnce(new Error("model offline"));
      else if (failure === 1) sdk.create.mockResolvedValueOnce({ content: [] });
      else sdk.create.mockResolvedValueOnce({ content: [{ type: "text", text: unparseable }] });

      const response = await send(app, newAddress());
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual(errors[failure]);
    }
    expect(sdk.create).toHaveBeenCalledTimes(LIMIT);
    expect(sdk.constructed).toHaveBeenCalledTimes(LIMIT);
    expectBusy(await send(app, newAddress()));
    expect(sdk.create).toHaveBeenCalledTimes(LIMIT);
    expect(sdk.constructed).toHaveBeenCalledTimes(LIMIT);
  });

  it("KD5 the model-call budget counts text and photo calls together", async () => {
    const app = await buildApp();
    for (let i = 0; i < LIMIT; i++) {
      const withPhoto = i % 2 === 1;
      const payload = withPhoto ? { photoBase64: PHOTO } : VALID_BODY;
      expect((await send(app, newAddress(), payload)).statusCode).toBe(200);
      const content = sdk.create.mock.calls[i][0].messages[0].content;
      const images = content.filter((block: { type: string }) => block.type === "image");
      expect(images).toHaveLength(withPhoto ? 1 : 0);
      if (withPhoto) {
        expect(images[0]).toEqual({
          type: "image",
          source: { type: "base64", media_type: "image/png", data: PHOTO.split(",")[1] },
        });
      }
    }
    expectBusy(await send(app, newAddress()));
    expectBusy(await send(app, newAddress(), { photoBase64: PHOTO }));
    expect(sdk.create).toHaveBeenCalledTimes(LIMIT);
    expect(sdk.constructed).toHaveBeenCalledTimes(LIMIT);
  });

  it("KD6 the per-address gate keeps its own limit and runs before the model-call budget", async () => {
    const app = await buildApp();
    const addressX = newAddress();
    for (let i = 0; i < 30; i++) {
      expect((await send(app, addressX)).statusCode).toBe(200);
    }
    const perAddress = await send(app, addressX);
    expect(perAddress.statusCode).toBe(429);
    expect(perAddress.json()).toEqual(PER_ADDRESS_BODY);
    expect(sdk.create).toHaveBeenCalledTimes(30);
    expect(sdk.constructed).toHaveBeenCalledTimes(30);

    for (let i = 0; i < LIMIT - 30; i++) {
      expect((await send(app, newAddress())).statusCode).toBe(200);
    }
    expectBusy(await send(app, newAddress()));
    const stillPerAddress = await send(app, addressX);
    expect(stillPerAddress.statusCode).toBe(429);
    expect(stillPerAddress.json()).toEqual(PER_ADDRESS_BODY);
    expect(sdk.create).toHaveBeenCalledTimes(LIMIT);
    expect(sdk.constructed).toHaveBeenCalledTimes(LIMIT);
  });

  it("KD7 the model-call budget pins the limit, window and retry numbers", async () => {
    expect(LIMIT).toBe(120);
    expect(IDENTIFY_DEVICE_GLOBAL_WINDOW_MS).toBe(3_600_000);
    const app = await buildApp();
    for (let i = 0; i < 120; i++) {
      expect((await send(app, newAddress())).statusCode).toBe(200);
    }
    const response = await send(app, newAddress());
    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({
      error: "Device identification is busy right now. Try again later.",
      retry_after_seconds: 3600,
    });
    expect(sdk.create).toHaveBeenCalledTimes(120);
    expect(sdk.constructed).toHaveBeenCalledTimes(120);
  });

  it("KD8 the model-call budget reserves concurrent calls before their replies", async () => {
    const app = await buildApp();
    const release: Array<() => void> = [];
    sdk.create.mockImplementation(() => new Promise((resolve) => {
      release.push(() => resolve(modelReply()));
    }));
    const finished: Response[] = [];
    const pending = Array.from({ length: LIMIT + 3 }, () =>
      send(app, newAddress()).then((response) => {
        finished.push(response);
        return response;
      }),
    );

    try {
      await vi.waitFor(() => {
        expect(sdk.create.mock.calls.length + finished.length).toBe(LIMIT + 3);
      }, { timeout: 4000 });
      expect(sdk.create).toHaveBeenCalledTimes(LIMIT);
      expect(sdk.constructed).toHaveBeenCalledTimes(LIMIT);
      expect(finished).toHaveLength(3);
      for (const response of finished) expectBusy(response);

      for (const resolve of release) resolve();
      const responses = await Promise.all(pending);
      expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(LIMIT);
      expect(responses.filter((response) => response.statusCode === 429)).toHaveLength(3);
      expect(sdk.create).toHaveBeenCalledTimes(LIMIT);
      expect(sdk.constructed).toHaveBeenCalledTimes(LIMIT);
    } finally {
      for (const resolve of release) resolve();
      await Promise.all(pending);
    }
  });

  it("KD9 the model-call budget counts handlers that resume together in one step", async () => {
    const app = Fastify();
    apps.push(app);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let arrivals = 0;
    app.addHook("preHandler", async () => {
      arrivals++;
      if (arrivals === LIMIT + 3) open();
      await gate;
    });
    app.register(identifyDeviceRoutes);
    await app.ready();

    const release: Array<() => void> = [];
    sdk.create.mockImplementation(() => new Promise((resolve) => {
      release.push(() => resolve(modelReply()));
    }));
    const finished: Response[] = [];
    const pending = Array.from({ length: LIMIT + 3 }, () =>
      send(app, newAddress()).then((response) => {
        finished.push(response);
        return response;
      }),
    );

    try {
      await vi.waitFor(() => {
        expect(sdk.create.mock.calls.length + finished.length).toBe(LIMIT + 3);
      }, { timeout: 4000 });
      expect(sdk.create).toHaveBeenCalledTimes(LIMIT);
      expect(sdk.constructed).toHaveBeenCalledTimes(LIMIT);
      expect(finished).toHaveLength(3);
      for (const response of finished) expectBusy(response);

      for (const resolve of release) resolve();
      const responses = await Promise.all(pending);
      expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(LIMIT);
      expect(responses.filter((response) => response.statusCode === 429)).toHaveLength(3);
      expect(sdk.create).toHaveBeenCalledTimes(LIMIT);
      expect(sdk.constructed).toHaveBeenCalledTimes(LIMIT);
    } finally {
      open();
      for (const resolve of release) resolve();
      await Promise.all(pending);
    }
  });

  it("KD10 the budget reset hook starts a new window at the next request", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.UTC(2026, 0, 1);
    vi.setSystemTime(t0);
    const app = await buildApp();

    for (let i = 0; i < LIMIT; i++) {
      expect((await send(app, newAddress())).statusCode).toBe(200);
    }
    expect(sdk.create).toHaveBeenCalledTimes(LIMIT);
    expect(sdk.constructed).toHaveBeenCalledTimes(LIMIT);

    vi.setSystemTime(t0 + IDENTIFY_DEVICE_GLOBAL_WINDOW_MS / 2);
    expectBusy(await send(app, newAddress()));
    expect(sdk.create).toHaveBeenCalledTimes(LIMIT);
    expect(sdk.constructed).toHaveBeenCalledTimes(LIMIT);

    __resetIdentifyDeviceBudgetForTest();
    expect(sdk.create).toHaveBeenCalledTimes(LIMIT);
    expect(sdk.constructed).toHaveBeenCalledTimes(LIMIT);

    for (let i = 0; i < LIMIT; i++) {
      expect((await send(app, newAddress())).statusCode).toBe(200);
    }
    expectBusy(await send(app, newAddress()));
    expect(sdk.create).toHaveBeenCalledTimes(2 * LIMIT);
    expect(sdk.constructed).toHaveBeenCalledTimes(2 * LIMIT);

    vi.setSystemTime(t0 + IDENTIFY_DEVICE_GLOBAL_WINDOW_MS + 1);
    expectBusy(await send(app, newAddress()));
    expect(sdk.create).toHaveBeenCalledTimes(2 * LIMIT);
    expect(sdk.constructed).toHaveBeenCalledTimes(2 * LIMIT);

    vi.setSystemTime(t0 + IDENTIFY_DEVICE_GLOBAL_WINDOW_MS / 2 + IDENTIFY_DEVICE_GLOBAL_WINDOW_MS + 1);
    expect((await send(app, newAddress())).statusCode).toBe(200);
    expect(sdk.create).toHaveBeenCalledTimes(2 * LIMIT + 1);
    expect(sdk.constructed).toHaveBeenCalledTimes(2 * LIMIT + 1);
  });

  it("KD11 the model-call budget excludes the route's own oversized-photo refusal", async () => {
    const app = Fastify({ bodyLimit: 16 * 1024 * 1024 });
    apps.push(app);
    app.register(identifyDeviceRoutes);
    await app.ready();

    const response = await send(app, newAddress(), { photoBase64: "A".repeat(8_388_612) });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({ error: "Photo too large (max 6MB)" });
    expect(sdk.create).toHaveBeenCalledTimes(0);
    expect(sdk.constructed).toHaveBeenCalledTimes(0);

    for (let i = 0; i < LIMIT; i++) {
      expect((await send(app, newAddress())).statusCode).toBe(200);
    }
    expect(sdk.create).toHaveBeenCalledTimes(LIMIT);
    expect(sdk.constructed).toHaveBeenCalledTimes(LIMIT);
    expectBusy(await send(app, newAddress()));
    expect(sdk.create).toHaveBeenCalledTimes(LIMIT);
    expect(sdk.constructed).toHaveBeenCalledTimes(LIMIT);
  });
});
