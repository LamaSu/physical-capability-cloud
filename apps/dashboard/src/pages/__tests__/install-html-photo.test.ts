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

async function pickPhoto(size = 3_000_000) {
  const file = new File([new Uint8Array(size)], "photo.jpg", { type: "image/jpeg" });
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function stubImagePhoto(failure?: "reader" | "image") {
  const photo = stubPhoto();
  vi.stubGlobal("createImageBitmap", undefined);
  const source = "data:image/png;base64,c291cmNl";
  const reader = {
    result: null as string | null,
    onload: null as (() => void) | null,
    onerror: null as (() => void) | null,
    readAsDataURL: vi.fn((_file: File) => {
      queueMicrotask(() => {
        if (failure === "reader") reader.onerror!();
        else {
          reader.result = source;
          reader.onload!();
        }
      });
    }),
  };
  let imageSrc = "";
  const image = {
    naturalWidth: 4000,
    naturalHeight: 3000,
    width: 40,
    height: 30,
    onload: null as (() => void) | null,
    onerror: null as (() => void) | null,
    close: vi.fn(),
    get src() { return imageSrc; },
    set src(value: string) { imageSrc = value; },
  };
  const setSrc = vi.spyOn(image, "src", "set").mockImplementation((value: string) => {
    imageSrc = value;
    expect(image.onload).toEqual(expect.any(Function));
    expect(image.onerror).toEqual(expect.any(Function));
    expect(value).toBe(source);
    queueMicrotask(() => {
      if (failure === "image") image.onerror!();
      else image.onload!();
    });
  });
  const makeReader = vi.fn(function () { return reader; });
  const makeImage = vi.fn(function () { return image; });
  const createObjectURL = vi.fn();
  vi.stubGlobal("FileReader", makeReader);
  vi.stubGlobal("Image", makeImage);
  vi.stubGlobal("URL", { createObjectURL });
  return { ...photo, source, reader, image, setSrc, makeReader, makeImage, createObjectURL };
}

function stubPendingPhotos() {
  const photo = stubPhoto();
  const first = {
    ...deferred<typeof photo.bitmap>(),
    bitmap: photo.bitmap,
    dataUrl: PREFIX + "A".repeat(4096),
    status: "✓ photo attached (3 KB)",
  };
  const second = {
    ...deferred<typeof photo.bitmap>(),
    bitmap: { width: 4000, height: 3000, close: vi.fn() },
    dataUrl: PREFIX + "B".repeat(8192),
    status: "✓ photo attached (6 KB)",
  };
  photo.decode.mockReset().mockReturnValueOnce(first.promise).mockReturnValue(second.promise);
  photo.toDataURL.mockImplementation(() =>
    photo.ctx.drawImage.mock.lastCall?.[0] === first.bitmap ? first.dataUrl : second.dataUrl);
  return { photo, first, second };
}

async function pressEnter() {
  document.getElementById("device-text")!.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter", bubbles: true, cancelable: true,
  }));
  await vi.advanceTimersByTimeAsync(0);
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
    [1568, 1176, 1238, 928],
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

    await pressIdentify();
    expectPhotoPost(DATA_URL);
  });

  it.each([
    [1000, 6000, 261, 1568],
    [6000, 1000, 1568, 261],
    [1939, 277, 1568, 224],
    [277, 1939, 224, 1568],
    [3000, 1000, 1568, 522],
    [1000, 3000, 522, 1568],
    [100000, 10, 1568, 1],
    [10, 100000, 1, 1568],
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

  it("L2: the page scales and sends a photo file over 6 MB instead of refusing it", async () => {
    stubPhoto(4000, 3000);
    boot();
    await pickPhoto(7 * 1024 * 1024);

    const status = document.getElementById("photo-status")!;
    expect(status.textContent).toMatch(/^✓ photo attached \(/);
    expect(status.classList.contains("ok")).toBe(true);
    await pressIdentify();
    expectPhotoPost(DATA_URL);
  });

  it.each(["decode rejection", "null context", "thrown encode"] as const)(
    "L3: the page sends nothing and shows an unreadable photo after a %s",
    async (cause) => {
      const photo = stubPhoto();
      if (cause === "decode rejection") photo.decode.mockRejectedValue(new Error("decode failed"));
      if (cause === "null context") photo.getContext.mockReturnValue(null);
      if (cause === "thrown encode") photo.toDataURL.mockImplementation(() => { throw new Error("encode failed"); });
      boot();
      await pickPhoto();

      expect(photo.bitmap.close).toHaveBeenCalledTimes(cause === "decode rejection" ? 0 : 1);
      await expectRefusal(UNREADABLE);
    },
  );

  it("L3: the page drops an earlier attached photo, clears the input and sends nothing when the next photo is unreadable", async () => {
    const photo = stubPhoto();
    boot();
    await pickPhoto();
    expect(document.getElementById("photo-status")!.classList.contains("ok")).toBe(true);

    photo.decode.mockRejectedValue(new Error("decode failed"));
    const input = document.getElementById("device-photo") as HTMLInputElement;
    const valueSetter = vi.spyOn(input, "value", "set");
    await pickPhoto();
    await expectRefusal(UNREADABLE);
    expect(valueSetter).toHaveBeenCalledTimes(1);
    expect(valueSetter).toHaveBeenCalledWith("");
  });

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

  it("L5: after the page stops waiting, it sends the next identify request with a fresh signal and shows that reply", async () => {
    fetchMock.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    }));
    boot();
    await pressIdentify("Prusa MK4");
    const firstSignal = fetchMock.mock.calls[0][1]?.signal;
    expect(firstSignal).toBeInstanceOf(AbortSignal);

    await vi.advanceTimersByTimeAsync(90_000);
    expect(firstSignal!.aborted).toBe(true);
    expect(document.getElementById("resolver-err")!.textContent)
      .toBe("Identification failed: the page stopped waiting after 90 seconds. Try again.");

    fetchMock.mockImplementationOnce((_url, options) => {
      if (options?.signal?.aborted) {
        return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ candidates: [] }) });
    });
    await pressIdentify("Prusa MK4");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondSignal = fetchMock.mock.calls[1][1]?.signal;
    expect(secondSignal).toBeInstanceOf(AbortSignal);
    expect(secondSignal).not.toBe(firstSignal);
    expect(secondSignal!.aborted).toBe(false);
    expect(document.getElementById("resolver-err")!.style.display).toBe("none");
    const button = document.getElementById("identify-btn") as HTMLButtonElement;
    expect(button.textContent).toBe("Identify →");
    expect(button.disabled).toBe(false);
  });

  it("L5: the page shows that it stopped waiting when 90 seconds run out during a 502 reply's body", async () => {
    fetchMock.mockImplementation(async (_url, options) => ({
      ok: false,
      status: 502,
      json: () => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      }),
    }));
    boot();
    await pressIdentify("Prusa MK4");

    await vi.advanceTimersByTimeAsync(90_000);
    expect(document.getElementById("resolver-err")!.textContent)
      .toBe("Identification failed: the page stopped waiting after 90 seconds. Try again.");
    const button = document.getElementById("identify-btn") as HTMLButtonElement;
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

  it("L8a: an orientation-option rejection retries once without options and sends the closed bitmap", async () => {
    const photo = stubPhoto();
    photo.decode.mockRejectedValueOnce(new TypeError("unsupported orientation"));
    boot();
    const file = await pickPhoto();

    expect(photo.decode.mock.calls).toEqual([[file, { imageOrientation: "from-image" }], [file]]);
    expect(photo.ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(photo.ctx.drawImage).toHaveBeenCalledWith(photo.bitmap, 0, 0, 1238, 928);
    expect(photo.bitmap.close).toHaveBeenCalledTimes(1);
    expect(document.getElementById("photo-status")!.classList.contains("ok")).toBe(true);
    await pressIdentify();
    expectPhotoPost(DATA_URL);
  });

  it("L8b: two decode rejections refuse the photo and enable Identify again", async () => {
    const photo = stubPhoto();
    photo.decode.mockRejectedValue(new TypeError("decode failed"));
    boot();
    const file = await pickPhoto();

    expect(photo.decode.mock.calls).toEqual([[file, { imageOrientation: "from-image" }], [file]]);
    expect(photo.bitmap.close).not.toHaveBeenCalled();
    await expectRefusal(UNREADABLE);
  });

  it("L8c: a successful first decode never makes a second decode", async () => {
    const photo = stubPhoto();
    boot();
    const file = await pickPhoto();

    expect(photo.decode.mock.calls).toEqual([[file, { imageOrientation: "from-image" }]]);
    await pressIdentify();
    expectPhotoPost(DATA_URL);
  });

  it("L9a: without createImageBitmap the reader's data URL loads an image and shares JPEG scaling", async () => {
    const photo = stubImagePhoto();
    boot();
    const file = await pickPhoto();

    expect(photo.makeReader).toHaveBeenCalledTimes(1);
    expect(photo.reader.readAsDataURL).toHaveBeenCalledTimes(1);
    expect(photo.reader.readAsDataURL).toHaveBeenCalledWith(file);
    expect(photo.makeImage).toHaveBeenCalledTimes(1);
    expect(photo.setSrc).toHaveBeenCalledTimes(1);
    expect(photo.setSrc).toHaveBeenCalledWith(photo.source);
    expect(photo.image.src).toBe(photo.source);
    expect(photo.createObjectURL).not.toHaveBeenCalled();
    expect(photo.ctx.fillRect).toHaveBeenCalledTimes(1);
    expect(photo.ctx.fillRect).toHaveBeenCalledWith(0, 0, 1238, 928);
    expect(photo.fillStyles).toEqual(["#ffffff"]);
    expect(photo.ctx.fillRect.mock.invocationCallOrder[0])
      .toBeLessThan(photo.ctx.drawImage.mock.invocationCallOrder[0]);
    expect(photo.ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(photo.ctx.drawImage).toHaveBeenCalledWith(photo.image, 0, 0, 1238, 928);
    expect(photo.toDataURL).toHaveBeenCalledTimes(1);
    expect(photo.toDataURL).toHaveBeenCalledWith("image/jpeg", 0.85);
    expect(photo.encodedSizes).toEqual([[1238, 928]]);
    expect(photo.image.close).not.toHaveBeenCalled();
    expect(document.getElementById("photo-status")!.classList.contains("ok")).toBe(true);
    await pressIdentify();
    expectPhotoPost(DATA_URL);
  });

  it("L9b: an image load error refuses the photo after one data URL read", async () => {
    const photo = stubImagePhoto("image");
    boot();
    const file = await pickPhoto();

    expect(photo.reader.readAsDataURL).toHaveBeenCalledTimes(1);
    expect(photo.reader.readAsDataURL).toHaveBeenCalledWith(file);
    expect(photo.makeImage).toHaveBeenCalledTimes(1);
    expect(photo.setSrc).toHaveBeenCalledTimes(1);
    expect(photo.setSrc).toHaveBeenCalledWith(photo.source);
    expect(photo.ctx.drawImage).not.toHaveBeenCalled();
    await expectRefusal(UNREADABLE);
  });

  it("L9c: a reader error refuses the photo after one data URL read", async () => {
    const photo = stubImagePhoto("reader");
    boot();
    const file = await pickPhoto();

    expect(photo.reader.readAsDataURL).toHaveBeenCalledTimes(1);
    expect(photo.reader.readAsDataURL).toHaveBeenCalledWith(file);
    expect(photo.ctx.drawImage).not.toHaveBeenCalled();
    await expectRefusal(UNREADABLE);
  });

  it("L10a: an earlier pick finishing last leaves the newest photo and its KB attached", async () => {
    const { first, second } = stubPendingPhotos();
    boot();
    const input = document.getElementById("device-photo") as HTMLInputElement;
    const valueSetter = vi.spyOn(input, "value", "set");
    const status = document.getElementById("photo-status")!;
    const button = document.getElementById("identify-btn") as HTMLButtonElement;
    await pickPhoto();
    await pickPhoto();
    second.resolve(second.bitmap);
    await vi.advanceTimersByTimeAsync(0);
    expect(status.textContent).toBe(second.status);
    expect(status.classList.contains("ok")).toBe(true);
    expect(button.disabled).toBe(false);

    first.resolve(first.bitmap);
    await vi.advanceTimersByTimeAsync(0);
    expect(status.textContent).toBe(second.status);
    expect(status.classList.contains("ok")).toBe(true);
    expect(button.disabled).toBe(false);
    expect(valueSetter).not.toHaveBeenCalled();
    await pressIdentify();
    expectPhotoPost(second.dataUrl);
  });

  it("L10b: an earlier pick finishing first leaves the newest pick preparing and disabled", async () => {
    const { first, second } = stubPendingPhotos();
    boot();
    await pickPhoto();
    await pickPhoto();
    const input = document.getElementById("device-photo") as HTMLInputElement;
    Object.defineProperty(input, "files", { configurable: true, value: [] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const valueSetter = vi.spyOn(input, "value", "set");
    first.resolve(first.bitmap);
    await vi.advanceTimersByTimeAsync(0);

    expect(document.getElementById("photo-status")!.textContent).toBe("Preparing the photo…");
    expect(document.getElementById("photo-status")!.classList.contains("ok")).toBe(false);
    expect((document.getElementById("identify-btn") as HTMLButtonElement).disabled).toBe(true);
    expect(valueSetter).not.toHaveBeenCalled();
    second.resolve(second.bitmap);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById("photo-status")!.textContent).toBe(second.status);
    await pressIdentify();
    expectPhotoPost(second.dataUrl);
  });

  it("L10c: an earlier unreadable pick cannot clear the newest photo, input, status or request button", async () => {
    const { photo, first, second } = stubPendingPhotos();
    const request = deferred<Awaited<ReturnType<typeof fetchMock>>>();
    fetchMock.mockReturnValueOnce(request.promise);
    boot();
    await pickPhoto();
    await pickPhoto();
    second.resolve(second.bitmap);
    await vi.advanceTimersByTimeAsync(0);
    const input = document.getElementById("device-photo") as HTMLInputElement;
    const valueSetter = vi.spyOn(input, "value", "set");
    await pressIdentify();
    expectPhotoPost(second.dataUrl);
    photo.decode.mockRejectedValue(new TypeError("retry failed"));
    first.reject(new TypeError("first decode failed"));
    await vi.advanceTimersByTimeAsync(0);

    expect(document.getElementById("photo-status")!.textContent).toBe(second.status);
    expect(document.getElementById("photo-status")!.classList.contains("ok")).toBe(true);
    expect(valueSetter).not.toHaveBeenCalled();
    const button = document.getElementById("identify-btn") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Identifying…");
    request.resolve({ ok: true, status: 200, json: async () => ({ candidates: [] }) });
    await vi.advanceTimersByTimeAsync(0);
    fetchMock.mockClear();
    await pressIdentify();
    expectPhotoPost(second.dataUrl);
  });

  it("L11a: a replacement pick clears ok and blocks click and Enter without changing the page", async () => {
    const { first, second } = stubPendingPhotos();
    boot();
    await pickPhoto();
    first.resolve(first.bitmap);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById("photo-status")!.classList.contains("ok")).toBe(true);
    document.getElementById("results")!.innerHTML = '<div class="candidate">Existing device results</div>';
    (document.getElementById("device-text") as HTMLInputElement).value = "Prusa MK4";
    await pickPhoto();

    const button = document.getElementById("identify-btn") as HTMLButtonElement;
    expect(document.getElementById("photo-status")!.textContent).toBe("Preparing the photo…");
    expect(document.getElementById("photo-status")!.classList.contains("ok")).toBe(false);
    expect(button.disabled).toBe(true);
    const before = document.body.innerHTML;
    await pressIdentify("Prusa MK4");
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await pressEnter();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.getElementById("resolver-err")!.style.display).toBe("none");
    expect(document.body.innerHTML).toBe(before);

    second.resolve(second.bitmap);
    await vi.advanceTimersByTimeAsync(0);
    expect(button.disabled).toBe(false);
    await pressIdentify("Prusa MK4");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string))
      .toEqual({ text: "Prusa MK4", photoBase64: second.dataUrl });
  });

  it("L11b: a request ending during a preparation renders its reply but leaves Identify disabled", async () => {
    const photo = stubPhoto();
    const decode = deferred<typeof photo.bitmap>();
    photo.decode.mockReturnValueOnce(decode.promise);
    const request = deferred<Awaited<ReturnType<typeof fetchMock>>>();
    fetchMock.mockReturnValueOnce(request.promise);
    boot();
    await pressIdentify("Prusa MK4");
    await pickPhoto();
    request.resolve({
      ok: true, status: 200,
      json: async () => ({ candidates: [], clarifyingQuestions: ["Which controller?"] }),
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.getElementById("results")!.textContent).toContain("Which controller?");
    const button = document.getElementById("identify-btn") as HTMLButtonElement;
    expect(button.textContent).toBe("Identify →");
    expect(button.disabled).toBe(true);
    expect(document.getElementById("photo-status")!.textContent).toBe("Preparing the photo…");
    decode.resolve(photo.bitmap);
    await vi.advanceTimersByTimeAsync(0);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Identify →");
  });

  it("L11c: a photo finishing during a request keeps Identifying disabled until the request ends", async () => {
    stubPhoto();
    const request = deferred<Awaited<ReturnType<typeof fetchMock>>>();
    fetchMock.mockReturnValueOnce(request.promise);
    boot();
    await pressIdentify("Prusa MK4");
    await pickPhoto();

    const button = document.getElementById("identify-btn") as HTMLButtonElement;
    expect(document.getElementById("photo-status")!.classList.contains("ok")).toBe(true);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Identifying…");
    request.resolve({ ok: true, status: 200, json: async () => ({ candidates: [] }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Identify →");
  });

  it("L11d: Enter during a request sends nothing else and leaves the page unchanged", async () => {
    const request = deferred<Awaited<ReturnType<typeof fetchMock>>>();
    fetchMock.mockReturnValue(request.promise);
    boot();
    await pressIdentify("Prusa MK4");
    const before = document.body.innerHTML;
    const timers = vi.getTimerCount();
    await pressEnter();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.body.innerHTML).toBe(before);
    expect(vi.getTimerCount()).toBe(timers);
    request.resolve({ ok: true, status: 200, json: async () => ({ candidates: [] }) });
    await vi.advanceTimersByTimeAsync(0);
  });

  it("L11e: click and Enter with empty text during a replacement preparation send nothing and leave the page unchanged", async () => {
    const { first, second } = stubPendingPhotos();
    boot();
    await pickPhoto();
    first.resolve(first.bitmap);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById("photo-status")!.textContent).toBe(first.status);
    await pickPhoto();
    (document.getElementById("device-text") as HTMLInputElement).value = "";

    const before = document.body.innerHTML;
    document.getElementById("identify-btn")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await pressEnter();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.getElementById("resolver-err")!.style.display).toBe("none");
    expect(document.body.innerHTML).toBe(before);
    second.resolve(second.bitmap);
    await vi.advanceTimersByTimeAsync(0);
  });

  it("L11f: Enter during a preparation sends nothing and keeps the existing error showing unchanged", async () => {
    const { first } = stubPendingPhotos();
    boot();
    await pressIdentify();
    const error = document.getElementById("resolver-err")!;
    const message = "Type a device name or attach a photo first.";
    expect(error.textContent).toBe(message);
    expect(error.style.display).toBe("");
    await pickPhoto();
    (document.getElementById("device-text") as HTMLInputElement).value = "Prusa MK4";

    const before = document.body.innerHTML;
    await pressEnter();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(error.style.display).toBe("");
    expect(error.textContent).toBe(message);
    expect(document.body.innerHTML).toBe(before);
    first.resolve(first.bitmap);
    await vi.advanceTimersByTimeAsync(0);
  });

  it("L11g: click and Enter with emptied text during a request send nothing else and leave the page unchanged", async () => {
    const request = deferred<Awaited<ReturnType<typeof fetchMock>>>();
    fetchMock.mockReturnValueOnce(request.promise);
    boot();
    await pressIdentify("Prusa MK4");
    (document.getElementById("device-text") as HTMLInputElement).value = "";

    const before = document.body.innerHTML;
    document.getElementById("identify-btn")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await pressEnter();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.getElementById("resolver-err")!.style.display).toBe("none");
    expect(document.body.innerHTML).toBe(before);
    request.resolve({ ok: true, status: 200, json: async () => ({ candidates: [] }) });
    await vi.advanceTimersByTimeAsync(0);
  });
});
