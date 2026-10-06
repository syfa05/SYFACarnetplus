import { randomUUID } from 'node:crypto';
import type { Db, Queryable } from '../db/db.js';
import type { IdentityConfig } from './config.js';
import type { FieldCrypto } from './crypto.js';
import { IdentityError } from './errors.js';
import { noFhirReassigner, type FhirReferenceReassigner } from './fhir-port.js';
import { normalizeName, phoneticKey } from './normalize.js';
import { matchScore, type Profile } from './scoring.js';
import type { IdentifierInput, IdentifierType, Match, MatchResult, Patient, PatientInput } from './types.js';

const COLS = `id, nom_chiffre, prenoms_chiffre, date_naissance_chiffre, date_precision, sexe, lieu_naissance_chiffre,
  nom_mere_chiffre, nom_pere_chiffre, niveau_identite, telephone_chiffre, langue, localite_chiffre, statut_dossier, merged_into`;

interface Row {
  id: string;
  nom_chiffre: string;
  prenoms_chiffre: string;
  date_naissance_chiffre: string;
  date_precision: Patient['datePrecision'];
  sexe: Patient['sexe'];
  lieu_naissance_chiffre: string | null;
  nom_mere_chiffre: string | null;
  nom_pere_chiffre: string | null;
  niveau_identite: number;
  telephone_chiffre: string | null;
  langue: Patient['langue'];
  localite_chiffre: string | null;
  statut_dossier: Patient['statutDossier'];
  merged_into: string | null;
}

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

// Contraintes techniques de saisie (pas des règles métier paramétrables).
const PHONE = /^2376\d{8}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_TEXT = 200;
const MAX_IDENTIFIER = 64;
const MAX_IDENTIFIERS = 10;

const isUniqueViolation = (e: unknown): boolean => (e as { code?: string } | null)?.code === '23505';

function validate(input: PatientInput): void {
  const errors: string[] = [];
  const need = (v: string | undefined, code: string) => {
    if (!v || !v.trim()) errors.push(code);
  };
  need(input.nom, 'nom_requis');
  need(input.prenoms, 'prenoms_requis');
  if (input.nom?.trim() && !normalizeName(input.nom)) errors.push('nom_invalide');
  if (input.prenoms?.trim() && !normalizeName(input.prenoms)) errors.push('prenoms_invalide');
  for (const v of [input.nom, input.prenoms, input.lieuNaissance, input.nomMere, input.nomPere, input.localite, input.contactUrgenceNom]) {
    if (v !== undefined && v.length > MAX_TEXT) errors.push('texte_trop_long');
  }
  const precision = input.datePrecision ?? 'jour';
  if (!['jour', 'mois', 'annee'].includes(precision)) errors.push('date_precision_invalide');
  const m = ISO_DATE.exec(input.dateNaissance ?? '');
  const d = m ? new Date(`${input.dateNaissance}T00:00:00Z`) : null;
  if (!m || !d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== input.dateNaissance) {
    errors.push('date_naissance_invalide');
  } else {
    if (d.getTime() > Date.now()) errors.push('date_naissance_future');
    // Jour ou mois inconnu : stocké à 01, avec l'indicateur de précision correspondant.
    if ((precision === 'mois' && m[3] !== '01') || (precision === 'annee' && (m[2] !== '01' || m[3] !== '01'))) {
      errors.push('date_precision_incoherente');
    }
  }
  if (!['F', 'M', 'I'].includes(input.sexe)) errors.push('sexe_invalide');
  if (![1, 2, 3].includes(input.niveauIdentite)) errors.push('niveau_identite_invalide');
  if (!['fr', 'en'].includes(input.langue)) errors.push('langue_invalide');
  if (input.telephone !== undefined && !PHONE.test(input.telephone)) errors.push('telephone_invalide');
  if (input.contactUrgenceTelephone !== undefined && !PHONE.test(input.contactUrgenceTelephone)) {
    errors.push('contact_urgence_telephone_invalide');
  }
  if (input.niveauIdentite !== 1 && !input.lieuNaissance?.trim()) errors.push('lieu_naissance_requis');
  const ids = input.identifiants ?? [];
  if (ids.length > MAX_IDENTIFIERS) errors.push('trop_d_identifiants');
  for (const i of ids) {
    if (!['csu', 'cni', 'acte'].includes(i.type)) errors.push('identifiant_type_invalide');
    const v = normalizeIdentifier(i.valeur ?? '');
    if (!v) errors.push('identifiant_vide');
    if (v.length > MAX_IDENTIFIER) errors.push('identifiant_trop_long');
  }
  if (input.niveauIdentite === 1 && !ids.some((i) => i.type === 'csu' || i.type === 'cni')) {
    errors.push('niveau_1_exige_csu_ou_cni');
  }
  if (errors.length) throw new IdentityError('validation', { errors: [...new Set(errors)] });
}

