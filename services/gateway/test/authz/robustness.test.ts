import { describe, expect, it } from 'vitest';
import { decideAdmin, type AdminAction } from '../../src/authz/admin.js';
import { decide } from '../../src/authz/engine.js';
import { type AccessRequest, type Actor, type StaffRole } from '../../src/authz/types.js';
import { EST, goodItem, hoursAgo, NOW, openEpisode, PATIENT, req, staff } from './helpers.js';

const patient: Actor = { kind: 'patient', patientId: PATIENT };
const asAny = (r: unknown) => r as AccessRequest;
const invalid = (r: unknown) => expect(decide(asAny(r))).toMatchObject({ allow: false, reason: 'invalid_input' });

describe('entrées mal formées : refus, jamais d\'ouverture ni d\'exception (JSON, synchronisation, paramètres de route)', () => {
  const PROTO = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', '', 'c', 'CR', 'C ', 42, null, undefined, {}, ['C']];
  it('action ou donnée prise dans la chaîne de prototypes ou inconnue : refus pour tous les acteurs', () => {
    const actors: Actor[] = [patient, { kind: 'representant', personId: 'r' }, staff('secretaire'), staff('medecin'), staff('directeur_medical'), staff('pharmacien')];
    for (const actor of actors) for (const bad of PROTO) {
      invalid({ ...req(actor, 'summary', 'C'), action: bad });
      invalid({ ...req(actor, 'summary', 'C'), data: bad });
    }
  });
  it('dates : chaîne ISO, absente, invalide, nombre → refus (épisode expiré jamais traité comme ouvert)', () => {
    const ok = req(staff('medecin'), 'summary', 'C');
    expect(decide(ok).allow).toBe(true);
    const past = hoursAgo(5);
    for (const expiresAt of [past.toISOString(), undefined, new Date('x'), past.getTime(), null, {}]) {
      invalid({ ...ok, context: { ...ok.context, episode: { ...openEpisode(), expiresAt } } });
    }
    for (const closedAt of [past.toISOString(), new Date('x'), 5, {}]) invalid({ ...ok, context: { ...ok.context, episode: openEpisode({ closedAt }) } });
    for (const now of [NOW.toISOString(), undefined, new Date('x'), NOW.getTime()]) invalid({ ...ok, context: { ...ok.context, now } });
  });
  it('C2 : date de validation invalide ou sérialisée → refus (pas de visibilité immédiate)', () => {
    for (const validatedAt of [new Date('x'), hoursAgo(100).toISOString(), 0, {}]) {
      invalid(req(patient, 'consultations', 'C', { item: goodItem({ validatedAt: validatedAt as never }) }));
    }
  });
  it('motif d\'urgence, format d\'export, opposition, acteur, rôles : types stricts', () => {
    const urgent = (emergency: unknown) => ({ ...req(staff('infirmier'), 'summary', 'C', { episode: undefined }), context: { now: NOW, emergency } });
    for (const e of [{ motive: 42 }, { motive: null }, { motive: ['x'.repeat(20)] }, {}, null, 'urgence']) invalid(urgent(e));
    invalid({ ...req(staff('medecin'), 'summary', 'E'), context: { now: NOW, episode: openEpisode(), export: { format: 'zip' } } });
    invalid({ ...req(staff('medecin'), 'summary', 'C'), context: { now: NOW, episode: openEpisode(), opposedProfessionals: 'u1' } });
    invalid({ ...req(staff('medecin'), 'summary', 'C'), actor: { kind: 'staff', sub: 'u', active: true, establishmentId: EST, roles: 'medecin' } });
    invalid({ ...req(staff('medecin'), 'summary', 'C'), actor: { kind: 'dieu' } });
    invalid({ ...req(staff('medecin'), 'summary', 'C'), actor: undefined });
    invalid({ ...req(staff('medecin'), 'summary', 'C'), context: undefined });
    invalid({ ...req(staff('medecin'), 'summary', 'C'), patientId: 12 });
  });
  it('paramètres de configuration invalides (NaN) : refus', () => {
    expect(decide(req(patient, 'summary', 'C'), { releaseDelayHours: NaN, emergencyMotiveMinLength: 10 })).toMatchObject({ allow: false, reason: 'invalid_config' });
  });
  it('fuzz : aucune combinaison de valeurs aberrantes ne lève d\'exception ni n\'autorise', () => {
    const junk = [undefined, null, NaN, 0, -1, '', 'x', [], {}, new Date('x'), true, () => 1, Symbol('s')];
    const base = req(staff('medecin'), 'consultations', 'M', { item: goodItem({ status: 'brouillon' }) });
    for (const j of junk) for (const path of ['action', 'data', 'patientId', 'actor', 'context']) {
      if (path === 'patientId' && j === 'x') continue; // une chaîne non vide est un identifiant valide
      const r = { ...base, [path]: j } as unknown as AccessRequest;
      let d;
      expect(() => (d = decide(r)), `${path}=${String(j)}`).not.toThrow();
      expect((d as unknown as { allow: boolean }).allow, `${path}=${String(j)}`).toBe(false);
    }
    for (const j of junk) for (const k of ['episode', 'item', 'now', 'emergency', 'export', 'representation', 'opposedProfessionals']) {
      const r = { ...base, context: { ...base.context, [k]: j } } as unknown as AccessRequest;
      expect(() => decide(r), `${k}=${String(j)}`).not.toThrow();
    }
  });
});

