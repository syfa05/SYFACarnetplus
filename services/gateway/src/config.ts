import { parseCidr } from './auth/network.js';

// Configuration externalisée (principe 9 : aucune valeur paramétrable codée en dur).
export type Mode = 'central' | 'local';

export interface Config {
  mode: Mode;
  port: number;
  oidcIssuer: string;
  oidcAudience: string;
  /** URL JWKS ; par défaut déduite de l'émetteur Keycloak. */
  jwksUrl: string;
  /**
   * Reverse proxys de confiance : `false` ou une liste d'adresses/CIDR. Jamais « tous » : sinon X-Forwarded-For
   * est contrôlé par l'appelant (limitation de débit et liste blanche réseau contournées).
   */
  trustProxy: boolean | string[];
  databaseUrl?: string;
  autoMigrate: boolean;
  migrationsDir: string;
  i18nDir: string;
  smsUrl?: string;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Variable d'environnement manquante : ${key}`);
  return v;
}

/**
 * Reverse proxys de confiance : liste d'adresses ou de CIDR. L'adresse du client est alors la première adresse
 * NON fiable en remontant X-Forwarded-For depuis la droite. « true » (tout croire) et un nombre de sauts sont
 * refusés : le premier laisse l'appelant choisir son adresse, le second n'a pas le comportement attendu avec la
 * version de Fastify utilisée (vérifié par essai : l'adresse du proxy est alors prise pour celle du client).
 */
export function parseTrustProxy(v: string | undefined): boolean | string[] {
  const raw = (v ?? '').trim();
  if (raw === '' || raw === 'false') return false;
  if (raw === 'true' || /^\d+$/.test(raw)) {
    throw new Error("TRUST_PROXY : indiquer la liste des adresses/CIDR des reverse proxys de confiance (ex. 10.0.0.0/8), pas « true » ni un nombre");
  }
  const list = raw.split(',').map((x) => x.trim()).filter(Boolean);
  if (!list.length) throw new Error('TRUST_PROXY vide');
  for (const c of list) {
    const { prefix, family } = parseCidr(c);
    // Tout hôte de la plage peut forger X-Forwarded-For : indiquer les adresses exactes des proxys.
    if (prefix < (family === 'ipv4' ? 24 : 64)) throw new Error(`TRUST_PROXY : ${c} est trop large ; indiquer les adresses exactes des reverse proxys (/32 ou /128)`);
  }
  return list;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.SYFA_MODE ?? 'central';
  if (mode !== 'central' && mode !== 'local') {
    throw new Error(`SYFA_MODE invalide : ${mode} (attendu : central | local)`);
  }
  const oidcIssuer = required(env, 'OIDC_ISSUER');
  return {
    mode,
    port: Number(env.PORT ?? 8080),
    oidcIssuer,
    oidcAudience: required(env, 'OIDC_AUDIENCE'),
    jwksUrl: env.OIDC_JWKS_URL ?? `${oidcIssuer}/protocol/openid-connect/certs`,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    databaseUrl: env.DATABASE_URL,
    autoMigrate: env.AUTO_MIGRATE === 'true',
    migrationsDir: env.MIGRATIONS_DIR ?? './migrations',
    i18nDir: env.I18N_DIR ?? '../../i18n',
    smsUrl: env.SMS_URL,
  };
}
