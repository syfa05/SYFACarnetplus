import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, makeOrgEnv, type OrgEnv } from './helpers.js';

afterEach(cleanup);

const denials = (e: OrgEnv, actor: string) => e.db.query<{ reason: string; data: string }>('SELECT reason, data FROM access_denial WHERE actor_sub=$1 ORDER BY id', [actor]).then((r) => r.rows);

describe('établissements : réservés à l\'opérateur', () => {
  it('l\'opérateur crée un établissement et un service ; un autre rôle est refusé et le refus est journalisé', async () => {
    const e = await makeOrgEnv();
    const est = await e.establishment('YDE-01', { district: 'Centre-1' });
    const svc = await e.call('POST', `/v1/admin/establishments/${est}/services`, await e.tok('op-1'), { name: 'Pédiatrie' });
    expect(svc.statusCode).toBe(201);
    const dir = await e.staff('op-1', 'dir.yde', est, [{ role: 'directeur_medical' }]);
    const t = await e.tok(dir);
    expect((await e.call('POST', '/v1/admin/establishments', t, { code: 'X-1', name: 'Autre' })).statusCode).toBe(403);
    expect((await denials(e, dir))[0]).toMatchObject({ reason: 'role_not_permitted', data: 'establishment.manage' });
  });
  it('code déjà pris : 409 ; réseaux invalides ou « tout Internet » : 400', async () => {
    const e = await makeOrgEnv();
    await e.establishment('A-1');
    const op = await e.tok('op-1');
    expect((await e.call('POST', '/v1/admin/establishments', op, { code: 'A-1', name: 'Doublon' })).statusCode).toBe(409);
    for (const bad of [['0.0.0.0/0'], ['::/0'], ['pas-une-adresse'], ['10.0.0.0/33']]) {
      expect((await e.call('POST', '/v1/admin/establishments', op, { code: 'B-1', name: 'Réseau', allowedNetworks: bad })).statusCode, JSON.stringify(bad)).toBe(400);
    }
  });
  it('un directeur ne voit que son établissement ; les réseaux sont réservés à l\'opérateur', async () => {
    const e = await makeOrgEnv();
    const a = await e.establishment('A-1'); await e.establishment('B-1');
    const dir = await e.staff('op-1', 'dir.a', a, [{ role: 'directeur_medical' }]);
    const list = (await e.call('GET', '/v1/admin/establishments', await e.tok(dir))).json() as Array<{ code: string }>;
    expect(list.map((x) => x.code)).toEqual(['A-1']);
    expect((await e.call('GET', '/v1/admin/establishments', await e.tok('op-1'))).json()).toHaveLength(2);
    expect((await e.call('PUT', `/v1/admin/establishments/${a}/networks`, await e.tok(dir), { allowedNetworks: ['10.0.0.0/8'] })).statusCode).toBe(403);
    expect((await e.call('PUT', `/v1/admin/establishments/${a}/networks`, await e.tok('op-1'), { allowedNetworks: ['10.0.0.0/8'] })).statusCode).toBe(204);
  });
});

