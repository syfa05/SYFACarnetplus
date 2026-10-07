import { describe, expect, it } from 'vitest';
import { decide } from '../../src/authz/engine.js';
import type { Actor } from '../../src/authz/types.js';
import { EST, goodItem, hoursAgo, NOW, openEpisode, PATIENT, req, staff } from './helpers.js';

const patient: Actor = { kind: 'patient', patientId: PATIENT };
const rep: Actor = { kind: 'representant', personId: 'rep-1' };
const link = (over = {}) => ({ personId: 'rep-1', childId: PATIENT, active: true, childAutonomous: false, ...over });
const denied = (r: ReturnType<typeof req>, reason: string, condition?: string) =>
  expect(decide(r)).toMatchObject({ allow: false, reason, ...(condition && { condition }) });

describe('C1 — prise en charge ouverte (T-ACC-02)', () => {
  it('médecin sans prise en charge : refus', () => denied(req(staff('medecin'), 'summary', 'C', { episode: undefined }), 'episode_required', 'C1'));
  it('prise en charge expirée ou clôturée : refus', () => {
    denied(req(staff('medecin'), 'summary', 'C', { episode: openEpisode({ expiresAt: hoursAgo(1) }) }), 'episode_closed', 'C1');
    denied(req(staff('medecin'), 'summary', 'C', { episode: openEpisode({ closedAt: hoursAgo(1) }) }), 'episode_closed', 'C1');
  });
  it('la limite est exclusive : à l\'instant d\'expiration, refus', () => denied(req(staff('medecin'), 'summary', 'C', { episode: openEpisode({ expiresAt: NOW }) }), 'episode_closed', 'C1'));
  it('prise en charge d\'un autre établissement : refus', () => denied(req(staff('medecin'), 'summary', 'C', { episode: openEpisode({ establishmentId: 'autre' }) }), 'other_establishment', 'C1'));
  it('périmètre par service activé : seul le service de la prise en charge', () => {
    const ep = openEpisode({ serviceScoped: true, serviceId: 'cardio' });
    expect(decide(req(staff('medecin', {}, 'cardio'), 'summary', 'C', { episode: ep })).allow).toBe(true);
    denied(req(staff('medecin', {}, 'pediatrie'), 'summary', 'C', { episode: ep }), 'service_mismatch', 'C1');
    denied(req(staff('medecin', {}, null), 'summary', 'C', { episode: ep }), 'service_mismatch', 'C1'); // sans service : refus
    expect(decide(req(staff('directeur_medical', {}, null), 'summary', 'C', { episode: ep })).allow).toBe(true); // le directeur couvre l'établissement
  });
  it('périmètre par service désactivé : tout l\'établissement', () => expect(decide(req(staff('medecin', {}, 'pediatrie'), 'summary', 'C', { episode: openEpisode({ serviceId: 'cardio' }) })).allow).toBe(true));
  it('exception : un professionnel complète ses propres consultations après clôture, pas celles des autres', () => {
    const closed = openEpisode({ closedAt: hoursAgo(5) });
    const mine = goodItem({ authorSub: 'u1', status: 'brouillon' });
    expect(decide(req(staff('medecin'), 'consultations', 'M', { episode: closed, item: mine })).allow).toBe(true);
    expect(decide(req(staff('medecin'), 'consultations', 'C', { episode: closed, item: mine })).allow).toBe(true);
    denied(req(staff('medecin'), 'consultations', 'M', { episode: closed, item: goodItem({ authorSub: 'autre', status: 'brouillon' }) }), 'episode_closed', 'C1');
    // l'exception ne couvre ni l'historique (autres données) ni un autre établissement
    denied(req(staff('medecin'), 'summary', 'C', { episode: closed, item: mine }), 'episode_closed', 'C1');
    denied(req(staff('medecin'), 'consultations', 'M', { episode: openEpisode({ establishmentId: 'autre', closedAt: hoursAgo(5) }), item: mine }), 'other_establishment', 'C1');
  });
  it('l\'infirmier n\'a pas cette exception', () => denied(req(staff('infirmier'), 'consultations', 'C', { episode: openEpisode({ closedAt: hoursAgo(5) }), item: goodItem({ authorSub: 'u1' }) }), 'episode_closed', 'C1'));
  it('exemptions : création d\'un dossier à l\'accueil, journal de l\'établissement', () => {
    expect(decide(req(staff('secretaire'), 'identity', 'Cr', { episode: undefined })).allow).toBe(true);
    expect(decide(req(staff('secretaire'), 'identity', 'M', { episode: undefined })).allow).toBe(false);
    expect(decide(req(staff('directeur_medical'), 'journal', 'C', { episode: undefined, scopeEstablishmentId: EST })).allow).toBe(true);
  });
  it('journal : le directeur ne lit que son établissement', () => denied(req(staff('directeur_medical'), 'journal', 'C', { episode: undefined, scopeEstablishmentId: 'autre' }), 'other_establishment'));
});

