import Fastify, { type FastifyInstance } from 'fastify';
import { AuthError } from './auth/errors.js';
import { authHook } from './auth/hook.js';
import { patientAuthRoutes, rateLimitHook, sessionRoutes } from './auth/routes.js';
import type { AuthRuntime } from './auth/runtime.js';
import type { Config } from './config.js';

export function buildApp(config: Config, rt: AuthRuntime): FastifyInstance {
  const app = Fastify({
    logger: false,
    trustProxy: config.trustProxy, // liste d'adresses de confiance ou faux (jamais « tous »)
    // Validation stricte : champs inconnus refusés et aucune conversion de type (par défaut, Fastify les « corrige »).
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false, allErrors: false } },
  });
  app.decorateRequest('roles', null as never);

  // Aucune erreur interne ne remonte à l'appelant : codes stables seulement (jamais de message externe).
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AuthError) {
      const { attemptsLeft, retryAfterSeconds } = err.details as { attemptsLeft?: number; retryAfterSeconds?: number };
      if (retryAfterSeconds !== undefined) reply.header('retry-after', String(retryAfterSeconds));
      return reply.code(err.status).send({ error: err.code, ...(attemptsLeft !== undefined && { attemptsLeft }), ...(retryAfterSeconds !== undefined && { retryAfterSeconds }) });
    }
    if ((err as { validation?: unknown }).validation) return reply.code(400).send({ error: 'validation' });
    // Erreurs de requête gérées par Fastify (corps trop gros, JSON invalide, type de contenu) : code stable, jamais le message.
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 413) return reply.code(413).send({ error: 'payload_too_large' });
    if (status === 415) return reply.code(415).send({ error: 'unsupported_media_type' });
    if (status && status >= 400 && status < 500) return reply.code(400).send({ error: 'validation' });
    return reply.code(500).send({ error: 'internal_error' });
  });

  // Seule route publique hors authentification : sonde de santé (sans donnée).
  app.get('/health', async () => ({ status: 'ok', mode: config.mode }));

  // Authentification des patients (publique, limitée en débit).
  app.register(async (pub) => patientAuthRoutes(pub, rt));

  // Tout le reste exige un jeton valide (principe 1 : contrôle côté serveur).
  app.register(async (secured) => {
    // Limitation de débit AVANT le contrôle du jeton, sur les seules routes d'authentification.
    const limit = rateLimitHook(rt);
    secured.addHook('onRequest', async (req, reply) => (req.url.startsWith('/v1/auth/') ? limit(req, reply) : undefined));
    secured.addHook('onRequest', authHook(config, rt));
    sessionRoutes(secured, rt, config);
    secured.get('/v1/me', async (req) => ({ subject: req.subject, roles: req.roles, kind: req.principal?.kind }));
  });

  return app;
}
