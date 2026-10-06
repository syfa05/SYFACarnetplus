import { afterAll, describe, expect, it } from 'vitest';
import { loadIdentityConfig } from '../../src/identity/config.js';
import { FieldCrypto, generateMasterKey } from '../../src/identity/crypto.js';
import { IdentityService } from '../../src/identity/service.js';
import { base, cleanup, created, makeService } from './helpers.js';

afterAll(cleanup);

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

describe('R2 : identifiants chiffrés lisibles après fusion et annulation', () => {
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