describe('C2 — visibilité différée', () => {
  const asPatient = (item: object, now = NOW) => req(patient, 'consultations', 'C', { item: goodItem(item), now });
  it('avant le délai : refus ; au délai exact : autorisé', () => {
    denied(asPatient({ validatedAt: hoursAgo(71) }), 'release_delay', 'C2');
    expect(decide(asPatient({ validatedAt: hoursAgo(72) })).allow).toBe(true);
  });
  it('libération anticipée par le médecin', () => expect(decide(asPatient({ validatedAt: hoursAgo(1), releasedEarly: true })).allow).toBe(true));
  it('un compte rendu non validé n\'est jamais visible, même libéré', () => {
    denied(asPatient({ status: 'brouillon', releasedEarly: true }), 'not_validated', 'C2');
    denied(req(patient, 'consultations', 'C', { item: undefined }), 'not_validated', 'C2'); // information absente : refus
  });
  it('le délai est un paramètre, pas une constante', () => {
    const r = asPatient({ validatedAt: hoursAgo(10) });
    expect(decide(r, { releaseDelayHours: 8, emergencyMotiveMinLength: 10 }).allow).toBe(true);
    expect(decide(r, { releaseDelayHours: 24, emergencyMotiveMinLength: 10 }).allow).toBe(false);
  });
  it('s\'applique aussi à l\'export et aux résultats d\'examens', () => {
    denied(req(patient, 'consultations', 'E', { item: goodItem({ validatedAt: hoursAgo(1) }) }), 'release_delay', 'C2');
    denied(req(patient, 'exams', 'C', { item: goodItem({ validatedAt: hoursAgo(1) }) }), 'release_delay', 'C2');
  });
  it('un patient ne voit que son propre dossier', () => denied({ ...req(patient, 'summary', 'C'), patientId: 'autre' }, 'not_own_record'));
});

describe('C3 — représentant (T-ACC-04)', () => {
  const asRep = (ctx = {}) => req(rep, 'summary', 'C', { representation: link(), item: goodItem(), ...ctx });
  it('lien actif et enfant non autonome : droits', () => expect(decide(asRep()).allow).toBe(true));
  it('sans lien, lien d\'un autre enfant ou d\'un autre représentant : refus', () => {
    denied(asRep({ representation: undefined }), 'no_representation', 'C3');
    denied(asRep({ representation: link({ childId: 'autre' }) }), 'no_representation', 'C3');
    denied(asRep({ representation: link({ personId: 'rep-2' }) }), 'no_representation', 'C3');
  });
  it('lien retiré ou enfant autonome : refus', () => {
    denied(asRep({ representation: link({ active: false }) }), 'representation_inactive', 'C3');
    denied(asRep({ representation: link({ childAutonomous: true }) }), 'child_autonomous', 'C3');
  });
  it('consultation confidentielle : invisible, dans toutes les vues (consultation, journal, export)', () => {
    for (const [data, action] of [['consultations', 'C'], ['journal', 'C'], ['consultations', 'E'], ['vitals', 'C']] as const) {
      denied(req(rep, data, action, { representation: link(), item: goodItem({ confidential: true }) }), 'confidential', 'C3');
    }
  });
  it('refus par défaut : la confidentialité doit être AFFIRMÉE absente', () => {
    denied(req(rep, 'consultations', 'C', { representation: link(), item: undefined }), 'item_required', 'C3');
    denied(req(rep, 'journal', 'C', { representation: link(), item: goodItem({ confidential: undefined }) }), 'item_required', 'C3');
  });
  it('le représentant obtient la visibilité différée comme le patient', () => denied(req(rep, 'consultations', 'C', { representation: link(), item: goodItem({ validatedAt: hoursAgo(1) }) }), 'release_delay', 'C2'));
});

