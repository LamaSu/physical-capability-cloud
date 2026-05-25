/**
 * Tests for the SSRF guard.
 *
 * Covers: scheme/credential/IP-range/IPv6/metadata/loopback/DNS-rebind paths.
 */

import { describe, it, expect } from "vitest";
import {
  assertSafeFetchUrl,
  assertSafeFetchUrlWithDns,
  SSRFRejected,
} from "../url-guard.js";

describe("assertSafeFetchUrl — positive cases", () => {
  it("accepts a normal https URL", () => {
    const u = assertSafeFetchUrl("https://api.example.com/v1/list");
    expect(u.hostname).toBe("api.example.com");
  });

  it("accepts https with port + path + query", () => {
    const u = assertSafeFetchUrl(
      "https://api.example.com:8443/v1/list?q=hello",
    );
    expect(u.port).toBe("8443");
  });

  it("accepts http://localhost (dev default)", () => {
    const u = assertSafeFetchUrl("http://localhost:3000/api/x");
    expect(u.hostname).toBe("localhost");
  });

  it("accepts http://127.0.0.1 (dev default)", () => {
    const u = assertSafeFetchUrl("http://127.0.0.1:8080/foo");
    expect(u.hostname).toBe("127.0.0.1");
  });

  it("accepts https on a public hostname even when http would be rejected", () => {
    const u = assertSafeFetchUrl("https://example.com/health", {
      allowLocalhostHttp: false,
    });
    expect(u.hostname).toBe("example.com");
  });
});

describe("assertSafeFetchUrl — negative cases (scheme + format)", () => {
  it("rejects invalid URL", () => {
    expect(() => assertSafeFetchUrl("not-a-url")).toThrow(SSRFRejected);
  });

  it("rejects empty string", () => {
    expect(() => assertSafeFetchUrl("")).toThrow(SSRFRejected);
  });

  it("rejects ftp scheme", () => {
    expect(() => assertSafeFetchUrl("ftp://example.com/x")).toThrowError(
      /scheme-not-allowed/,
    );
  });

  it("rejects file scheme", () => {
    expect(() => assertSafeFetchUrl("file:///etc/passwd")).toThrowError(
      /scheme-not-allowed/,
    );
  });

  it("rejects gopher scheme", () => {
    expect(() =>
      assertSafeFetchUrl("gopher://example.com/x"),
    ).toThrowError(/scheme-not-allowed/);
  });

  it("rejects http on a non-localhost host", () => {
    expect(() => assertSafeFetchUrl("http://api.example.com/")).toThrowError(
      /http-not-allowed/,
    );
  });

  it("rejects http on localhost when allowLocalhostHttp:false", () => {
    expect(() =>
      assertSafeFetchUrl("http://localhost/x", { allowLocalhostHttp: false }),
    ).toThrowError(/http-not-allowed/);
  });

  it("rejects URL with credentials (user:pass@)", () => {
    expect(() =>
      assertSafeFetchUrl("https://user:pass@api.example.com/x"),
    ).toThrowError(/credentials-in-url/);
  });
});

describe("assertSafeFetchUrl — negative cases (IPv4 ranges)", () => {
  it("rejects 10.0.0.0/8 (RFC-1918)", () => {
    expect(() => assertSafeFetchUrl("https://10.1.2.3/")).toThrowError(
      /rfc1918-10/,
    );
  });

  it("rejects 172.16.0.0/12 (RFC-1918)", () => {
    expect(() => assertSafeFetchUrl("https://172.16.5.5/")).toThrowError(
      /rfc1918-172/,
    );
    expect(() => assertSafeFetchUrl("https://172.31.255.255/")).toThrowError(
      /rfc1918-172/,
    );
    // 172.15.x.x is public — should pass.
    expect(() => assertSafeFetchUrl("https://172.15.0.1/")).not.toThrow();
  });

  it("rejects 192.168.0.0/16 (RFC-1918)", () => {
    expect(() => assertSafeFetchUrl("https://192.168.1.1/")).toThrowError(
      /rfc1918-192/,
    );
  });

  it("rejects 169.254.0.0/16 (link-local + cloud metadata)", () => {
    expect(() => assertSafeFetchUrl("https://169.254.169.254/")).toThrowError(
      /link-local/,
    );
  });

  it("rejects 127.0.0.0/8 except literal 127.0.0.1", () => {
    expect(() => assertSafeFetchUrl("https://127.0.0.2/")).toThrowError(
      /loopback/,
    );
    // Literal 127.0.0.1 is allowed under default localhost flag.
    expect(() => assertSafeFetchUrl("https://127.0.0.1/")).not.toThrow();
  });

  it("rejects 0.0.0.0/8 (this network)", () => {
    expect(() => assertSafeFetchUrl("https://0.0.0.0/")).toThrowError(
      /zero-network/,
    );
  });

  it("rejects 100.64.0.0/10 (CGNAT)", () => {
    expect(() => assertSafeFetchUrl("https://100.64.0.1/")).toThrowError(
      /cgnat/,
    );
  });

  it("rejects 224.0.0.0/4 (multicast)", () => {
    expect(() => assertSafeFetchUrl("https://224.0.0.1/")).toThrowError(
      /multicast/,
    );
  });

  it("rejects 240.0.0.0/4 (reserved)", () => {
    expect(() => assertSafeFetchUrl("https://240.0.0.1/")).toThrowError(
      /reserved/,
    );
  });
});

