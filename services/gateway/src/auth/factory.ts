import type { Db } from '../db/db.js';
import type { IdentityService } from '../identity/service.js';
import type { AuthConfig } from './config.js';
import type { AuthCrypto } from './crypto.js';
import { ProfessionalDeviceService } from './devices.js';
import { AuthEvents } from './events.js';
import { NetworkPolicy } from './network.js';
import { PatientAuthService } from './patient.js';
import type { KeyResolver } from './principal.js';
import { RateLimiter } from './rate-limit.js';
import type { AuthRuntime } from './runtime.js';
import { SessionStore } from './sessions.js';
import type { SmsSender, Translator } from './sms.js';
import { PatientTokens } from './tokens.js';

export interface AuthRuntimeOptions {
  auth: AuthConfig;
  db: Db;
  identity: IdentityService;
  crypto: AuthCrypto;
  sms: SmsSender;
  i18n: Translator;
  keycloakKey: KeyResolver;
  patientPrivateKeyPem: string;
  now?: () => Date;
}

export function createAuthRuntime(o: AuthRuntimeOptions): AuthRuntime {
  const now = o.now ?? (() => new Date());
  const events = new AuthEvents(now);
  const sessions = new SessionStore(o.db, o.auth, now);
  const limiter = new RateLimiter(o.db, o.crypto, now);
  const tokens = PatientTokens.fromPem(o.auth, o.patientPrivateKeyPem, now);
  return {
    config: o.auth,
    keycloakKey: o.keycloakKey,
    patientTokens: tokens,
    sessions,
    sessionsDb: o.db,
    limiter,
    events,
    network: new NetworkPolicy(o.auth.allowedNetworks),
    devices: new ProfessionalDeviceService(o.db, o.auth, o.crypto, o.sms, o.i18n, sessions, events, limiter, now),
    patients: new PatientAuthService(o.db, o.auth, o.crypto, o.identity, o.sms, o.i18n, tokens, sessions, limiter, events, now),
  };
}
