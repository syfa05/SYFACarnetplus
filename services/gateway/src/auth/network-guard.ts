import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { AuthRuntime } from './runtime.js';

/** En-têtes ajoutés par un reverse proxy : leur présence prouve qu'un proxy est devant la passerelle. */
const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip'];

export type NetworkVerdict = 'ok' | 'denied' | 'proxy_untrusted';

/**
 * Décide si la requête vient d'un réseau autorisé.
 * Défaillance bruyante : si un proxy est visible (en-têtes) mais qu'AUCUN proxy de confiance n'est déclaré
 * (TRUST_PROXY), l'adresse vue serait celle du proxy — souvent interne, donc « autorisée » à tort. On refuse
 * plutôt que d'ouvrir silencieusement : l'erreur de configuration se voit tout de suite.
 */
export function checkNetwork(req: FastifyRequest, config: Config, rt: AuthRuntime): NetworkVerdict {
  if (!config.trustProxy && PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) return 'proxy_untrusted';
  return rt.network.allows(req.ip) ? 'ok' : 'denied';
}

/** Trace un refus réseau, au plus une fois par minute, par utilisateur et par motif (adresse non conservée). */
export async function recordNetworkDenial(
  rt: AuthRuntime, subject: string, verdict: Exclude<NetworkVerdict, 'ok'>, context: string,
): Promise<void> {
  if ((await rt.limiter.hit(`net-denied:${verdict}:${context}`, subject, 1, 60)).allowed) {
    await rt.events.record(rt.sessionsDb, verdict === 'proxy_untrusted' ? 'proxy_untrusted' : 'network_denied', subject, { contexte: context });
  }
}
