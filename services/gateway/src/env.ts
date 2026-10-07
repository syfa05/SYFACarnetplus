/**
 * Lecture stricte de l'environnement. Une valeur mal écrite ne doit JAMAIS être prise pour « faux » ou ignorée :
 * pour un réglage de sécurité, la faute de frappe (`treu`) désactiverait silencieusement le contrôle.
 * On refuse donc de démarrer.
 */
export function parseBool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const v = env[key];
  if (v === undefined || v === '') return fallback; // non défini : valeur par défaut (sûre)
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`${key} doit valoir exactement « true » ou « false » (reçu : ${JSON.stringify(v)})`);
}

export function parseIntStrict(env: NodeJS.ProcessEnv, key: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${key} doit être un entier entre ${min} et ${max} (reçu : ${JSON.stringify(v)})`);
  }
  return n;
}
