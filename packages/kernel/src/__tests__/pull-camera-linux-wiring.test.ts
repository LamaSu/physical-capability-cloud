/**
 * The default grabber's Linux identity goes through linuxV4l2Identity and the
 * node's own lstat (astra pack 155 HIGH 3). This box has no /dev/videoN, so
 * node:fs/promises is mocked HERE ONLY, in its own file. That lets the test
 * see the exact calls: lstat with { bigint: true } on the configured node, then
 * the sysfs reads for that node's N.
 */

import { beforeEach, describe, it, expect, vi } from "vitest";

const fsMock = vi.hoisted(() => ({ lstat: vi.fn(), readFile: vi.fn() }));
vi.mock("node:fs/promises", () => ({ lstat: fsMock.lstat, readFile: fsMock.readFile, default: fsMock }));

import { ffmpegFrameGrabber } from "../adapters/pull-camera-adapter.js";

/** glibc makedev(). */
function makedev(major: number, minor: number): bigint {
  const M = BigInt(major);
  const m = BigInt(minor);
  return ((M & 0xfffn) << 8n) | ((M & 0xfffff000n) << 32n) | (m & 0xffn) | ((m & 0xffffff00n) << 12n);
}

const SYSFS: Record<string, string> = {
  "/sys/class/video4linux/video3/dev": "81:3\n",
  "/sys/class/video4linux/video3/device/../serial": "SER-WIRED\n",
};

const spec = { platform: "linux-v4l2" as const, device: "/dev/video3", identity: "SER-WIRED" };

describe("ffmpegFrameGrabber.identity on linux-v4l2 (node:fs/promises mocked)", () => {
  beforeEach(() => {
    fsMock.lstat.mockReset();
    fsMock.readFile.mockReset();
    fsMock.readFile.mockImplementation(async (path: string) => {
      if (path in SYSFS) return SYSFS[path];
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    });
  });

  it("returns the serial of the character device whose rdev matches sysfs, after lstat with { bigint: true }", async () => {
    fsMock.lstat.mockResolvedValue({ isCharacterDevice: () => true, isSymbolicLink: () => false, rdev: makedev(81, 3) });
    expect(await ffmpegFrameGrabber.identity(spec)).toBe("SER-WIRED");
    expect(fsMock.lstat.mock.calls).toEqual([["/dev/video3", { bigint: true }]]);
    expect(fsMock.readFile.mock.calls).toEqual([
      ["/sys/class/video4linux/video3/dev", "utf8"],
      ["/sys/class/video4linux/video3/device/../serial", "utf8"],
    ]);
  });

  it("a symlink at the configured node gives null, though sysfs has a serial for it", async () => {
    fsMock.lstat.mockResolvedValue({ isCharacterDevice: () => false, isSymbolicLink: () => true, rdev: 0n });
    expect(await ffmpegFrameGrabber.identity(spec)).toBeNull();
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });

  it("a node whose rdev is another device's gives null", async () => {
    fsMock.lstat.mockResolvedValue({ isCharacterDevice: () => true, isSymbolicLink: () => false, rdev: makedev(81, 42) });
    expect(await ffmpegFrameGrabber.identity(spec)).toBeNull();
  });

  it("a non-canonical path is never lstat'ed or read", async () => {
    expect(await ffmpegFrameGrabber.identity({ ...spec, device: "/tmp/video3" })).toBeNull();
    expect(fsMock.lstat).not.toHaveBeenCalled();
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });
});
