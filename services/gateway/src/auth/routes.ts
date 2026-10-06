import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { AuthError } from './errors.js';
import { checkNetwork, recordNetworkDenial } from './network-guard.js';
import type { AuthRuntime } from './runtime.js';

const str = (max: number, min = 1) => ({ type: 'string', minLength: min, maxLength: max });
/** Corps d'authentification : quelques dizaines d'octets suffisent, 4 Ko au plus. */
const BODY_LIMIT = 4096;
const body = (properties: Record<string, unknown>, required: string[]) =>
  ({ bodyLimit: BODY_LIMIT, schema: { body: { type: 'object', properties, required, additionalProperties: false } } });

/** Limitation de débit par adresse sur TOUTES les routes d'authentification (échec = refus, jamais d'ouverture). */
export function rateLimitHook(rt: AuthRuntime) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const d = await rt.limiter.hit('ip-auth', req.ip, rt.config.rateLimit.ipLimit, rt.config.rateLimit.ipWindowSeconds);
    if (!d.allowed) {
      reply.header('retry-after', String(d.retryAfterSeconds));
      return reply.code(429).send({ error: 'too_many_requests', retryAfterSeconds: d.retryAfterSeconds });
    }
  };
}

/** Routes publiques d'authentification des patients (code SMS, PIN, rafraîchissement). */
export function patientAuthRoutes(app: FastifyInstance, rt: AuthRuntime): void {
  app.addHook('onRequest', rateLimitHook(rt));

  app.post('/v1/auth/patient/otp/request', { ...body({ telephone: str(20) }, ['telephone']) }, async (req, reply) => {
    await rt.patients.requestOtp((req.body as { telephone: string }).telephone);
    return reply.code(202).send({ status: 'sent' }); // identique que le numéro soit connu ou non
  });

  app.post('/v1/auth/patient/otp/verify',
    { ...body({ telephone: str(20), code: str(12), pin: str(8), deviceLabel: str(80) }, ['telephone', 'code', 'pin']) },
    async (req) => {
      const b = req.body as { telephone: string; code: string; pin: string; deviceLabel?: string };
      return rt.patients.verifyOtp(b.telephone, b.code, b.pin, b.deviceLabel);
    });

  app.post('/v1/auth/patient/unlock',
    { ...body({ deviceId: str(64), deviceSecret: str(200), pin: str(8) }, ['deviceId', 'deviceSecret', 'pin']) },
    async (req) => {
      const b = req.body as { deviceId: string; deviceSecret: string; pin: string };
      return rt.patients.unlock(b.deviceId, b.deviceSecret, b.pin);
    });

  app.post('/v1/auth/patient/refresh', { ...body({ refreshToken: str(200) }, ['refreshToken']) }, async (req) =>
    rt.patients.refresh((req.body as { refreshToken: string }).refreshToken));
}

/** Routes d'authentification exigeant un jeton valide (déconnexion, appareils des professionnels). */
export function sessionRoutes(app: FastifyInstance, rt: AuthRuntime, config: Config): void {
  app.post('/v1/auth/logout', async (req, reply) => {
    const p = req.principal!;
    if (p.kind === 'system') throw new AuthError('forbidden', 403);
    await rt.sessions.revoke(rt.sessionsDb, p.sid, 'logout');
    return reply.code(204).send();
  });

  const professional = (req: FastifyRequest) => {
    const p = req.principal;
    if (p?.kind !== 'professional') throw new AuthError('forbidden', 403);
    return p;
  };

  app.post('/v1/auth/devices', { config: { skipDeviceCheck: true }, ...body({ deviceKey: str(128, 32), label: str(80) }, ['deviceKey']) },
    async (req, reply) => {
      const p = professional(req);
      // Un appareil ne s'enrôle qu'à l'établissement (réseau autorisé), quel que soit le type de client du jeton.
      if (rt.config.deviceEnrolmentNetworkOnly) {
        const verdict = checkNetwork(req, config, rt);
        if (verdict !== 'ok') {
          await recordNetworkDenial(rt, p.sub, verdict, 'device_enrolment');
          throw new AuthError('network_not_allowed', 403);
        }
      }
      const b = req.body as { deviceKey: string; label?: string };
      const r = await rt.devices.register(p.sub, b.deviceKey, b.label, p.phone, p.lang);
      return reply.code(r.created ? 201 : 200).send(r);
    });

  app.get('/v1/auth/devices', async (req) => rt.devices.list(professional(req).sub));

  app.delete('/v1/auth/devices/:id', async (req, reply) => {
    const p = professional(req);
    const ok = await rt.devices.revoke((req.params as { id: string }).id, { subject: p.sub, reason: 'revoked_by_owner', actor: p.sub });
    return reply.code(ok ? 204 : 404).send();
  });
}
