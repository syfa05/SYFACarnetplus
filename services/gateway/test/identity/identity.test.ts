import { describe, expect, it } from 'vitest';
import { IdentityError } from '../../src/identity/errors.js';
import { normalizeName, phoneticKey } from '../../src/identity/normalize.js';
import { base, makeService } from './helpers.js';

const created = async (s: Awaited<ReturnType<typeof makeService>>['service'], over = {}) => {
  const r = await s.register(base(over), 'acteur-1', { confirmNew: true, justification: 'test' });
  if (r.outcome !== 'created') throw new Error(r.outcome);
  return r.patient;
};

describe('normalisation et phonétique (onglet 3.2)', () => {
  it('majuscules sans accents, forme d\'origine conservée en base', async () => {
    expect(normalizeName("  N'Guéma-Éloïse ")).toBe('NGUEMA ELOISE');
    const { service, raw } = await makeService();
    await created(service, { nom: 'Ngoué', prenoms: 'Élise' });
    const r = await raw.query<{ nom: string; nom_normalise: string }>('SELECT nom, nom_normalise FROM patient');
    expect(r.rows[0]).toEqual({ nom: 'Ngoué', nom_normalise: 'NGOUE' });
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
    await raw.query("INSERT INTO companion_delegation VALUES (gen_random_uuid(), $1, '237690000001', 'Tante', now(), now() + interval '1 day', 'x')", [p.id]);
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

describe('fusion réversible', () => {
  const setup = async () => {
    const calls: string[] = [];
    const s = await makeService({
      reassign: async (f, t) => { calls.push(`reassign ${f}->${t}`); return [{ ref: 'Encounter/1' }]; },
      restore: async (f, t) => { calls.push(`restore ${f}->${t}`); },
    });
    const surv = await created(s.service, { niveauIdentite: 1, identifiants: [{ type: 'cni', valeur: 'C1' }] });
    const abs = await created(s.service, { nom: 'Mbargua', identifiants: [{ type: 'csu', valeur: 'S1' }], niveauIdentite: 1 });
    await s.raw.query("INSERT INTO companion_delegation VALUES (gen_random_uuid(), $1, '237690000001', 'Tante', now(), now() + interval '1 day', 'x')", [abs.id]);
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
  it('échec FHIR : la fusion est annulée en base', async () => {
    const { db } = await makeService();
    const { IdentityService } = await import('../../src/identity/service.js');
    const { loadIdentityConfig } = await import('../../src/identity/config.js');
    const s = new IdentityService(db, loadIdentityConfig({}), { reassign: async () => { throw new Error('fhir down'); }, restore: async () => {} });
    const a = await created(s); const b = await created(s, { nom: 'Autre', dateNaissance: '1930-01-01' });
    await expect(s.merge(a.id, b.id, 'x', 'm')).rejects.toThrow('fhir down');
    expect((await s.resolve(b.id))!.statutDossier).toBe('actif');
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
