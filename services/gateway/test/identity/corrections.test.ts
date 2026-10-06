import { inspect } from 'node:util';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { describeFailure } from '../../src/identity/errors.js';
import { FieldCrypto, generateMasterKey } from '../../src/identity/crypto.js';
import { loadIdentityConfig } from '../../src/identity/config.js';
import { IdentityService } from '../../src/identity/service.js';
import type { FhirReferenceReassigner } from '../../src/identity/fhir-port.js';
import { base, cleanup, makeService, REAL_PG } from './helpers.js';

afterAll(cleanup);

type Svc = Awaited<ReturnType<typeof makeService>>['service'];
const created = async (s: Svc, over = {}) => {
  const r = await s.register(base(over), 'acteur-1', { confirmNew: true, justification: 'test' });
  if (r.outcome !== 'created') throw new Error(r.outcome);
  return r.patient;
};
const flaky = (mode: { reassign?: boolean; restore?: boolean }) => {
  const calls: string[] = [];
  const port: FhirReferenceReassigner = {
    reassign: async (f, t) => { calls.push('reassign'); if (mode.reassign) throw new Error('fhir down'); return [{ ref: `Encounter/${f}->${t}` }]; },
    restore: async () => { calls.push('restore'); if (mode.restore) throw new Error('fhir down'); },
  };
  return { port, calls, mode };
};

describe('1.1 chiffrement des colonnes sensibles (onglet 4.2, principe 7)', () => {
  it('aucune valeur sensible en clair dans la base', async () => {
    const { service, raw } = await makeService();
    await created(service, {
      nom: 'Ngoué Atangana', prenoms: 'Éloïse', dateNaissance: '1984-07-21', lieuNaissance: 'Bafoussam', nomMere: 'Tchamba',
      nomPere: 'Fotsing', telephone: '237690123456', localite: 'Bangang', contactUrgenceNom: 'Tante Rose',
      contactUrgenceTelephone: '237677000111', niveauIdentite: 1, identifiants: [{ type: 'csu', valeur: 'CSU-0042' }, { type: 'cni', valeur: '123456789' }],
    });
    // Les chiffrés sont comparés sous forme d'octets (et non de base64) : pas de faux positif au hasard.
    const flat = (rows: Record<string, unknown>[]) =>
      rows.map((r) => Object.values(r).map((v) => (typeof v === 'string' && v.startsWith('v1:') ? Buffer.from(v.slice(3), 'base64').toString('latin1') : String(v))));
    const dump = JSON.stringify([
      flat((await raw.query<Record<string, unknown>>('SELECT * FROM patient')).rows),
      flat((await raw.query<Record<string, unknown>>('SELECT * FROM patient_identifier')).rows),
    ]).toUpperCase();
    for (const secret of ['NGOUE', 'ATANGANA', 'ELOISE', 'ÉLOÏSE', '1984-07-21', 'BAFOUSSAM', 'TCHAMBA', 'FOTSING', '690123456', 'BANGANG', 'TANTE ROSE', '677000111', 'CSU0042', '123456789']) {
      expect(dump, secret).not.toContain(secret);
    }
  });
  it('relecture exacte après chiffrement', async () => {
    const { service } = await makeService();
    const p = await created(service, { nom: 'Ngoué', prenoms: 'Éloïse', telephone: '237690123456', nomMere: 'Tchamba' });
    expect(await service.resolve(p.id)).toMatchObject({ nom: 'Ngoué', prenoms: 'Éloïse', telephone: '237690123456', nomMere: 'Tchamba', dateNaissance: '1985-03-12' });
  });
  it('un chiffré copié sur une autre ligne ou une autre colonne est rejeté (AAD)', async () => {
    const { service, raw } = await makeService();
    const a = await created(service);
    const b = await created(service, { nom: 'Fotso', prenoms: 'Paul', dateNaissance: '1960-05-05' });
    const [ca] = (await raw.query<{ nom_chiffre: string }>('SELECT nom_chiffre FROM patient WHERE id=$1', [a.id])).rows;
    await raw.query('UPDATE patient SET nom_chiffre=$1 WHERE id=$2', [ca!.nom_chiffre, b.id]);
    await expect(service.resolve(b.id)).rejects.toThrow();
    await raw.query('UPDATE patient SET nom_chiffre=prenoms_chiffre WHERE id=$1', [a.id]);
    await expect(service.resolve(a.id)).rejects.toThrow();
  });
  it('une autre clé ne déchiffre pas ; les clés invalides sont refusées', async () => {
    const { service, raw, db } = await makeService();
    const p = await created(service);
    const other = new IdentityService(db, loadIdentityConfig({}), new FieldCrypto(generateMasterKey()));
    await expect(other.resolve(p.id)).rejects.toThrow();
    expect(await raw.query('SELECT 1 FROM patient')).toBeTruthy();
    expect(() => new FieldCrypto('court')).toThrow();
    expect(() => FieldCrypto.fromEnv({})).toThrow();
  });
  it('mêmes valeurs → chiffrés différents (nonce), index aveugles stables', () => {
    const c = new FieldCrypto(generateMasterKey());
    expect(c.encrypt('X', 'a')).not.toBe(c.encrypt('X', 'a'));
    expect(c.blindIndex('l', 'X')).toBe(c.blindIndex('l', 'X'));
    expect(c.blindIndex('l', 'X')).not.toBe(c.blindIndex('m', 'X'));
    expect(c.decrypt(c.encrypt('é', 'a'), 'a')).toBe('é');
  });
  it('le rapprochement et la recherche par identifiant fonctionnent sur les données chiffrées', async () => {
    const { service } = await makeService();
    const p = await created(service, { niveauIdentite: 1, identifiants: [{ type: 'cni', valeur: '987' }] });
    expect((await service.findByIdentifier('cni', ' 987 '))!.id).toBe(p.id);
    expect((await service.findMatches(base({ nom: 'MBARGA', prenoms: 'jean-pierre' }))).probable[0]!.patient.id).toBe(p.id);
  });
});

