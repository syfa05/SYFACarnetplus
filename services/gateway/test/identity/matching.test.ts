import { afterAll, describe, expect, it } from 'vitest';
import { IdentityError } from '../../src/identity/errors.js';
import { loadIdentityConfig } from '../../src/identity/config.js';
import { IdentityService } from '../../src/identity/service.js';
import { normalizeName, phoneticKey } from '../../src/identity/normalize.js';
import { base, cleanup, created, DELEGATION_SQL, makeService } from './helpers.js';

afterAll(cleanup);

describe('normalisation et phonétique (onglet 3.2)', () => {
  it('majuscules sans accents, forme d\'origine conservée en base', async () => {
    expect(normalizeName("  N'Guéma-Éloïse ")).toBe('NGUEMA ELOISE');
    const { service, raw } = await makeService();
    await created(service, { nom: 'Ngoué', prenoms: 'Élise' });
    const p = await service.resolve((await raw.query<{ id: string }>('SELECT id FROM patient')).rows[0]!.id);
    expect(p).toMatchObject({ nom: 'Ngoué', prenoms: 'Élise' });
  });
  it('variantes orthographiques courantes partagent la clé', () => {
    const k = (s: string) => phoneticKey(normalizeName(s));
    expect(k('Mbarga')).toBe(k('Barga'));
    expect(k('Tchamba')).toBe(k('Shamba'));
    expect(k('Philippe')).toBe(k('Filip'));
    expect(k('Njoya')).not.toBe(k('Kamga'));
  });
});

describe('F-ID-01 doublons', () => {
  it('correspondance probable : justification exigée, puis journalisée', async () => {
    const { service, raw } = await makeService();
    const a = await created(service);
    const dup = base({ nom: 'MBARGA', prenoms: 'jean-pierre' });
    const r1 = await service.register(dup, 'acteur-2');
    expect(r1.outcome).toBe('justification_required');
    if (r1.outcome === 'justification_required') expect(r1.matches[0]!.patient.id).toBe(a.id);
    expect((await service.register(dup, 'acteur-2', { justification: '   ' })).outcome).toBe('justification_required');
    const r2 = await service.register(dup, 'acteur-2', { justification: 'Homonyme confirmé par la CNI du patient' });
    expect(r2.outcome).toBe('created');
    const ev = await raw.query<{ details: { justification: string } }>("SELECT details FROM identity_event WHERE type='doublon_probable_justifie'");
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]!.details.justification).toContain('CNI');
  });
  it('correspondance possible : liste courte, création après confirmation', async () => {
    const { service } = await makeService();
    await created(service);
    const near = base({ dateNaissance: '1985-03-27' }); // même personne ? jour différent
    const r = await service.register(near, 'a');
    expect(r.outcome).toBe('review_required');
    expect((await service.register(near, 'a', { confirmNew: true })).outcome).toBe('created');
  });
  it('aucune correspondance : création directe', async () => {
    const { service } = await makeService();
    await created(service);
    expect((await service.register(base({ nom: 'Fotso', prenoms: 'Aline', sexe: 'F', dateNaissance: '1999-01-01' }), 'a')).outcome).toBe('created');
  });
  it('CSU ou CNI identique : création interdite, même avec justification', async () => {
    const { service, raw } = await makeService();
    const a = await created(service, { niveauIdentite: 1, identifiants: [{ type: 'csu', valeur: 'CSU-123 456' }] });
    const r = await service.register(
      base({ nom: 'Autre', prenoms: 'Nom', dateNaissance: '1970-01-01', niveauIdentite: 1, identifiants: [{ type: 'csu', valeur: 'csu123456' }] }),
      'a', { justification: 'je force', confirmNew: true },
    );
    expect(r.outcome).toBe('existing');
    if (r.outcome === 'existing') expect(r.patients[0]!.id).toBe(a.id);
    expect((await raw.query('SELECT 1 FROM patient')).rows).toHaveLength(1);
  });
  it('l\'unicité CSU/CNI est aussi garantie par la base', async () => {
    const { service, raw } = await makeService();
    const a = await created(service, { niveauIdentite: 1, identifiants: [{ type: 'cni', valeur: '123' }] });
    await expect(raw.query("INSERT INTO patient_identifier VALUES (gen_random_uuid(), $1, 'cni', '123', now())", [a.id])).rejects.toThrow();
  });
  it('sexes opposés : jamais une correspondance probable', async () => {
    const { service } = await makeService();
    await created(service);
    const r = await service.register(base({ sexe: 'F' }), 'a');
    expect(r.outcome).not.toBe('justification_required');
  });
});

