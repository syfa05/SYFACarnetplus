/** Rôles du personnel (attribués dans la base de la passerelle, jamais déduits d'un jeton). */
export const STAFF_ROLES = [
  'secretaire', 'infirmier', 'medecin', 'directeur_medical', 'pharmacien', 'laboratoire',
  'chef_service', 'agent_emission', 'vaccinateur',
  'chef_district', 'superviseur_pev', 'operateur', 'administrateur_habilite',
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** Colonnes de la matrice principale (onglet 2, section 2.2). */
export type DataRole = 'patient' | 'representant' | 'secretaire' | 'infirmier' | 'medecin' | 'directeur_medical' | 'pharmacien' | 'laboratoire';

export const DATA_TYPES = [
  'identity', 'summary', 'consultations', 'vitals', 'prescriptions', 'exams', 'vaccinations', 'documents', 'journal', 'restrictions',
  /** Statut d'un compte rendu (hors matrice 2.2) : ce que voit la secrétaire après sa saisie déléguée (C4). */
  'consultation_status',
] as const;
export type DataType = (typeof DATA_TYPES)[number];

/** C = consulter, Cr = créer, M = modifier, P = partager, E = exporter. */
export const ACTIONS = ['C', 'Cr', 'M', 'P', 'E'] as const;
export type Action = (typeof ACTIONS)[number];

export interface RoleGrant { role: StaffRole; serviceId: string | null }

export type Actor =
  | { kind: 'patient'; patientId: string }
  | { kind: 'representant'; personId: string }
  /** Accompagnant temporaire (C9) : aucun droit sur le contenu. */
  | { kind: 'accompagnant'; personId: string }
  | { kind: 'staff'; sub: string; active: boolean; establishmentId: string | null; roles: RoleGrant[] }
  | { kind: 'system'; client: string; homologated: boolean };

/** Élément visé (compte rendu, prescription, document...). Champs absents = condition NON satisfaite (refus par défaut). */
export interface Item {
  status?: 'brouillon' | 'en_attente' | 'valide' | 'renvoye';
  authorSub?: string;
  /** Masqué par le patient (C6). */
  masked?: boolean;
  /** Consultation confidentielle d'un mineur (C3). */
  confidential?: boolean;
  validatedAt?: Date;
  /** Libération anticipée par le médecin (C2). */
  releasedEarly?: boolean;
  /** Prescription active / en cours. */
  active?: boolean;
  /** Soin ou prescription en cours (infirmier, onglet 2). */
  currentCare?: boolean;
  /** Examen : prescrit ou résultat (laboratoire). */
  examKind?: 'prescrit' | 'resultat';
  /** Création d'un brouillon délégué (C4). */
  delegatedDraft?: boolean;
}

export interface Episode {
  establishmentId: string;
  serviceId: string | null;
  /** Périmètre par service activé pour cette prise en charge. */
  serviceScoped: boolean;
  expiresAt: Date;
  closedAt?: Date | null;
}

export interface Representation { personId: string; childId: string; active: boolean; childAutonomous: boolean }

export interface AccessContext {
  now: Date;
  episode?: Episode;
  representation?: Representation;
  /** Professionnels (identifiants) nommés par le patient dans une opposition (C7). */
  opposedProfessionals?: string[];
  /** Accès d'urgence (C8) : motif obligatoire. */
  emergency?: { motive: string };
  item?: Item;
  /** Journal : établissement dont on consulte le journal. */
  scopeEstablishmentId?: string;
  /** Export demandé : format et portée. */
  export?: { format: 'pdf' | 'fhir'; bulk?: boolean };
}

export interface AccessRequest {
  actor: Actor;
  /** Dossier visé. */
  patientId: string;
  action: Action;
  data: DataType;
  context: AccessContext;
}

export interface EngineConfig {
  /** Délai de visibilité différée (C2), en heures. Paramètre national : jamais codé en dur dans un service. */
  releaseDelayHours: number;
  /** Longueur minimale du motif d'un accès d'urgence (caractères). */
  emergencyMotiveMinLength: number;
}

export type Condition = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7' | 'C8' | 'C9';

export type Decision =
  | { allow: true; /** Conditions vérifiées pour cette décision. */ conditions: Condition[]; /** Champs seuls autorisés (absent = tous). */ fields?: string[] }
  | { allow: false; reason: string; condition?: Condition };

export const allow = (conditions: Condition[] = [], fields?: string[]): Decision => ({ allow: true, conditions, ...(fields && { fields }) });
export const deny = (reason: string, condition?: Condition): Decision => ({ allow: false, reason, ...(condition && { condition }) });
