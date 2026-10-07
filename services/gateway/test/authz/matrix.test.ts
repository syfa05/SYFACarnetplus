import { describe, expect, it } from 'vitest';
import { decide } from '../../src/authz/engine.js';
import { ACTIONS, type AccessRequest, type Action, type Actor, type DataRole, type DataType } from '../../src/authz/types.js';
import { EST, goodItem, hoursAgo, NOW, openEpisode, PATIENT, req, staff } from './helpers.js';

/**
 * Onglet 2, section 2.2 — recopié TEL QUEL du document (colonnes dans l'ordre du tableau). Cette copie est
 * volontairement indépendante de `src/authz/matrix.ts` : le test compare le moteur au document, pas à lui-même.
 */
const ROLES: DataRole[] = ['patient', 'representant', 'secretaire', 'infirmier', 'medecin', 'directeur_medical', 'pharmacien', 'laboratoire'];
const DOC: Record<Exclude<DataType, 'consultation_status'>, string[]> = {
  identity: ['C, E', 'C*, E*', 'C, Cr, M', 'C', 'C', 'C, M', 'C (nom, âge)', 'C (nom, âge)'],
  summary: ['C, E', 'C*, E*', '—', 'C', 'C, Cr, M', 'C, Cr, M', 'C (allergies seulement)', '—'],
  consultations: ['C*, E', 'C*, E*', 'Cr* (brouillon délégué)', 'C (soins et prescriptions en cours)', 'C, Cr, M*, P, E', 'C, Cr, M*, P, E', '—', '—'],
  vitals: ['C', 'C*', '—', 'C, Cr', 'C, Cr', 'C, Cr', '—', '—'],
  prescriptions: ['C, E', 'C*, E*', '—', 'C', 'C, Cr, M*', 'C, Cr, M*', 'C (actives), M (délivrance)', '—'],
  exams: ['C*', 'C*', '—', 'C', 'C, Cr', 'C, Cr', '—', 'C (prescrits), Cr (résultats)'],
  vaccinations: ['C, Cr (déclaré)', 'C, Cr (déclaré)', '—', 'C, Cr', 'C, Cr, M (contrôle)', 'C, Cr, M', '—', '—'],
  documents: ['C, Cr', 'C*, Cr*', 'Cr', 'C', 'C, Cr', 'C, Cr', '—', '—'],
  journal: ['C (son dossier)', 'C* (hors confidentiel)', '—', '—', '—', 'C (son établissement)', '—', '—'],
  restrictions: ['Cr, M', 'Cr*, M*', '—', '—', '—', '—', '—', '—'],
};

function parse(cell: string): Map<Action, boolean> {
  const out = new Map<Action, boolean>();
  if (cell === '—') return out;
  for (const tok of cell.replace(/\([^)]*\)/g, '').split(',').map((t) => t.trim()).filter(Boolean)) {
    const starred = tok.endsWith('*');
    const a = tok.replace('*', '') as Action;
    expect(ACTIONS).toContain(a);
    out.set(a, starred);
  }
  return out;
}

function actorFor(role: DataRole): Actor {
  if (role === 'patient') return { kind: 'patient', patientId: PATIENT };
  if (role === 'representant') return { kind: 'representant', personId: 'rep-1' };
  return staff(role);
}

/** Contexte où TOUTES les conditions sont satisfaites : seule la matrice décide. */
function perfect(role: DataRole, data: DataType, action: Action): AccessRequest {
  const writing = action === 'M' || action === 'Cr';
  const item = goodItem({
    status: writing ? 'brouillon' : 'valide',
    examKind: action === 'Cr' ? 'resultat' : 'prescrit',
    ...(role === 'secretaire' ? { delegatedDraft: true, authorSub: 'u1', status: 'brouillon' as const } : {}),
  });
  return req(actorFor(role), data, action, {
    item,
    representation: { personId: 'rep-1', childId: PATIENT, active: true, childAutonomous: false },
    scopeEstablishmentId: EST,
  });
}

describe('matrice de l\'onglet 2.2 : chaque cellule, autorisée et refusée', () => {
  const rows = Object.entries(DOC) as Array<[Exclude<DataType, 'consultation_status'>, string[]]>;
  it('le tableau recopié a 10 lignes de 8 colonnes', () => {
    expect(rows).toHaveLength(10);
    for (const [, cells] of rows) expect(cells).toHaveLength(ROLES.length);
  });

  for (const [data, cells] of rows) {
    for (const [i, role] of ROLES.entries()) {
      const granted = parse(cells[i]!);
      for (const action of ACTIONS) {
        const expected = granted.has(action);
        it(`${data} · ${role} · ${action} → ${expected ? 'autorisé' : 'refusé'}`, () => {
          const d = decide(perfect(role, data, action));
          expect(d.allow, JSON.stringify(d)).toBe(expected);
        });
      }
    }
  }
});

