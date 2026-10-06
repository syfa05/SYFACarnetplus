import { afterAll, describe, expect, it, vi } from 'vitest';
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
    const dump = JSON.stringify([
      (await raw.query('SELECT * FROM patient')).rows,
      (await raw.query('SELECT * FROM patient_identifier')).rows,
    ]).toUpperCase();
    for (const secret of ['NGOUE', 'ATANGANA', 'ELOISE', 'ÉLOÏSE', '1984', 'BAFOUSSAM', 'TCHAMBA', 'FOTSING', '690123456', 'BANGANG', 'ROSE', '677000111', 'CSU0042', '123456789']) {
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
    expect(row).toEqual({ fhir_etat: 'a_reconcilier', fhir_operation: 'restore', fhir_erreur: 'fhir down' });
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