describe('3.1 fusion avec lien de représentation entre les deux dossiers', () => {
  it('refusée par un code métier, rien n\'est modifié', async () => {
    const { service, raw } = await makeService();
    const parent = await created(service, { nom: 'Parent', dateNaissance: '1960-01-01' });
    const enfant = await created(service, { nom: 'Enfant', dateNaissance: '2015-01-01' });
    await raw.query("INSERT INTO representation_link VALUES (gen_random_uuid(), $1, $2, 'pere', NULL, '2020-01-01', NULL, 'actif')", [enfant.id, parent.id]);
    for (const [s, a] of [[parent.id, enfant.id], [enfant.id, parent.id]] as const) {
      await expect(service.merge(s, a, 'x', 'm')).rejects.toMatchObject({ code: 'fusion_lien_representation_entre_dossiers' });
    }
    expect((await service.resolve(enfant.id))!.statutDossier).toBe('actif');
  });
  it('les autres liens sont réaffectés puis restitués', async () => {
    const { service, raw } = await makeService();
    const [a, b, tuteur] = [await created(service), await created(service, { nom: 'Autre', dateNaissance: '1930-01-01' }), await created(service, { nom: 'Tuteur', dateNaissance: '1970-01-01' })];
    await raw.query("INSERT INTO representation_link VALUES (gen_random_uuid(), $1, $2, 'tuteur', NULL, '2020-01-01', NULL, 'actif')", [b.id, tuteur.id]);
    const m = await service.merge(a.id, b.id, 'x', 'm');
    expect((await raw.query('SELECT 1 FROM representation_link WHERE id_enfant=$1', [a.id])).rows).toHaveLength(1);
    await service.unmerge(m, 'x', 'annulation');
    expect((await raw.query('SELECT 1 FROM representation_link WHERE id_enfant=$1', [b.id])).rows).toHaveLength(1);
  });
});