function requireActor(acteur: string): void {
  if (!acteur?.trim()) throw new IdentityError('acteur_requis');
}

export class IdentityService {
  constructor(
    private readonly db: Db,
    private readonly config: IdentityConfig,
    private readonly crypto: FieldCrypto,
    private readonly fhir: FhirReferenceReassigner = noFhirReassigner,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ---- chiffrement ------------------------------------------------------------------------------------------

  private enc(id: string, col: string, v: string | null | undefined): string | null {
    return v == null || v === '' ? null : this.crypto.encrypt(v, `patient:${id}:${col}`);
  }
  private dec(id: string, col: string, v: string | null): string | null {
    return v == null ? null : this.crypto.decrypt(v, `patient:${id}:${col}`);
  }
  private phonIdx(normalized: string): string {
    return this.crypto.blindIndex('phon', phoneticKey(normalized));
  }
  private identIdx(type: IdentifierType, valeur: string): string {
    return this.crypto.blindIndex(`ident:${type}`, normalizeIdentifier(valeur));
  }

  private toPatient(r: Row): Patient {
    return {
      id: r.id,
      nom: this.dec(r.id, 'nom', r.nom_chiffre)!,
      prenoms: this.dec(r.id, 'prenoms', r.prenoms_chiffre)!,
      dateNaissance: this.dec(r.id, 'date_naissance', r.date_naissance_chiffre)!,
      datePrecision: r.date_precision,
      sexe: r.sexe,
      lieuNaissance: this.dec(r.id, 'lieu_naissance', r.lieu_naissance_chiffre),
      nomMere: this.dec(r.id, 'nom_mere', r.nom_mere_chiffre),
      nomPere: this.dec(r.id, 'nom_pere', r.nom_pere_chiffre),
      niveauIdentite: r.niveau_identite as Patient['niveauIdentite'],
      telephone: this.dec(r.id, 'telephone', r.telephone_chiffre),
      langue: r.langue,
      localite: this.dec(r.id, 'localite', r.localite_chiffre),
      statutDossier: r.statut_dossier,
      mergedInto: r.merged_into,
    };
  }

  private profileOf(p: Patient): Profile {
    return {
      nomNormalise: normalizeName(p.nom),
      prenomsNormalise: normalizeName(p.prenoms),
      dateNaissance: p.dateNaissance,
      datePrecision: p.datePrecision,
      sexe: p.sexe,
      nomMereNormalise: p.nomMere ? normalizeName(p.nomMere) : null,
    };
  }

  /** Colonnes chiffrées et index aveugles d'un nouveau dossier (aussi utilisé pour les chargements en masse). */
  patientRow(input: PatientInput, id: string): Record<string, unknown> {
    const nomN = normalizeName(input.nom);
    const prenomsN = normalizeName(input.prenoms);
    return {
      id,
      nom_chiffre: this.enc(id, 'nom', input.nom.trim()),
      prenoms_chiffre: this.enc(id, 'prenoms', input.prenoms.trim()),
      nom_idx: this.phonIdx(nomN),
      prenoms_idx: this.phonIdx(prenomsN),
      date_naissance_chiffre: this.enc(id, 'date_naissance', input.dateNaissance),
      date_naissance_idx: this.crypto.blindIndex('dob', input.dateNaissance),
      date_precision: input.datePrecision ?? 'jour',
      sexe: input.sexe,
      lieu_naissance_chiffre: this.enc(id, 'lieu_naissance', input.lieuNaissance?.trim()),
      nom_mere_chiffre: this.enc(id, 'nom_mere', input.nomMere?.trim()),
      nom_pere_chiffre: this.enc(id, 'nom_pere', input.nomPere?.trim()),
      niveau_identite: input.niveauIdentite,
      telephone_chiffre: this.enc(id, 'telephone', input.telephone),
      telephone_idx: input.telephone ? this.crypto.blindIndex('tel', input.telephone) : null,
      langue: input.langue,
      contact_urgence_nom_chiffre: this.enc(id, 'contact_urgence_nom', input.contactUrgenceNom),
      contact_urgence_telephone_chiffre: this.enc(id, 'contact_urgence_telephone', input.contactUrgenceTelephone),
      localite_chiffre: this.enc(id, 'localite', input.localite),
      statut_dossier: input.provisoire ? 'provisoire' : 'actif',
      created_at: this.now().toISOString(),
    };
  }

  // ---- journal ----------------------------------------------------------------------------------------------

  private async event(q: Queryable, type: string, acteur: string, patientId: string | null, details: Record<string, unknown> = {}) {
    await q.query('INSERT INTO identity_event (at, type, acteur, patient_id, details) VALUES ($1,$2,$3,$4,$5::jsonb)', [
      this.now().toISOString(), type, acteur, patientId, JSON.stringify(details),
    ]);
  }

  // ---- lecture / rapprochement ------------------------------------------------------------------------------

  /** Suit la redirection des dossiers fusionnés jusqu'au dossier conservé. */
  async resolve(id: string, q: Queryable = this.db): Promise<Patient | null> {
    let current = id;
    for (let i = 0; i < 20; i++) {
      const { rows } = await q.query<Row>(`SELECT ${COLS} FROM patient WHERE id = $1`, [current]);
      const row = rows[0];
      if (!row) return null;
      if (!row.merged_into) return this.toPatient(row);
      current = row.merged_into;
    }
    throw new IdentityError('redirection_cyclique', { id });
  }

  async findByIdentifier(type: IdentifierType, valeur: string, q: Queryable = this.db): Promise<Patient | null> {
    const { rows } = await q.query<{ patient_id: string }>(
      'SELECT patient_id FROM patient_identifier WHERE type = $1 AND valeur_idx = $2 LIMIT 1',
      [type, this.identIdx(type, valeur)],
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
    // Candidats : même clé phonétique du nom (ou du prénom, si les deux sont inversés), ou même prénom et même date.
    const nomIdx = this.phonIdx(query.nomNormalise);
    const prenomsIdx = this.phonIdx(query.prenomsNormalise);
    const { rows } = await q.query<Row>(
      `SELECT ${COLS} FROM patient
       WHERE statut_dossier <> 'fusionne'
         AND (nom_idx = $1 OR nom_idx = $2 OR (prenoms_idx = $2 AND date_naissance_idx = $3))`,
      [nomIdx, prenomsIdx, this.crypto.blindIndex('dob', input.dateNaissance)],
    );
    const scored: Match[] = rows
      .filter((r) => !strong.has(r.id))
      .map((r) => this.toPatient(r))
      .map((patient) => ({ patient, score: matchScore(query, this.profileOf(patient), this.config.match) }))
      .filter((m) => m.score >= this.config.seuilBas)
      .sort((a, b) => b.score - a.score);
    return {
      strong: [...strong.values()],
      probable: scored.filter((m) => m.score >= this.config.seuilHaut),
      possible: scored.filter((m) => m.score < this.config.seuilHaut).slice(0, this.config.maxPossibles),
    };
  }

  // ---- inscription ------------------------------------------------------------------------------------------

  async register(input: PatientInput, acteur: string, options: RegisterOptions = {}): Promise<RegisterResult> {
    requireActor(acteur);
    validate(input);
    // Deux inscriptions simultanées avec le même CSU/CNI : la base tranche (index unique) ; on rejoue pour
    // retrouver le dossier créé par l'autre et répondre « existant ».
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.registerOnce(input, acteur, options);
      } catch (e) {
        if (attempt === 0 && isUniqueViolation(e)) continue;
        throw e;
      }
    }
  }

