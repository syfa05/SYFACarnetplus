import Fastify, { type FastifyInstance } from 'fastify';
import { createRemoteJWKSet } from 'jose';
import { authHook, type KeyResolver } from './auth.js';
import type { Config } from './config.js';

export function buildApp(config: Config, key?: KeyResolver): FastifyInstance {
  const app = Fastify({ logger: false });
  const resolver = key ?? createRemoteJWKSet(new URL(config.jwksUrl));
  app.decorateRequest('roles', null as never);

  // Seule route publique : sonde de santé (sans donnée).
  app.get('/health', async () => ({ status: 'ok', mode: config.mode }));

  // Tout le reste exige un jeton valide (principe 1 : contrôle côté serveur).
  app.register(async (secured) => {
    secured.addHook('onRequest', authHook(config, resolver));
    secured.get('/v1/me', async (req) => ({ subject: req.subject, roles: req.roles }));
  });

  return app;
}
