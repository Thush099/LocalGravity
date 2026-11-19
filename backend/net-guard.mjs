import net from 'node:net';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 (this host)
  if (a === 10) return true; // 10.0.0.0/8 (RFC1918)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC1918)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC1918)
  if (a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2)) return true; // IETF / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast & reserved
  return false;
}

function extractMappedIpv4FromIpv6(ip) {
  const lower = ip.toLowerCase();
  // Dotted form: ::ffff:127.0.0.1
  const dotted = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1];
  // Hex form emitted by WHATWG URL parser: ::ffff:7f00:1 or ::ffff:7f00:0001
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

function isPrivateIpv6(rawIp) {
  const ip = rawIp.toLowerCase().split('%')[0];
  if (ip === '::' || ip === '::1') return true;
  const mappedV4 = extractMappedIpv4FromIpv6(ip);
  if (mappedV4) return isPrivateIpv4(mappedV4);
  const firstGroup = ip.split(':')[0];
  if (/^f[cd][0-9a-f]{2}$/.test(firstGroup)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]$/.test(firstGroup)) return true; // fe80::/10 link-local
  if (/^ff[0-9a-f]{2}$/.test(firstGroup)) return true; // ff00::/8 multicast
  // Also catch zero-expanded loopback like 0:0:0:0:0:0:0:1 or 0000:...
  const groups = ip.split(':').filter((g) => g.length > 0);
  if (groups.every((g) => /^0+$/.test(g))) return true;
  if (groups.length > 1 && groups.slice(0, -1).every((g) => /^0+$/.test(g)) && /^0*1$/.test(groups[groups.length - 1])) {
    return true;
  }
  return false;
}

function isBlockedHost(hostname) {
  const bare = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (!bare) return true;
  if (bare === 'localhost' || bare.endsWith('.localhost') || bare.endsWith('.local') || bare.endsWith('.internal')) {
    return true;
  }
  // Reject bare numeric hostnames (e.g. decimal IP 2130706433) if URL didn't already normalize them
  if (/^\d+$/.test(bare)) return true;

  const ipVer = net.isIP(bare);
  if (ipVer === 4) return isPrivateIpv4(bare);
  if (ipVer === 6) return isPrivateIpv6(bare);
  return false;
}

/**
 * Validate that a URL is an http/https target pointing to a public host (blocks SSRF to
 * loopback, link-local metadata endpoints, RFC1918, CGNAT, and private IPv6 ranges).
 */
export function assertPublicHttpUrl(rawUrl, label = 'URL') {
  const text = String(rawUrl || '').trim();
  if (!text) {
    const err = new Error(`A ${label} is required.`);
    err.statusCode = 400;
    throw err;
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    const err = new Error(`Invalid URL: ${text}`);
    err.statusCode = 400;
    throw err;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const err = new Error(`Only http:// and https:// URLs are supported.`);
    err.statusCode = 400;
    throw err;
  }
  if (isBlockedHost(parsed.hostname)) {
    const err = new Error('Refusing to fetch from local or private network hosts.');
    err.statusCode = 400;
    throw err;
  }
  return parsed;
}

/**
 * Perform a public HTTP/HTTPS fetch while validating the initial URL and every redirect hop
 * against SSRF rules.
 */
export async function safePublicFetch(
  rawUrl,
  { fetchFn = globalThis.fetch, timeoutMs = 15000, maxRedirects = 5, headers } = {}
) {
  let current = assertPublicHttpUrl(rawUrl).toString();
  const signal = AbortSignal.timeout(timeoutMs);

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await fetchFn(current, {
      redirect: 'manual',
      signal,
      ...(headers ? { headers } : {}),
    });

    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers?.get?.('location');
      if (!location) return res;
      if (hop === maxRedirects) {
        throw new Error('Too many HTTP redirects.');
      }
      const nextUrl = new URL(location, current).toString();
      current = assertPublicHttpUrl(nextUrl).toString();
      try {
        await res.body?.cancel();
      } catch {
        // ignore already consumed body
      }
      continue;
    }

    return res;
  }

  throw new Error('Too many HTTP redirects.');
}
