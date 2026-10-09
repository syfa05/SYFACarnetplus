import type { ProfessionalDeviceService } from './devices.js';
import type { AuthConfig } from './config.js';
import type { PatientAuthService } from './patient.js';
import type { RateLimiter } from './rate-limit.js';
import type { SessionStore } from './sessions.js';
import type { AuthEvents } from './events.js';
import type { Db } from '../db/db.js';
import type { NetworkPolicy } from './network.js';
import type { PatientTokens } from './tokens.js';
import type { KeyResolver } from './principal.js';
import type { AccessGuard } from '../authz/guard.js';
import type { CardService } from '../cards/service.js';
import type { OrgService } from '../org/service.js';
import type { StaffRepository } from '../org/repository.js';

/** Tout ce dont la passerelle a besoin pour authentifier une requête. */
export interface AuthRuntime {
  config: AuthConfig;
  keycloakKey: KeyResolver;
  patientTokens: PatientTokens;
  sessions: SessionStore;
  devices: ProfessionalDeviceService;
  patients: PatientAuthService;
  limiter: RateLimiter;
  network: NetworkPolicy;
  events: AuthEvents;
  db: Db;
  staff: StaffRepository;
  org: OrgService;
  cards: CardService;
  access: AccessGuard;
}
