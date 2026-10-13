import { describe, expect, it } from "vitest";
import { resolveListenHost } from "./listen-host.js";

describe("resolveListenHost", () => {
  it.each([
    [undefined, "0.0.0.0"],
    ["", "0.0.0.0"],
    ["   ", "0.0.0.0"],
    ["127.0.0.1", "127.0.0.1"],
    ["::1", "::1"],
    ["localhost", "localhost"],
    [" 127.0.0.1 ", "127.0.0.1"],
    ["0.0.0.0", "0.0.0.0"],
    ["2001:db8::1", "2001:db8::1"],
    ["gateway.example", "gateway.example"],
    ["gateway.example.", "gateway.example."],
    ["1-gateway.example", "1-gateway.example"],
  ])("resolves HOST=%j to %s", (value, expected) => {
    expect(resolveListenHost(value)).toBe(expected);
  });

  it.each([
    "http://localhost",
    "localhost:3200",
    "127.0.0.1:3200",
    "[::1]",
    "::gg",
    "999.0.0.1",
    "127.00.0.1",
    "host name",
    "host/name",
    "host_name",
    "-gateway.example",
    "gateway-.example",
    "gateway..example",
    ".",
    "  bad host  ",
    "a".repeat(64) + ".example",
    Array(4).fill("a".repeat(63)).join("."),
  ])("rejects invalid HOST=%j and names its value", (value) => {
    expect(() => resolveListenHost(value)).toThrow("HOST");
    expect(() => resolveListenHost(value)).toThrow(JSON.stringify(value));
  });
});
