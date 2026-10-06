import type { ProfessionalDeviceService } from './devices.js';
import type { AuthConfig } from './config.js';
import type { PatientAuthService } from './patient.js';
import type { RateLimiter } from './rate-limit.js';
import type { SessionStore } from './sessions.js';
import type { Db } from '../db/db.js';
import type { PatientTokens } from './tokens.js';
import type { KeyResolver } from './principal.js';

/** Tout ce dont la passerelle a besoin pour authentifier une requête. */
export interface AuthRuntime {
  config: AuthConfig;
  keycloakKey: KeyResolver;
  patientTokens: PatientTokens;
  sessions: SessionStore;
  devices: ProfessionalDeviceService;
  patients: PatientAuthService;
  limiter: RateLimiter;
  sessionsDb: Db;
}