describe('création de comptes : opérateur → directeur médical → personnel', () => {
  it('chaîne complète ; compte créé désactivé puis activé chez l\'annuaire ; mot de passe temporaire renvoyé une fois', async () => {
    const e = await makeOrgEnv();
    const est = await e.establishment('A-1');
    const r = await e.call('POST', '/v1/admin/staff', await e.tok('op-1'), { username: 'dir.a', phone: '237690000010', establishmentId: est, roles: [{ role: 'directeur_medical' }] });
    expect(r.statusCode).toBe(201);
    const { sub, temporaryPassword } = r.json() as { sub: string; temporaryPassword: string };
    expect(temporaryPassword.length).toBeGreaterThanOrEqual(20);
    expect(e.directory.users.get(sub)).toMatchObject({ username: 'dir.a', phone: '237690000010', enabled: true });
    const doc = await e.staff(sub, 'dr.martin', est, [{ role: 'medecin' }, { role: 'secretaire' }]);
    const rec = await e.rt.staff.bySub(doc);
    expect(rec).toMatchObject({ establishmentId: est, status: 'active' });
    expect(rec!.roles.map((x) => x.role).sort()).toEqual(['medecin', 'secretaire']);
    // le mot de passe n'est conservé nulle part dans la passerelle
    const all = JSON.stringify((await e.db.query('SELECT * FROM staff_member')).rows) + JSON.stringify((await e.db.query('SELECT details FROM admin_action')).rows);
    expect(all).not.toContain(temporaryPassword);
  });
  it('le directeur ne crée ni directeur, ni opérateur, ni compte dans un autre établissement ; l\'opérateur ne crée pas de personnel', async () => {
    const e = await makeOrgEnv();
    const a = await e.establishment('A-1'); const b = await e.establishment('B-1');
    const dir = await e.staff('op-1', 'dir.a', a, [{ role: 'directeur_medical' }]);
    const t = await e.tok(dir);
    const make = (token: string, roles: unknown[], est = a) => e.call('POST', '/v1/admin/staff', token, { username: `u${Math.random().toString(36).slice(2, 8)}`, phone: '237690000099', establishmentId: est, roles });
    for (const role of ['directeur_medical', 'operateur', 'chef_district', 'administrateur_habilite', 'superviseur_pev']) {
      expect((await make(t, [{ role }])).statusCode, role).toBe(403);
    }
    expect((await make(t, [{ role: 'medecin' }], b)).statusCode).toBe(403);
    expect((await make(await e.tok('op-1'), [{ role: 'medecin' }])).statusCode).toBe(403);
    expect(e.directory.users.size).toBe(1); // aucun compte distant créé pour une demande refusée
  });
  it('un jeton qui annonce un rôle ne donne aucun droit : seuls les rôles de la base comptent', async () => {
    const e = await makeOrgEnv();
    const a = await e.establishment('A-1');
    const dir = await e.staff('op-1', 'dir.a', a, [{ role: 'directeur_medical' }]);
    const doc = await e.staff(dir, 'dr.a', a, [{ role: 'medecin' }]);
    const body = { username: 'x.y.z', phone: '237690000098', establishmentId: a, roles: [{ role: 'infirmier' }] };
    // médecin dont le jeton dit « directeur_medical » et « operateur »
    const forged = await e.tok(doc, { realm_access: { roles: ['directeur_medical', 'operateur'] } });
    expect((await e.call('POST', '/v1/admin/staff', forged, body)).statusCode).toBe(403);
    // inconnu de la base, mais jeton « operateur »
    const stranger = await e.tok('inconnu-1', { realm_access: { roles: ['operateur'] } });
    expect((await e.call('POST', '/v1/admin/establishments', stranger, { code: 'Z-1', name: 'Z' })).statusCode).toBe(403);
    expect((await e.call('GET', '/v1/me', stranger)).json()).not.toHaveProperty('staff');
  });
  it('rôles : chef de service sans service, service d\'un autre établissement, rôle inconnu → 400', async () => {
    const e = await makeOrgEnv();
    const a = await e.establishment('A-1'); const b = await e.establishment('B-1');
    const svcB = ((await e.call('POST', `/v1/admin/establishments/${b}/services`, await e.tok('op-1'), { name: 'S' })).json() as { id: string }).id;
    const dir = await e.staff('op-1', 'dir.a', a, [{ role: 'directeur_medical' }]);
    const t = await e.tok(dir);
    const post = (roles: unknown) => e.call('POST', '/v1/admin/staff', t, { username: 'nouveau.u', phone: '237690000097', establishmentId: a, roles });
    expect((await post([{ role: 'chef_service' }])).statusCode).toBe(400);
    expect((await post([{ role: 'medecin', serviceId: svcB }])).statusCode).toBe(400);
    expect((await post([{ role: 'sorcier' }])).statusCode).toBe(400);
    expect((await post([])).statusCode).toBe(400);
  });
  it('entrées invalides : téléphone, nom, champ inconnu → 400', async () => {
    const e = await makeOrgEnv();
    const a = await e.establishment('A-1');
    const op = await e.tok('op-1');
    const base = { username: 'dir.ok', phone: '237690000011', establishmentId: a, roles: [{ role: 'directeur_medical' }] };
    for (const bad of [{ phone: '0690000011' }, { username: 'a' }, { username: 'Espace Interdit' }, { email: 'pas-un-mail' }, { extra: 1 }, { establishmentId: 'x' }]) {
      expect((await e.call('POST', '/v1/admin/staff', op, { ...base, ...bad })).statusCode, JSON.stringify(bad)).toBe(400);
    }
  });
  it('annuaire : conflit → 409 sans fiche locale ; indisponible → 502 sans fiche locale', async () => {
    const e = await makeOrgEnv();
    const a = await e.establishment('A-1');
    const op = await e.tok('op-1');
    const body = { username: 'dir.a', phone: '237690000012', establishmentId: a, roles: [{ role: 'directeur_medical' }] };
    expect((await e.call('POST', '/v1/admin/staff', op, body)).statusCode).toBe(201);
    expect((await e.call('POST', '/v1/admin/staff', op, body)).statusCode).toBe(409);
    e.directory.failNext = 'create';
    expect((await e.call('POST', '/v1/admin/staff', op, { ...body, username: 'dir.b' })).statusCode).toBe(502);
    expect((await e.db.query('SELECT count(*)::int AS n FROM staff_member WHERE sub NOT IN (\'op-1\')')).rows[0]).toMatchObject({ n: 1 });
  });
  it('activation échouée : 502 avec l\'identifiant ; la reprise (activate) aboutit', async () => {
    const e = await makeOrgEnv();
    const a = await e.establishment('A-1');
    e.directory.failNext = 'enable';
    const r = await e.call('POST', '/v1/admin/staff', await e.tok('op-1'), { username: 'dir.a', phone: '237690000013', establishmentId: a, roles: [{ role: 'directeur_medical' }] });
    expect(r.statusCode).toBe(502);
    const [sub] = [...e.directory.users.keys()];
    expect(e.directory.users.get(sub!)!.enabled).toBe(false);
    expect((await e.rt.staff.bySub(sub!))!.status).toBe('active'); // fiche locale présente, compte distant encore inutilisable
    expect((await e.call('POST', `/v1/admin/staff/${sub}/activate`, await e.tok('op-1'))).statusCode).toBe(204);
    expect(e.directory.users.get(sub!)!.enabled).toBe(true);
  });
});

