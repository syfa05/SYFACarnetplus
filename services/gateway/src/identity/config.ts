import type { MatchParams } from './scoring.js';

/** Seuils et réglages paramétrables (principe 9), à calibrer pendant le pilote (onglet 3.3). */
export interface IdentityConfig {
  seuilHaut: number; // correspondance probable
  seuilBas: number; // correspondance possible
  maxPossibles: number; // taille de la liste courte
  match: MatchParams;
}

export function loadIdentityConfig(env: NodeJS.ProcessEnv = process.env): IdentityConfig {
  const num = (k: string, d: number) => {
    const v = env[k];
    if (v === undefined || v === '') return d;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${k} doit être un nombre`);
    return n;
  };
  const cfg: IdentityConfig = {
    seuilHaut: num('ID_MATCH_HIGH', 0.9),
    seuilBas: num('ID_MATCH_LOW', 0.75),
    maxPossibles: num('ID_MATCH_MAX_POSSIBLE', 5),
    match: {
      weights: {
        nom: num('ID_W_NOM', 0.3),
        prenoms: num('ID_W_PRENOMS', 0.25),
        dateNaissance: num('ID_W_DOB', 0.3),
        sexe: num('ID_W_SEXE', 0.05),
        nomMere: num('ID_W_MERE', 0.1),
      },
      phonetique: num('ID_PHONETIC_SIMILARITY', 0.93),
      phonetiqueLongueurMin: num('ID_PHONETIC_MIN_LENGTH', 2),
      inversion: num('ID_SWAP_FACTOR', 0.97),
      sexeOppose: num('ID_SEX_MISMATCH_FACTOR', 0.6),
      sexeIndetermine: num('ID_SEX_UNKNOWN_SCORE', 0.5),
      date: {
        anneeVoisine: num('ID_DOB_YEAR_NEIGHBOUR', 0.3),
        anneeSeule: num('ID_DOB_YEAR_ONLY', 0.8),
        moisSeul: num('ID_DOB_MONTH_ONLY', 0.9),
        jourMoisInverses: num('ID_DOB_DAY_MONTH_SWAPPED', 0.6),
        moisDifferent: num('ID_DOB_MONTH_DIFFERENT', 0.2),
        jourDifferent: num('ID_DOB_DAY_DIFFERENT', 0.5),
      },
    },
  };
  validateParams(cfg);
  if (!(cfg.seuilBas > 0 && cfg.seuilBas < cfg.seuilHaut && cfg.seuilHaut <= 1)) {
    throw new Error('Seuils invalides : 0 < ID_MATCH_LOW < ID_MATCH_HIGH <= 1');
  }
  return cfg;
}

/** Une configuration absurde ne doit jamais désactiver silencieusement la détection des doublons. */
function validateParams(cfg: IdentityConfig): void {
  const { weights: w, date: d, ...rest } = cfg.match;
  const bad: string[] = [];
  for (const [k, v] of Object.entries(w)) if (!(v >= 0)) bad.push(`ID_W_* : poids négatif (${k})`);
  if (!(Object.values(w).reduce((a, b) => a + b, 0) > 0)) bad.push('ID_W_* : la somme des poids doit être > 0');
  const unit: Array<[string, number]> = [
    ['ID_PHONETIC_SIMILARITY', rest.phonetique], ['ID_SWAP_FACTOR', rest.inversion],
    ['ID_SEX_MISMATCH_FACTOR', rest.sexeOppose], ['ID_SEX_UNKNOWN_SCORE', rest.sexeIndetermine],
    ...Object.entries(d).map(([k, v]): [string, number] => [`ID_DOB_* (${k})`, v]),
  ];
  for (const [name, v] of unit) if (!(v >= 0 && v <= 1)) bad.push(`${name} doit être entre 0 et 1`);
  if (!Number.isInteger(rest.phonetiqueLongueurMin) || rest.phonetiqueLongueurMin < 0) bad.push('ID_PHONETIC_MIN_LENGTH doit être un entier >= 0');
  if (!Number.isInteger(cfg.maxPossibles) || cfg.maxPossibles < 0) bad.push('ID_MATCH_MAX_POSSIBLE doit être un entier >= 0');
  if (bad.length) throw new Error(`Configuration d'identité invalide : ${bad.join(' ; ')}`);
}