describe('C4 — saisie déléguée', () => {
  const draft = (over = {}) => goodItem({ delegatedDraft: true, authorSub: 'u1', status: 'brouillon', ...over });
  it('la secrétaire crée un brouillon délégué', () => expect(decide(req(staff('secretaire'), 'consultations', 'Cr', { item: draft() })).allow).toBe(true));
  it('mais pas autre chose qu\'un brouillon, ni lire l\'historique (T-ACC-01)', () => {
    denied(req(staff('secretaire'), 'consultations', 'Cr', { item: draft({ status: 'valide' }) }), 'not_delegated_draft', 'C4');
    denied(req(staff('secretaire'), 'consultations', 'Cr', { item: draft({ delegatedDraft: false }) }), 'not_delegated_draft', 'C4');
    denied(req(staff('secretaire'), 'consultations', 'C'), 'role_not_permitted');
    denied(req(staff('secretaire'), 'summary', 'C'), 'role_not_permitted');
    denied(req(staff('secretaire'), 'prescriptions', 'C'), 'role_not_permitted');
    denied(req(staff('secretaire'), 'consultations', 'M', { item: draft() }), 'role_not_permitted');
  });
  it('elle voit ensuite seulement le statut, du brouillon qu\'elle a saisi', () => {
    expect(decide(req(staff('secretaire'), 'consultation_status', 'C', { item: draft(), episode: undefined }))).toMatchObject({ allow: true, fields: ['status'] });
    denied(req(staff('secretaire'), 'consultation_status', 'C', { item: draft({ authorSub: 'autre' }) }), 'not_delegated_draft', 'C4');
  });
});

describe('C5 — un élément validé n\'est jamais modifié', () => {
  it('modification d\'un compte rendu ou d\'une prescription validés : refus, addendum (T-ACC-09)', () => {
    for (const data of ['consultations', 'prescriptions'] as const) for (const role of ['medecin', 'directeur_medical'] as const) {
      denied(req(staff(role), data, 'M', { item: goodItem({ status: 'valide' }) }), 'addendum_required', 'C5');
      denied(req(staff(role), data, 'M', { item: goodItem({ status: 'en_attente' }) }), 'addendum_required', 'C5');
      expect(decide(req(staff(role), data, 'M', { item: goodItem({ status: 'brouillon' }) })).allow).toBe(true);
      expect(decide(req(staff(role), data, 'M', { item: goodItem({ status: 'renvoye' }) })).allow).toBe(true);
    }
  });
  it('l\'addendum est une création, toujours possible', () => expect(decide(req(staff('medecin'), 'consultations', 'Cr', { item: goodItem({ status: 'valide' }) })).allow).toBe(true));
  it('élément non précisé : refus', () => denied(req(staff('medecin'), 'prescriptions', 'M', { item: goodItem({ status: undefined }) }), 'addendum_required', 'C5'));
});

