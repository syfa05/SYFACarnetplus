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
  if (!(cfg.seuilBas > 0 && cfg.seuilBas < cfg.seuilHaut && cfg.seuilHaut <= 1)) {
    throw new Error('Seuils invalides : 0 < ID_MATCH_LOW < ID_MATCH_HIGH <= 1');
  }
  return cfg;
}
