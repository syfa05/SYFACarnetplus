import { comparableKey, normalizeName, phoneticKey } from './normalize.js';
import type { DatePrecision, Sexe } from './types.js';

export interface MatchWeights {
  nom: number;
  prenoms: number;
  dateNaissance: number;
  sexe: number;
  nomMere: number;
}

/** Tous les réglages du score, lus en configuration (jamais codés en dur). */
export interface MatchParams {
  weights: MatchWeights;
  /** Similarité accordée à deux noms de même clé phonétique. */
  phonetique: number;
  /** Une clé phonétique plus courte (ex. noms composés surtout de voyelles) n'est pas discriminante. */
  phonetiqueLongueurMin: number;
  /** Coefficient quand nom et prénoms sont lus à l'envers. */
  inversion: number;
  /** Coefficient global quand les deux sexes déclarés sont opposés. */
  sexeOppose: number;
  /** Similarité du sexe quand l'un des deux est indéterminé. */
  sexeIndetermine: number;
  date: {
    anneeVoisine: number; // même jour et mois, année ±1
    anneeSeule: number; // précision « année » : même année
    moisSeul: number; // précision « mois » : même mois
    jourMoisInverses: number;
    moisDifferent: number; // même année seulement
    jourDifferent: number; // même mois, jour différent
  };
}

export interface Profile {
  nomNormalise: string;
  prenomsNormalise: string;
  dateNaissance: string; // YYYY-MM-DD
  datePrecision: DatePrecision;
  sexe: Sexe;
  nomMereNormalise?: string | null;
}

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a.length === 0 ? 0 : 1;
  if (!a || !b) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array<boolean>(a.length).fill(false);
  const bm = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(b.length - 1, i + window);
    for (let j = lo; j <= hi; j++) {
      if (!bm[j] && a[i] === b[j]) {
        am[i] = bm[j] = true;
        matches++;
        break;
      }
    }
  }
  if (matches === 0) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - t / 2) / m) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Similarité de deux noms normalisés : forme comparable (jetons triés) et clé phonétique. */
export function nameSimilarity(a: string, b: string, p: MatchParams): number {
  if (!a || !b) return 0;
  const jw = jaroWinkler(comparableKey(a), comparableKey(b));
  const ka = phoneticKey(a);
  const phon = ka === phoneticKey(b) && ka.length >= p.phonetiqueLongueurMin ? p.phonetique : 0;
  return Math.max(jw, phon);
}

function parts(d: string): [number, number, number] {
  const [y, m, day] = d.split('-').map(Number);
  return [y ?? 0, m ?? 0, day ?? 0];
}

/** Date de naissance : exacte = 1 ; jour inversé ou voisin = partiel ; selon la précision déclarée. */
export function dateSimilarity(a: string, ap: DatePrecision, b: string, bp: DatePrecision, t: MatchParams['date']): number {
  const [ay, am, ad] = parts(a);
  const [by, bm, bd] = parts(b);
  const coarse = ap === 'annee' || bp === 'annee' ? 'annee' : ap === 'mois' || bp === 'mois' ? 'mois' : 'jour';
  if (ay !== by) return Math.abs(ay - by) === 1 && coarse === 'jour' && am === bm && ad === bd ? t.anneeVoisine : 0;
  if (coarse === 'annee') return t.anneeSeule;
  if (am !== bm) return coarse === 'jour' && am === bd && ad === bm ? t.jourMoisInverses : t.moisDifferent;
  if (coarse === 'mois') return t.moisSeul;
  return ad === bd ? 1 : t.jourDifferent;
}

/** Score global dans [0,1] : moyenne pondérée sur les champs disponibles. */
export function matchScore(q: Profile, c: Profile, p: MatchParams): number {
  const w = p.weights;
  let sum = 0;
  let weight = 0;
  const add = (wt: number, s: number) => {
    sum += wt * s;
    weight += wt;
  };
  // Nom et prénoms parfois inversés à la saisie : on retient la meilleure lecture, légèrement pénalisée.
  const straight = [nameSimilarity(q.nomNormalise, c.nomNormalise, p), nameSimilarity(q.prenomsNormalise, c.prenomsNormalise, p)] as const;
  const swapped = [nameSimilarity(q.nomNormalise, c.prenomsNormalise, p) * p.inversion, nameSimilarity(q.prenomsNormalise, c.nomNormalise, p) * p.inversion] as const;
  const [sn, sp] = w.nom * straight[0] + w.prenoms * straight[1] >= w.nom * swapped[0] + w.prenoms * swapped[1] ? straight : swapped;
  add(w.nom, sn);
  add(w.prenoms, sp);
  add(w.dateNaissance, dateSimilarity(q.dateNaissance, q.datePrecision, c.dateNaissance, c.datePrecision, p.date));
  add(w.sexe, q.sexe === c.sexe ? 1 : q.sexe === 'I' || c.sexe === 'I' ? p.sexeIndetermine : 0);
  if (q.nomMereNormalise && c.nomMereNormalise) {
    add(w.nomMere, nameSimilarity(q.nomMereNormalise, c.nomMereNormalise, p));
  }
  const score = sum / weight;
  // Sexes opposés déclarés : jamais une correspondance probable.
  return q.sexe !== c.sexe && q.sexe !== 'I' && c.sexe !== 'I' ? score * p.sexeOppose : score;
}

export { normalizeName };
