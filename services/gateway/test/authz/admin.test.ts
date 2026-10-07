import { describe, expect, it } from 'vitest';
import { decideAdmin, type AdminAction, type AdminContext, type AdminTarget } from '../../src/authz/admin.js';
import { STAFF_ROLES, type Actor, type StaffRole } from '../../src/authz/types.js';
import { EST, staff } from './helpers.js';

/**
 * Onglet 2, section 2.3 — recopié du document. Colonnes : agent d'émission, médecin, chef de service, directeur
 * médical, opérateur. Les rôles absents du tableau (pharmacien, laboratoire, infirmier, secrétaire, vaccinateur,
 * chef de district, superviseur PEV, administrateur habilité) n'ont aucun droit d'administration, sauf mention
 * explicite dans une cellule (« et superviseur PEV de district », « administrateur habilité »).
 */
const DOC: Array<{ label: string; actions: AdminAction[]; byRole: Partial<Record<StaffRole, AdminAction[]>> }> = [
  { label: 'Émettre, activer, bloquer une carte', actions: ['card.issue', 'card.activate', 'card.block'], byRole: { agent_emission: ['card.issue', 'card.activate', 'card.block'], directeur_medical: ['card.issue', 'card.activate', 'card.block'], operateur: ['card.block'] } },
  { label: 'Créer ou désactiver un compte du personnel', actions: ['account.create', 'account.disable'], byRole: { directeur_medical: ['account.create', 'account.disable'], operateur: ['account.create', 'account.disable'] } },
  { label: 'Attribuer un rôle', actions: ['role.assign'], byRole: { directeur_medical: ['role.assign'], operateur: ['role.assign'] } },
  { label: 'Contrôler les accès d\'urgence', actions: ['emergency.control'], byRole: { chef_service: ['emergency.control'], directeur_medical: ['emergency.control'] } },
  { label: 'Consulter le journal', actions: ['journal.read'], byRole: { chef_service: ['journal.read'], directeur_medical: ['journal.read'], operateur: ['journal.read'] } },
  { label: 'Fusionner des doublons', actions: ['patient.merge'], byRole: { directeur_medical: ['patient.merge'], operateur: ['patient.merge'] } },
  { label: 'Déclarer ou annuler un décès', actions: ['death.declare', 'death.cancel'], byRole: { medecin: ['death.declare'], directeur_medical: ['death.cancel'], operateur: ['death.cancel'] } },
  { label: 'Ajouter ou retirer un représentant', actions: ['representative.change'], byRole: { directeur_medical: ['representative.change'], operateur: ['representative.change'] } },
  { label: 'Rapprocher un enregistrement en attente', actions: ['pending.reconcile'], byRole: { directeur_medical: ['pending.reconcile'], operateur: ['pending.reconcile'], superviseur_pev: ['pending.reconcile'] } },
  { label: 'Modifier les paramètres nationaux', actions: ['settings.national'], byRole: { administrateur_habilite: ['settings.national'] } },
  { label: 'Homologuer un logiciel tiers', actions: ['software.certify'], byRole: { operateur: ['software.certify'] } },
  { label: '(établissements : création par l\'opérateur seulement)', actions: ['establishment.manage'], byRole: { operateur: ['establishment.manage'] } },
  { label: '(services : directeur de l\'établissement ou opérateur)', actions: ['service.manage'], byRole: { directeur_medical: ['service.manage'], operateur: ['service.manage'] } },
];

/** Cible et contexte où toutes les conditions sont réunies : seul le rôle décide. */
function perfect(action: AdminAction, role: StaffRole): { target: AdminTarget; context: AdminContext } {
  const roles: StaffRole[] = role === 'operateur' ? ['directeur_medical'] : ['medecin'];
  return {
    target: { establishmentId: EST, serviceId: 'svc-1', staffSub: 'someone-else', roles },
    context: {
      officialDocument: true, conventionActive: true,
      entry: { actorSub: 'someone-else', actorRoles: ['infirmier'], establishmentId: EST, serviceId: 'svc-1', district: null },
    },
  };
}

describe('matrice des actions d\'administration (onglet 2.3) : chaque cellule', () => {
  for (const row of DOC) for (const action of row.actions) for (const role of STAFF_ROLES) {
    const expected = row.byRole[role]?.includes(action) ?? false;
    it(`${row.label} · ${action} · ${role} → ${expected ? 'autorisé' : 'refusé'}`, () => {
      const { target, context } = perfect(action, role);
      const d = decideAdmin({ actor: staff(role, {}, 'svc-1'), action, target, context });
      expect(d.allow, JSON.stringify(d)).toBe(expected);
    });
  }
  it('seuls le personnel (pas un patient, un représentant ni un système) administre', () => {
    for (const actor of [{ kind: 'patient', patientId: 'p' }, { kind: 'representant', personId: 'r' }, { kind: 'system', client: 'x', homologated: true }] as Actor[]) {
      expect(decideAdmin({ actor, action: 'card.block', target: { establishmentId: EST } })).toMatchObject({ allow: false, reason: 'staff_only' });
    }
  });
  it('compte désactivé : aucun droit', () => expect(decideAdmin({ actor: staff('directeur_medical', { active: false }), action: 'card.block', target: { establishmentId: EST } })).toMatchObject({ reason: 'account_disabled' }));
});