describe('3.2 synchronisation FHIR : jamais d\'échec silencieux', () => {
  it('échec de réaffectation : la base est restaurée et l\'échec est journalisé', async () => {
    const f = flaky({ reassign: true });
    const { service, raw } = await makeService(f.port);
    const a = await created(service); const b = await created(service, { nom: 'Autre', dateNaissance: '1930-01-01' });
    await expect(service.merge(a.id, b.id, 'x', 'm')).rejects.toMatchObject({ code: 'fhir_reaffectation_echouee' });
    expect((await service.resolve(b.id))!.statutDossier).toBe('actif');
    expect((await raw.query("SELECT 1 FROM identity_event WHERE type='fusion_echec_fhir'")).rows).toHaveLength(1);
    expect(await service.pendingFhirSyncs()).toEqual([]);
    f.mode.reassign = false;
    await service.merge(a.id, b.id, 'x', 'on réessaie'); // réessai possible
  });
  it('échec de restauration à l\'annulation : marqué « à réconcilier », bloque une nouvelle fusion, puis se reprend', async () => {
    const f = flaky({ restore: true });
    const { service, raw } = await makeService(f.port);
    const a = await created(service); const b = await created(service, { nom: 'Autre', dateNaissance: '1930-01-01' });
    const m = await service.merge(a.id, b.id, 'x', 'm');
    await expect(service.unmerge(m, 'x', 'erreur')).rejects.toMatchObject({ code: 'fhir_restauration_echouee' });
    expect((await service.resolve(b.id))!.statutDossier).toBe('actif'); // base : annulée
    expect(await service.pendingFhirSyncs()).toEqual([m]);
    const row = (await raw.query<{ fhir_etat: string; fhir_operation: string; fhir_erreur: string }>('SELECT fhir_etat, fhir_operation, fhir_erreur FROM patient_merge')).rows[0]!;
    expect(row).toEqual({ fhir_etat: 'a_reconcilier', fhir_operation: 'restore', fhir_erreur: 'Error' });
    await expect(service.merge(a.id, b.id, 'x', 'trop tôt')).rejects.toMatchObject({ code: 'fusion_fhir_non_reconciliee' });
    await expect(service.reconcileFhir(m, 'ops')).rejects.toMatchObject({ code: 'fhir_reconciliation_echouee' });
    f.mode.restore = false;
    await service.reconcileFhir(m, 'ops');
    expect(await service.pendingFhirSyncs()).toEqual([]);
    await service.merge(a.id, b.id, 'x', 'maintenant oui');
  });
  it('compensation impossible : fusion « à réconcilier », reprise par reconcileFhir', async () => {
    const f = flaky({ reassign: true });
    const { service, raw, db } = await makeService(f.port);
    const a = await created(service); const b = await created(service, { nom: 'Autre', dateNaissance: '1930-01-01' });
    // la compensation échoue parce que le dossier conservé est entre-temps fusionné ailleurs
    const third = await created(service, { nom: 'Tiers', dateNaissance: '1944-04-04' });
    const orig = f.port.reassign;
    f.port.reassign = async (...args) => {
      await db.query("UPDATE patient SET statut_dossier='fusionne', merged_into=$1 WHERE id=$2", [third.id, a.id]);
      return orig(...args);
    };
    await expect(service.merge(a.id, b.id, 'x', 'm')).rejects.toMatchObject({ code: 'fusion_a_reconcilier' });
    expect((await raw.query("SELECT 1 FROM identity_event WHERE type='fusion_a_reconcilier'")).rows).toHaveLength(1);
    const [id] = await service.pendingFhirSyncs();
    f.mode.reassign = false;
    await service.reconcileFhir(id!, 'ops');
    expect(await service.pendingFhirSyncs()).toEqual([]);
  });
  it('arrêt entre les deux phases : la fusion reste « en attente » et se reprend', async () => {
    const f = flaky({});
    const { service, db } = await makeService(f.port);
    const a = await created(service); const b = await created(service, { nom: 'Autre', dateNaissance: '1930-01-01' });
    const orig = db.query.bind(db);
    // simule une panne de la base juste après FHIR (mise à jour finale impossible)
    const spy = vi.spyOn(db, 'query').mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("fhir_etat='ok'") && sql.includes('references_fhir')) throw new Error('db down');
      return orig(sql, params);
    });
    await expect(service.merge(a.id, b.id, 'x', 'm')).rejects.toThrow('db down');
    spy.mockRestore();
    const pending = await service.pendingFhirSyncs();
    expect(pending).toHaveLength(1);
    await service.reconcileFhir(pending[0]!, 'ops');
    expect(await service.pendingFhirSyncs()).toEqual([]);
  });
});