describe('attribution des rôles', () => {
  it('le directeur attribue et retire des rôles de son personnel, jamais à lui-même ni un rôle hors périmètre', async () => {
    const e = await makeOrgEnv();
    const a = await e.establishment('A-1');
    const dir = await e.staff('op-1', 'dir.a', a, [{ role: 'directeur_medical' }]);
    const inf = await e.staff(dir, 'inf.a', a, [{ role: 'infirmier' }]);
    const t = await e.tok(dir);
    const add = await e.call('POST', `/v1/admin/staff/${inf}/roles`, t, { role: 'vaccinateur' });
    expect(add.statusCode).toBe(201);
    expect((await e.call('POST', `/v1/admin/staff/${inf}/roles`, t, { role: 'vaccinateur' })).statusCode).toBe(409); // déjà attribué
    expect((await e.call('POST', `/v1/admin/staff/${inf}/roles`, t, { role: 'directeur_medical' })).statusCode).toBe(403);
    expect((await e.call('POST', `/v1/admin/staff/${dir}/roles`, t, { role: 'medecin' })).statusCode).toBe(403); // pas à soi-même
    expect((await e.rt.staff.bySub(inf))!.roles.map((r) => r.role).sort()).toEqual(['infirmier', 'vaccinateur']);
    const roleId = (add.json() as { id: string }).id;
    expect((await e.call('DELETE', `/v1/admin/staff/${inf}/roles/${roleId}`, t)).statusCode).toBe(204);
    expect((await e.rt.staff.bySub(inf))!.roles.map((r) => r.role)).toEqual(['infirmier']);
    // l'opérateur attribue directeur et chef de district
    expect((await e.call('POST', `/v1/admin/staff/${inf}/roles`, await e.tok('op-1'), { role: 'directeur_medical' })).statusCode).toBe(201);
  });
  it('un directeur n\'agit pas sur un autre établissement', async () => {
    const e = await makeOrgEnv();
    const a = await e.establishment('A-1'); const b = await e.establishment('B-1');
    const dirA = await e.staff('op-1', 'dir.a', a, [{ role: 'directeur_medical' }]);
    const dirB = await e.staff('op-1', 'dir.b', b, [{ role: 'directeur_medical' }]);
    const infB = await e.staff(dirB, 'inf.b', b, [{ role: 'infirmier' }]);
    expect((await e.call('POST', `/v1/admin/staff/${infB}/roles`, await e.tok(dirA), { role: 'medecin' })).statusCode).toBe(403);
    expect((await e.call('POST', `/v1/admin/staff/${infB}/disable`, await e.tok(dirA), { reason: 'test' })).statusCode).toBe(403);
  });
});

