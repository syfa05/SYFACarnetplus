import { afterAll, describe, expect, it, vi } from 'vitest';
import { base, cleanup, created, makeService, REAL_PG } from './helpers.js';

afterAll(cleanup);

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
