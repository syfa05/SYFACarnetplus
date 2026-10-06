import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { NetworkPolicy } from './network.js';
import type { AuthRuntime } from './runtime.js';

/** En-têtes ajoutés par un reverse proxy : leur présence prouve qu'un proxy est devant la passerelle. */
const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip'];

export type NetworkVerdict = 'ok' | 'denied' | 'proxy_untrusted';

const trustedPolicies = new WeakMap<object, NetworkPolicy | null>();
function trustedProxies(config: Config): NetworkPolicy | null {
  let p = trustedPolicies.get(config);
  if (p === undefined) {
    p = Array.isArray(config.trustProxy) ? new NetworkPolicy(config.trustProxy) : null;
    trustedPolicies.set(config, p);
  }
  return p;
}

/**
 * Décide si la requête vient d'un réseau autorisé.
 *
 * Défaillance bruyante : l'adresse n'est crédible que si, SI un proxy est devant la passerelle, Fastify a bien lu
 * l'adresse du client dans X-Forwarded-For. On contrôle l'EFFET (`req.ips` : le pair est un proxy déclaré ET l'en-tête
 * a été consommé), pas seulement la configuration. Sont refusés, car l'adresse vue serait celle du proxy (souvent
 * interne, donc « autorisée » à tort) :
 *  - un en-tête de proxy sans aucun proxy de confiance déclaré (TRUST_PROXY absent) ;
 *  - un en-tête de proxy mais un pair absent de la liste TRUST_PROXY (liste erronée) ;
 *  - un pair déclaré de confiance qui ne transmet pas l'adresse du client (X-Forwarded-For non configuré sur le proxy).
 */
export function checkNetwork(req: FastifyRequest, config: Config, rt: AuthRuntime): NetworkVerdict {
  const trusted = trustedProxies(config);
  const hasProxyHeader = PROXY_HEADERS.some((h) => req.headers[h] !== undefined);
  if (hasProxyHeader) {
    const consumed = trusted !== null && (req.ips?.length ?? 0) >= 2;
    if (!consumed) return 'proxy_untrusted';
  } else if (trusted?.allows(req.socket.remoteAddress)) {
    return 'proxy_untrusted';
  }
  return rt.network.allows(req.ip) ? 'ok' : 'denied';
}

/** Trace un refus réseau, au plus une fois par minute, par utilisateur et par motif (adresse non conservée). */
export async function recordNetworkDenial(
  rt: AuthRuntime, subject: string, verdict: Exclude<NetworkVerdict, 'ok'>, context: string,
): Promise<void> {
  if ((await rt.limiter.hit(`net-denied:${verdict}:${context}`, subject, 1, 60)).allowed) {
    await rt.events.record(rt.db, verdict === 'proxy_untrusted' ? 'proxy_untrusted' : 'network_denied', subject, { contexte: context });
  }
}