describe('C6 — masquage', () => {
  it('un document masqué n\'est visible que de son auteur', () => {
    denied(req(staff('medecin'), 'documents', 'C', { item: goodItem({ masked: true }) }), 'masked', 'C6');
    expect(decide(req(staff('medecin'), 'documents', 'C', { item: goodItem({ masked: true, authorSub: 'u1' }) })).allow).toBe(true);
  });
  it('refus par défaut : l\'appelant doit affirmer que l\'élément n\'est pas masqué', () => {
    denied(req(staff('medecin'), 'documents', 'C', { item: goodItem({ masked: undefined }) }), 'item_required', 'C6');
    denied(req(staff('medecin'), 'documents', 'C', { item: undefined }), 'item_required', 'C6');
  });
  it('le patient voit ses propres éléments masqués', () => expect(decide(req(patient, 'documents', 'C', { item: goodItem({ masked: true }) })).allow).toBe(true));
});

describe('C7 et C8 — opposition et accès d\'urgence (T-ACC-05)', () => {
  const opposed = { opposedProfessionals: ['u1'] };
  it('professionnel nommé : refus hors urgence', () => {
    denied(req(staff('medecin'), 'summary', 'C', opposed), 'opposed', 'C7');
    expect(decide(req(staff('medecin', { sub: 'u2' }), 'summary', 'C', opposed)).allow).toBe(true); // un autre n'est pas concerné
  });
  it('l\'opposition vaut aussi pour sa propre consultation après clôture', () => denied(req(staff('medecin'), 'consultations', 'M', { ...opposed, episode: openEpisode({ closedAt: hoursAgo(2) }), item: goodItem({ authorSub: 'u1', status: 'brouillon' }) }), 'opposed', 'C7'));
  const urgent = (data: 'summary' | 'identity' | 'prescriptions' | 'consultations', over = {}) =>
    req(staff('infirmier'), data, 'C', { episode: undefined, emergency: { motive: 'Patient inconscient, arrivée aux urgences' }, item: goodItem({ masked: true }), ...opposed, ...over });
  it('urgence : informations vitales seulement, malgré opposition, masquage et absence de prise en charge', () => {
    expect(decide(urgent('summary'))).toMatchObject({ allow: true, conditions: ['C8'], fields: ['groupe_sanguin', 'allergies', 'traitements_en_cours', 'pathologies_chroniques'] });
    expect(decide(urgent('identity'))).toMatchObject({ allow: true, fields: ['contact_urgence'] });
    expect(decide(urgent('prescriptions'))).toMatchObject({ allow: true, fields: ['traitements_en_cours'] });
  });
  it('urgence : jamais le reste du dossier', () => {
    denied(urgent('consultations'), 'emergency_vital_only', 'C8');
    denied(urgent('prescriptions', { item: goodItem({ active: false }) }), 'emergency_vital_only', 'C8');
  });
  it('urgence : motif obligatoire, lecture seule, soignants seulement', () => {
    denied(urgent('summary', { emergency: { motive: '' } }), 'emergency_motive_required', 'C8');
    denied(urgent('summary', { emergency: { motive: '   court  ' } }), 'emergency_motive_required', 'C8');
    denied({ ...urgent('summary'), action: 'M' }, 'emergency_read_only', 'C8');
    denied({ ...urgent('summary'), actor: staff('secretaire') }, 'emergency_role', 'C8');
    denied({ ...urgent('summary'), actor: staff('pharmacien') }, 'emergency_role', 'C8');
    for (const role of ['infirmier', 'medecin', 'directeur_medical'] as const) expect(decide({ ...urgent('summary'), actor: staff(role) }).allow).toBe(true);
  });
  it('urgence : un compte désactivé ne passe pas', () => denied({ ...urgent('summary'), actor: staff('medecin', { active: false }) }, 'account_disabled'));
  it('le patient ni le représentant n\'ont pas d\'« urgence » : le drapeau est ignoré pour eux', () => {
    denied(req(patient, 'consultations', 'C', { emergency: { motive: 'x'.repeat(30) }, item: goodItem({ validatedAt: hoursAgo(1) }) }), 'release_delay', 'C2');
  });
});

