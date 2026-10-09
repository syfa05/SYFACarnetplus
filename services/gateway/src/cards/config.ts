import { parseIntStrict } from '../env.js';

/** Règles des cartes (principe 9 : paramétrables). */
export interface CardsConfig {
  /** Une carte émise et non activée au-delà de ce délai (jours) est révoquée automatiquement (onglet 11.5.6 : proposition 90 jours). */
  activationDeadlineDays: number;
  /** Cartes de réserve non utilisées au plus par appareil d'émission et par appel. */
  reserveMax: number;
  /** Numéro d'assistance imprimé au verso (« Carte perdue ? … au 8XXX ») : décision de l'opérateur ; sans lui, aucune carte n'est imprimée. */
  assistanceNumber: string;
  /** Taille maximale d'une page de la liste des cartes révoquées. */
  revocationPageMax: number;
  /** Période du balayage des cartes non activées dans les délais (minutes). */
  sweepIntervalMinutes: number;
}

export function loadCardsConfig(env: NodeJS.ProcessEnv = process.env): CardsConfig {
  const assistance = (env.CARDS_ASSISTANCE_NUMBER ?? '').trim();
  if (assistance.length > 20 || /[^\d+ ]/.test(assistance)) throw new Error("CARDS_ASSISTANCE_NUMBER : chiffres, espaces et « + » seulement (20 au plus)");
  return {
    activationDeadlineDays: parseIntStrict(env, 'CARDS_ACTIVATION_DEADLINE_DAYS', 90, 1),
    reserveMax: parseIntStrict(env, 'CARDS_RESERVE_MAX', 20, 1),
    assistanceNumber: assistance,
    revocationPageMax: parseIntStrict(env, 'CARDS_REVOCATION_PAGE_MAX', 1000, 1),
    sweepIntervalMinutes: parseIntStrict(env, 'CARDS_SWEEP_INTERVAL_MINUTES', 60, 1),
  };
}