describe('3.3 fusion et décès', () => {
  it('refusée si un seul des deux dossiers est décédé ; permise si les deux le sont', async () => {
    const { service, raw } = await makeService();
    const [a, b, c] = [await created(service), await created(service, { nom: 'B', dateNaissance: '1940-01-01' }), await created(service, { nom: 'C', dateNaissance: '1941-01-01' })];
    await raw.query("UPDATE patient SET statut_dossier='decede' WHERE id=$1", [b.id]);
    await expect(service.merge(a.id, b.id, 'x', 'm')).rejects.toMatchObject({ code: 'fusion_decede_incompatible' });
    await expect(service.merge(b.id, a.id, 'x', 'm')).rejects.toMatchObject({ code: 'fusion_decede_incompatible' });
    await raw.query("UPDATE patient SET statut_dossier='decede' WHERE id=$1", [c.id]);
    await service.merge(b.id, c.id, 'x', 'm');
    expect((await service.resolve(c.id))!.statutDossier).toBe('decede');
  });
});

describe('1.2 / 3.4 / 3.5 / 4.1', () => {
  it('1.2 : un numéro d\'acte ajouté deux fois ne crée qu\'une ligne', async () => {
    const { service, raw } = await makeService();
    const p = await created(service);
    await service.addIdentifier(p.id, { type: 'acte', valeur: 'A-1' }, 'a');
    await service.addIdentifier(p.id, { type: 'acte', valeur: 'a1' }, 'a');
    expect((await raw.query('SELECT 1 FROM patient_identifier')).rows).toHaveLength(1);
  });
  it('3.4 : course sur un même CSU (violation d\'unicité) → « existant », sans erreur SQL', async () => {
    const { service, raw } = await makeService();
    const input = base({ nom: 'Alpha', prenoms: 'Zed', dateNaissance: '1950-01-01', niveauIdentite: 1, identifiants: [{ type: 'csu', valeur: 'RACE' }] });
    await service.register(input, 'a');
    // la première lecture ne voit pas le dossier (course), l'insertion heurte l'index unique, on rejoue
    vi.spyOn(service, 'findMatches').mockResolvedValueOnce({ strong: [], probable: [], possible: [] });
    const r = await service.register({ ...input, nom: 'Beta' }, 'a');
    expect(r.outcome).toBe('existing');
    expect((await raw.query('SELECT 1 FROM patient')).rows).toHaveLength(1);
  });
  it.skipIf(!REAL_PG)('3.4 (PostgreSQL réel) : 10 inscriptions simultanées du même CSU → un seul dossier', async () => {
    const { service, raw } = await makeService();
    const mk = (i: number) => service.register(base({ nom: `Nom${String.fromCharCode(65 + i)}`, prenoms: 'Zed', dateNaissance: '1950-01-01', niveauIdentite: 1, identifiants: [{ type: 'csu', valeur: 'RACE' }] }), 'a');
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => mk(i)));
    expect(res.filter((r) => r.outcome === 'created')).toHaveLength(1);
    expect((await raw.query('SELECT 1 FROM patient')).rows).toHaveLength(1);
  });
  it.skipIf(!REAL_PG)('3.5 (PostgreSQL réel) : fusions croisées simultanées → pas d\'interblocage', async () => {
    const { service } = await makeService();
    const a = await created(service); const b = await created(service, { nom: 'Autre', dateNaissance: '1930-01-01' });
    const res = await Promise.allSettled([service.merge(a.id, b.id, 'x', 'm'), service.merge(b.id, a.id, 'x', 'm')]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const err = (res.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason;
    expect(err.code).toBe('dossier_deja_fusionne'); // et non 40P01
  });
  it('4.1 : précision de date, longueurs et acteur validés par des codes métier', async () => {
    const { service } = await makeService();
    const errs = async (over: object) => { try { await service.register(base(over), 'a'); } catch (e) { return (e as { details: { errors: string[] } }).details.errors; } };
    expect(await errs({ datePrecision: 'bidon' })).toContain('date_precision_invalide');
    expect(await errs({ datePrecision: 'mois', dateNaissance: '1985-03-12' })).toContain('date_precision_incoherente');
    expect(await errs({ datePrecision: 'annee', dateNaissance: '1985-03-01' })).toContain('date_precision_incoherente');
    expect(await errs({ nom: 'x'.repeat(201) })).toContain('texte_trop_long');
    expect(await errs({ identifiants: Array.from({ length: 11 }, (_, i) => ({ type: 'acte' as const, valeur: `${i}` })) })).toContain('trop_d_identifiants');
    await expect(service.register(base(), ' ')).rejects.toMatchObject({ code: 'acteur_requis' });
    expect((await service.register(base({ datePrecision: 'annee', dateNaissance: '1985-01-01' }), 'a', { confirmNew: true })).outcome).toBe('created');
  });
});

