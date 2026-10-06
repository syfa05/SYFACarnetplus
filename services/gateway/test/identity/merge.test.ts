import { afterAll, describe, expect, it } from 'vitest';
import { base, cleanup, created, DELEGATION_SQL, flaky, makeService, REAL_PG } from './helpers.js';

afterAll(cleanup);

describe('fusion réversible', () => {
  const setup = async () => {
    const calls: string[] = [];
    const s = await makeService({
      reassign: async (f, t) => { calls.push(`reassign ${f}->${t}`); return [{ ref: 'Encounter/1' }]; },
      restore: async (f, t) => { calls.push(`restore ${f}->${t}`); },
    });
    const surv = await created(s.service, { niveauIdentite: 1, identifiants: [{ type: 'cni', valeur: 'C1' }] });
    const abs = await created(s.service, { nom: 'Mbargua', identifiants: [{ type: 'csu', valeur: 'S1' }], niveauIdentite: 1 });
    await s.raw.query(DELEGATION_SQL, [abs.id]);
    return { ...s, surv, abs, calls };
  };

  it('fusionne : statut, redirection, identifiants et délégations réaffectés, FHIR réaffecté', async () => {
    const { service, raw, surv, abs, calls } = await setup();
    await service.merge(surv.id, abs.id, 'dir-1', 'Même personne, CNI présentée');
    const absorbed = (await raw.query<{ statut_dossier: string; merged_into: string }>('SELECT statut_dossier, merged_into FROM patient WHERE id=$1', [abs.id])).rows[0]!;
    expect(absorbed).toEqual({ statut_dossier: 'fusionne', merged_into: surv.id });
    expect((await service.resolve(abs.id))!.id).toBe(surv.id);
    expect((await service.findByIdentifier('csu', 'S1'))!.id).toBe(surv.id);
    expect((await raw.query('SELECT 1 FROM companion_delegation WHERE id_enfant=$1', [surv.id])).rows).toHaveLength(1);
    expect(calls).toEqual([`reassign ${abs.id}->${surv.id}`]);
    // l'identifiant du dossier absorbé reste interdit à la création
    const r = await service.register(base({ nom: 'Zed', prenoms: 'Y', dateNaissance: '1950-01-01', niveauIdentite: 1, identifiants: [{ type: 'csu', valeur: 'S1' }] }), 'a');
    expect(r.outcome).toBe('existing');
  });
  it('annulation : tout est restitué, rien n\'est perdu', async () => {
    const { service, raw, surv, abs, calls } = await setup();
    const id = await service.merge(surv.id, abs.id, 'dir-1', 'erreur probable');
    await service.unmerge(id, 'dir-1', 'Deux personnes distinctes');
    const p = (await raw.query<{ statut_dossier: string; merged_into: string | null }>('SELECT statut_dossier, merged_into FROM patient WHERE id=$1', [abs.id])).rows[0]!;
    expect(p).toEqual({ statut_dossier: 'actif', merged_into: null });
    expect((await service.findByIdentifier('csu', 'S1'))!.id).toBe(abs.id);
    expect((await service.findByIdentifier('cni', 'C1'))!.id).toBe(surv.id);
    expect((await raw.query('SELECT 1 FROM companion_delegation WHERE id_enfant=$1', [abs.id])).rows).toHaveLength(1);
    expect(calls).toContain(`restore ${abs.id}->${surv.id}`);
    await expect(service.unmerge(id, 'x', 'encore')).rejects.toMatchObject({ code: 'fusion_deja_annulee' });
    // on peut re-fusionner après annulation
    await service.merge(surv.id, abs.id, 'dir-1', 'finalement oui');
  });
  it('refuse : même dossier, motif vide, dossier déjà fusionné, annulation sous fusion ultérieure', async () => {
    const { service, surv, abs } = await setup();
    await expect(service.merge(surv.id, surv.id, 'a', 'm')).rejects.toMatchObject({ code: 'fusion_meme_dossier' });
    await expect(service.merge(surv.id, abs.id, 'a', ' ')).rejects.toMatchObject({ code: 'motif_requis' });
    const m1 = await service.merge(surv.id, abs.id, 'a', 'm');
    await expect(service.merge(surv.id, abs.id, 'a', 'm')).rejects.toMatchObject({ code: 'dossier_deja_fusionne' });
    const third = await created(service, { nom: 'Tiers', prenoms: 'Un', dateNaissance: '1944-04-04' });
    await service.merge(third.id, surv.id, 'a', 'chaîne');
    expect((await service.resolve(abs.id))!.id).toBe(third.id);
    await expect(service.unmerge(m1, 'a', 'm')).rejects.toMatchObject({ code: 'annuler_fusion_ulterieure_dabord' });
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

describe('R4 / R5 / R6', () => {
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