describe('désactivation immédiate (T-ACC-08)', () => {
  it('le jeton encore valide est refusé à la requête suivante ; sessions et appareils révoqués ; annuaire prévenu', async () => {
    const e = await makeOrgEnv();
    const a = await e.establishment('A-1');
    const dir = await e.staff('op-1', 'dir.a', a, [{ role: 'directeur_medical' }]);
    const doc = await e.staff(dir, 'dr.a', a, [{ role: 'medecin' }]);
    const docTok = await e.tok(doc);
    expect((await e.call('GET', '/v1/me', docTok)).statusCode).toBe(200);
    await e.db.query("INSERT INTO auth_professional_device (id, subject, key_hash, status, created_at) VALUES ('11111111-1111-4111-8111-111111111111', $1, 'h', 'active', now())", [doc]);
    const r = await e.call('POST', `/v1/admin/staff/${doc}/disable`, await e.tok(dir), { reason: 'départ de l\'établissement' });
    expect(r.json()).toEqual({ directory: 'ok' });
    const after = await e.call('GET', '/v1/me', docTok);
    expect(after.statusCode).toBe(401);
    expect(after.json()).toEqual({ error: 'account_disabled' });
    expect((await e.db.query("SELECT status FROM auth_professional_device WHERE subject=$1", [doc])).rows[0]).toMatchObject({ status: 'revoked' });
    expect((await e.db.query("SELECT count(*)::int AS n FROM auth_session WHERE subject=$1 AND revoked_at IS NULL", [doc])).rows[0]).toMatchObject({ n: 0 });
    expect(e.directory.users.get(doc)!.enabled).toBe(false);
    // et un nouveau jeton, même valide, reste refusé
    expect((await e.call('GET', '/v1/me', await e.tok(doc, { sid: 'autre-session' }))).statusCode).toBe(401);
  });
  it('l\'annuaire en panne n\'affaiblit pas l\'effet local : réponse « pending », accès refusé quand même', async () => {
    const e = await makeOrgEnv();
    const a = await e.establishment('A-1');
    const dir = await e.staff('op-1', 'dir.a', a, [{ role: 'directeur_medical' }]);
    const doc = await e.staff(dir, 'dr.a', a, [{ role: 'medecin' }]);
    e.directory.failNext = 'enable';
    const r = await e.call('POST', `/v1/admin/staff/${doc}/disable`, await e.tok(dir), { reason: 'test' });
    expect(r.json()).toEqual({ directory: 'pending' });
    expect((await e.call('GET', '/v1/me', await e.tok(doc))).statusCode).toBe(401);
  });
  it('double désactivation : 409 ; soi-même, un directeur par un directeur, inconnu : refus', async () => {
    const e = await makeOrgEnv();
    const a = await e.establishment('A-1');
    const d1 = await e.staff('op-1', 'dir.1', a, [{ role: 'directeur_medical' }]);
    const d2 = await e.staff('op-1', 'dir.2', a, [{ role: 'directeur_medical' }]);
    const doc = await e.staff(d1, 'dr.a', a, [{ role: 'medecin' }]);
    const t1 = await e.tok(d1);
    expect((await e.call('POST', `/v1/admin/staff/${d1}/disable`, t1, { reason: 'moi' })).statusCode).toBe(403);
    expect((await e.call('POST', `/v1/admin/staff/${d2}/disable`, t1, { reason: 'pair' })).statusCode).toBe(403);
    expect((await e.call('POST', '/v1/admin/staff/inconnu/disable', t1, { reason: 'x' })).statusCode).toBe(404);
    expect((await e.call('POST', `/v1/admin/staff/${doc}/disable`, t1, { reason: 'ok' })).statusCode).toBe(200);
    expect((await e.call('POST', `/v1/admin/staff/${doc}/disable`, t1, { reason: 'encore' })).statusCode).toBe(409);
    // l'opérateur désactive un directeur
    expect((await e.call('POST', `/v1/admin/staff/${d2}/disable`, await e.tok('op-1'), { reason: 'fin de mission' })).statusCode).toBe(200);
  });
  it('un compte désactivé ne peut plus rien administrer, même avec son ancien jeton', async () => {
    const e = await makeOrgEnv();
    const a = await e.establishment('A-1');
    const dir = await e.staff('op-1', 'dir.a', a, [{ role: 'directeur_medical' }]);
    const old = await e.tok(dir);
    await e.call('POST', `/v1/admin/staff/${dir}/disable`, await e.tok('op-1'), { reason: 'x' });
    expect((await e.call('POST', '/v1/admin/staff', old, { username: 'nouveau', phone: '237690000020', establishmentId: a, roles: [{ role: 'medecin' }] })).statusCode).toBe(401);
  });
});

describe('opérateur initial', () => {
  it('pose idempotente ; aucune route ne crée d\'opérateur', async () => {
    const e = await makeOrgEnv();
    const { bootstrapOperator } = await import('../../src/org/bootstrap.js');
    await bootstrapOperator(e.db, 'op-1'); await bootstrapOperator(e.db, 'op-1', { habilite: true }); await bootstrapOperator(e.db, 'op-1', { habilite: true });
    expect((await e.rt.staff.bySub('op-1'))!.roles.map((r) => r.role).sort()).toEqual(['administrateur_habilite', 'operateur']);
    const a = await e.establishment('A-1');
    const op = await e.tok('op-1');
    expect((await e.call('POST', '/v1/admin/staff', op, { username: 'op.deux', phone: '237690000021', establishmentId: a, roles: [{ role: 'operateur' }] })).statusCode).toBe(403);
    await expect(bootstrapOperator(e.db, ' ')).rejects.toThrow();
  });
});
