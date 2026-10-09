import { malformedActor, own } from './engine.js';
import { allow, deny, type Actor, type Decision, type RoleGrant, type StaffRole } from './types.js';

/** Actions d'administration (onglet 2, section 2.3). */
export const ADMIN_ACTIONS = [
  'card.issue', 'card.activate', 'card.block',
  'account.create', 'account.disable', 'role.assign',
  'emergency.control', 'journal.read',
  'patient.merge', 'death.declare', 'death.cancel', 'representative.change', 'pending.reconcile',
  'settings.national', 'software.certify',
  'supervision.review', 'establishment.manage', 'service.manage',
] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

type Scope = 'any' | 'establishment' | 'service';
interface Rule {
  scope: Scope;
  /** Rôles que l'on peut créer / attribuer / désactiver avec cette règle. */
  targetRoles?: readonly StaffRole[];
  needs?: 'officialDocument' | 'convention';
}

/** Rôles que le directeur médical gère dans son établissement. */
export const DIRECTOR_MANAGES: readonly StaffRole[] = ['chef_service', 'medecin', 'infirmier', 'secretaire', 'pharmacien', 'laboratoire', 'agent_emission', 'vaccinateur'];
/** Rôles que l'opérateur de la plateforme attribue (directeur médical, et les rôles nationaux ou de district). */
export const OPERATOR_MANAGES: readonly StaffRole[] = ['directeur_medical', 'chef_district', 'superviseur_pev'];

const ADMIN: Record<AdminAction, Partial<Record<StaffRole, Rule>>> = {
  'card.issue': { agent_emission: { scope: 'establishment' }, directeur_medical: { scope: 'establishment' } },
  'card.activate': { agent_emission: { scope: 'establishment' }, directeur_medical: { scope: 'establishment' } },
  'card.block': { agent_emission: { scope: 'establishment' }, directeur_medical: { scope: 'establishment' }, operateur: { scope: 'any' } },
  'account.create': { directeur_medical: { scope: 'establishment', targetRoles: DIRECTOR_MANAGES }, operateur: { scope: 'any', targetRoles: OPERATOR_MANAGES } },
  'account.disable': { directeur_medical: { scope: 'establishment', targetRoles: DIRECTOR_MANAGES }, operateur: { scope: 'any', targetRoles: OPERATOR_MANAGES } },
  'role.assign': { directeur_medical: { scope: 'establishment', targetRoles: DIRECTOR_MANAGES }, operateur: { scope: 'any', targetRoles: OPERATOR_MANAGES } },
  'emergency.control': { chef_service: { scope: 'service' }, directeur_medical: { scope: 'establishment' } },
  'journal.read': { chef_service: { scope: 'service' }, directeur_medical: { scope: 'establishment' }, operateur: { scope: 'any', needs: 'convention' } },
  'patient.merge': { directeur_medical: { scope: 'establishment' }, operateur: { scope: 'any' } },
  'death.declare': { medecin: { scope: 'establishment' } },
  'death.cancel': { directeur_medical: { scope: 'establishment' }, operateur: { scope: 'any' } },
  'representative.change': { directeur_medical: { scope: 'establishment', needs: 'officialDocument' }, operateur: { scope: 'any' } },
  'pending.reconcile': { directeur_medical: { scope: 'establishment' }, operateur: { scope: 'any' }, superviseur_pev: { scope: 'any' } },
  'settings.national': { administrateur_habilite: { scope: 'any' } },
  'software.certify': { operateur: { scope: 'any' } },
  // Contrôle par le niveau supérieur : traité à part (voir `upperLevel`).
  'supervision.review': {},
  'establishment.manage': { operateur: { scope: 'any' } },
  'service.manage': { directeur_medical: { scope: 'establishment' }, operateur: { scope: 'any' } },
};

/** Actions du directeur médical soumises au contrôle du niveau supérieur (onglet 2.3, dernier paragraphe). */
export const CONTROLLED_BY_UPPER_LEVEL: readonly string[] = ['account.create', 'account.password_reset', 'role.assign', 'patient.merge', 'death.cancel', 'emergency.access'];

export interface AdminTarget {
  establishmentId?: string | null;
  serviceId?: string | null;
  /** Compte visé (création, désactivation, attribution de rôle). */
  staffSub?: string;
  /** Rôles créés, attribués ou portés par le compte visé. */
  roles?: StaffRole[];
}
export interface AuditedEntry { actorSub: string; actorRoles: StaffRole[]; establishmentId: string | null; serviceId?: string | null; district: string | null }
export interface AdminContext {
  officialDocument?: boolean;
  conventionActive?: boolean;
  /** Contrôle : l'action ou l'accès contrôlé. */
  entry?: AuditedEntry;
  /** Un chef de district actif couvre le district de l'établissement concerné (« lorsqu'il est intégré »). */
  districtChiefAvailable?: boolean;
  /** District du chef de district qui agit. */
  actorDistrict?: string | null;
}
export interface AdminRequest { actor: Actor; action: AdminAction; target?: AdminTarget; context?: AdminContext }