describe('C9 — accompagnant temporaire', () => {
  it('aucun droit sur le contenu, quelle que soit la donnée ou l\'action', () => {
    const c: Actor = { kind: 'accompagnant', personId: 'c1' };
    for (const data of ['identity', 'summary', 'consultations', 'journal', 'documents'] as const) for (const action of ['C', 'Cr', 'M', 'P'] as const) {
      denied(req(c, data, action), 'companion_no_content', 'C9');
    }
  });
});

describe('export (onglet 2.5) et systèmes', () => {
  it('export de masse interdit à tous les rôles', () => {
    for (const actor of [patient, rep, staff('medecin'), staff('directeur_medical'), staff('operateur'), { kind: 'system', client: 'dme', homologated: true } as Actor]) {
      denied(req(actor, 'summary', 'E', { export: { format: 'fhir', bulk: true }, representation: link() }), 'bulk_export_forbidden');
    }
  });
  it('FHIR : réservé aux systèmes homologués, avec prise en charge ouverte', () => {
    const sys = (h: boolean): Actor => ({ kind: 'system', client: 'dme', homologated: h });
    expect(decide(req(sys(true), 'summary', 'E', { export: { format: 'fhir' } }))).toMatchObject({ allow: true });
    denied(req(sys(false), 'summary', 'E', { export: { format: 'fhir' } }), 'system_not_homologated');
    denied(req(sys(true), 'summary', 'E', { export: { format: 'fhir' }, episode: undefined }), 'episode_required', 'C1');
    denied(req(sys(true), 'journal', 'E', { export: { format: 'fhir' } }), 'not_exportable');
    for (const actor of [patient, staff('medecin'), staff('directeur_medical')]) denied(req(actor, 'summary', 'E', { export: { format: 'fhir' }, representation: link() }), 'fhir_export_systems_only');
  });
  it('un système (ou administrateur technique) n\'a aucun accès au contenu, même en lecture', () => {
    for (const data of ['summary', 'consultations', 'identity'] as const) denied(req({ kind: 'system', client: 'dme', homologated: true }, data, 'C'), 'system_no_content');
  });
  it('une action d\'export exige un format, et un format exige l\'action d\'export', () => {
    denied({ ...req(staff('medecin'), 'consultations', 'E'), context: { now: NOW, episode: openEpisode(), item: goodItem() } }, 'export_format_required');
    denied(req(staff('medecin'), 'consultations', 'C', { export: { format: 'pdf' } }), 'export_requires_action_E');
  });
  it('export par un professionnel : couvert par la matrice et par C1', () => {
    expect(decide(req(staff('medecin'), 'consultations', 'E')).allow).toBe(true);
    denied(req(staff('infirmier'), 'consultations', 'E', { item: goodItem() }), 'role_not_permitted');
    denied(req(staff('medecin'), 'consultations', 'E', { episode: undefined }), 'episode_required', 'C1');
  });
});

describe('plusieurs rôles', () => {
  it('l\'union des droits s\'applique, chaque rôle avec ses propres limites', () => {
    const both: Actor = { kind: 'staff', sub: 'u1', active: true, establishmentId: EST, roles: [{ role: 'secretaire', serviceId: null }, { role: 'pharmacien', serviceId: null }] };
    expect(decide(req(both, 'documents', 'Cr')).allow).toBe(true); // secrétaire
    expect(decide(req(both, 'summary', 'C')).allow).toBe(true); // pharmacien (allergies)
    denied(req(both, 'consultations', 'C'), 'role_not_permitted');
  });
  it('le refus le plus informatif est renvoyé', () => {
    const both: Actor = { kind: 'staff', sub: 'u1', active: true, establishmentId: EST, roles: [{ role: 'chef_service', serviceId: null }, { role: 'medecin', serviceId: null }] };
    denied(req(both, 'summary', 'C', { episode: undefined }), 'episode_required', 'C1');
  });
  it('sans rôle ou sans établissement : refus', () => {
    denied(req(staff('medecin', { roles: [] }), 'summary', 'C'), 'no_establishment_or_role');
    denied(req(staff('medecin', { establishmentId: null }), 'summary', 'C'), 'no_establishment_or_role');
  });
});