describe('4.2 / 4.3 réglages du score en configuration', () => {
  it('les coefficients se lisent dans l\'environnement et changent le résultat', async () => {
    const { db, crypto } = await makeService();
    const strict = new IdentityService(db, loadIdentityConfig({ ID_SWAP_FACTOR: '0.1' }), crypto);
    const lax = new IdentityService(db, loadIdentityConfig({}), crypto);
    await created(lax, { nom: 'Mbarga', prenoms: 'Jean' });
    const swapped = base({ nom: 'Jean', prenoms: 'Mbarga' });
    expect((await lax.findMatches(swapped)).probable).toHaveLength(1);
    expect((await strict.findMatches(swapped)).probable).toHaveLength(0);
    expect(() => loadIdentityConfig({ ID_SWAP_FACTOR: 'abc' })).toThrow();
  });
  it('4.3 : des noms formés surtout de voyelles ne sont pas confondus par la seule phonétique', async () => {
    const { service } = await makeService();
    await created(service, { nom: 'Eyo', prenoms: 'Ayo' });
    const m = await service.findMatches(base({ nom: 'Yao', prenoms: 'Uyo' }));
    expect(m.probable).toHaveLength(0);
  });
});

describe('revue 2 — R1 : annulation pendant la phase FHIR', () => {
  const gated = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const log: string[] = [];
    const port: FhirReferenceReassigner = {
      reassign: async () => { await gate; log.push('reassign'); return [{ r: 1 }]; },
      restore: async (_f, _t, refs) => { log.push(`restore:${JSON.stringify(refs)}`); },
    };
    return { port, release, log };
  };
  it('refusée tant que la réaffectation FHIR n\'est pas terminée ; la fusion aboutit proprement', async () => {
    const g = gated();
    const { service, raw } = await makeService(g.port);
    const a = await created(service); const b = await created(service, { nom: 'Autre', dateNaissance: '1930-01-01' });
    const merging = service.merge(a.id, b.id, 'x', 'm');
    await vi.waitFor(async () => expect((await raw.query('SELECT 1 FROM patient_merge')).rows).toHaveLength(1));
    const id = (await raw.query<{ id: string }>('SELECT id FROM patient_merge')).rows[0]!.id;
    await expect(service.unmerge(id, 'x', 'trop tôt')).rejects.toMatchObject({ code: 'fusion_fhir_en_cours' });
    g.release();
    await merging;
    expect(g.log).toEqual(['reassign']); // aucune restauration intempestive
    expect((await raw.query<{ fhir_etat: string; annulee_le: unknown }>('SELECT fhir_etat, annulee_le FROM patient_merge')).rows[0]).toEqual({ fhir_etat: 'ok', annulee_le: null });
    await service.unmerge(id, 'x', 'maintenant');
    expect(g.log).toEqual(['reassign', 'restore:[{"r":1}]']);
  });
  it('refusée aussi tant qu\'une fusion est « à réconcilier »', async () => {
    const f = flaky({ reassign: true });
    const { service, db } = await makeService(f.port);
    const a = await created(service); const b = await created(service, { nom: 'Autre', dateNaissance: '1930-01-01' });
    const third = await created(service, { nom: 'Tiers', dateNaissance: '1944-04-04' });
    const orig = f.port.reassign;
    f.port.reassign = async (...args) => { await db.query("UPDATE patient SET statut_dossier='fusionne', merged_into=$1 WHERE id=$2", [third.id, a.id]); return orig(...args); };
    await expect(service.merge(a.id, b.id, 'x', 'm')).rejects.toMatchObject({ code: 'fusion_a_reconcilier' });
    const [id] = await service.pendingFhirSyncs();
    await expect(service.unmerge(id!, 'x', 'm')).rejects.toMatchObject({ code: 'fusion_fhir_en_cours' });
  });
  it('si l\'état change pendant la phase FHIR, rien n\'est écrasé : « à réconcilier »', async () => {
    const f = flaky({});
    const { service, raw } = await makeService(f.port);
    const a = await created(service); const b = await created(service, { nom: 'Autre', dateNaissance: '1930-01-01' });
    f.port.reassign = async () => { await raw.query("UPDATE patient_merge SET annulee_le=now()"); return []; };
    await expect(service.merge(a.id, b.id, 'x', 'm')).rejects.toMatchObject({ code: 'fusion_etat_inattendu' });
    expect(await service.pendingFhirSyncs()).toHaveLength(1);
  });
});

