import { jwtVerify, type JWTVerifyGetKey, type KeyLike } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';

export type KeyResolver = KeyLike | Uint8Array | JWTVerifyGetKey;

declare module 'fastify' {
  interface FastifyRequest {
    subject?: string;
    roles: string[];
  }
}

/** Vérifie le jeton porteur. Toute requête sans jeton valide est refusée (401). */
export function authHook(config: Config, key: KeyResolver) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    try {
      const { payload } = await jwtVerify(header.slice(7), key as never, {
        issuer: config.oidcIssuer,
        audience: config.oidcAudience,
      });
      req.subject = payload.sub;
      const realm = (payload.realm_access as { roles?: string[] } | undefined)?.roles;
      req.roles = Array.isArray(realm) ? realm : [];
    } catch {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };
}