describe('portée', () => {
  const dir = staff('directeur_medical');
  it('le directeur n\'agit que dans son établissement', () => {
    expect(decideAdmin({ actor: dir, action: 'card.issue', target: { establishmentId: EST } }).allow).toBe(true);
    expect(decideAdmin({ actor: dir, action: 'card.issue', target: { establishmentId: 'autre' } })).toMatchObject({ allow: false, reason: 'out_of_scope' });
    expect(decideAdmin({ actor: dir, action: 'card.issue', target: {} })).toMatchObject({ allow: false, reason: 'out_of_scope' });
  });
  it('le chef de service n\'agit que dans son service', () => {
    const chef = staff('chef_service', {}, 'svc-1');
    const entry = (serviceId: string | null) => ({ actorSub: 'x', actorRoles: ['medecin'] as StaffRole[], establishmentId: EST, serviceId, district: null });
    expect(decideAdmin({ actor: chef, action: 'journal.read', target: { establishmentId: EST, serviceId: 'svc-1' } }).allow).toBe(true);
    expect(decideAdmin({ actor: chef, action: 'journal.read', target: { establishmentId: EST, serviceId: 'svc-2' } }).allow).toBe(false);
    expect(decideAdmin({ actor: chef, action: 'emergency.control', context: { entry: entry('svc-1') } }).allow).toBe(true);
    expect(decideAdmin({ actor: chef, action: 'emergency.control', context: { entry: entry('svc-2') } }).allow).toBe(false);
    expect(decideAdmin({ actor: staff('chef_service', {}, null), action: 'journal.read', target: { establishmentId: EST, serviceId: null } }).allow).toBe(false); // sans service : aucune portée
  });
  it('journal complet de l\'opérateur : seulement dans le cadre de la convention', () => {
    expect(decideAdmin({ actor: staff('operateur', { establishmentId: null }), action: 'journal.read', target: { establishmentId: 'x' }, context: { conventionActive: false } })).toMatchObject({ reason: 'convention_required' });
  });
  it('représentant : le directeur exige un document officiel', () => {
    expect(decideAdmin({ actor: dir, action: 'representative.change', target: { establishmentId: EST }, context: { officialDocument: false } })).toMatchObject({ reason: 'official_document_required' });
    expect(decideAdmin({ actor: dir, action: 'representative.change', target: { establishmentId: EST } })).toMatchObject({ reason: 'official_document_required' });
  });
});

describe('comptes et rôles : qui peut créer ou attribuer quoi', () => {
  const op = staff('operateur', { establishmentId: null });
  const dir = staff('directeur_medical');
  const tgt = (roles?: StaffRole[], over: Partial<AdminTarget> = {}): AdminTarget => ({ establishmentId: EST, staffSub: 'x', ...(roles && { roles }), ...over });
  it('l\'opérateur crée des directeurs médicaux, pas du personnel', () => {
    expect(decideAdmin({ actor: op, action: 'account.create', target: tgt(['directeur_medical'], { establishmentId: 'e9' }) }).allow).toBe(true);
    expect(decideAdmin({ actor: op, action: 'account.create', target: tgt(['medecin']) })).toMatchObject({ reason: 'role_not_manageable' });
  });
  it('le directeur crée du personnel, pas d\'autre directeur ni d\'opérateur', () => {
    expect(decideAdmin({ actor: dir, action: 'account.create', target: tgt(['medecin', 'chef_service']) }).allow).toBe(true);
    for (const r of ['directeur_medical', 'operateur', 'chef_district', 'administrateur_habilite', 'superviseur_pev'] as const) {
      expect(decideAdmin({ actor: dir, action: 'account.create', target: tgt([r]) }), r).toMatchObject({ allow: false, reason: 'role_not_manageable' });
      expect(decideAdmin({ actor: dir, action: 'role.assign', target: tgt([r]) }), r).toMatchObject({ allow: false, reason: 'role_not_manageable' });
    }
  });
  it('un seul rôle hors périmètre suffit à tout refuser', () => expect(decideAdmin({ actor: dir, action: 'role.assign', target: tgt(['medecin', 'directeur_medical']) }).allow).toBe(false));
  it('les rôles du compte visé sont obligatoires (refus par défaut)', () => {
    expect(decideAdmin({ actor: dir, action: 'account.create', target: tgt(undefined) })).toMatchObject({ reason: 'target_roles_required' });
    expect(decideAdmin({ actor: dir, action: 'account.create', target: tgt([]) })).toMatchObject({ reason: 'target_roles_required' });
    expect(decideAdmin({ actor: dir, action: 'account.disable', target: tgt(undefined) })).toMatchObject({ reason: 'target_roles_required' });
    expect(decideAdmin({ actor: dir, action: 'account.disable', target: tgt([]) }).allow).toBe(true); // compte sans rôle : désactivable
  });
  it('désactivation : le directeur ne désactive pas un directeur ; l\'opérateur désactive les directeurs', () => {
    expect(decideAdmin({ actor: dir, action: 'account.disable', target: tgt(['directeur_medical']) }).allow).toBe(false);
    expect(decideAdmin({ actor: op, action: 'account.disable', target: tgt(['directeur_medical'], { establishmentId: 'e9' }) }).allow).toBe(true);
  });
  it('personne n\'agit sur son propre compte', () => {
    for (const action of ['account.create', 'account.disable', 'role.assign'] as const) {
      expect(decideAdmin({ actor: dir, action, target: tgt(['medecin'], { staffSub: 'u1' }) }), action).toMatchObject({ allow: false, reason: 'self_action' });
    }
  });
  it('le directeur ne gère pas un autre établissement', () => expect(decideAdmin({ actor: dir, action: 'account.create', target: tgt(['medecin'], { establishmentId: 'autre' }) })).toMatchObject({ reason: 'out_of_scope' }));
});

