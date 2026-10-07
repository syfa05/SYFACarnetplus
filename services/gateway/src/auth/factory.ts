import { AccessGuard } from '../authz/guard.js';
import type { EngineConfig } from '../authz/types.js';
import type { Db } from '../db/db.js';
import type { DirectoryPort } from '../org/directory.js';
import { StaffRepository } from '../org/repository.js';
import { OrgService } from '../org/service.js';
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
  directory: DirectoryPort;
  engine?: EngineConfig;
  /** Clients « système » homologués (export FHIR, onglet 2.5). */
  homologatedClients?: string[];
  now?: () => Date;
}

export function createAuthRuntime(o: AuthRuntimeOptions): AuthRuntime {
  const now = o.now ?? (() => new Date());
  const events = new AuthEvents(now);
  const sessions = new SessionStore(o.db, o.auth, now);
  const limiter = new RateLimiter(o.db, o.crypto, now);
  const tokens = PatientTokens.fromPem(o.auth, o.patientPrivateKeyPem, now);
  const staff = new StaffRepository(o.db);
  return {
    config: o.auth,
    keycloakKey: o.keycloakKey,
    patientTokens: tokens,
    sessions,
    db: o.db,
    staff,
    org: new OrgService(o.db, staff, o.directory, sessions, events, now),
    access: new AccessGuard(o.db, now, o.engine, o.homologatedClients),
    limiter,
    events,
    network: new NetworkPolicy(o.auth.allowedNetworks),
    devices: new ProfessionalDeviceService(o.db, o.auth, o.crypto, o.sms, o.i18n, sessions, events, limiter, now),
    patients: new PatientAuthService(o.db, o.auth, o.crypto, o.identity, o.sms, o.i18n, tokens, sessions, limiter, events, now),
  };
}
