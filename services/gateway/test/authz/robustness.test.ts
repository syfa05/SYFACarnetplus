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
