import { randomUUID } from 'node:crypto';
import type { Db, Queryable } from '../db/db.js';
import type { IdentityConfig } from './config.js';
import { IdentityError } from './errors.js';
import { noFhirReassigner, type FhirReferenceReassigner } from './fhir-port.js';
import { normalizeName, phoneticKey } from './normalize.js';
import { matchScore, type Profile } from './scoring.js';
import type {
  IdentifierInput,
  IdentifierType,
  Match,
  MatchResult,
  Patient,
  PatientInput,
} from './types.js';

const COLS = `id, nom, prenoms, nom_normalise, prenoms_normalise, to_char(date_naissance,'YYYY-MM-DD') AS date_naissance,
  date_precision, sexe, lieu_naissance, nom_mere, nom_mere_normalise, nom_pere, niveau_identite, telephone, langue, localite,
  statut_dossier, merged_into`;

interface Row {
  id: string;
  nom: string;
  prenoms: string;
  nom_normalise: string;
  prenoms_normalise: string;
  date_naissance: string;
  date_precision: Patient['datePrecision'];
  sexe: Patient['sexe'];
  lieu_naissance: string | null;
  nom_mere: string | null;
  nom_mere_normalise: string | null;
  nom_pere: string | null;
  niveau_identite: number;
  telephone: string | null;
  langue: Patient['langue'];
  localite: string | null;
  statut_dossier: Patient['statutDossier'];
  merged_into: string | null;
}

const toPatient = (r: Row): Patient => ({
  id: r.id,
  nom: r.nom,
  prenoms: r.prenoms,
  dateNaissance: r.date_naissance,
  datePrecision: r.date_precision,
  sexe: r.sexe,
  lieuNaissance: r.lieu_naissance,
  nomMere: r.nom_mere,
  nomPere: r.nom_pere,
  niveauIdentite: r.niveau_identite as Patient['niveauIdentite'],
  telephone: r.telephone,
  langue: r.langue,
  localite: r.localite,
  statutDossier: r.statut_dossier,
  mergedInto: r.merged_into,
});

const toProfile = (r: Row): Profile => ({
  nomNormalise: r.nom_normalise,
  prenomsNormalise: r.prenoms_normalise,
  dateNaissance: r.date_naissance,
  datePrecision: r.date_precision,
  sexe: r.sexe,
  nomMereNormalise: r.nom_mere_normalise,
});

export type RegisterResult =
  | { outcome: 'created'; patient: Patient }
  /** CSU ou CNI identique : dossier existant ouvert, création interdite. */
  | { outcome: 'existing'; patients: Patient[] }
  /** Correspondance probable : création possible uniquement avec justification. */
  | { outcome: 'justification_required'; matches: Match[] }
  /** Correspondance possible : liste courte à confirmer par le professionnel (confirmNew). */
  | { outcome: 'review_required'; matches: Match[] };

export interface RegisterOptions {
  justification?: string;
  /** Le professionnel a vu la liste courte et confirme la création d'un nouveau dossier. */
  confirmNew?: boolean;
}

export function normalizeIdentifier(valeur: string): string {
  return valeur.toUpperCase().replace(/[\s.\-/]/g, '');
}

const PHONE = /^2376\d{8}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validate(input: PatientInput): void {
  const errors: string[] = [];
  const need = (v: string | undefined, code: string) => {
    if (!v || !v.trim()) errors.push(code);
  };
  need(input.nom, 'nom_requis');
  need(input.prenoms, 'prenoms_requis');
  if (input.nom?.trim() && !normalizeName(input.nom)) errors.push('nom_invalide');
  if (input.prenoms?.trim() && !normalizeName(input.prenoms)) errors.push('prenoms_invalide');
  const m = ISO_DATE.exec(input.dateNaissance ?? '');
  const d = m ? new Date(`${input.dateNaissance}T00:00:00Z`) : null;
  if (!m || !d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== input.dateNaissance) {
    errors.push('date_naissance_invalide');
  } else if (d.getTime() > Date.now()) errors.push('date_naissance_future');
  if (!['F', 'M', 'I'].includes(input.sexe)) errors.push('sexe_invalide');
  if (![1, 2, 3].includes(input.niveauIdentite)) errors.push('niveau_identite_invalide');
  if (!['fr', 'en'].includes(input.langue)) errors.push('langue_invalide');
  if (input.telephone !== undefined && !PHONE.test(input.telephone)) errors.push('telephone_invalide');
  if (input.contactUrgenceTelephone !== undefined && !PHONE.test(input.contactUrgenceTelephone)) {
    errors.push('contact_urgence_telephone_invalide');
  }
  if (input.niveauIdentite !== 1 && !input.lieuNaissance?.trim()) errors.push('lieu_naissance_requis');
  const ids = input.identifiants ?? [];
  for (const i of ids) {
    if (!['csu', 'cni', 'acte'].includes(i.type)) errors.push('identifiant_type_invalide');
    if (!normalizeIdentifier(i.valeur ?? '')) errors.push('identifiant_vide');
  }
  if (input.niveauIdentite === 1 && !ids.some((i) => i.type === 'csu' || i.type === 'cni')) {
    errors.push('niveau_1_exige_csu_ou_cni');
  }
  if (errors.length) throw new IdentityError('validation', { errors });
}

