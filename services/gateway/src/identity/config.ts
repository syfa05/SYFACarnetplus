import type { MatchWeights } from './scoring.js';

/** Seuils et poids paramétrables (principe 9), à calibrer pendant le pilote (onglet 3.3). */
export interface IdentityConfig {
  seuilHaut: number; // correspondance probable
  seuilBas: number; // correspondance possible
  maxPossibles: number; // taille de la liste courte
  weights: MatchWeights;
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
    weights: {
      nom: num('ID_W_NOM', 0.3),
      prenoms: num('ID_W_PRENOMS', 0.25),
      dateNaissance: num('ID_W_DOB', 0.3),
      sexe: num('ID_W_SEXE', 0.05),
      nomMere: num('ID_W_MERE', 0.1),
    },
  };
  if (!(cfg.seuilBas > 0 && cfg.seuilBas < cfg.seuilHaut && cfg.seuilHaut <= 1)) {
    throw new Error('Seuils invalides : 0 < ID_MATCH_LOW < ID_MATCH_HIGH <= 1');
  }
  return cfg;
}