const inScope = (g: RoleGrant, rule: Rule, actor: Extract<Actor, { kind: 'staff' }>, t: AdminTarget | undefined): boolean => {
  if (rule.scope === 'any') return true;
  if (!t?.establishmentId || t.establishmentId !== actor.establishmentId) return false;
  if (rule.scope === 'establishment') return true;
  return g.serviceId !== null && t.serviceId === g.serviceId;
};

/**
 * Contrôle de niveau supérieur : les actions du directeur médical sont contrôlées par le chef de district de santé
 * lorsqu'il est intégré, sinon par l'opérateur. Personne ne contrôle ses propres actions.
 */
function upperLevel(actor: Extract<Actor, { kind: 'staff' }>, ctx: AdminContext | undefined): Decision {
  const e = ctx?.entry;
  if (!e) return deny('entry_required');
  if (e.actorSub === actor.sub) return deny('self_control');
  if (!e.actorRoles.includes('directeur_medical')) return deny('not_upper_level_action');
  const isChief = actor.roles.some((g) => g.role === 'chef_district');
  const isOperator = actor.roles.some((g) => g.role === 'operateur');
  if (isChief && ctx?.actorDistrict && e.district !== null && ctx.actorDistrict === e.district) return allow();
  if (isOperator && ctx?.districtChiefAvailable === false) return allow(); // information absente : refus
  return deny('not_upper_level');
}

export function decideAdmin(req: AdminRequest): Decision {
  if (!req || typeof req !== 'object') return deny('invalid_input');
  const { actor, action, target, context } = req;
  if (!(ADMIN_ACTIONS as readonly unknown[]).includes(action) || !actor || typeof actor !== 'object') return deny('invalid_input');
  if (typeof actor !== 'object' || malformedActor(actor)) return deny('invalid_input');
  if (target !== undefined && (typeof target !== 'object' || target === null || (target.roles !== undefined && (!Array.isArray(target.roles) || target.roles.some((r) => typeof r !== 'string'))))) return deny('invalid_input');
  const entry = context?.entry;
  if (entry !== undefined && (typeof entry !== 'object' || entry === null || typeof entry.actorSub !== 'string' || !Array.isArray(entry.actorRoles))) return deny('invalid_input');
  if (actor.kind !== 'staff') return deny('staff_only');
  if (!actor.active) return deny('account_disabled');
  if (actor.roles.length === 0) return deny('no_role');

  if (action === 'supervision.review') return upperLevel(actor, context);

  // Personne n'agit sur son propre compte (création, désactivation, rôles).
  if ((action === 'account.disable' || action === 'role.assign' || action === 'account.create') && target?.staffSub === actor.sub) return deny('self_action');

  // Contrôle des accès d'urgence : ceux d'un directeur médical relèvent du niveau supérieur, jamais de lui-même ni de ses pairs.
  if (action === 'emergency.control') {
    const e = context?.entry;
    if (!e) return deny('entry_required');
    if (e.actorSub === actor.sub) return deny('self_control');
    if (e.actorRoles.includes('directeur_medical')) return upperLevel(actor, context);
    const t: AdminTarget = { establishmentId: e.establishmentId, serviceId: e.serviceId ?? null };
    for (const g of actor.roles) {
      const rule = own(ADMIN[action], g.role);
      if (rule && inScope(g, rule, actor, t)) return allow();
    }
    return deny('role_not_permitted');
  }

  let best: Decision = deny('role_not_permitted');
  for (const g of actor.roles) {
    const rule = own(ADMIN[action], g.role);
    if (!rule) continue;
    if (!inScope(g, rule, actor, target)) { best = deny('out_of_scope'); continue; }
    if (rule.needs === 'officialDocument' && !context?.officialDocument) { best = deny('official_document_required'); continue; }
    if (rule.needs === 'convention' && !context?.conventionActive) { best = deny('convention_required'); continue; }
    if (rule.targetRoles) {
      // Refus par défaut : les rôles du compte visé doivent être fournis (liste vide admise seulement pour une désactivation).
      const roles = target?.roles;
      if (!roles || (roles.length === 0 && action !== 'account.disable')) { best = deny('target_roles_required'); continue; }
      if (roles.some((r) => !rule.targetRoles!.includes(r))) { best = deny('role_not_manageable'); continue; }
    }
    return allow();
  }
  return best;
}
