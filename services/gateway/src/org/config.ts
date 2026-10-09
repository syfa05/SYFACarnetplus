import { parseIntStrict } from '../env.js';
import type { EngineConfig } from '../authz/types.js';
import { KeycloakDirectory, DirectoryError, type DirectoryPort } from './directory.js';

export interface OrgConfig {
  engine: EngineConfig;
  homologatedClients: string[];
  /** Préfixe minimal d'un réseau autorisé (IPv4 / IPv6) : refuse les plages équivalentes à « tout Internet ». */
  minNetworkPrefix: { v4: number; v6: number };
  /** Refus d'accès journalisés au plus N fois par acteur, motif et fenêtre (anti-remplissage). */
  denialLog: { perWindow: number; windowSeconds: number };
  /** Rattrapage de l'annuaire : période de la tâche et nombre de comptes par passage. */
  reconcile: { intervalSeconds: number; batch: number };
  /** Contrôles : taille maximale d'une page et lignes examinées au plus par appel. */
  reviews: { pageMax: number; maxScan: number };
  /** Rétention du journal des refus, en jours (plancher de 90, imposé aussi par la base). */
  denialRetentionDays: number;
}

/** Règles d'autorisation paramétrables (principe 9) : aucun délai codé en dur dans un service. */
export function loadOrgConfig(env: NodeJS.ProcessEnv = process.env): OrgConfig {
  return {
    engine: {
      releaseDelayHours: parseIntStrict(env, 'ORG_RELEASE_DELAY_HOURS', 72, 0),
      emergencyMotiveMinLength: parseIntStrict(env, 'ORG_EMERGENCY_MOTIVE_MIN_LENGTH', 10, 1),
    },
    minNetworkPrefix: { v4: parseIntStrict(env, 'ORG_MIN_NETWORK_PREFIX_V4', 8, 1), v6: parseIntStrict(env, 'ORG_MIN_NETWORK_PREFIX_V6', 32, 1) },
    denialLog: { perWindow: parseIntStrict(env, 'ORG_DENIAL_LOG_PER_WINDOW', 5, 1), windowSeconds: parseIntStrict(env, 'ORG_DENIAL_LOG_WINDOW_SECONDS', 60, 1) },
    reconcile: { intervalSeconds: parseIntStrict(env, 'ORG_RECONCILE_INTERVAL_SECONDS', 60, 5), batch: parseIntStrict(env, 'ORG_RECONCILE_BATCH', 200, 1) },
    reviews: { pageMax: parseIntStrict(env, 'ORG_REVIEWS_PAGE_MAX', 100, 1), maxScan: parseIntStrict(env, 'ORG_REVIEWS_MAX_SCAN', 5000, 1) },
    denialRetentionDays: parseIntStrict(env, 'ORG_DENIAL_RETENTION_DAYS', 90, 90),
    homologatedClients: (env.ORG_HOMOLOGATED_CLIENTS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

/** Annuaire non configuré : la création de comptes est indisponible (les droits existants restent contrôlés localement). */
export class UnconfiguredDirectory implements DirectoryPort {
  async createUser(): Promise<{ sub: string }> { throw new DirectoryError('unavailable'); }
  async setEnabled(): Promise<void> { throw new DirectoryError('unavailable'); }
  async deleteUser(): Promise<void> { throw new DirectoryError('unavailable'); }
  async logout(): Promise<void> { throw new DirectoryError('unavailable'); }
  async setTemporaryPassword(): Promise<void> { throw new DirectoryError('unavailable'); }
}

/** Annuaire Keycloak si `DIRECTORY_CLIENT_ID` et `DIRECTORY_CLIENT_SECRET` sont fournis (compte de service). */
export function loadDirectory(oidcIssuer: string, env: NodeJS.ProcessEnv = process.env): DirectoryPort {
  const id = env.DIRECTORY_CLIENT_ID;
  const secret = env.DIRECTORY_CLIENT_SECRET;
  if (!id && !secret) return new UnconfiguredDirectory();
  if (!id || !secret) throw new Error('DIRECTORY_CLIENT_ID et DIRECTORY_CLIENT_SECRET vont ensemble');
  const m = /^(.*)\/realms\/([^/]+)$/.exec(oidcIssuer);
  const baseUrl = env.DIRECTORY_URL ?? m?.[1];
  const realm = env.DIRECTORY_REALM ?? m?.[2];
  if (!baseUrl || !realm) throw new Error("DIRECTORY_URL / DIRECTORY_REALM requis : l'émetteur OIDC n'a pas la forme .../realms/<realm>");
  return new KeycloakDirectory(baseUrl, realm, id, secret);
}