describe('les cellules « sous condition » (*) se referment quand la condition manque', () => {
  const starred: Array<[DataRole, DataType, Action]> = [];
  for (const [data, cells] of Object.entries(DOC) as Array<[DataType, string[]]>) {
    for (const [i, role] of ROLES.entries()) for (const [a, s] of parse(cells[i]!)) if (s) starred.push([role, data, a]);
  }
  it('le test voit bien les cellules étoilées du document', () => expect(starred.length).toBeGreaterThan(15));

  for (const [role, data, action] of starred) {
    it(`${data} · ${role} · ${action} : refusé sans sa condition`, () => {
      const base = perfect(role, data, action);
      let broken: AccessRequest;
      if (role === 'representant') broken = { ...base, context: { ...base.context, representation: { personId: 'rep-1', childId: PATIENT, active: false, childAutonomous: false } } };
      else if (role === 'patient') broken = { ...base, context: { ...base.context, item: goodItem({ validatedAt: hoursAgo(1), status: 'valide' }) } }; // C2
      else if (role === 'secretaire') broken = { ...base, context: { ...base.context, item: goodItem({ status: 'valide', delegatedDraft: false }) } }; // C4
      else broken = { ...base, context: { ...base.context, item: goodItem({ status: 'valide' }) } }; // C5 : élément validé
      expect(decide(broken).allow).toBe(false);
    });
  }
});

describe('restrictions de champs des cellules à parenthèses', () => {
  it('pharmacien : allergies seulement ; nom et âge seulement pour pharmacien et laboratoire', () => {
    expect(decide(perfect('pharmacien', 'summary', 'C'))).toMatchObject({ allow: true, fields: ['allergies'] });
    expect(decide(perfect('pharmacien', 'identity', 'C'))).toMatchObject({ allow: true, fields: ['nom', 'age'] });
    expect(decide(perfect('laboratoire', 'identity', 'C'))).toMatchObject({ allow: true, fields: ['nom', 'age'] });
  });
  it('pharmacien : la modification se limite à la délivrance ; vaccinations : « déclaré » pour le patient, « contrôle » pour le médecin', () => {
    expect(decide(perfect('pharmacien', 'prescriptions', 'M'))).toMatchObject({ allow: true, fields: ['dispensation'] });
    expect(decide(perfect('patient', 'vaccinations', 'Cr'))).toMatchObject({ allow: true, fields: ['declaration'] });
    expect(decide(perfect('medecin', 'vaccinations', 'M'))).toMatchObject({ allow: true, fields: ['controle'] });
  });
  it('pharmacien : ordonnances actives seulement ; infirmier : soins en cours seulement ; laboratoire : prescrits en lecture, résultats en création', () => {
    const p = perfect('pharmacien', 'prescriptions', 'C');
    expect(decide({ ...p, context: { ...p.context, item: goodItem({ active: false }) } }).allow).toBe(false);
    const n = perfect('infirmier', 'consultations', 'C');
    expect(decide({ ...n, context: { ...n.context, item: goodItem({ currentCare: false }) } }).allow).toBe(false);
    const l = perfect('laboratoire', 'exams', 'C');
    expect(decide({ ...l, context: { ...l.context, item: goodItem({ examKind: 'resultat' }) } }).allow).toBe(false);
    const lc = perfect('laboratoire', 'exams', 'Cr');
    expect(decide({ ...lc, context: { ...lc.context, item: goodItem({ examKind: 'prescrit' }) } }).allow).toBe(false);
  });
});

describe('rôles sans colonne dans la matrice : aucun droit sur le contenu', () => {
  for (const role of ['chef_service', 'agent_emission', 'vaccinateur', 'chef_district', 'superviseur_pev', 'operateur', 'administrateur_habilite'] as const) {
    it(role, () => {
      for (const data of Object.keys(DOC) as DataType[]) for (const action of ACTIONS) {
        expect(decide(req(staff(role), data, action)).allow, `${data}/${action}`).toBe(false);
      }
    });
  }
  it('un compte désactivé n\'a aucun droit, quel que soit son rôle', () => {
    expect(decide(req(staff('medecin', { active: false }), 'summary', 'C'))).toMatchObject({ allow: false, reason: 'account_disabled' });
  });
  it('tests de l\'ouverture : une prise en charge d\'un autre établissement ne donne rien', () => {
    expect(decide(req(staff('medecin'), 'summary', 'C', { episode: openEpisode({ establishmentId: 'autre' }) }))).toMatchObject({ allow: false, reason: 'other_establishment' });
  });
  it('NOW est bien l\'instant de référence des tests', () => expect(NOW.toISOString()).toBe('2026-10-06T10:00:00.000Z'));
});