describe('revue 2 — R2 : identifiants chiffrés lisibles après fusion et annulation', () => {
  it('relecture exacte, quel que soit le dossier qui les porte', async () => {
    const { service } = await makeService();
    const p = await created(service, { niveauIdentite: 1, identifiants: [{ type: 'csu', valeur: 'CSU-1' }, { type: 'acte', valeur: 'A 9' }] });
    const q = await created(service, { nom: 'Autre', dateNaissance: '1930-01-01', niveauIdentite: 1, identifiants: [{ type: 'cni', valeur: 'C-2' }] });
    const key = (i: { type: string; valeur: string }) => `${i.type}:${i.valeur}`;
    const first = await service.listIdentifiers(p.id);
    expect(first.map(key).sort()).toEqual(['acte:A9', 'csu:CSU1']);
    expect((await service.listIdentifiers(p.id)).map(key)).toEqual(first.map(key)); // ordre stable d'un appel à l'autre
    const m = await service.merge(q.id, p.id, 'x', 'm');
    expect((await service.listIdentifiers(q.id)).map((i) => i.valeur).sort()).toEqual(['A9', 'C2', 'CSU1']);
    await service.unmerge(m, 'x', 'annulation');
    expect((await service.listIdentifiers(p.id)).map((i) => i.valeur).sort()).toEqual(['A9', 'CSU1']);
    expect((await service.listIdentifiers(q.id)).map((i) => i.valeur)).toEqual(['C2']);
  });
});

describe('revue 2 — R3 : configuration absurde refusée', () => {
  it.each([
    [{ ID_W_NOM: '0', ID_W_PRENOMS: '0', ID_W_DOB: '0', ID_W_SEXE: '0', ID_W_MERE: '0' }, 'somme'],
    [{ ID_W_NOM: '-1' }, 'négatif'],
    [{ ID_SWAP_FACTOR: '1.5' }, 'entre 0 et 1'],
    [{ ID_DOB_YEAR_ONLY: '-0.1' }, 'entre 0 et 1'],
    [{ ID_PHONETIC_MIN_LENGTH: '1.5' }, 'entier'],
    [{ ID_MATCH_MAX_POSSIBLE: '-2' }, 'entier'],
  ])('%j', (env, msg) => {
    expect(() => loadIdentityConfig(env)).toThrow(msg);
  });
  it('la configuration par défaut est valide', () => {
    expect(() => loadIdentityConfig({})).not.toThrow();
  });
});