describe('administration : actions et rôles pris dans la chaîne de prototypes', () => {
  it('action inconnue ou héritée : refus', () => {
    for (const action of ['constructor', '__proto__', 'toString', '', 'account.nope', 42, null, undefined]) {
      expect(decideAdmin({ actor: staff('directeur_medical'), action: action as AdminAction, target: { establishmentId: EST } })).toMatchObject({ allow: false, reason: 'invalid_input' });
    }
  });
  it('rôle du compte nommé comme une propriété d\'objet : sans droit', () => {
    for (const role of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const actor: Actor = { kind: 'staff', sub: 'u', active: true, establishmentId: EST, roles: [{ role: role as StaffRole, serviceId: null }] };
      expect(decideAdmin({ actor, action: 'card.block', target: { establishmentId: EST } }).allow, role).toBe(false);
      expect(decide(req(actor, 'summary', 'C')).allow, role).toBe(false);
    }
  });
});

describe('pureté : mêmes entrées, même décision (modes central et local)', () => {
  const deepFreeze = <T>(o: T): T => {
    if (o && typeof o === 'object' && !Object.isFrozen(o) && !(o instanceof Date)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
    return o;
  };
  it('le moteur ne modifie pas la requête (objets gelés) et répond de façon répétable', () => {
    const cases = [
      req(patient, 'consultations', 'C', { item: goodItem({ validatedAt: hoursAgo(100) }) }),
      req(staff('medecin'), 'consultations', 'M', { item: goodItem({ status: 'brouillon' }) }),
      req(staff('infirmier'), 'summary', 'C', { episode: undefined, emergency: { motive: 'Patient inconscient aux urgences' } }),
      req(staff('pharmacien'), 'prescriptions', 'M'),
    ].map(deepFreeze);
    for (const r of cases) {
      const a = decide(r), b = decide(r);
      expect(a).toEqual(b);
      expect(a.allow).toBe(true);
    }
  });
  it('indépendant du fuseau horaire et de l\'horloge de la machine (l\'heure est dans la requête)', () => {
    const r = req(patient, 'consultations', 'C', { item: goodItem({ validatedAt: hoursAgo(71) }) });
    const before = decide(r);
    const tz = process.env.TZ;
    process.env.TZ = 'Pacific/Kiritimati';
    const after = decide(r);
    process.env.TZ = tz;
    expect(after).toEqual(before);
    expect(before).toMatchObject({ allow: false, reason: 'release_delay' });
  });
});

describe('revue L3 (2e passe) · types stricts : une valeur « presque juste » n\'est jamais prise pour la bonne', () => {
  it('« releasedEarly » doit être le booléen true : la chaîne « no », 1, un objet ne libèrent rien (C2)', () => {
    for (const releasedEarly of ['no', 'false', '', 1, {}, [], 'true']) {
      invalid(req(patient, 'consultations', 'C', { item: goodItem({ validatedAt: hoursAgo(1), releasedEarly: releasedEarly as never }) }));
    }
    expect(decide(req(patient, 'consultations', 'C', { item: goodItem({ validatedAt: hoursAgo(1), releasedEarly: true }) })).allow).toBe(true);
    expect(decide(req(patient, 'consultations', 'C', { item: goodItem({ validatedAt: hoursAgo(1), releasedEarly: false }) })).allow).toBe(false);
  });
  it('autres champs de l\'élément : booléens, statut et auteur stricts', () => {
    const bad = (item: object) => invalid(req(staff('medecin'), 'documents', 'C', { item: goodItem(item) }));
    bad({ masked: 'false' }); bad({ confidential: 0 }); bad({ active: 'oui' }); bad({ currentCare: 1 }); bad({ delegatedDraft: 'x' });
    bad({ status: 'VALIDE' }); bad({ status: 5 }); bad({ authorSub: 12 }); bad({ authorSub: '' }); bad({ examKind: 'autre' });
  });
  it('rôle sans serviceId (undefined) ≠ « sans service » : refus de forme, jamais un passe-droit du périmètre par service', () => {
    const ep = openEpisode({ serviceScoped: true, serviceId: null });
    const actor = (serviceId: unknown): Actor => ({ kind: 'staff', sub: 'u1', active: true, establishmentId: EST, roles: [{ role: 'medecin', serviceId } as never] });
    invalid(req(actor(undefined), 'summary', 'C', { episode: ep }));
    expect(decide(req(actor(null), 'summary', 'C', { episode: ep }))).toMatchObject({ allow: false, reason: 'service_mismatch' });
    expect(decide(req(actor('cardio'), 'summary', 'C', { episode: openEpisode({ serviceScoped: true, serviceId: 'cardio' }) })).allow).toBe(true);
    invalid(req(staff('medecin'), 'summary', 'C', { episode: openEpisode({ serviceScoped: 'oui' as never }) }));
    invalid(req(staff('medecin'), 'summary', 'C', { episode: openEpisode({ serviceId: undefined as never }) }));
  });
  it('acteur sans identifiant : « même auteur » (undefined === undefined) impossible pour C6 et pour l\'exception C1', () => {
    const noSub = { kind: 'staff', active: true, establishmentId: EST, roles: [{ role: 'medecin', serviceId: null }] } as unknown as Actor;
    invalid(req(noSub, 'documents', 'C', { item: { masked: true } }));
    invalid(req({ ...(noSub as object), sub: '' } as Actor, 'documents', 'C', { item: { masked: true } }));
    invalid(req({ ...(noSub as object), sub: 7 } as unknown as Actor, 'consultations', 'M', { episode: openEpisode({ closedAt: hoursAgo(2) }), item: goodItem({ status: 'brouillon' }) }));
    // un élément masqué sans auteur reste invisible pour un acteur identifié
    expect(decide(req(staff('medecin'), 'documents', 'C', { item: { masked: true } }))).toMatchObject({ allow: false, reason: 'masked' });
  });
  it('acteurs : champs d\'identité, d\'état et de rattachement typés', () => {
    invalid(req({ kind: 'patient', patientId: 5 } as unknown as Actor, 'summary', 'C'));
    invalid(req({ kind: 'representant' } as unknown as Actor, 'summary', 'C'));
    invalid(req({ kind: 'system', client: 'x', homologated: 'oui' } as unknown as Actor, 'summary', 'E', { export: { format: 'fhir' } }));
    invalid(req({ ...(staff('medecin') as object), active: 'true' } as unknown as Actor, 'summary', 'C'));
    invalid(req({ ...(staff('medecin') as object), establishmentId: undefined } as unknown as Actor, 'summary', 'C'));
    invalid(req(staff('medecin'), 'summary', 'C', { representation: { personId: 'r', childId: PATIENT, active: 'oui', childAutonomous: false } as never }));
    invalid(req(staff('medecin'), 'summary', 'C', { opposedProfessionals: ['a', 7] as never }));
    // tableau de rôles creux
    const holes = [, { role: 'medecin', serviceId: null }] as never;
    invalid(req({ kind: 'staff', sub: 'u1', active: true, establishmentId: EST, roles: holes }, 'summary', 'C'));
  });
  it('configuration négative : refusée (un délai négatif rendrait tout visible)', () => {
    const r = req(patient, 'consultations', 'C', { item: goodItem({ validatedAt: hoursAgo(0.01) }) });
    expect(decide(r, { releaseDelayHours: -5, emergencyMotiveMinLength: 10 })).toMatchObject({ allow: false, reason: 'invalid_config' });
    expect(decide(r, { releaseDelayHours: 72, emergencyMotiveMinLength: 0 })).toMatchObject({ allow: false, reason: 'invalid_config' });
    expect(decide(r, { releaseDelayHours: 0, emergencyMotiveMinLength: 1 })).toMatchObject({ allow: true });
  });
  it('administration : acteur ou cible mal formés refusés (pas d\'exception), information absente = refus', () => {
    const dir = staff('directeur_medical');
    for (const bad of [{ roles: 'x' }, { roles: [1] }, null, 'x']) {
      expect(() => decideAdmin({ actor: dir, action: 'role.assign', target: bad as never })).not.toThrow();
      expect(decideAdmin({ actor: dir, action: 'role.assign', target: bad as never }).allow).toBe(false);
    }
    expect(decideAdmin({ actor: { kind: 'staff', sub: 'u', active: true, establishmentId: EST, roles: 'x' } as never, action: 'card.block', target: { establishmentId: EST } })).toMatchObject({ reason: 'invalid_input' });
    expect(decideAdmin(null as never)).toMatchObject({ allow: false });
    const e = { actorSub: 'dir-1', actorRoles: ['directeur_medical'] as StaffRole[], establishmentId: EST, district: null };
    const op = staff('operateur', { establishmentId: null });
    expect(decideAdmin({ actor: op, action: 'supervision.review', context: { entry: e } })).toMatchObject({ allow: false, reason: 'not_upper_level' }); // districtChiefAvailable absent
    expect(decideAdmin({ actor: op, action: 'supervision.review', context: { entry: e, districtChiefAvailable: false } }).allow).toBe(true);
    expect(decideAdmin({ actor: op, action: 'supervision.review', context: { entry: { ...e, actorRoles: 'x' as never } } })).toMatchObject({ reason: 'invalid_input' });
  });
});

describe('revue L3 (3e passe) · couverture des contrôles de forme et des rôles hérités', () => {
  it('rôle nommé comme une propriété d\'objet, AVEC un service : toujours sans droit (le service ne masque plus le test)', () => {
    for (const role of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      const actor: Actor = { kind: 'staff', sub: 'u', active: true, establishmentId: EST, roles: [{ role: role as StaffRole, serviceId: 's1' }] };
      for (const action of ['card.issue', 'account.create', 'journal.read', 'patient.merge', 'role.assign', 'card.block'] as const) {
        expect(decideAdmin({ actor, action, target: { establishmentId: EST, serviceId: 's1', staffSub: 'x', roles: ['medecin'] } }).allow, `${role}/${action}`).toBe(false);
      }
      expect(decide(req(actor, 'summary', 'C')).allow, role).toBe(false);
    }
  });
  it('épisode : identifiant d\'établissement de mauvais type ou absent → refus de forme', () => {
    const ok = req(staff('medecin'), 'summary', 'C');
    for (const establishmentId of [7, null, undefined, '', {}]) {
      invalid({ ...ok, context: { ...ok.context, episode: { ...openEpisode(), establishmentId } } });
    }
  });
});
