// Configuration externalisée (principe 9 : aucune valeur paramétrable codée en dur).
export type Mode = 'central' | 'local';

export interface Config {
  mode: Mode;
  port: number;
  oidcIssuer: string;
  oidcAudience: string;
  /** URL JWKS ; par défaut déduite de l'émetteur Keycloak. */
  jwksUrl: string;
  rateLimitPerMinute: number;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Variable d'environnement manquante : ${key}`);
  return v;
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
    rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 120),
  };
}
