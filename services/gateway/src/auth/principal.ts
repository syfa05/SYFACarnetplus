import type { JWTVerifyGetKey, KeyLike } from 'jose';
import type { ClientClass } from './config.js';

export type KeyResolver = KeyLike | Uint8Array | JWTVerifyGetKey;

export type Principal =
  | { kind: 'patient'; sub: string; roles: string[]; sid: string; clientClass: 'patient_app' }
  | { kind: 'professional'; sub: string; roles: string[]; sid: string; clientClass: ClientClass; deviceId: string | null; phone?: string; lang: string }
  | { kind: 'system'; sub: string; roles: string[]; client: string };

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    /** Compatibilité L0. */
    subject?: string;
    roles: string[];
  }
  interface FastifyContextConfig {
    /** Route d'enregistrement d'appareil : l'appareil n'existe pas encore. */
    skipDeviceCheck?: boolean;
  }
}