describe("assertSafeFetchUrl — negative cases (IPv6 + metadata)", () => {
  it("rejects ::1 (IPv6 loopback) when localhost mode is off", () => {
    expect(() =>
      assertSafeFetchUrl("https://[::1]/", { allowLocalhostHttp: false }),
    ).toThrowError(/ipv6-loopback/);
  });

  it("rejects fe80:: link-local", () => {
    expect(() =>
      assertSafeFetchUrl("https://[fe80::1234]/"),
    ).toThrowError(/ipv6-link-local/);
  });

  it("rejects fc00:: / fd00:: unique-local", () => {
    expect(() =>
      assertSafeFetchUrl("https://[fc00::1]/"),
    ).toThrowError(/ipv6-unique-local/);
    expect(() =>
      assertSafeFetchUrl("https://[fd12:3456::1]/"),
    ).toThrowError(/ipv6-unique-local/);
  });

  it("rejects IPv4-mapped IPv6 of an RFC-1918 address", () => {
    expect(() =>
      assertSafeFetchUrl("https://[::ffff:10.0.0.1]/"),
    ).toThrowError(/ipv4-mapped/);
  });

  it("rejects metadata.google.internal", () => {
    expect(() =>
      assertSafeFetchUrl("https://metadata.google.internal/"),
    ).toThrowError(/metadata-hostname/);
  });

  it("rejects bare 'metadata' hostname", () => {
    expect(() =>
      assertSafeFetchUrl("https://metadata/"),
    ).toThrowError(/metadata-hostname/);
  });

  it("rejects host.internal", () => {
    expect(() =>
      assertSafeFetchUrl("https://some.host.internal/"),
    ).toThrowError(/metadata-hostname/);
  });
});

describe("assertSafeFetchUrlWithDns — DNS rebind defense", () => {
  it("rejects when DNS resolves to a private IP", async () => {
    const resolver = async () => ["10.0.0.5"];
    await expect(
      assertSafeFetchUrlWithDns("https://safe-looking.example/", resolver),
    ).rejects.toThrowError(/dns-rebind/);
  });

  it("rejects when DNS resolves to 169.254.169.254 (cloud metadata)", async () => {
    const resolver = async () => ["169.254.169.254"];
    await expect(
      assertSafeFetchUrlWithDns("https://attacker.example/", resolver),
    ).rejects.toThrowError(/dns-rebind/);
  });

  it("accepts when DNS resolves only to public IPs", async () => {
    const resolver = async () => ["1.2.3.4", "8.8.8.8"];
    const u = await assertSafeFetchUrlWithDns(
      "https://api.example.com/",
      resolver,
    );
    expect(u.hostname).toBe("api.example.com");
  });

  it("skips DNS check for IP literals (already validated synchronously)", async () => {
    const resolver = async () => {
      throw new Error("should not be called");
    };
    const u = await assertSafeFetchUrlWithDns("https://1.1.1.1/", resolver);
    expect(u.hostname).toBe("1.1.1.1");
  });

  it("wraps DNS resolution errors as SSRFRejected", async () => {
    const resolver = async () => {
      throw new Error("NXDOMAIN");
    };
    await expect(
      assertSafeFetchUrlWithDns("https://no-such-host.example/", resolver),
    ).rejects.toThrowError(/dns-resolution-failed/);
  });
});

describe("SSRFRejected", () => {
  it("exposes reason + rawUrl + name", () => {
    try {
      assertSafeFetchUrl("https://10.0.0.1/x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SSRFRejected);
      const e = err as SSRFRejected;
      expect(e.name).toBe("SSRFRejected");
      expect(e.rawUrl).toBe("https://10.0.0.1/x");
      expect(e.reason).toMatch(/rfc1918-10/);
    }
  });
});