export class IdentityService {
  constructor(
    private readonly db: Db,
    private readonly config: IdentityConfig,
    private readonly fhir: FhirReferenceReassigner = noFhirReassigner,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async event(
    q: Queryable,
    type: string,
    acteur: string,
    patientId: string | null,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await q.query('INSERT INTO identity_event (at, type, acteur, patient_id, details) VALUES ($1,$2,$3,$4,$5::jsonb)', [
      this.now().toISOString(),
      type,
      acteur,
      patientId,
      JSON.stringify(details),
    ]);
  }

  /** Suit la redirection des dossiers fusionnés jusqu'au dossier conservé. */
  async resolve(id: string, q: Queryable = this.db): Promise<Patient | null> {
    let current = id;
    for (let i = 0; i < 20; i++) {
      const { rows } = await q.query<Row>(`SELECT ${COLS} FROM patient WHERE id = $1`, [current]);
      const row = rows[0];
      if (!row) return null;
      if (!row.merged_into) return toPatient(row);
      current = row.merged_into;
    }
    throw new IdentityError('redirection_cyclique', { id });
  }

  async findByIdentifier(type: IdentifierType, valeur: string, q: Queryable = this.db): Promise<Patient | null> {
    const { rows } = await q.query<{ patient_id: string }>(
      'SELECT patient_id FROM patient_identifier WHERE type = $1 AND valeur = $2 LIMIT 1',
      [type, normalizeIdentifier(valeur)],
    );
    return rows[0] ? this.resolve(rows[0].patient_id, q) : null;
  }

  /** Rapprochement : identifiant fort, puis score (onglet 3.3). */
  async findMatches(input: PatientInput, q: Queryable = this.db): Promise<MatchResult> {
    const strong = new Map<string, Patient>();
    for (const i of input.identifiants ?? []) {
      if (i.type === 'acte') continue; // non bloquant
      const p = await this.findByIdentifier(i.type, i.valeur, q);
      if (p) strong.set(p.id, p);
    }
    const query: Profile = {
      nomNormalise: normalizeName(input.nom),
      prenomsNormalise: normalizeName(input.prenoms),
      dateNaissance: input.dateNaissance,
      datePrecision: input.datePrecision ?? 'jour',
      sexe: input.sexe,
      nomMereNormalise: input.nomMere ? normalizeName(input.nomMere) : null,
    };
    // Candidats : même clé phonétique du nom, ou même prénom phonétique et même date de naissance.
    const { rows } = await q.query<Row>(
      `SELECT ${COLS} FROM patient
       WHERE statut_dossier <> 'fusionne'
         AND (nom_phonetique = $1 OR (prenoms_phonetique = $2 AND date_naissance = $3::date) OR nom_phonetique = $4)`,
      [phoneticKey(query.nomNormalise), phoneticKey(query.prenomsNormalise), input.dateNaissance, phoneticKey(query.prenomsNormalise)],
    );
    const scored: Match[] = rows
      .filter((r) => !strong.has(r.id))
      .map((r) => ({ patient: toPatient(r), score: matchScore(query, toProfile(r), this.config.weights) }))
      .filter((m) => m.score >= this.config.seuilBas)
      .sort((a, b) => b.score - a.score);
    return {
      strong: [...strong.values()],
      probable: scored.filter((m) => m.score >= this.config.seuilHaut),
      possible: scored.filter((m) => m.score < this.config.seuilHaut).slice(0, this.config.maxPossibles),
    };
  }

  async register(input: PatientInput, acteur: string, options: RegisterOptions = {}): Promise<RegisterResult> {
    validate(input);
    return this.db.transaction(async (tx) => {
      const found = await this.findMatches(input, tx);
      if (found.strong.length) {
        await this.event(tx, 'creation_refusee_identifiant', acteur, found.strong[0]!.id, {
          existants: found.strong.map((p) => p.id),
        });
        return { outcome: 'existing', patients: found.strong } as const;
      }
      const justification = options.justification?.trim();
      if (found.probable.length && !justification) {
        return { outcome: 'justification_required', matches: found.probable } as const;
      }
      if (!found.probable.length && found.possible.length && !options.confirmNew) {
        return { outcome: 'review_required', matches: found.possible } as const;
      }
      const patient = await this.insert(tx, input, acteur);
      if (found.probable.length) {
        await this.event(tx, 'doublon_probable_justifie', acteur, patient.id, {
          justification,
          correspondances: found.probable.map((m) => ({ id: m.patient.id, score: m.score })),
        });
      }
      return { outcome: 'created', patient } as const;
    });
  }

  private async insert(tx: Queryable, input: PatientInput, acteur: string): Promise<Patient> {
    const id = randomUUID();
    const nomN = normalizeName(input.nom);
    const prenomsN = normalizeName(input.prenoms);
    const precision = input.datePrecision ?? 'jour';
    const now = this.now().toISOString();
    await tx.query(
      `INSERT INTO patient (id, nom, nom_normalise, nom_phonetique, prenoms, prenoms_normalise, prenoms_phonetique,
         date_naissance, date_precision, sexe, lieu_naissance, nom_mere, nom_mere_normalise, nom_pere, niveau_identite,
         telephone, langue, contact_urgence_nom, contact_urgence_telephone, localite, statut_dossier, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [
        id, input.nom.trim(), nomN, phoneticKey(nomN), input.prenoms.trim(), prenomsN, phoneticKey(prenomsN),
        input.dateNaissance, precision, input.sexe, input.lieuNaissance?.trim() ?? null,
        input.nomMere?.trim() ?? null, input.nomMere ? normalizeName(input.nomMere) : null, input.nomPere?.trim() ?? null,
        input.niveauIdentite, input.telephone ?? null, input.langue, input.contactUrgenceNom ?? null,
        input.contactUrgenceTelephone ?? null, input.localite ?? null, input.provisoire ? 'provisoire' : 'actif', now,
      ],
    );
    for (const i of input.identifiants ?? []) await this.insertIdentifier(tx, id, i);
    await this.event(tx, 'patient_cree', acteur, id, { niveau: input.niveauIdentite });
    return (await this.resolve(id, tx))!;
  }

  private async insertIdentifier(tx: Queryable, patientId: string, i: IdentifierInput): Promise<void> {
    await tx.query('INSERT INTO patient_identifier (id, patient_id, type, valeur, created_at) VALUES ($1,$2,$3,$4,$5)', [
      randomUUID(), patientId, i.type, normalizeIdentifier(i.valeur), this.now().toISOString(),
    ]);
  }

  /** Ajoute un identifiant à un dossier existant, sans toucher à l'historique (F-ID-03). */
  async addIdentifier(patientId: string, ident: IdentifierInput, acteur: string): Promise<Patient> {
    if (!['csu', 'cni', 'acte'].includes(ident.type) || !normalizeIdentifier(ident.valeur ?? '')) {
      throw new IdentityError('validation', { errors: ['identifiant_invalide'] });
    }
    return this.db.transaction(async (tx) => {
      const target = await this.resolve(patientId, tx);
      if (!target) throw new IdentityError('patient_introuvable');
      if (target.id !== patientId) throw new IdentityError('dossier_fusionne', { conserve: target.id });
      if (ident.type !== 'acte') {
        const owner = await this.findByIdentifier(ident.type, ident.valeur, tx);
        if (owner && owner.id === patientId) return target; // déjà présent : idempotent
        if (owner) throw new IdentityError('identifiant_deja_attribue', { existant: owner.id });
      }
      await this.insertIdentifier(tx, patientId, ident);
      await this.event(tx, 'identifiant_ajoute', acteur, patientId, { type: ident.type });
      return target;
    });
  }

  /** Fusion réversible : le dossier absorbé pointe vers le dossier conservé (onglet 3.3). */
  async merge(survivantId: string, absorbeId: string, acteur: string, motif: string): Promise<string> {
    if (!motif?.trim()) throw new IdentityError('motif_requis');
    if (survivantId === absorbeId) throw new IdentityError('fusion_meme_dossier');
    let reassigned: unknown[] | null = null;
    try {
      return await this.db.transaction(async (tx) => {
        const rows = (await tx.query<{ id: string; statut_dossier: string }>(
          'SELECT id, statut_dossier FROM patient WHERE id = ANY($1::uuid[]) FOR UPDATE', [[survivantId, absorbeId]],
        )).rows;
        const surv = rows.find((r) => r.id === survivantId);
        const abs = rows.find((r) => r.id === absorbeId);
        if (!surv || !abs) throw new IdentityError('patient_introuvable');
        if (surv.statut_dossier === 'fusionne' || abs.statut_dossier === 'fusionne') {
          throw new IdentityError('dossier_deja_fusionne');
        }
        const ids = await tx.query<{ id: string }>('UPDATE patient_identifier SET patient_id=$1 WHERE patient_id=$2 RETURNING id', [survivantId, absorbeId]);
        const enfant = await tx.query<{ id: string }>('UPDATE representation_link SET id_enfant=$1 WHERE id_enfant=$2 RETURNING id', [survivantId, absorbeId]);
        const repr = await tx.query<{ id: string }>('UPDATE representation_link SET id_representant=$1 WHERE id_representant=$2 RETURNING id', [survivantId, absorbeId]);
        const deleg = await tx.query<{ id: string }>('UPDATE companion_delegation SET id_enfant=$1 WHERE id_enfant=$2 RETURNING id', [survivantId, absorbeId]);
        await tx.query("UPDATE patient SET statut_dossier='fusionne', merged_into=$1 WHERE id=$2", [survivantId, absorbeId]);
        reassigned = await this.fhir.reassign(absorbeId, survivantId);
        const mergeId = randomUUID();
        await tx.query(
          `INSERT INTO patient_merge (id, survivant_id, absorbe_id, statut_precedent, effectuee_par, motif, deplace, references_fhir, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
          [mergeId, survivantId, absorbeId, abs.statut_dossier, acteur, motif.trim(),
           JSON.stringify({ identifiants: ids.rows.map((r) => r.id), liensEnfant: enfant.rows.map((r) => r.id), liensRepresentant: repr.rows.map((r) => r.id), delegations: deleg.rows.map((r) => r.id) }),
           JSON.stringify(reassigned), this.now().toISOString()],
        );
        await this.event(tx, 'patient_fusionne', acteur, survivantId, { absorbe: absorbeId, fusion: mergeId, motif: motif.trim() });
        return mergeId;
      });
    } catch (e) {
      if (reassigned) await this.fhir.restore(absorbeId, survivantId, reassigned).catch(() => {});
      throw e;
    }
  }

  /** Annule une fusion : restitue le dossier absorbé et tout ce qui avait été réaffecté. */
  async unmerge(mergeId: string, acteur: string, motif: string): Promise<void> {
    if (!motif?.trim()) throw new IdentityError('motif_requis');
    await this.db.transaction(async (tx) => {
      const m = (await tx.query<{
        survivant_id: string; absorbe_id: string; statut_precedent: string; annulee_le: string | null;
        deplace: { identifiants: string[]; liensEnfant: string[]; liensRepresentant: string[]; delegations: string[] };
        references_fhir: unknown[];
      }>('SELECT * FROM patient_merge WHERE id=$1 FOR UPDATE', [mergeId])).rows[0];
      if (!m) throw new IdentityError('fusion_introuvable');
      if (m.annulee_le) throw new IdentityError('fusion_deja_annulee');
      const surv = (await tx.query<{ statut_dossier: string }>('SELECT statut_dossier FROM patient WHERE id=$1', [m.survivant_id])).rows[0];
      if (surv?.statut_dossier === 'fusionne') throw new IdentityError('annuler_fusion_ulterieure_dabord');
      const back = (table: string, col: string, list: string[]) =>
        tx.query(`UPDATE ${table} SET ${col}=$1 WHERE id IN (SELECT jsonb_array_elements_text($2::jsonb)::uuid) AND ${col}=$3`,
          [m.absorbe_id, JSON.stringify(list), m.survivant_id]);
      await back('patient_identifier', 'patient_id', m.deplace.identifiants);
      await back('representation_link', 'id_enfant', m.deplace.liensEnfant);
      await back('representation_link', 'id_representant', m.deplace.liensRepresentant);
      await back('companion_delegation', 'id_enfant', m.deplace.delegations);
      await tx.query('UPDATE patient SET statut_dossier=$1, merged_into=NULL WHERE id=$2', [m.statut_precedent, m.absorbe_id]);
      await this.fhir.restore(m.absorbe_id, m.survivant_id, m.references_fhir);
      await tx.query('UPDATE patient_merge SET annulee_le=$1, annulee_par=$2, motif_annulation=$3 WHERE id=$4',
        [this.now().toISOString(), acteur, motif.trim(), mergeId]);
      await this.event(tx, 'fusion_annulee', acteur, m.survivant_id, { absorbe: m.absorbe_id, fusion: mergeId, motif: motif.trim() });
    });
  }
}
