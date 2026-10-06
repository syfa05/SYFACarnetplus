export type Sexe = 'F' | 'M' | 'I';
export type DatePrecision = 'jour' | 'mois' | 'annee';
export type NiveauIdentite = 1 | 2 | 3;
export type Langue = 'fr' | 'en';
export type IdentifierType = 'csu' | 'cni' | 'acte';
export type StatutDossier = 'actif' | 'provisoire' | 'decede' | 'fusionne';

export interface IdentifierInput {
  type: IdentifierType;
  valeur: string;
}

export interface PatientInput {
  nom: string;
  prenoms: string;
  dateNaissance: string; // YYYY-MM-DD ; jour/mois à 01 si inconnus, avec datePrecision
  datePrecision?: DatePrecision;
  sexe: Sexe;
  lieuNaissance?: string;
  nomMere?: string;
  nomPere?: string;
  niveauIdentite: NiveauIdentite;
  telephone?: string; // 2376XXXXXXXX
  langue: Langue;
  contactUrgenceNom?: string;
  contactUrgenceTelephone?: string;
  localite?: string;
  identifiants?: IdentifierInput[];
  provisoire?: boolean;
}

export interface Patient {
  id: string;
  nom: string;
  prenoms: string;
  dateNaissance: string;
  datePrecision: DatePrecision;
  sexe: Sexe;
  lieuNaissance: string | null;
  nomMere: string | null;
  nomPere: string | null;
  niveauIdentite: NiveauIdentite;
  telephone: string | null;
  langue: Langue;
  localite: string | null;
  statutDossier: StatutDossier;
  mergedInto: string | null;
}

export interface Match {
  patient: Patient;
  score: number;
}

export interface MatchResult {
  /** Dossier trouvé par CSU ou CNI identique : la création est interdite. */
  strong: Patient[];
  /** Score ≥ seuil haut. */
  probable: Match[];
  /** Score entre les deux seuils (liste courte proposée au professionnel). */
  possible: Match[];
}
