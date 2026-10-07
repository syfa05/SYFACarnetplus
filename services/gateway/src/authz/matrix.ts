import type { Action, Condition, DataRole, DataType } from './types.js';

/** Contrainte sur l'élément visé, propre à une cellule (les parenthèses de l'onglet 2). */
export type Where = 'active' | 'currentCare' | 'examPrescrit' | 'examResultat' | 'delegatedDraft';

export interface Right {
  /** Conditions propres à la cellule (les étoiles). Les conditions générales (C1, C3, C6, C7, C8) sont dans le moteur. */
  conds?: Condition[];
  /** Champs seuls autorisés. */
  fields?: string[];
  where?: Where;
}
export type Cell = Partial<Record<Action, Right>>;

const R: Right = {};

/**
 * Onglet 2, section 2.2 — matrice principale, une ligne par type de donnée. Une cellule absente = « — » (aucun droit).
 * Tout ce qui n'est pas listé est REFUSÉ.
 */
export const MATRIX: Record<DataType, Partial<Record<DataRole, Cell>>> = {
  identity: {
    patient: { C: R, E: R },
    representant: { C: R, E: R },
    secretaire: { C: R, Cr: R, M: R },
    infirmier: { C: R },
    medecin: { C: R },
    directeur_medical: { C: R, M: R },
    pharmacien: { C: { fields: ['nom', 'age'] } },
    laboratoire: { C: { fields: ['nom', 'age'] } },
  },
  summary: {
    patient: { C: R, E: R },
    representant: { C: R, E: R },
    infirmier: { C: R },
    medecin: { C: R, Cr: R, M: R },
    directeur_medical: { C: R, Cr: R, M: R },
    pharmacien: { C: { fields: ['allergies'] } },
  },
  consultations: {
    patient: { C: { conds: ['C2'] }, E: { conds: ['C2'] } },
    representant: { C: { conds: ['C2'] }, E: { conds: ['C2'] } },
    secretaire: { Cr: { conds: ['C4'], where: 'delegatedDraft' } },
    infirmier: { C: { where: 'currentCare' } },
    medecin: { C: R, Cr: R, M: { conds: ['C5'] }, P: R, E: R },
    directeur_medical: { C: R, Cr: R, M: { conds: ['C5'] }, P: R, E: R },
  },
  vitals: {
    patient: { C: R },
    representant: { C: R },
    infirmier: { C: R, Cr: R },
    medecin: { C: R, Cr: R },
    directeur_medical: { C: R, Cr: R },
  },
  prescriptions: {
    patient: { C: R, E: R },
    representant: { C: R, E: R },
    infirmier: { C: R },
    medecin: { C: R, Cr: R, M: { conds: ['C5'] } },
    directeur_medical: { C: R, Cr: R, M: { conds: ['C5'] } },
    pharmacien: { C: { where: 'active' }, M: { fields: ['dispensation'] } },
  },
  exams: {
    patient: { C: { conds: ['C2'] } },
    representant: { C: { conds: ['C2'] } },
    infirmier: { C: R },
    medecin: { C: R, Cr: R },
    directeur_medical: { C: R, Cr: R },
    laboratoire: { C: { where: 'examPrescrit' }, Cr: { where: 'examResultat' } },
  },
  vaccinations: {
    patient: { C: R, Cr: { fields: ['declaration'] } },
    representant: { C: R, Cr: { fields: ['declaration'] } },
    infirmier: { C: R, Cr: R },
    medecin: { C: R, Cr: R, M: { fields: ['controle'] } },
    directeur_medical: { C: R, Cr: R, M: R },
  },
  documents: {
    patient: { C: R, Cr: R },
    representant: { C: R, Cr: R },
    secretaire: { Cr: R },
    infirmier: { C: R },
    medecin: { C: R, Cr: R },
    directeur_medical: { C: R, Cr: R },
  },
  journal: {
    patient: { C: R },
    representant: { C: R },
    directeur_medical: { C: R },
  },
  restrictions: {
    patient: { Cr: R, M: R },
    representant: { Cr: R, M: R },
  },
  // Hors matrice 2.2 : ce que voit la secrétaire d'un brouillon qu'elle a saisi (C4 : « elle voit ensuite seulement le statut »).
  consultation_status: {
    secretaire: { C: { conds: ['C4'], fields: ['status'], where: 'delegatedDraft' } },
  },
};

/** Données dont la lecture par le patient ou son représentant est différée (C2). */
export const C2_DATA: DataType[] = ['consultations', 'exams'];

/** Données qui ne relèvent pas de la prise en charge (C1) : création d'un dossier (accueil), journal de l'établissement, statut de saisie déléguée. */
export const C1_EXEMPT: Array<{ data: DataType; action?: Action }> = [
  { data: 'identity', action: 'Cr' },
  { data: 'journal' },
  { data: 'consultation_status' },
];

/** Informations vitales en accès d'urgence (C8). */
export const VITAL: Partial<Record<DataType, { fields: string[]; where?: Where }>> = {
  identity: { fields: ['contact_urgence'] },
  summary: { fields: ['groupe_sanguin', 'allergies', 'traitements_en_cours', 'pathologies_chroniques'] },
  prescriptions: { fields: ['traitements_en_cours'], where: 'active' },
};