describe('revue 2 — R4 / R5 / R6', () => {
  it('R5 : fusion refusée si l\'un des deux dossiers a une synchronisation FHIR en attente (y compris côté conservé)', async () => {
    const f = flaky({ restore: true });
    const { service } = await makeService(f.port);
    const a = await created(service); const b = await created(service, { nom: 'Autre', dateNaissance: '1930-01-01' });
    const c = await created(service, { nom: 'Tiers', dateNaissance: '1944-04-04' });
    const m = await service.merge(a.id, b.id, 'x', 'm');
    await expect(service.unmerge(m, 'x', 'm')).rejects.toMatchObject({ code: 'fhir_restauration_echouee' });
    await expect(service.merge(a.id, c.id, 'x', 'conservé en attente')).rejects.toMatchObject({ code: 'fusion_fhir_non_reconciliee' });
    await expect(service.merge(c.id, a.id, 'x', 'absorbé en attente')).rejects.toMatchObject({ code: 'fusion_fhir_non_reconciliee' });
  });
  it('R6 : le message de l\'erreur FHIR n\'est jamais copié dans la base identité', async () => {
    const { service, raw } = await makeService({
      reassign: async () => { throw Object.assign(new Error('Patient Jean Dupont, diabète, Encounter/42'), { code: 'ECONNRESET' }); },
      restore: async () => {},
    });
    const a = await created(service); const b = await created(service, { nom: 'Autre', dateNaissance: '1930-01-01' });
    await expect(service.merge(a.id, b.id, 'x', 'm')).rejects.toMatchObject({ code: 'fhir_reaffectation_echouee' });
    const dump = JSON.stringify((await raw.query('SELECT details FROM identity_event')).rows) + JSON.stringify((await raw.query('SELECT * FROM patient_merge')).rows);
    expect(dump).not.toMatch(/Dupont|diabète|Encounter/);
    expect(dump).toContain('Error:ECONNRESET');
  });
  it.skipIf(!REAL_PG)('R4 (PostgreSQL réel, test de fumée ; l\'ordre des verrous est prouvé par T5) : annulation et fusion concurrentes → jamais d\'interblocage', async () => {
    const { service } = await makeService();
    for (let i = 0; i < 8; i++) {
      const a = await created(service, { nom: `Alpha${i}`, dateNaissance: `19${40 + i}-01-01` });
      const b = await created(service, { nom: `Beta${i}`, dateNaissance: `19${50 + i}-02-02` });
      const c = await created(service, { nom: `Gamma${i}`, dateNaissance: `19${60 + i}-03-03` });
      const m = await service.merge(a.id, b.id, 'x', 'm');
      const res = await Promise.allSettled([service.unmerge(m, 'x', 'u'), service.merge(c.id, a.id, 'x', 'm2')]);
      for (const r of res) if (r.status === 'rejected') expect((r.reason as { code?: string }).code).not.toBe('40P01');
      // cohérence : chaque dossier se résout vers un dossier non fusionné
      for (const p of [a, b, c]) expect((await service.resolve(p.id))!.statutDossier).not.toBe('fusionne');
    }
  });
});

describe('revue 3 — T1 : reprise concurrente d\'une fusion en cours', () => {
  it('si une reprise termine la fusion pendant la phase FHIR, la fusion réussit et l\'état « ok » est conservé', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const { service, raw } = await makeService({
      reassign: async () => { if (calls++ === 0) await gate; return [{ n: calls }]; },
      restore: async () => {},
    });
    const a = await created(service); const b = await created(service, { nom: 'Autre', dateNaissance: '1930-01-01' });
    const merging = service.merge(a.id, b.id, 'x', 'm');
    await vi.waitFor(async () => expect(await service.pendingFhirSyncs()).toHaveLength(1));
    await service.reconcileFhir((await service.pendingFhirSyncs())[0]!, 'ops'); // l'exploitation reprend entre-temps
    release();
    await expect(merging).resolves.toEqual(expect.any(String)); // plus de faux échec
    expect((await raw.query('SELECT fhir_etat, fhir_operation FROM patient_merge')).rows).toEqual([{ fhir_etat: 'ok', fhir_operation: null }]);
    expect(await service.pendingFhirSyncs()).toEqual([]);
  });
});