describe('F-ID-02 niveaux et validation', () => {
  it('niveau 1 exige CSU ou CNI ; niveaux 2/3 exigent le lieu de naissance', async () => {
    const { service } = await makeService();
    const code = async (p: object) => {
      try { await service.register(base(p), 'a'); } catch (e) { return (e as IdentityError).details.errors; }
    };
    expect(await code({ niveauIdentite: 1 })).toContain('niveau_1_exige_csu_ou_cni');
    expect(await code({ lieuNaissance: undefined })).toContain('lieu_naissance_requis');
    expect(await code({ niveauIdentite: 3, lieuNaissance: '' })).toContain('lieu_naissance_requis');
  });
  it('téléphone 2376XXXXXXXX, date réelle, champs obligatoires', async () => {
    const { service } = await makeService();
    for (const [over, err] of [
      [{ telephone: '690000000' }, 'telephone_invalide'],
      [{ dateNaissance: '1985-02-30' }, 'date_naissance_invalide'],
      [{ dateNaissance: '2999-01-01' }, 'date_naissance_future'],
      [{ nom: ' ' }, 'nom_requis'],
      [{ sexe: 'X' }, 'sexe_invalide'],
    ] as const) {
      await expect(service.register(base(over as never), 'a')).rejects.toMatchObject({ details: { errors: expect.arrayContaining([err]) } });
    }
    expect((await service.register(base({ telephone: '237690000000' }), 'a', { confirmNew: true })).outcome).toBe('created');
  });
  it('le niveau est stocké et restitué (affichage soignant ; jamais imprimé sur la carte)', async () => {
    const { service } = await makeService();
    const p = await created(service, { niveauIdentite: 3 });
    expect(p.niveauIdentite).toBe(3);
  });
  it('aucune colonne médicale dans la base identité', async () => {
    const { raw } = await makeService();
    const cols = (await raw.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema='public'")).rows.map((r) => r.column_name);
    expect(cols.filter((c) => /diagnos|allerg|prescri|observ|vaccin|traitement/.test(c))).toEqual([]);
  });
});

describe('F-ID-03 ajout d\'un CSU', () => {
  it('conserve l\'identifiant interne et tous les liens', async () => {
    const { service, raw } = await makeService();
    const p = await created(service, { identifiants: [{ type: 'acte', valeur: 'A-77' }] });
    await raw.query(DELEGATION_SQL, [p.id]);
    const after = await service.addIdentifier(p.id, { type: 'csu', valeur: 'CSU-9' }, 'a');
    expect(after.id).toBe(p.id);
    expect((await service.findByIdentifier('csu', 'csu9'))!.id).toBe(p.id);
    expect((await service.findByIdentifier('acte', 'A-77'))!.id).toBe(p.id);
    expect((await raw.query('SELECT 1 FROM companion_delegation WHERE id_enfant=$1', [p.id])).rows).toHaveLength(1);
    expect((await raw.query('SELECT 1 FROM patient')).rows).toHaveLength(1);
  });
  it('refuse un CSU déjà attribué à un autre dossier (suggère la fusion)', async () => {
    const { service } = await makeService();
    const a = await created(service, { niveauIdentite: 1, identifiants: [{ type: 'csu', valeur: 'X1' }] });
    const b = await created(service, { nom: 'Fotso', prenoms: 'Paul', dateNaissance: '1960-05-05' });
    await expect(service.addIdentifier(b.id, { type: 'csu', valeur: 'x1' }, 'a')).rejects.toMatchObject({ code: 'identifiant_deja_attribue', details: { existant: a.id } });
  });
  it('est idempotent', async () => {
    const { service, raw } = await makeService();
    const p = await created(service);
    await service.addIdentifier(p.id, { type: 'csu', valeur: 'Z' }, 'a');
    await service.addIdentifier(p.id, { type: 'csu', valeur: 'Z' }, 'a');
    expect((await raw.query('SELECT 1 FROM patient_identifier')).rows).toHaveLength(1);
  });
});

describe('journal des événements d\'identité', () => {
  it('est en ajout seul', async () => {
    const { service, raw } = await makeService();
    await created(service);
    await expect(raw.query('DELETE FROM identity_event')).rejects.toThrow();
    await expect(raw.query("UPDATE identity_event SET acteur='x'")).rejects.toThrow();
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

describe('R3 : configuration absurde refusée', () => {
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
