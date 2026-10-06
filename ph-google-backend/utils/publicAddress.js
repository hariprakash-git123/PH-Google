const net = require('net');
const dns = require('dns');

/**
 * Deciding whether a URL points at the public internet.
 *
 * For anything this server fetches because a request asked it to. A hostname
 * check alone is not enough — a public-looking name can resolve to a private
 * address — so the name is resolved and every address it has must be public.
 * The caller then connects to the address that was checked, not to the name
 * again, so the answer cannot change between the check and the request.
 */

/** Address ranges that are never on the public internet. */
const blocked = new net.BlockList();
[
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private (Docker's default networks live here)
  ['192.0.0.0', 24], // protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4] // reserved, broadcast
].forEach(([address, prefix]) => blocked.addSubnet(address, prefix, 'ipv4'));
[
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8] // multicast
].forEach(([address, prefix]) => blocked.addSubnet(address, prefix, 'ipv6'));

/** Names that only ever mean "this machine" or "this network". */
const INTERNAL_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.lan',
  '.home',
  '.corp',
  '.intranet',
  '.home.arpa'
];

/** "::ffff:10.0.0.1" is 10.0.0.1 wearing an IPv6 address. */
function unwrapMapped(address) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped ? mapped[1] : address;
}

/** Whether an IP address (v4 or v6) is on the public internet. */
function isPublicAddress(address) {
  const value = unwrapMapped(String(address || '').trim());
  const family = net.isIP(value);
  if (family === 4) return !blocked.check(value, 'ipv4');
  if (family === 6) {
    // An IPv4-mapped address in hex form (::ffff:7f00:1) is checked as IPv4.
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(value);
    if (hex) {
      const high = parseInt(hex[1], 16);
      const low = parseInt(hex[2], 16);
      return isPublicAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return !blocked.check(value, 'ipv6');
  }
  return false;
}

/**
 * Whether a hostname could be a public one at all, before any DNS lookup.
 * Single-label names ("redis", "mongo", "opensearch", "backend") are how
 * services find each other on a Docker or company network; a public site
 * always has a dot.
 */
function isPublicHostname(hostname) {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (!host || host === 'localhost') return false;
  if (net.isIP(host)) return isPublicAddress(host);
  if (!host.includes('.')) return false;
  if (INTERNAL_SUFFIXES.some(suffix => host.endsWith(suffix))) return false;
  return /^[a-z0-9.-]+$/.test(host);
}

/**
 * Resolves a hostname and returns one address to connect to — only if the
 * name and EVERY address it resolves to are public.
 *
 * @param {string} hostname  as URL.hostname gives it ("[::1]" brackets allowed)
 * @param {Function} [lookup]  dns.promises.lookup-compatible (tests)
 * @returns {Promise<{address: string, family: number} | null>} null when the
 *          target is not public or does not resolve
 */
async function resolvePublicAddress(hostname, lookup = dns.promises.lookup) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '');
  if (!isPublicHostname(host)) return null;
  if (net.isIP(host)) return { address: unwrapMapped(host), family: net.isIP(unwrapMapped(host)) };

  let addresses;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    return null;
  }
  if (!Array.isArray(addresses) || addresses.length === 0) return null;
  if (!addresses.every(entry => entry && isPublicAddress(entry.address))) return null;

  const chosen = addresses.find(entry => entry.family === 4) || addresses[0];
  const address = unwrapMapped(chosen.address);
  return { address, family: net.isIP(address) };
}

module.exports = { isPublicAddress, isPublicHostname, resolvePublicAddress };
