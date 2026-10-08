/**
 * Client IP resolution with a trusted-proxy list.
 *
 * X-Forwarded-For is only honoured when the direct TCP peer is in the trusted
 * list (INKOS_TRUSTED_PROXIES, comma/space separated IPs or CIDRs; empty by
 * default = always use the socket address). The header is then walked from
 * right to left, skipping trusted hops; the first untrusted address is the client.
 */
import { BlockList, isIP } from "node:net";

export interface TrustedProxies {
  readonly entries: ReadonlyArray<string>;
  contains(ip: string): boolean;
}

/** Strip brackets / zone ids / IPv4-mapped prefix; returns "" when not an IP. */
export function normalizeIp(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  let ip = raw.trim();
  if (!ip) return "";
  if (ip.startsWith("[")) {
    const end = ip.indexOf("]");
    if (end > 0) ip = ip.slice(1, end);
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) {
    ip = ip.slice(0, ip.lastIndexOf(":")); // IPv4 with port
  }
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1]!;
  const family = isIP(ip);
  if (family === 0) return "";
  return family === 6 ? ip.toLowerCase() : ip;
}

export class InvalidTrustedProxyError extends Error {}

export function parseTrustedProxies(raw: string | null | undefined): TrustedProxies {
  const list = new BlockList();
  const entries: string[] = [];
  const tokens = String(raw ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  for (const token of tokens) {
    const [addrRaw, prefixRaw, extra] = token.split("/");
    if (extra !== undefined) throw new InvalidTrustedProxyError(`invalid trusted proxy entry: ${token}`);
    const addr = normalizeIp(addrRaw);
    const family = isIP(addr);
    if (!addr || family === 0) throw new InvalidTrustedProxyError(`invalid trusted proxy entry: ${token}`);
    const type = family === 6 ? "ipv6" : "ipv4";
    if (prefixRaw === undefined) {
      list.addAddress(addr, type);
    } else {
      const max = family === 6 ? 128 : 32;
      if (!/^\d+$/.test(prefixRaw) || Number(prefixRaw) > max) {
        throw new InvalidTrustedProxyError(`invalid CIDR prefix in trusted proxy entry: ${token}`);
      }
      list.addSubnet(addr, Number(prefixRaw), type);
    }
    entries.push(prefixRaw === undefined ? addr : `${addr}/${prefixRaw}`);
  }
  return {
    entries,
    contains(ip: string): boolean {
      if (entries.length === 0) return false;
      const normalized = normalizeIp(ip);
      const family = isIP(normalized);
      if (family === 0) return false;
      return list.check(normalized, family === 6 ? "ipv6" : "ipv4");
    },
  };
}

export function resolveClientIp(
  peerAddress: string | null | undefined,
  forwardedFor: string | null | undefined,
  trusted: TrustedProxies,
): string {
  const peer = normalizeIp(peerAddress) || "unknown";
  if (peer === "unknown" || !trusted.contains(peer) || !forwardedFor) return peer;
  const hops = forwardedFor.split(",").map((h) => h.trim()).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i -= 1) {
    const hop = normalizeIp(hops[i]);
    if (!hop) return peer; // garbage in the header: fall back to the socket address
    if (!trusted.contains(hop)) return hop;
  }
  // Every hop is a trusted proxy: the left-most one is the best we know.
  return normalizeIp(hops[0]) || peer;
}
