import { C1_EXEMPT, C2_DATA, MATRIX, VITAL, type Cell, type Right, type Where } from './matrix.js';
import {
  ACTIONS, DATA_TYPES, allow, deny, type AccessRequest, type Actor, type Condition, type DataRole, type Decision, type EngineConfig,
  type Item, type RoleGrant, type StaffRole,
} from './types.js';

/** Lecture dans une table par clé propre : jamais la chaîne de prototypes (`constructor`, `__proto__`, `toString`). */
export const own = <T>(table: Record<string, T> | Partial<Record<string, T>>, key: unknown): T | undefined =>
  typeof key === 'string' && Object.hasOwn(table, key) ? (table as Record<string, T>)[key] : undefined;

const validDate = (d: unknown): d is Date => d instanceof Date && Number.isFinite(d.getTime());
const ACTOR_KINDS: readonly string[] = ['patient', 'representant', 'accompagnant', 'staff', 'system'];

/**
 * Forme de la requête. Le moteur est appelé avec des valeurs qui viennent parfois d'une route, d'un JSON ou d'une
 * synchronisation : tout ce qui n'a pas EXACTEMENT le type attendu est refusé (jamais une comparaison silencieusement fausse).
 */
function malformed(req: AccessRequest): boolean {
  const c = req?.context as AccessRequest['context'] | undefined;
  if (!c || !req.actor || !ACTOR_KINDS.includes(req.actor.kind)) return true;
  if (!(ACTIONS as readonly unknown[]).includes(req.action) || !(DATA_TYPES as readonly unknown[]).includes(req.data)) return true;
  if (typeof req.patientId !== 'string' || req.patientId === '' || !validDate(c.now)) return true;
  if (req.actor.kind === 'staff' && (!Array.isArray(req.actor.roles) || req.actor.roles.some((g) => typeof g?.role !== 'string'))) return true;
  const ep = c.episode;
  if (ep !== undefined && (typeof ep !== 'object' || ep === null || !validDate(ep.expiresAt) || (ep.closedAt != null && !validDate(ep.closedAt)) || typeof ep.establishmentId !== 'string')) return true;
  const it = c.item;
  if (it !== undefined && (typeof it !== 'object' || it === null || (it.validatedAt !== undefined && !validDate(it.validatedAt)))) return true;
  if (c.emergency !== undefined && (typeof c.emergency !== 'object' || c.emergency === null || typeof c.emergency.motive !== 'string')) return true;
  if (c.export !== undefined && (typeof c.export !== 'object' || c.export === null || (c.export.format !== 'pdf' && c.export.format !== 'fhir'))) return true;
  if (c.opposedProfessionals !== undefined && !Array.isArray(c.opposedProfessionals)) return true;
  return false;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = { releaseDelayHours: 72, emergencyMotiveMinLength: 10 };

const EMERGENCY_ROLES: StaffRole[] = ['infirmier', 'medecin', 'directeur_medical'];
/** Données du représentant qui n'exigent pas de précision sur la confidentialité d'un élément. */
const REP_NO_ITEM: ReadonlySet<string> = new Set(['identity', 'summary', 'restrictions']);
/** Données faites d'éléments pouvant être masqués par le patient (C6). */
const ITEM_DATA: ReadonlySet<string> = new Set(['consultations', 'vitals', 'prescriptions', 'exams', 'vaccinations', 'documents']);
const DATA_ROLES: ReadonlySet<string> = new Set<DataRole>(['secretaire', 'infirmier', 'medecin', 'directeur_medical', 'pharmacien', 'laboratoire']);

/**
 * Moteur de décision unique (onglet 2) : fonction pure, sans accès à la base ni à l'horloge (l'heure est dans la
 * requête) ; les mêmes entrées donnent la même décision en mode central et en mode local. Refus par défaut :
 * toute cellule, condition ou information manquante donne un refus.
 */
export function decide(req: AccessRequest, cfg: EngineConfig = DEFAULT_ENGINE_CONFIG): Decision {
  if (malformed(req)) return deny('invalid_input');
  if (!Number.isFinite(cfg?.releaseDelayHours) || !Number.isFinite(cfg?.emergencyMotiveMinLength)) return deny('invalid_config');
  const { actor, context } = req;
  // Export de masse : interdit à tous les rôles (onglet 2.5) ; seules les statistiques anonymisées vers DHIS2 existent.
  if (context.export?.bulk) return deny('bulk_export_forbidden');
  if (req.action === 'E' && !context.export) return deny('export_format_required');
  if (context.export && req.action !== 'E') return deny('export_requires_action_E');
  // Export FHIR : réservé aux systèmes homologués, « jamais à un utilisateur individuel » (onglet 2.5).
  if (context.export?.format === 'fhir' && actor.kind !== 'system') return deny('fhir_export_systems_only');

  switch (actor.kind) {
    case 'accompagnant':
      return deny('companion_no_content', 'C9'); // C9 : jamais de droit sur le contenu (seulement les SMS, hors moteur)
    case 'system':
      return decideSystem(req, actor);
    case 'patient':
      if (actor.patientId !== req.patientId) return deny('not_own_record');
      return grantCell('patient', req, cfg);
    case 'representant': {
      const rep = context.representation;
      if (!rep || rep.personId !== actor.personId || rep.childId !== req.patientId) return deny('no_representation', 'C3');
      if (!rep.active) return deny('representation_inactive', 'C3');
      if (rep.childAutonomous) return deny('child_autonomous', 'C3');
      // Une consultation confidentielle n'existe pas pour le représentant, quelle que soit la vue.
      // Refus par défaut : l'appelant doit AFFIRMER que l'élément n'est pas confidentiel (une information absente n'est pas « non confidentiel »).
      if (REP_NO_ITEM.has(req.data) ? false : context.item?.confidential !== false) return deny(context.item?.confidential === true ? 'confidential' : 'item_required', 'C3');
      return grantCell('representant', req, cfg);
    }
    case 'staff':
      return decideStaff(req, actor, cfg);
  }
}

/** Administrateurs techniques et systèmes : aucun accès au contenu médical, sauf export FHIR d'un système homologué. */
function decideSystem(req: AccessRequest, actor: Extract<Actor, { kind: 'system' }>): Decision {
  const x = req.context.export;
  if (!(req.action === 'E' && x?.format === 'fhir')) return deny('system_no_content');
  if (!actor.homologated) return deny('system_not_homologated');
  if (req.data === 'journal' || req.data === 'restrictions' || req.data === 'consultation_status') return deny('not_exportable');
  const ep = req.context.episode;
  if (!ep || ep.closedAt || req.context.now >= ep.expiresAt) return deny('episode_required', 'C1');
  return allow(['C1']);
}

function itemRule(where: Where | undefined, item: Item | undefined, actorSub?: string): string | null {
  if (!where) return null;
  switch (where) {
    case 'active': return item?.active === true ? null : 'item_not_active';
    case 'currentCare': return item?.currentCare === true ? null : 'item_not_current_care';
    case 'examPrescrit': return item?.examKind === 'prescrit' ? null : 'exam_not_prescribed';
    case 'examResultat': return item?.examKind === 'resultat' ? null : 'exam_not_result';
    case 'delegatedDraft': return item?.delegatedDraft === true && item.status === 'brouillon' && (actorSub === undefined || item.authorSub === actorSub) ? null : 'not_delegated_draft';
  }
}

/** Évalue une cellule de la matrice pour un rôle, avec les conditions propres à la cellule (C2, C4, C5). */
function evalCell(cell: Cell | undefined, req: AccessRequest, cfg: EngineConfig, side: 'patient' | 'staff', actorSub?: string): Decision {
  const right: Right | undefined = cell ? own(cell, req.action) : undefined;
  if (!right) return deny('role_not_permitted');
  const item = req.context.item;
  const used: Condition[] = [];

  const bad = itemRule(right.where, item, actorSub);
  if (bad) return deny(bad, right.conds?.includes('C4') ? 'C4' : undefined);

  if (right.conds?.includes('C4')) used.push('C4'); // saisie déléguée : brouillon seulement (contrôlé par `where`)

  // C2 — visibilité différée pour le patient et son représentant.
  if (side === 'patient' && C2_DATA.includes(req.data)) {
    if (!item || item.status !== 'valide' || !item.validatedAt) return deny('not_validated', 'C2');
    const visibleAt = item.validatedAt.getTime() + cfg.releaseDelayHours * 3_600_000;
    if (!item.releasedEarly && req.context.now.getTime() < visibleAt) return deny('release_delay', 'C2');
    used.push('C2');
  }

  // C5 — jamais de modification d'un élément validé : correction par addendum.
  if (right.conds?.includes('C5')) {
    if (req.action === 'M' && item?.status !== 'brouillon' && item?.status !== 'renvoye') return deny('addendum_required', 'C5');
    used.push('C5');
  }
  return allow(used, right.fields);
}

function grantCell(role: DataRole, req: AccessRequest, cfg: EngineConfig): Decision {
  const side = role === 'patient' || role === 'representant' ? 'patient' : 'staff';
  const d = evalCell(own(MATRIX, req.data) ? own(own(MATRIX, req.data)!, role) : undefined, req, cfg, side);
  if (d.allow && role === 'representant') d.conditions.unshift('C3');
  return d;
}

function c1Applies(req: AccessRequest): boolean {
  return !C1_EXEMPT.some((e) => e.data === req.data && (e.action === undefined || e.action === req.action));
}

/** C1 pour un rôle donné : prise en charge ouverte dans l'établissement (et le service si le périmètre par service est activé). */
function c1(req: AccessRequest, actor: Extract<Actor, { kind: 'staff' }>, g: RoleGrant): Decision | null {
  const ep = req.context.episode;
  if (!ep) return deny('episode_required', 'C1');
  if (ep.establishmentId !== actor.establishmentId) return deny('other_establishment', 'C1');
  // Exception : le professionnel complète et valide ses propres consultations après clôture, sans relire l'historique ; ni export ni partage après clôture.
  const own = req.data === 'consultations' && (req.action === 'C' || req.action === 'Cr' || req.action === 'M') && req.context.item?.authorSub === actor.sub && (g.role === 'medecin' || g.role === 'directeur_medical');
  if (own) return null;
  if (ep.closedAt || req.context.now >= ep.expiresAt) return deny('episode_closed', 'C1');
  if (ep.serviceScoped) {
    const inService = g.serviceId !== null ? g.serviceId === ep.serviceId : g.role === 'directeur_medical';
    if (!inService) return deny('service_mismatch', 'C1');
  }
  return null;
}

function decideStaff(req: AccessRequest, actor: Extract<Actor, { kind: 'staff' }>, cfg: EngineConfig): Decision {
  if (!actor.active) return deny('account_disabled');
  if (!actor.establishmentId || actor.roles.length === 0) return deny('no_establishment_or_role');

  if (req.context.emergency) return decideEmergency(req, actor, cfg);

  // C7 — un professionnel nommé par le patient n'accède plus au dossier (sauf urgence, traitée plus haut).
  if (req.context.opposedProfessionals?.includes(actor.sub)) return deny('opposed', 'C7');
  // C6 — un élément masqué par le patient n'est visible que de son auteur.
  const item = req.context.item;
  if (ITEM_DATA.has(req.data) && req.action !== 'Cr' && typeof item?.masked !== 'boolean') return deny('item_required', 'C6');
  if (item?.masked && item.authorSub !== actor.sub) return deny('masked', 'C6');

  if (req.data === 'journal' && req.context.scopeEstablishmentId !== actor.establishmentId) return deny('other_establishment');

  let best: Decision = deny('role_not_permitted');
  for (const g of actor.roles) {
    if (!DATA_ROLES.has(g.role)) continue;
    let d = evalCell(own(MATRIX, req.data) ? own(own(MATRIX, req.data)!, g.role) : undefined, req, cfg, 'staff', actor.sub);
    if (d.allow && c1Applies(req)) {
      const blocked = c1(req, actor, g);
      if (blocked) d = blocked;
      else d.conditions.push('C1');
    }
    if (d.allow) return d;
    if (best.allow === false && best.reason === 'role_not_permitted') best = d; // garde le refus le plus informatif
  }
  return best;
}

/** C8 — accès d'urgence : motif obligatoire, informations vitales seulement, consultation seule. */
function decideEmergency(req: AccessRequest, actor: Extract<Actor, { kind: 'staff' }>, cfg: EngineConfig): Decision {
  if (!actor.roles.some((g) => EMERGENCY_ROLES.includes(g.role))) return deny('emergency_role', 'C8');
  if ((req.context.emergency!.motive ?? '').trim().length < cfg.emergencyMotiveMinLength) return deny('emergency_motive_required', 'C8');
  if (req.action !== 'C') return deny('emergency_read_only', 'C8');
  const vital = own(VITAL, req.data);
  if (!vital) return deny('emergency_vital_only', 'C8');
  const bad = itemRule(vital.where, req.context.item);
  if (bad) return deny('emergency_vital_only', 'C8');
  // L'urgence passe outre C1 (pas de prise en charge), C6 (masquage) et C7 (opposition) pour ces informations seulement.
  return allow(['C8'], vital.fields);
}
