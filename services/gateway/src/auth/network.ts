import { BlockList, isIP } from 'node:net';

/** Adresse IPv4/IPv6 → forme canonique (IPv4 intégrée dans IPv6 ramenée en IPv4, zone retirée). */
export function normalizeIp(ip: string): string | null {
  const bare = ip.split('%')[0]!.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  const candidate = mapped ? mapped[1]! : bare;
  return isIP(candidate) ? candidate : null;
}

export function parseCidr(cidr: string): { net: string; prefix: number; family: 'ipv4' | 'ipv6' } {
  const [net, p, extra] = cidr.trim().split('/');
  const family = net && isIP(net) === 4 ? 'ipv4' : net && isIP(net) === 6 ? 'ipv6' : null;
  const prefix = p === undefined ? (family === 'ipv4' ? 32 : 128) : Number(p);
  const max = family === 'ipv4' ? 32 : 128;
  if (!net || !family || extra !== undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > max || (p !== undefined && !/^\d+$/.test(p))) {
    throw new Error(`réseau invalide : ${cidr}`);
  }
  return { net, prefix, family };
}

/** Liste blanche de réseaux (CIDR). Une adresse illisible n'est jamais autorisée. */
export class NetworkPolicy {
  private readonly list = new BlockList();
  constructor(cidrs: string[]) {
    for (const c of cidrs) {
      const { net, prefix, family } = parseCidr(c);
      this.list.addSubnet(net, prefix, family);
    }
  }
  allows(ip: string | undefined): boolean {
    const n = ip ? normalizeIp(ip) : null;
    return n !== null && this.list.check(n, isIP(n) === 4 ? 'ipv4' : 'ipv6');
  }
}

/** PIN trivial : chiffres identiques, suite croissante ou décroissante, motifs AABB et ABAB. */
export function isWeakPin(pin: string): boolean {
  const d = [...pin].map(Number);
  if (d.every((x) => x === d[0])) return true;
  const steps = d.slice(1).map((x, i) => x - d[i]!);
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return true;
  const half = pin.length / 2;
  if (Number.isInteger(half) && pin.slice(0, half) === pin.slice(half)) return true; // 1212, 123123
  return pin.length === 4 && pin[0] === pin[1] && pin[2] === pin[3]; // 1122
}