  private registerOnce(input: PatientInput, acteur: string, options: RegisterOptions): Promise<RegisterResult> {
    return this.db.transaction(async (tx): Promise<RegisterResult> => {
      const found = await this.findMatches(input, tx);
      if (found.strong.length) {
        await this.event(tx, 'creation_refusee_identifiant', acteur, found.strong[0]!.id, {
          existants: found.strong.map((p) => p.id),
        });
        return { outcome: 'existing', patients: found.strong };
      }
      const justification = options.justification?.trim();
      if (found.probable.length && !justification) {
        return { outcome: 'justification_required', matches: found.probable };
      }
      if (!found.probable.length && found.possible.length && !options.confirmNew) {
        return { outcome: 'review_required', matches: found.possible };
      }
      const patient = await this.insert(tx, input, acteur);
      if (found.probable.length) {
        await this.event(tx, 'doublon_probable_justifie', acteur, patient.id, {
          justification,
          correspondances: found.probable.map((m) => ({ id: m.patient.id, score: m.score })),
        });
      }
      return { outcome: 'created', patient };
    });
  }

  private async insert(tx: Queryable, input: PatientInput, acteur: string): Promise<Patient> {
    const id = randomUUID();
    const row = this.patientRow(input, id);
    const cols = Object.keys(row);
    await tx.query(
      `INSERT INTO patient (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
      cols.map((c) => row[c]),
    );
    const seen = new Set<string>();
    for (const i of input.identifiants ?? []) {
      const key = `${i.type}:${normalizeIdentifier(i.valeur)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await this.insertIdentifier(tx, id, i);
    }
    await this.event(tx, 'patient_cree', acteur, id, { niveau: input.niveauIdentite });
    return (await this.resolve(id, tx))!;
  }

  private async insertIdentifier(tx: Queryable, patientId: string, i: IdentifierInput): Promise<void> {
    await tx.query(
      'INSERT INTO patient_identifier (id, patient_id, type, valeur_chiffre, valeur_idx, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [
        randomUUID(), patientId, i.type,
        this.crypto.encrypt(normalizeIdentifier(i.valeur), `identifier:${patientId}:${i.type}`),
        this.identIdx(i.type, i.valeur), this.now().toISOString(),
      ],
    );
  }

