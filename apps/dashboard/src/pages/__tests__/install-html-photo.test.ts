// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PUBLIC = resolve(__dirname, "../../../public");
const HTML = readFileSync(join(PUBLIC, "install.html"), "utf8");
const BODY = HTML.slice(HTML.indexOf("<body>") + "<body>".length, HTML.indexOf("<script>"));
const SCRIPT = HTML.slice(HTML.indexOf("<script>") + "<script>".length, HTML.indexOf("</script>"));
const PREFIX = "data:image/jpeg;base64,";
const DATA_URL = PREFIX + "AAAA";
const TOO_LARGE = "This photo is too large to send, even after scaling it down. Try another photo.";
const UNREADABLE = "This page couldn't read that file as a photo. Try a JPEG, PNG or WebP.";

const fetchMock = vi.fn(async (_url: string, _options?: RequestInit): Promise<Pick<Response, "ok" | "status" | "json">> => ({
  ok: true,
  status: 200,
  json: async () => ({ candidates: [] }),
}));

function boot(script = SCRIPT) {
  document.body.innerHTML = BODY;
  new Function(script)();
}

function stubPhoto(width = 4000, height = 3000, dataUrl = DATA_URL) {
  const bitmap = { width, height, close: vi.fn() };
  const decode = vi.fn().mockResolvedValue(bitmap);
  vi.stubGlobal("createImageBitmap", decode);
  const fillStyles: string[] = [];
  const ctx = {
    fillStyle: "",
    fillRect: vi.fn(function (this: { fillStyle: string }) {
      fillStyles.push(this.fillStyle);
    }),
    drawImage: vi.fn(),
  };
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  const encodedSizes: [number, number][] = [];
  const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL")
    .mockImplementation(function (this: HTMLCanvasElement) {
      encodedSizes.push([this.width, this.height]);
      return dataUrl;
    });
  return { bitmap, decode, ctx, fillStyles, getContext, toDataURL, encodedSizes };
}

async function pickPhoto() {
  const file = new File([new Uint8Array(3_000_000)], "photo.jpg", { type: "image/jpeg" });
  const input = document.getElementById("device-photo") as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(0);
  return file;
}

async function pressIdentify(text = "") {
  (document.getElementById("device-text") as HTMLInputElement).value = text;
  document.getElementById("identify-btn")!.click();
  await vi.advanceTimersByTimeAsync(0);
}

function expectPhotoPost(dataUrl: string) {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, options] = fetchMock.mock.calls[0];
  expect(url).toBe("/api/onboard/identify-device");
  expect(options?.method).toBe("POST");
  expect(options?.headers).toEqual({ "Content-Type": "application/json" });
  expect(JSON.parse(options?.body as string)).toEqual({ photoBase64: dataUrl });
}

