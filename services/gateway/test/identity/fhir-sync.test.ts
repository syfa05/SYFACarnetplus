import { inspect } from 'node:util';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { describeFailure } from '../../src/identity/errors.js';
import type { FhirReferenceReassigner } from '../../src/identity/fhir-port.js';
import { base, cleanup, created, flaky, makeService, REAL_PG } from './helpers.js';

afterAll(cleanup);

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

describe('R1 : annulation pendant la phase FHIR', () => {
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

describe('T1 : reprise concurrente d\'une fusion en cours', () => {
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

describe('T2 / T3 : aucune donnée sensible dans les erreurs', () => {
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

describe('T5 : ordre des verrous prouvé', () => {
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