  /** Ajoute un identifiant à un dossier existant, sans toucher à l'historique (F-ID-03). Idempotent. */
  async addIdentifier(patientId: string, ident: IdentifierInput, acteur: string): Promise<Patient> {
    requireActor(acteur);
    const valeur = normalizeIdentifier(ident.valeur ?? '');
    if (!['csu', 'cni', 'acte'].includes(ident.type) || !valeur || valeur.length > MAX_IDENTIFIER) {
      throw new IdentityError('validation', { errors: ['identifiant_invalide'] });
    }
    try {
      return await this.db.transaction(async (tx) => {
        const target = await this.resolve(patientId, tx);
        if (!target) throw new IdentityError('patient_introuvable');
        if (target.id !== patientId) throw new IdentityError('dossier_fusionne', { conserve: target.id });
        const idx = this.identIdx(ident.type, valeur);
        const same = await tx.query('SELECT 1 FROM patient_identifier WHERE patient_id=$1 AND type=$2 AND valeur_idx=$3', [patientId, ident.type, idx]);
        if (same.rows.length) return target;
        if (ident.type !== 'acte') {
          const owner = await this.findByIdentifier(ident.type, valeur, tx);
          if (owner) throw new IdentityError('identifiant_deja_attribue', { existant: owner.id });
        }
        await this.insertIdentifier(tx, patientId, ident);
        await this.event(tx, 'identifiant_ajoute', acteur, patientId, { type: ident.type });
        return target;
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const owner = await this.findByIdentifier(ident.type, valeur);
      if (owner?.id === patientId) return owner;
      throw new IdentityError('identifiant_deja_attribue', { existant: owner?.id ?? null });
    }
  }

  // ---- fusion -----------------------------------------------------------------------------------------------

  /**
   * Fusion réversible : le dossier absorbé pointe vers le dossier conservé (onglet 3.3).
   * Deux temps : (1) base identité, atomique ; (2) réaffectation FHIR. Si (2) échoue, la base est restaurée ;
   * si cette restauration échoue aussi, la fusion est marquée « à réconcilier » (jamais d'échec silencieux).
   */
  async merge(survivantId: string, absorbeId: string, acteur: string, motif: string): Promise<string> {
    requireActor(acteur);
    if (!motif?.trim()) throw new IdentityError('motif_requis');
    if (survivantId === absorbeId) throw new IdentityError('fusion_meme_dossier');

    const mergeId = await this.db.transaction(async (tx) => {
      // Verrou dans un ordre fixe (id croissant) : deux fusions croisées ne s'interbloquent pas.
      const rows = (await tx.query<{ id: string; statut_dossier: string }>(
        'SELECT id, statut_dossier FROM patient WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[survivantId, absorbeId]],
      )).rows;
      const surv = rows.find((r) => r.id === survivantId);
      const abs = rows.find((r) => r.id === absorbeId);
      if (!surv || !abs) throw new IdentityError('patient_introuvable');
      if (surv.statut_dossier === 'fusionne' || abs.statut_dossier === 'fusionne') throw new IdentityError('dossier_deja_fusionne');
      // Le décès ne doit jamais être perdu ni inventé par une fusion : les deux dossiers sont décédés, ou aucun.
      if ((surv.statut_dossier === 'decede') !== (abs.statut_dossier === 'decede')) throw new IdentityError('fusion_decede_incompatible');
      // Un lien parent-enfant entre les deux dossiers deviendrait un lien d'une personne avec elle-même.
      const between = await tx.query(
        `SELECT 1 FROM representation_link
         WHERE (id_enfant=$1 AND id_representant=$2) OR (id_enfant=$2 AND id_representant=$1) LIMIT 1`, [survivantId, absorbeId]);
      if (between.rows.length) throw new IdentityError('fusion_lien_representation_entre_dossiers');
      const pending = await tx.query("SELECT 1 FROM patient_merge WHERE absorbe_id=$1 AND fhir_etat <> 'ok' LIMIT 1", [absorbeId]);
      if (pending.rows.length) throw new IdentityError('fusion_fhir_non_reconciliee');

      const ids = await tx.query<{ id: string }>('UPDATE patient_identifier SET patient_id=$1 WHERE patient_id=$2 RETURNING id', [survivantId, absorbeId]);
      const enfant = await tx.query<{ id: string }>('UPDATE representation_link SET id_enfant=$1 WHERE id_enfant=$2 RETURNING id', [survivantId, absorbeId]);
      const repr = await tx.query<{ id: string }>('UPDATE representation_link SET id_representant=$1 WHERE id_representant=$2 RETURNING id', [survivantId, absorbeId]);
      const deleg = await tx.query<{ id: string }>('UPDATE companion_delegation SET id_enfant=$1 WHERE id_enfant=$2 RETURNING id', [survivantId, absorbeId]);
      await tx.query("UPDATE patient SET statut_dossier='fusionne', merged_into=$1 WHERE id=$2", [survivantId, absorbeId]);
      const id = randomUUID();
      await tx.query(
        `INSERT INTO patient_merge (id, survivant_id, absorbe_id, statut_precedent, effectuee_par, motif, deplace, created_at, fhir_etat, fhir_operation)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'en_attente','reassign')`,
        [id, survivantId, absorbeId, abs.statut_dossier, acteur, motif.trim(),
         JSON.stringify({ identifiants: ids.rows.map((r) => r.id), liensEnfant: enfant.rows.map((r) => r.id), liensRepresentant: repr.rows.map((r) => r.id), delegations: deleg.rows.map((r) => r.id) }),
         this.now().toISOString()],
      );
      await this.event(tx, 'patient_fusionne', acteur, survivantId, { absorbe: absorbeId, fusion: id, motif: motif.trim() });
      return id;
    });

    let refs: unknown[];
    try {
      refs = await this.fhir.reassign(absorbeId, survivantId);
    } catch (cause) {
      await this.compensateFailedMerge(mergeId, acteur, cause);
      throw new IdentityError('fhir_reaffectation_echouee', { fusion: mergeId }, cause); // la base a été restaurée
    }
    await this.db.query("UPDATE patient_merge SET references_fhir=$1::jsonb, fhir_etat='ok', fhir_operation=NULL, fhir_erreur=NULL WHERE id=$2", [JSON.stringify(refs), mergeId]);
    return mergeId;
  }

  private async compensateFailedMerge(mergeId: string, acteur: string, cause: unknown): Promise<void> {
    const message = cause instanceof Error ? cause.message : String(cause);
    try {
      await this.db.transaction(async (tx) => {
        await this.revertDatabase(tx, mergeId, acteur, 'echec_reaffectation_fhir', 'ok', null);
        await this.event(tx, 'fusion_echec_fhir', acteur, null, { fusion: mergeId, erreur: message });
      });
    } catch (e) {
      // Ni FHIR ni la base ne sont revenus à un état sûr : on le dit, durablement, pour la reprise.
      await this.db.query("UPDATE patient_merge SET fhir_etat='a_reconcilier', fhir_operation='reassign', fhir_erreur=$1 WHERE id=$2", [message, mergeId]);
      await this.event(this.db, 'fusion_a_reconcilier', acteur, null, { fusion: mergeId, erreur: message });
      throw new IdentityError('fusion_a_reconcilier', { fusion: mergeId }, e);
    }
  }

  /** Annule une fusion : restitue le dossier absorbé et tout ce qui avait été réaffecté. */
  async unmerge(mergeId: string, acteur: string, motif: string): Promise<void> {
    requireActor(acteur);
    if (!motif?.trim()) throw new IdentityError('motif_requis');
    const m = await this.db.transaction((tx) => this.revertDatabase(tx, mergeId, acteur, motif.trim(), 'en_attente', 'restore'));
    try {
      await this.fhir.restore(m.absorbe_id, m.survivant_id, m.references_fhir);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await this.db.query("UPDATE patient_merge SET fhir_etat='a_reconcilier', fhir_operation='restore', fhir_erreur=$1 WHERE id=$2", [message, mergeId]);
      await this.event(this.db, 'annulation_fhir_a_reconcilier', acteur, m.survivant_id, { fusion: mergeId, erreur: message });
      throw new IdentityError('fhir_restauration_echouee', { fusion: mergeId }, cause); // à reprendre : reconcileFhir
    }
    await this.db.query("UPDATE patient_merge SET fhir_etat='ok', fhir_operation=NULL, fhir_erreur=NULL WHERE id=$1", [mergeId]);
  }

  /** Partie « base identité » de l'annulation, partagée avec la compensation d'une fusion dont la phase FHIR a échoué. */
  private async revertDatabase(
    tx: Queryable, mergeId: string, acteur: string, motif: string,
    fhirEtat: 'ok' | 'en_attente', fhirOperation: 'restore' | null,
  ) {
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
    await tx.query(
      'UPDATE patient_merge SET annulee_le=$1, annulee_par=$2, motif_annulation=$3, fhir_etat=$4, fhir_operation=$5 WHERE id=$6',
      [this.now().toISOString(), acteur, motif, fhirEtat, fhirOperation, mergeId],
    );
    await this.event(tx, 'fusion_annulee', acteur, m.survivant_id, { absorbe: m.absorbe_id, fusion: mergeId, motif });
    return m;
  }

  /** Fusions dont la synchronisation FHIR n'est pas terminée (reprise après incident ou arrêt en cours de route). */
  async pendingFhirSyncs(): Promise<string[]> {
    return (await this.db.query<{ id: string }>("SELECT id FROM patient_merge WHERE fhir_etat <> 'ok' ORDER BY created_at")).rows.map((r) => r.id);
  }

  /** Rejoue la réaffectation ou la restauration FHIR en attente (idempotentes, voir le contrat du port). */
  async reconcileFhir(mergeId: string, acteur: string): Promise<void> {
    requireActor(acteur);
    const m = (await this.db.query<{
      survivant_id: string; absorbe_id: string; annulee_le: string | null; fhir_etat: string; references_fhir: unknown[];
    }>('SELECT survivant_id, absorbe_id, annulee_le, fhir_etat, references_fhir FROM patient_merge WHERE id=$1', [mergeId])).rows[0];
    if (!m) throw new IdentityError('fusion_introuvable');
    if (m.fhir_etat === 'ok') return;
    try {
      if (m.annulee_le) {
        await this.fhir.restore(m.absorbe_id, m.survivant_id, m.references_fhir);
        await this.db.query("UPDATE patient_merge SET fhir_etat='ok', fhir_operation=NULL, fhir_erreur=NULL WHERE id=$1", [mergeId]);
      } else {
        const refs = await this.fhir.reassign(m.absorbe_id, m.survivant_id);
        await this.db.query("UPDATE patient_merge SET references_fhir=$1::jsonb, fhir_etat='ok', fhir_operation=NULL, fhir_erreur=NULL WHERE id=$2", [JSON.stringify(refs), mergeId]);
      }
      await this.event(this.db, 'fhir_reconcilie', acteur, m.survivant_id, { fusion: mergeId });
    } catch (cause) {
      await this.db.query("UPDATE patient_merge SET fhir_etat='a_reconcilier', fhir_erreur=$1 WHERE id=$2", [cause instanceof Error ? cause.message : String(cause), mergeId]);
      throw new IdentityError('fhir_reconciliation_echouee', { fusion: mergeId }, cause);
    }
  }
}
