import { decodeJwt, jwtVerify } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { AuthRuntime } from './runtime.js';

const deny = (reply: FastifyReply, error = 'unauthorized', status = 401) => reply.code(status).send({ error });

/**
 * Contrôle de chaque requête (principe 1) :
 *  - patient : jeton émis par la passerelle + session active (inactivité, durée absolue, révocation) ;
 *  - professionnel : jeton du fournisseur d'identité + SECOND FACTEUR (F-AUTH-03) + client connu + session
 *    avec inactivité par type de client (F-AUTH-04) + appareil enregistré si exigé ;
 *  - système : jeton « client credentials » d'un client déclaré, sans session.
 * Tout échec renvoie 401 ; le détail n'est jamais donné à l'appelant au-delà d'un code stable.
 */
export function authHook(config: Config, rt: AuthRuntime) {
  const cfg = rt.config;
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return deny(reply);
    const token = header.slice(7);
    try {
      let iss: string | undefined;
      try {
        iss = decodeJwt(token).iss; // aiguillage seulement : rien n'est cru avant la vérification de signature
      } catch {
        return deny(reply);
      }

      if (iss === cfg.patientIssuer) {
        const payload = await rt.patientTokens.verify(token);
        const sid = payload.sid;
        if (typeof sid !== 'string' || !sid || typeof payload.sub !== 'string' || !payload.sub) return deny(reply);
        const check = await rt.sessions.touch(sid, 'patient_app');
        if (!check.ok) return deny(reply, 'session_expired');
        req.principal = { kind: 'patient', sub: payload.sub, roles: ['patient'], sid, clientClass: 'patient_app' };
      } else if (iss === config.oidcIssuer) {
        const { payload } = await jwtVerify(token, rt.keycloakKey as never, {
          issuer: config.oidcIssuer,
          audience: config.oidcAudience,
          algorithms: ['RS256', 'ES256', 'PS256'],
        });
        const azp = typeof payload.azp === 'string' ? payload.azp : '';
        const roles = (payload.realm_access as { roles?: string[] } | undefined)?.roles;
        const roleList = Array.isArray(roles) ? roles : [];
        if (cfg.systemClients.includes(azp)) {
          if (typeof payload.sub !== 'string' || !payload.sub) return deny(reply);
          req.principal = { kind: 'system', sub: payload.sub, roles: roleList, client: azp };
        } else {
          const clientClass = cfg.clientClasses[azp];
          if (!clientClass || typeof payload.sub !== 'string' || !payload.sub || typeof payload.sid !== 'string' || !payload.sid) return deny(reply);
          // F-AUTH-03 : pas de connexion professionnelle sans second facteur.
          const amr = Array.isArray(payload.amr) ? payload.amr : [];
          const acr = Number(payload.acr);
          if (!(amr.includes(cfg.mfa.amr) || (Number.isFinite(acr) && acr >= cfg.mfa.acrMin))) return deny(reply, 'mfa_required');
          // F-AUTH-04 : inactivité contrôlée ici, par type de client.
          const sessionId = `kc:${payload.sid}:${azp}`;
          if (!(await rt.sessions.touchOrCreate(sessionId, payload.sub, clientClass))) return deny(reply, 'session_expired');
          let deviceId: string | null = null;
          if (cfg.deviceRequiredClasses.includes(clientClass) && !req.routeOptions.config?.skipDeviceCheck) {
            const key = req.headers['x-device-key'];
            deviceId = await rt.devices.verify(payload.sub, typeof key === 'string' ? key : undefined);
            if (!deviceId) return deny(reply, 'device_not_registered');
          }
          req.principal = {
            kind: 'professional', sub: payload.sub, roles: roleList, sid: sessionId, clientClass, deviceId,
            phone: typeof payload.phone_number === 'string' ? payload.phone_number : undefined,
            lang: typeof payload.locale === 'string' && payload.locale.startsWith('en') ? 'en' : 'fr',
          };
        }
      } else {
        return deny(reply);
      }
      req.subject = req.principal!.sub;
      req.roles = req.principal!.roles;
    } catch {
      return deny(reply);
    }
  };
}
