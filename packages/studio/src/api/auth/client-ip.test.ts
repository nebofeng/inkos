import { describe, expect, it } from "vitest";
import { InvalidTrustedProxyError, normalizeIp, parseTrustedProxies, resolveClientIp } from "./client-ip.js";

describe("normalizeIp", () => {
  it("handles IPv4-mapped IPv6, brackets, ports and zones", () => {
    expect(normalizeIp("::ffff:172.18.0.1")).toBe("172.18.0.1");
    expect(normalizeIp("[2001:db8::1]:443")).toBe("2001:db8::1");
    expect(normalizeIp("203.0.113.5:51234")).toBe("203.0.113.5");
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80::1");
    expect(normalizeIp("2001:DB8::A")).toBe("2001:db8::a");
    expect(normalizeIp("not-an-ip")).toBe("");
    expect(normalizeIp(undefined)).toBe("");
  });
});

describe("parseTrustedProxies", () => {
  it("is empty by default", () => {
    const trusted = parseTrustedProxies(undefined);
    expect(trusted.entries).toEqual([]);
    expect(trusted.contains("127.0.0.1")).toBe(false);
  });

  it("accepts IPs and CIDRs (v4 + v6), comma or space separated", () => {
    const trusted = parseTrustedProxies("172.16.0.0/12, 10.1.2.3 2001:db8::/32");
    expect(trusted.entries).toEqual(["172.16.0.0/12", "10.1.2.3", "2001:db8::/32"]);
    expect(trusted.contains("172.20.0.1")).toBe(true);
    expect(trusted.contains("::ffff:172.31.255.254")).toBe(true);
    expect(trusted.contains("172.32.0.1")).toBe(false);
    expect(trusted.contains("10.1.2.3")).toBe(true);
    expect(trusted.contains("10.1.2.4")).toBe(false);
    expect(trusted.contains("2001:db8:1::5")).toBe(true);
    expect(trusted.contains("2001:db9::5")).toBe(false);
  });

  it("rejects invalid entries", () => {
    expect(() => parseTrustedProxies("172.17.0.0/33")).toThrow(InvalidTrustedProxyError);
    expect(() => parseTrustedProxies("docker-bridge")).toThrow(InvalidTrustedProxyError);
    expect(() => parseTrustedProxies("10.0.0.0/8/1")).toThrow(InvalidTrustedProxyError);
  });
});

describe("resolveClientIp", () => {
  const none = parseTrustedProxies("");
  const npm = parseTrustedProxies("172.20.0.1");

  it("ignores X-Forwarded-For when no proxy is trusted", () => {
    expect(resolveClientIp("172.20.0.1", "198.51.100.23", none)).toBe("172.20.0.1");
  });

  it("ignores X-Forwarded-For from an untrusted peer (spoofing)", () => {
    expect(resolveClientIp("203.0.113.66", "1.2.3.4", npm)).toBe("203.0.113.66");
  });

  it("uses the right-most untrusted hop from a trusted peer", () => {
    expect(resolveClientIp("::ffff:172.20.0.1", "198.51.100.23", npm)).toBe("198.51.100.23");
    // client-supplied fake first hop is ignored
    expect(resolveClientIp("172.20.0.1", "6.6.6.6, 198.51.100.23", npm)).toBe("198.51.100.23");
    const chain = parseTrustedProxies("172.20.0.1, 10.0.0.0/8");
    expect(resolveClientIp("172.20.0.1", "198.51.100.23, 10.0.0.5", chain)).toBe("198.51.100.23");
  });

  it("falls back to the peer for a missing or garbage header", () => {
    expect(resolveClientIp("172.20.0.1", undefined, npm)).toBe("172.20.0.1");
    expect(resolveClientIp("172.20.0.1", "garbage", npm)).toBe("172.20.0.1");
    expect(resolveClientIp(undefined, "1.2.3.4", npm)).toBe("unknown");
  });
});