describe('contrôle de niveau supérieur ; personne ne contrôle ses propres actions', () => {
  const directorEntry = (over = {}) => ({ actorSub: 'dir-1', actorRoles: ['directeur_medical'] as StaffRole[], establishmentId: EST, district: 'D1', ...over });
  const chief = (district: string | null = 'D1') => staff('chef_district', { establishmentId: null });
  const op = staff('operateur', { establishmentId: null });

  it('chef de district intégré : il contrôle les actions des directeurs de son district', () => {
    expect(decideAdmin({ actor: chief(), action: 'supervision.review', context: { entry: directorEntry(), actorDistrict: 'D1', districtChiefAvailable: true } }).allow).toBe(true);
    expect(decideAdmin({ actor: chief(), action: 'supervision.review', context: { entry: directorEntry({ district: 'D2' }), actorDistrict: 'D1', districtChiefAvailable: true } })).toMatchObject({ allow: false, reason: 'not_upper_level' });
  });
  it('sinon l\'opérateur — mais pas lorsqu\'un chef de district est disponible', () => {
    expect(decideAdmin({ actor: op, action: 'supervision.review', context: { entry: directorEntry({ district: null }), districtChiefAvailable: false } }).allow).toBe(true);
    expect(decideAdmin({ actor: op, action: 'supervision.review', context: { entry: directorEntry(), districtChiefAvailable: true } })).toMatchObject({ allow: false, reason: 'not_upper_level' });
  });
  it('un directeur ne contrôle pas un autre directeur, ni lui-même', () => {
    expect(decideAdmin({ actor: staff('directeur_medical', { sub: 'dir-2' }), action: 'supervision.review', context: { entry: directorEntry() } }).allow).toBe(false);
    expect(decideAdmin({ actor: staff('directeur_medical', { sub: 'dir-1' }), action: 'supervision.review', context: { entry: directorEntry() } })).toMatchObject({ reason: 'self_control' });
  });
  it('un opérateur ne contrôle pas ses propres actions, même s\'il cumule les rôles', () => {
    const both: Actor = { kind: 'staff', sub: 'dir-1', active: true, establishmentId: EST, roles: [{ role: 'directeur_medical', serviceId: null }, { role: 'operateur', serviceId: null }] };
    expect(decideAdmin({ actor: both, action: 'supervision.review', context: { entry: directorEntry({ district: null }), districtChiefAvailable: false } })).toMatchObject({ reason: 'self_control' });
  });
  it('seules les actions de directeur médical sont concernées', () => expect(decideAdmin({ actor: op, action: 'supervision.review', context: { entry: directorEntry({ actorRoles: ['medecin'] }), districtChiefAvailable: false } })).toMatchObject({ reason: 'not_upper_level_action' }));
  it('accès d\'urgence : le directeur contrôle son établissement, jamais ses propres accès ni ceux d\'un directeur', () => {
    const dir = staff('directeur_medical', { sub: 'dir-1' });
    const e = (over = {}) => ({ actorSub: 'inf-1', actorRoles: ['infirmier'] as StaffRole[], establishmentId: EST, district: null, ...over });
    expect(decideAdmin({ actor: dir, action: 'emergency.control', context: { entry: e() } }).allow).toBe(true);
    expect(decideAdmin({ actor: dir, action: 'emergency.control', context: { entry: e({ actorSub: 'dir-1', actorRoles: ['directeur_medical'] }) } })).toMatchObject({ reason: 'self_control' });
    expect(decideAdmin({ actor: dir, action: 'emergency.control', context: { entry: e({ actorSub: 'dir-2', actorRoles: ['directeur_medical'] }) } }).allow).toBe(false);
    expect(decideAdmin({ actor: dir, action: 'emergency.control', context: { entry: e({ establishmentId: 'autre' }) } }).allow).toBe(false);
    expect(decideAdmin({ actor: op, action: 'emergency.control', context: { entry: e({ actorSub: 'dir-2', actorRoles: ['directeur_medical'] }), districtChiefAvailable: false } }).allow).toBe(true);
    expect(decideAdmin({ actor: op, action: 'emergency.control', context: { entry: e() } }).allow).toBe(false); // l'opérateur ne contrôle que ceux des directeurs
  });
});