async function expectRefusal(message: string) {
  const status = document.getElementById("photo-status")!;
  expect(status.textContent).toBe(message);
  expect(status.classList.contains("ok")).toBe(false);
  await pressIdentify();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(document.getElementById("resolver-err")!.textContent)
    .toBe("Type a device name or attach a photo first.");
  expect(document.getElementById("resolver-err")!.style.display).toBe("");
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ candidates: [] }) });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("/install.html photo sending and status", () => {
  it.each([
    [4000, 3000, 1238, 928],
    [1000, 800, 1000, 800],
  ])("L1: the page sends a %i × %i photo as a %i × %i JPEG", async (w, h, width, height) => {
    const photo = stubPhoto(w, h);
    boot();
    const file = await pickPhoto();

    expect(photo.decode).toHaveBeenCalledTimes(1);
    expect(photo.decode).toHaveBeenCalledWith(file, { imageOrientation: "from-image" });
    expect(photo.getContext).toHaveBeenCalledTimes(1);
    expect(photo.getContext).toHaveBeenCalledWith("2d");
    expect(photo.ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(photo.ctx.drawImage).toHaveBeenCalledWith(photo.bitmap, 0, 0, width, height);
    expect(photo.toDataURL).toHaveBeenCalledTimes(1);
    expect(photo.toDataURL).toHaveBeenCalledWith("image/jpeg", 0.85);
    expect(photo.encodedSizes).toEqual([[width, height]]);
    expect(photo.bitmap.close).toHaveBeenCalledTimes(1);
    expect(photo.bitmap.close.mock.invocationCallOrder[0])
      .toBeGreaterThan(photo.ctx.drawImage.mock.invocationCallOrder[0]);
    expect(photo.bitmap.close.mock.invocationCallOrder[0])
      .toBeLessThan(photo.toDataURL.mock.invocationCallOrder[0]);

    await pressIdentify();
    expectPhotoPost(DATA_URL);
  });

  it.each([
    [1000, 6000, 261, 1568],
    [6000, 1000, 1568, 261],
    [1939, 277, 1568, 224],
  ])("L1b: the page sends a %i × %i photo as a %i × %i JPEG at the edge limit", async (w, h, width, height) => {
    const photo = stubPhoto(w, h);
    boot();
    await pickPhoto();

    expect(photo.ctx.drawImage).toHaveBeenCalledWith(photo.bitmap, 0, 0, width, height);
    expect(photo.encodedSizes).toEqual([[width, height]]);
    expect(photo.toDataURL).toHaveBeenCalledTimes(1);
    await pressIdentify();
    expectPhotoPost(DATA_URL);
  });

  it("L2: the page refuses a 1,000,001-character photo, clears the input and shows why it sends nothing", async () => {
    const photo = stubPhoto(4000, 3000, PREFIX + "A".repeat(1_000_001 - PREFIX.length));
    boot();
    const input = document.getElementById("device-photo") as HTMLInputElement;
    const valueSetter = vi.spyOn(input, "value", "set");
    await pickPhoto();

    expect(photo.toDataURL).toHaveBeenCalledTimes(1);
    expect(valueSetter).toHaveBeenCalledTimes(1);
    expect(valueSetter).toHaveBeenCalledWith("");
    await expectRefusal(TOO_LARGE);
  });

  it("L2: the page sends a photo of exactly 1,000,000 characters and shows it attached", async () => {
    const dataUrl = PREFIX + "A".repeat(1_000_000 - PREFIX.length);
    const photo = stubPhoto(4000, 3000, dataUrl);
    boot();
    await pickPhoto();

    const status = document.getElementById("photo-status")!;
    expect(status.textContent).toMatch(/^✓ photo attached \(/);
    expect(status.classList.contains("ok")).toBe(true);
    expect(photo.toDataURL).toHaveBeenCalledTimes(1);
    await pressIdentify();
    expectPhotoPost(dataUrl);
  });

  it("L2: the page drops an earlier attached photo when the next is too large and sends nothing", async () => {
    const photo = stubPhoto();
    boot();
    await pickPhoto();
    expect(document.getElementById("photo-status")!.classList.contains("ok")).toBe(true);

    photo.toDataURL.mockReturnValue(PREFIX + "A".repeat(1_000_001 - PREFIX.length));
    await pickPhoto();
    await expectRefusal(TOO_LARGE);
  });

  it.each(["decode rejection", "null context", "encode throw"] as const)(
    "L3: the page sends nothing and shows an unreadable photo after a %s",
    async (cause) => {
      const photo = stubPhoto();
      if (cause === "decode rejection") photo.decode.mockRejectedValue(new Error("decode failed"));
      if (cause === "null context") photo.getContext.mockReturnValue(null);
      if (cause === "encode throw") photo.toDataURL.mockImplementation(() => { throw new Error("encode failed"); });
      boot();
      await pickPhoto();

      expect(photo.bitmap.close).toHaveBeenCalledTimes(cause === "decode rejection" ? 0 : 1);
      await expectRefusal(UNREADABLE);
    },
  );

  it.each([
    ["A".repeat(409_600), 300],
    ["A".repeat(410_282) + "==", 300],
    ["A".repeat(410_400), 301],
  ])("L4: the page shows the sent JPEG's size for base64 row %#", async (base64, kb) => {
    const dataUrl = PREFIX + base64;
    stubPhoto(4000, 3000, dataUrl);
    boot();
    await pickPhoto();

    const status = document.getElementById("photo-status")!;
    expect(status.textContent).toBe("✓ photo attached (" + kb + " KB)");
    expect(status.classList.contains("ok")).toBe(true);
    await pressIdentify();
    expectPhotoPost(dataUrl);
  });

  it("L5: the page sends the device name, then shows that it stopped waiting at 90 seconds", async () => {
    fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    }));
    boot();
    await pressIdentify("Prusa MK4");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/onboard/identify-device");
    expect(JSON.parse(options?.body as string)).toEqual({ text: "Prusa MK4" });
    const signal = options?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);

    await vi.advanceTimersByTimeAsync(89_999);
    const button = document.getElementById("identify-btn") as HTMLButtonElement;
    const error = document.getElementById("resolver-err")!;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Identifying…");
    expect(error.style.display).toBe("none");
    expect(signal!.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(signal!.aborted).toBe(true);
    expect(error.style.display).toBe("");
    expect(error.textContent).toBe("Identification failed: the page stopped waiting after 90 seconds. Try again.");
    expect(document.getElementById("results")!.innerHTML).toBe("");
    expect(button.textContent).toBe("Identify →");
    expect(button.disabled).toBe(false);
  });

  it.each([
    ["network", "Identification failed: Failed to fetch"],
    ["502 reply", "Identification failed: Identification model unavailable, try again"],
  ])("L5b: the page shows the %s failure from the identification request", async (cause, message) => {
    if (cause === "network") fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    else fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({ error: "Identification model unavailable, try again" }),
    });
    boot();
    await pressIdentify("Prusa MK4");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.getElementById("resolver-err")!.textContent).toBe(message);
    expect(document.getElementById("resolver-err")!.style.display).toBe("");
    expect(document.getElementById("results")!.innerHTML).toBe("");
    const button = document.getElementById("identify-btn") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Identify →");
  });

  it.each(["200 reply", "network failure"])(
    "L5c: the page clears its waiting timer after showing a %s",
    async (outcome) => {
      if (outcome === "network failure") fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      boot();
      const timersBefore = vi.getTimerCount();
      await pressIdentify("Prusa MK4");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(timersBefore);
    },
  );

  it("L6: the page pins its photo sending limits and the refusal messages it shows", () => {
    for (const line of [
      "const PHOTO_MAX_EDGE = 1568;",
      "const PHOTO_MAX_AREA = 1150000;",
      "const PHOTO_JPEG_QUALITY = 0.85;",
      "const PHOTO_MAX_CHARS = 1000000;",
      "const IDENTIFY_WAIT_MS = 90000;",
      "'" + TOO_LARGE + "'",
      '"' + UNREADABLE + '"',
      "{ imageOrientation: 'from-image' }",
      "ctx.fillStyle = '#ffffff';",
      "bitmap.close();",
      "photoFileEl.value = '';",
    ]) {
      expect(SCRIPT.split(line), line).toHaveLength(2);
    }
  });

  it("L7: the page puts white behind transparent pixels before drawing the JPEG it sends", async () => {
    const photo = stubPhoto();
    boot();
    await pickPhoto();

    expect(photo.ctx.fillRect).toHaveBeenCalledTimes(1);
    expect(photo.ctx.fillRect).toHaveBeenCalledWith(0, 0, 1238, 928);
    expect(photo.fillStyles).toEqual(["#ffffff"]);
    expect(photo.ctx.fillRect.mock.invocationCallOrder[0])
      .toBeLessThan(photo.ctx.drawImage.mock.invocationCallOrder[0]);
    await pressIdentify();
    expectPhotoPost(DATA_URL);
  });
});