describe('revue 3 — T2 / T3 : aucune donnée sensible dans les erreurs', () => {
  const PHI = 'Patient Jean Dupont, diabète, Encounter/42';
  const leaky = (extra: object = {}) => Object.assign(new Error(PHI), extra);
  const noPhi = (e: unknown) => {
    expect(inspect(e, { depth: 10 })).not.toMatch(/Dupont|diabète|Encounter/);
    expect(JSON.stringify(e, Object.getOwnPropertyNames(e as object))).not.toMatch(/Dupont|diabète|Encounter/);
  };
  it('échec de réaffectation, de restauration et de reprise : ni message ni cause ne portent le texte d\'origine', async () => {
    const f = { reassign: true, restore: false };
    const { service } = await makeService({
      reassign: async () => { if (f.reassign) throw leaky(); return []; },
      restore: async () => { throw leaky({ code: 'ECONNRESET' }); },
    });
    const a = await created(service); const b = await created(service, { nom: 'Autre', dateNaissance: '1930-01-01' });
    noPhi(await service.merge(a.id, b.id, 'x', 'm').catch((e) => e));
    f.reassign = false;
    const m = await service.merge(a.id, b.id, 'x', 'm');
    const e2 = await service.unmerge(m, 'x', 'u').catch((e) => e);
    expect(e2).toMatchObject({ code: 'fhir_restauration_echouee' });
    noPhi(e2);
    noPhi(await service.reconcileFhir(m, 'ops').catch((e) => e));
  });
  it('échec de compensation (erreur de base) : cause réduite à sa classe', async () => {
    const f = flaky({ reassign: true });
    const { service, db } = await makeService(f.port);
    const a = await created(service); const b = await created(service, { nom: 'Autre', dateNaissance: '1930-01-01' });
    const third = await created(service, { nom: 'Tiers', dateNaissance: '1944-04-04' });
    f.port.reassign = async () => { await db.query("UPDATE patient SET statut_dossier='fusionne', merged_into=$1 WHERE id=$2", [third.id, a.id]); throw leaky(); };
    const e = await service.merge(a.id, b.id, 'x', 'm').catch((x) => x);
    expect(e).toMatchObject({ code: 'fusion_a_reconcilier' });
    noPhi(e);
  });
  it('describeFailure : classe et code au format strict seulement', () => {
    expect(describeFailure(leaky())).toBe('Error');
    expect(describeFailure(leaky({ code: 'ECONNRESET' }))).toBe('Error:ECONNRESET');
    expect(describeFailure(leaky({ code: '23505' }))).toBe('Error:23505');
    expect(describeFailure(leaky({ code: 503 }))).toBe('Error:503');
    for (const code of ['Patient Jean Dupont', 'a'.repeat(41), '', 'x;y', -1, 1.5, 1e9, {}, null]) {
      expect(describeFailure(leaky({ code }))).toBe('Error');
    }
    class Dupont_diabete extends Error {}
    expect(describeFailure(new Dupont_diabete('x'))).toBe('Error'); // nom de classe : name vaut « Error »
    const named = Object.assign(new Error('x'), { name: 'Patient Jean Dupont' });
    expect(describeFailure(named)).toBe('Error');
    expect(describeFailure('Patient Jean Dupont')).toBe('Error');
    expect(describeFailure(undefined)).toBe('Error');
  });
});

describe('revue 3 — T5 : ordre des verrous prouvé', () => {
  it.skipIf(!REAL_PG)('l\'annulation verrouille les dossiers AVANT la ligne de fusion (même ordre que la fusion)', async () => {
    const { service, db } = await makeService();
    const a = await created(service); const b = await created(service, { nom: 'Autre', dateNaissance: '1930-01-01' });
    const m = await service.merge(a.id, b.id, 'x', 'm');
    // Un tiers tient le verrou du dossier conservé : l'annulation doit attendre dessus.
    let locked!: () => void; const isLocked = new Promise<void>((r) => (locked = r));
    let free!: () => void; const gate = new Promise<void>((r) => (free = r));
    const holder = db.transaction(async (tx) => {
      await tx.query('SELECT 1 FROM patient WHERE id=$1 FOR UPDATE', [a.id]);
      locked();
      await gate;
    });
    await isLocked;
    const unmerging = service.unmerge(m, 'x', 'u');
    await vi.waitFor(async () => {
      const waiting = await db.query<{ n: string }>("SELECT count(*) AS n FROM pg_locks WHERE NOT granted AND locktype='transactionid'");
      expect(Number(waiting.rows[0]!.n)).toBeGreaterThan(0); // l'annulation est bloquée sur le dossier
    });
    // Pendant qu'elle attend, elle ne doit détenir aucun verrou sur la ligne de fusion.
    const probe = await db.transaction(async (tx) => {
      try { await tx.query('SELECT 1 FROM patient_merge WHERE id=$1 FOR UPDATE NOWAIT', [m]); return 'libre'; }
      catch (e) { return (e as { code?: string }).code ?? 'erreur'; }
    });
    free();
    await holder;
    await unmerging;
    expect(probe).toBe('libre'); // 55P03 ici = ancien ordre (fusion verrouillée avant les dossiers)
  });
});
