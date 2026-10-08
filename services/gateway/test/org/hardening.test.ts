import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapOperator } from '../../src/org/bootstrap.js';
import { DirectoryError, KeycloakDirectory } from '../../src/org/directory.js';
import { cleanup, makeOrgEnv, type OrgEnv } from './helpers.js';

afterEach(cleanup);
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((ok) => { s.closeAllConnections(); s.close(ok); }))); });
const servers: Server[] = [];

async function world() {
  const e = await makeOrgEnv();
  const est = await e.establishment('A-1');
  const dir = await e.staff('op-1', 'dir.a', est, [{ role: 'directeur_medical' }]);
  return { e, est, dir };
}
const staffBody = (est: string, over: Record<string, unknown> = {}) => ({ username: `u${Math.random().toString(36).slice(2, 9)}`, phone: '237690000041', establishmentId: est, roles: [{ role: 'medecin' }], ...over });

describe('revue L3 · rôles en double, compensation, comptes nationaux', () => {
  it('rôles dupliqués : 400 AVANT toute création distante (aucun compte orphelin, nom réutilisable)', async () => {
    const { e, est, dir } = await world();
    const t = await e.tok(dir);
    const before = e.directory.users.size;
    const body = staffBody(est, { username: 'dr.double', roles: [{ role: 'medecin' }, { role: 'medecin' }] });
    expect((await e.call('POST', '/v1/admin/staff', t, body)).statusCode).toBe(400);
    expect(e.directory.users.size).toBe(before);
    expect((await e.call('POST', '/v1/admin/staff', t, { ...body, roles: [{ role: 'medecin' }] })).statusCode).toBe(201); // le nom n'est pas brûlé
  });
  it('échec d\'écriture de la fiche locale : le compte distant est supprimé ; suppression impossible : événement d\'alerte', async () => {
    const { e, est, dir } = await world();
    await e.db.exec(`CREATE FUNCTION test_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'panne simulée'; END; $$ LANGUAGE plpgsql;
                     CREATE TRIGGER test_fail BEFORE INSERT ON staff_role FOR EACH ROW EXECUTE FUNCTION test_fail();`);
    const t = await e.tok(dir);
    const n = e.directory.users.size;
    expect((await e.call('POST', '/v1/admin/staff', t, staffBody(est))).statusCode).toBe(500);
    expect(e.directory.users.size).toBe(n);
    e.directory.failNext = null;
    const orig = e.directory.deleteUser.bind(e.directory);
    e.directory.deleteUser = async () => { throw new DirectoryError('unavailable'); };
    expect((await e.call('POST', '/v1/admin/staff', t, staffBody(est))).statusCode).toBe(500);
    e.directory.deleteUser = orig;
    expect(e.directory.users.size).toBe(n + 1);
    expect([...e.directory.users.values()].at(-1)!.enabled).toBe(false); // orphelin inutilisable
    expect((await e.db.query("SELECT count(*)::int AS n FROM auth_event WHERE type='staff_orphan_account'")).rows[0]).toMatchObject({ n: 1 });
  });
  it('chef de district créé par l\'API : national, district obligatoire, jamais avec un établissement', async () => {
    const { e, est, dir } = await world();
    const op = await e.tok('op-1');
    const body = { username: 'chef.d1', phone: '237690000042', roles: [{ role: 'chef_district' }] };
    expect((await e.call('POST', '/v1/admin/staff', op, body)).statusCode).toBe(400); // district manquant
    expect((await e.call('POST', '/v1/admin/staff', op, { ...body, district: 'Centre-1', establishmentId: est })).statusCode).toBe(400);
    expect((await e.call('POST', '/v1/admin/staff', op, { ...body, district: 'Centre-1', roles: [{ role: 'chef_district' }, { role: 'medecin' }] })).statusCode).toBe(403); // mélange : l'opérateur ne crée pas de personnel d'établissement
    const ok = await e.call('POST', '/v1/admin/staff', op, { ...body, district: 'Centre-1' });
    expect(ok.statusCode).toBe(201);
    const rec = await e.rt.staff.bySub((ok.json() as { sub: string }).sub);
    expect(rec).toMatchObject({ establishmentId: null, district: 'Centre-1' });
    // le directeur ne le peut pas
    expect((await e.call('POST', '/v1/admin/staff', await e.tok(dir), { ...body, username: 'chef.d2', district: 'X' })).statusCode).toBe(403);
    // district sur un compte d'établissement : refusé
    expect((await e.call('POST', '/v1/admin/staff', await e.tok(dir), staffBody(est, { district: 'X' }))).statusCode).toBe(400);
  });
  it('la base refuse les rôles incohérents, même hors du service', async () => {
    const { e, est, dir } = await world();
    const b = await e.establishment('B-1');
    const svcB = ((await e.call('POST', `/v1/admin/establishments/${b}/services`, await e.tok('op-1'), { name: 'S' })).json() as { id: string }).id;
    const ins = (role: string, sub: string, service: string | null = null) =>
      e.db.query('INSERT INTO staff_role (id, staff_id, role, service_id, granted_by, granted_at) SELECT gen_random_uuid(), id, $1, $3, \'t\', now() FROM staff_member WHERE sub=$2', [role, sub, service]);
    await expect(ins('chef_service', dir)).rejects.toThrow(); // chef de service sans service
    await expect(ins('medecin', dir, svcB)).rejects.toThrow(/autre établissement/);
    await expect(ins('chef_district', dir)).rejects.toThrow(/national/);
    await expect(ins('medecin', 'op-1')).rejects.toThrow(/sans établissement/);
    expect(est).toBeTruthy();
  });
  it('attribution : rôle national à un compte d\'établissement et inversement → 400', async () => {
    const { e, est, dir } = await world();
    const op = await e.tok('op-1');
    const doc = await e.staff(dir, 'dr.a', est, [{ role: 'medecin' }]);
    expect((await e.call('POST', `/v1/admin/staff/${doc}/roles`, op, { role: 'chef_district' })).statusCode).toBe(400);
    expect((await e.call('POST', `/v1/admin/staff/${doc}/roles`, await e.tok(dir), { role: 'infirmier', serviceId: 'pas-un-uuid' })).statusCode).toBe(400);
  });
});

describe('revue L3 · autorisation avant validation, liste des établissements', () => {
  it('un refus ne révèle rien : même 403 pour un service inexistant, un établissement inconnu ou des champs invalides', async () => {
    const { e, est, dir } = await world();
    const sec = await e.staff(dir, 'sec.a', est, [{ role: 'secretaire' }]);
    const t = await e.tok(sec);
    for (const body of [staffBody(est, { roles: [{ role: 'infirmier', serviceId: '11111111-1111-4111-8111-111111111111' }] }), staffBody('11111111-1111-4111-8111-111111111111'), staffBody(est, { phone: 'x' })]) {
      expect((await e.call('POST', '/v1/admin/staff', t, body)).statusCode).toBe(403);
    }
    expect((await e.call('POST', `/v1/admin/establishments/11111111-1111-4111-8111-111111111111/services`, t, { name: 'ok' })).statusCode).toBe(403);
    expect((await e.db.query("SELECT count(*)::int AS n FROM access_denial WHERE actor_sub=$1", [sec])).rows[0]!).toMatchObject({ n: 4 }); // 3 refus de création + 1 refus de service (chaque combinaison est limitée, pas supprimée)
  });
  it('la liste des établissements (et leurs réseaux) est réservée à ceux qui gèrent l\'établissement', async () => {
    const { e, est, dir } = await world();
    const sec = await e.staff(dir, 'sec.a', est, [{ role: 'secretaire' }]);
    const doc = await e.staff(dir, 'dr.a', est, [{ role: 'medecin' }]);
    expect((await e.call('GET', '/v1/admin/establishments', await e.tok(sec))).statusCode).toBe(403);
    expect((await e.call('GET', '/v1/admin/establishments', await e.tok(doc))).statusCode).toBe(403);
    expect((await e.call('GET', '/v1/admin/establishments', await e.tok(dir))).statusCode).toBe(200);
  });
});

describe('revue L3 · journal des refus : limité, borné, purgeable par rétention', () => {
  it('20 refus identiques → 5 lignes ; un autre motif ou une autre fenêtre → de nouvelles lignes', async () => {
    const { e, est, dir } = await world();
    const sec = await e.staff(dir, 'sec.a', est, [{ role: 'secretaire' }]);
    const t = await e.tok(sec);
    for (let i = 0; i < 20; i++) await e.call('POST', '/v1/admin/establishments', t, { code: 'X-1', name: 'x' });
    const count = async () => (await e.db.query<{ n: number }>('SELECT count(*)::int AS n FROM access_denial WHERE actor_sub=$1', [sec])).rows[0]!.n;
    expect(await count()).toBe(5);
    await e.call('POST', `/v1/admin/establishments/${est}/services`, t, { name: 'S' }); // autre action refusée
    expect(await count()).toBe(6);
    e.clock.advance(61);
    await e.call('POST', '/v1/admin/establishments', await e.tok(sec), { code: 'X-1', name: 'x' });
    expect(await count()).toBe(7);
  });
  it('la purge de rétention supprime les lignes anciennes seulement ; toute autre suppression reste refusée', async () => {
    const { e, est, dir } = await world();
    const sec = await e.staff(dir, 'sec.a', est, [{ role: 'secretaire' }]);
    await e.call('POST', '/v1/admin/establishments', await e.tok(sec), { code: 'X-1', name: 'x' });
    await e.db.query("INSERT INTO access_denial (at, actor_kind, action, data, reason) VALUES ('2020-01-01T00:00:00Z','staff','C','summary','vieux')");
    await expect(e.db.query('DELETE FROM access_denial')).rejects.toThrow(/ajout seul/);
    await expect(e.db.query('TRUNCATE access_denial')).rejects.toThrow(/ajout seul/);
    await expect(e.db.query('TRUNCATE admin_action')).rejects.toThrow(/ajout seul/);
    const r = await e.db.query<{ purge_access_denial: string }>("SELECT purge_access_denial('2025-01-01T00:00:00Z')");
    expect(Number(r.rows[0]!.purge_access_denial)).toBe(1);
    expect((await e.db.query('SELECT count(*)::int AS n FROM access_denial')).rows[0]!.n).toBeGreaterThanOrEqual(1);
    await expect(e.db.query('DELETE FROM access_denial')).rejects.toThrow(/ajout seul/); // le drapeau de purge ne persiste pas
  });
});

describe('revue L3 · rattrapage du fournisseur d\'identité', () => {
  it('désactivation avec annuaire en panne : « pending » ; le rattrapage désactive le compte distant et ferme ses sessions', async () => {
    const { e, est, dir } = await world();
    const doc = await e.staff(dir, 'dr.a', est, [{ role: 'medecin' }]);
    e.directory.failNext = 'enable';
    expect((await e.call('POST', `/v1/admin/staff/${doc}/disable`, await e.tok(dir), { reason: 'x' })).json()).toEqual({ directory: 'pending' });
    expect(e.directory.users.get(doc)!.enabled).toBe(true);
    expect((await e.db.query('SELECT directory_sync FROM staff_member WHERE sub=$1', [doc])).rows[0]).toMatchObject({ directory_sync: 'disable' });
    expect((await e.call('POST', '/v1/admin/directory/reconcile', await e.tok(dir))).statusCode).toBe(403);
    expect((await e.call('POST', '/v1/admin/directory/reconcile', await e.tok('op-1'))).json()).toEqual({ done: 1, failed: 0 });
    expect(e.directory.users.get(doc)!.enabled).toBe(false);
    expect(e.directory.logouts).toContain(doc);
    expect((await e.db.query('SELECT directory_sync FROM staff_member WHERE sub=$1', [doc])).rows[0]).toMatchObject({ directory_sync: null });
  });
  it('désactivation normale : compte distant désactivé ET sessions fermées', async () => {
    const { e, est, dir } = await world();
    const doc = await e.staff(dir, 'dr.a', est, [{ role: 'medecin' }]);
    await e.call('POST', `/v1/admin/staff/${doc}/disable`, await e.tok(dir), { reason: 'x' });
    expect(e.directory.logouts).toEqual([doc]);
  });
  it('fermeture des sessions en échec : « pending » et reprise', async () => {
    const { e, est, dir } = await world();
    const doc = await e.staff(dir, 'dr.a', est, [{ role: 'medecin' }]);
    e.directory.failNext = 'logout';
    expect((await e.call('POST', `/v1/admin/staff/${doc}/disable`, await e.tok(dir), { reason: 'x' })).json()).toEqual({ directory: 'pending' });
    expect(await e.rt.org.reconcilePending()).toEqual({ done: 1, failed: 0 });
    expect(e.directory.logouts).toEqual([doc]);
  });
  it('course : désactivation pendant l\'activation d\'un nouveau compte → le compte distant finit désactivé', async () => {
    const { e, est, dir } = await world();
    let fired = false;
    e.directory.beforeSetEnabled = async () => {
      if (fired) return;
      fired = true;
      const sub = [...e.directory.users.keys()].at(-1)!;
      await e.call('POST', `/v1/admin/staff/${sub}/disable`, await e.tok(dir), { reason: 'course' });
    };
    const r = await e.call('POST', '/v1/admin/staff', await e.tok(dir), staffBody(est));
    expect(r.statusCode).toBe(201);
    const sub = (r.json() as { sub: string }).sub;
    expect((await e.rt.staff.bySub(sub))!.status).toBe('disabled');
    expect(e.directory.users.get(sub)!.enabled).toBe(false); // jamais « activé » durablement
  });
  it('activation en échec à la création : fiche marquée, rattrapage active le compte', async () => {
    const { e, est, dir } = await world();
    e.directory.failNext = 'enable';
    expect((await e.call('POST', '/v1/admin/staff', await e.tok(dir), staffBody(est))).statusCode).toBe(502);
    const sub = [...e.directory.users.keys()].at(-1)!;
    expect(e.directory.users.get(sub)!.enabled).toBe(false);
    await e.rt.org.reconcilePending();
    expect(e.directory.users.get(sub)!.enabled).toBe(true);
  });
});

describe('revue L3 · mot de passe temporaire', () => {
  it('jamais mis en cache ; réinitialisable ; refusé pour un compte désactivé ou hors périmètre', async () => {
    const { e, est, dir } = await world();
    const r = await e.call('POST', '/v1/admin/staff', await e.tok(dir), staffBody(est));
    expect(r.headers['cache-control']).toBe('no-store');
    const sub = (r.json() as { sub: string }).sub;
    const reset = await e.call('POST', `/v1/admin/staff/${sub}/temporary-password`, await e.tok(dir));
    expect(reset.headers['cache-control']).toBe('no-store');
    const { temporaryPassword } = reset.json() as { temporaryPassword: string };
    expect(e.directory.passwords.get(sub)).toBe(temporaryPassword);
    expect((await e.db.query("SELECT action FROM admin_action WHERE action='account.password_reset'")).rows).toHaveLength(1);
    expect(JSON.stringify((await e.db.query('SELECT details FROM admin_action')).rows)).not.toContain(temporaryPassword);
    const b = await e.establishment('B-1');
    const dirB = await e.staff('op-1', 'dir.b', b, [{ role: 'directeur_medical' }]);
    expect((await e.call('POST', `/v1/admin/staff/${sub}/temporary-password`, await e.tok(dirB))).statusCode).toBe(403);
    await e.call('POST', `/v1/admin/staff/${sub}/disable`, await e.tok(dir), { reason: 'x' });
    expect((await e.call('POST', `/v1/admin/staff/${sub}/temporary-password`, await e.tok(dir))).statusCode).toBe(409);
  });
});

describe('revue L3 · liste des contrôles : récents d\'abord, pagination, pas de noyade', () => {
  it('pages de 3, curseur, ordre décroissant, aucune ligne perdue ni répétée ; curseur invalide → 400', async () => {
    const { e } = await world();
    const op = await e.tok('op-1');
    for (let i = 0; i < 7; i++) {
      await e.db.query(
        "INSERT INTO admin_action (id, at, actor_sub, actor_roles, action, review_required) VALUES (gen_random_uuid(), $1, 'dir-x', ARRAY['directeur_medical'], 'patient.merge', true)",
        [new Date(Date.UTC(2026, 9, 1, 10, i)).toISOString()]);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const r = await e.call('GET', `/v1/admin/reviews?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, op);
      const j = r.json() as { items: Array<{ id: string; at: string }>; next: string | null };
      seen.push(...j.items.map((x) => x.at));
      cursor = j.next;
      if (!cursor) break;
    }
    expect(seen.length).toBe(7); // la création du directeur par l'opérateur n'est pas à contrôler
    expect(new Set(seen).size).toBe(7);
    expect([...seen].sort().reverse()).toEqual(seen);
    expect((await e.call('GET', '/v1/admin/reviews?cursor=bidon', op)).statusCode).toBe(400);
    expect((await e.call('GET', '/v1/admin/reviews?limit=1000', op)).statusCode).toBe(400);
  });
  it('les lignes que l\'acteur ne peut pas contrôler sont sautées sans masquer les suivantes', async () => {
    const { e } = await world();
    const op = await e.tok('op-1');
    // 6 actions d'un district couvert par un chef de district (l'opérateur n'en est pas le contrôleur) puis 1 sans district
    const chief = await e.call('POST', '/v1/admin/staff', op, { username: 'chef.z', phone: '237690000043', district: 'Z-1', roles: [{ role: 'chef_district' }] });
    expect(chief.statusCode).toBe(201);
    for (let i = 0; i < 6; i++) await e.db.query("INSERT INTO admin_action (id, at, actor_sub, actor_roles, action, district, review_required) VALUES (gen_random_uuid(), $1, 'dir-z', ARRAY['directeur_medical'], 'patient.merge', 'Z-1', true)", [new Date(Date.UTC(2026, 9, 2, 10, i)).toISOString()]);
    await e.db.query("INSERT INTO admin_action (id, at, actor_sub, actor_roles, action, review_required) VALUES (gen_random_uuid(), '2026-09-01T00:00:00Z', 'dir-y', ARRAY['directeur_medical'], 'patient.merge', true)");
    const r = (await e.call('GET', '/v1/admin/reviews?limit=2', op)).json() as { items: unknown[] };
    expect(r.items).toHaveLength(1); // seule l'action du directeur sans district remonte, malgré 6 lignes plus récentes non contrôlables
  });
});

describe('revue L3 · réseaux : préfixe minimal', () => {
  it('deux moitiés d\'Internet refusées ; plage d\'établissement acceptée ; IPv6 aussi', async () => {
    const { e, est } = await world();
    const op = await e.tok('op-1');
    const put = (nets: string[]) => e.call('PUT', `/v1/admin/establishments/${est}/networks`, op, { allowedNetworks: nets });
    expect((await put(['0.0.0.0/1', '128.0.0.0/1'])).statusCode).toBe(400);
    expect((await put(['10.0.0.0/7'])).statusCode).toBe(400);
    expect((await put(['::/8'])).statusCode).toBe(400);
    expect((await put(['10.0.0.0/8', '2001:db8::/32'])).statusCode).toBe(204);
  });
});

describe('revue L3 · opérateur initial', () => {
  it('un compte désactivé n\'est réactivé que par --reactivate', async () => {
    const { e } = await world();
    await e.db.query("UPDATE staff_member SET status='disabled' WHERE sub='op-1'");
    await expect(bootstrapOperator(e.db, 'op-1')).rejects.toThrow(/reactivate/);
    expect((await e.rt.staff.bySub('op-1'))!.status).toBe('disabled');
    await bootstrapOperator(e.db, 'op-1', { reactivate: true });
    expect((await e.rt.staff.bySub('op-1'))!.status).toBe('active');
  });
});

describe('revue L3 · adaptateur Keycloak', () => {
  async function fake(handler: (req: { method: string; url: string; auth?: string }) => { status: number; json?: unknown; headers?: Record<string, string> }) {
    const seen: Array<{ method: string; url: string; auth?: string }> = [];
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const r = { method: req.method!, url: req.url!, auth: req.headers.authorization };
        seen.push(r);
        const out = handler(r);
        res.writeHead(out.status, { 'content-type': 'application/json', ...out.headers });
        res.end(out.json === undefined ? '' : JSON.stringify(out.json));
      });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    servers.push(server);
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
  }
  it('401 : jeton invalidé et appel rejoué une fois avec un jeton neuf', async () => {
    let n = 0;
    const f = await fake((r) => r.url.endsWith('/token') ? { status: 200, json: { access_token: `tok-${++n}`, expires_in: 300 } }
      : r.auth === 'Bearer tok-1' ? { status: 401 } : { status: 204 });
    await new KeycloakDirectory(f.url, 'syfa', 'c', 's').logout('u1234567');
    expect(f.seen.filter((s) => s.url.endsWith('/token'))).toHaveLength(2);
    expect(f.seen.at(-1)!.auth).toBe('Bearer tok-2');
  });
  it('appels concurrents : un seul échange de jeton', async () => {
    const f = await fake((r) => r.url.endsWith('/token') ? { status: 200, json: { access_token: 'tok', expires_in: 300 } } : { status: 204 });
    const d = new KeycloakDirectory(f.url, 'syfa', 'c', 's');
    await Promise.all([d.logout('u1234567'), d.logout('u2345678'), d.logout('u3456789'), d.deleteUser('u4567890')]);
    expect(f.seen.filter((s) => s.url.endsWith('/token'))).toHaveLength(1);
  });
  it('redirection non suivie ; identifiant inattendu jamais placé dans un chemin', async () => {
    const f = await fake((r) => r.url.endsWith('/token') ? { status: 200, json: { access_token: 'tok', expires_in: 300 } } : { status: 302, headers: { location: 'http://169.254.169.254/' } });
    const d = new KeycloakDirectory(f.url, 'syfa', 'c', 's');
    await expect(d.logout('u1234567')).rejects.toBeInstanceOf(DirectoryError);
    const n = f.seen.length;
    for (const bad of ['../../admin', 'a/b', 'x', 'u1234567?x=1', '']) await expect(d.logout(bad)).rejects.toBeInstanceOf(DirectoryError);
    expect(f.seen.length).toBe(n); // aucun appel émis pour un identifiant invalide
  });
  it('suppression : 404 toléré (déjà supprimé) ; réinitialisation du mot de passe temporaire', async () => {
    const f = await fake((r) => r.url.endsWith('/token') ? { status: 200, json: { access_token: 'tok', expires_in: 300 } } : r.method === 'DELETE' ? { status: 404 } : { status: 204 });
    const d = new KeycloakDirectory(f.url, 'syfa', 'c', 's');
    await d.deleteUser('u1234567');
    await d.setTemporaryPassword('u1234567', 'Tmp-Pass');
    expect(f.seen.at(-1)).toMatchObject({ method: 'PUT', url: '/admin/realms/syfa/users/u1234567/reset-password' });
  });
});

export type { OrgEnv };

describe('revue L3 (2e passe) · majeur C : plages IPv6 « mappées IPv4 »', () => {
  it('toute plage IPv6 qui contient ::ffff:0:0/96 (donc tout l\'IPv4) est refusée, sous toutes ses écritures', async () => {
    const { validateNetworks } = await import('../../src/org/service.js');
    for (const bad of ['::ffff:0:0/96', '::ffff:0.0.0.0/96', '0:0:0:0:0:ffff::/96', '0:0:0:0:0:ffff:0:0/96', '::ffff:0:0/95', '::ffff:0:0/64', '::/32', '::/40', '0::/32', '0:0:0:0:0:fffe::/80', '::ffff:0.0.0.0/100', '::ffff:0.0.0.0/103']) {
      expect(() => validateNetworks([bad]), bad).toThrow();
    }
  });
  it('plages IPv6 ordinaires et plages mappées assez étroites : acceptées, et le filtre se comporte comme annoncé', async () => {
    const { validateNetworks } = await import('../../src/org/service.js');
    const { NetworkPolicy } = await import('../../src/auth/network.js');
    expect(validateNetworks(['2001:db8::/32', '2001:db8:1::/48', '::ffff:10.0.0.0/104', '::ffff:192.168.0.0/112'])).toHaveLength(4);
    const p = new NetworkPolicy(['::ffff:10.0.0.0/104']);
    expect(p.allows('10.1.2.3')).toBe(true);
    expect(p.allows('11.0.0.1')).toBe(false);
    expect(p.allows('8.8.8.8')).toBe(false);
  });
  it('par l\'API : refus 400, liste inchangée', async () => {
    const { e, est } = await world();
    const op = await e.tok('op-1');
    expect((await e.call('PUT', `/v1/admin/establishments/${est}/networks`, op, { allowedNetworks: ['::ffff:0:0/96'] })).statusCode).toBe(400);
    expect((await e.call('PUT', `/v1/admin/establishments/${est}/networks`, op, { allowedNetworks: ['10.0.0.0/8', '::ffff:0:0/95'] })).statusCode).toBe(400);
    expect((await e.db.query('SELECT allowed_networks FROM establishment WHERE id=$1', [est])).rows[0]).toMatchObject({ allowed_networks: [] });
    expect((await e.call('POST', '/v1/admin/establishments', op, { code: 'N-1', name: 'n', allowedNetworks: ['::ffff:0:0/96'] })).statusCode).toBe(400);
  });
});

describe('revue L3 (2e passe) · majeur B : rôles et rattachements ne se transforment pas après coup', () => {
  it('UPDATE d\'un rôle (role, service, compte) refusé : un directeur ne devient pas opérateur', async () => {
    const { e, dir } = await world();
    await expect(e.db.query("UPDATE staff_role SET role='operateur' WHERE staff_id=(SELECT id FROM staff_member WHERE sub=$1)", [dir])).rejects.toThrow(/seule la révocation/);
    await expect(e.db.query("UPDATE staff_role SET staff_id=(SELECT id FROM staff_member WHERE sub='op-1') WHERE staff_id=(SELECT id FROM staff_member WHERE sub=$1)", [dir])).rejects.toThrow(/seule la révocation/);
    await expect(e.db.query("UPDATE staff_role SET granted_by='x'")).rejects.toThrow(/seule la révocation/);
    await expect(e.db.query('DELETE FROM staff_role')).rejects.toThrow(/suppression interdite/);
  });
  it('la révocation reste possible une fois ; un rôle révoqué ne revit pas', async () => {
    const { e, est, dir } = await world();
    const doc = await e.staff(dir, 'dr.a', est, [{ role: 'medecin' }]);
    const rec = await e.rt.staff.bySub(doc);
    expect((await e.call('DELETE', `/v1/admin/staff/${doc}/roles/${rec!.roles[0]!.id}`, await e.tok(dir))).statusCode).toBe(204);
    await expect(e.db.query('UPDATE staff_role SET revoked_at=NULL, revoked_by=NULL WHERE id=$1', [rec!.roles[0]!.id])).rejects.toThrow(/déjà révoqué/);
    await expect(e.db.query("UPDATE staff_role SET revoked_at=now() WHERE id=$1", [rec!.roles[0]!.id])).rejects.toThrow(/déjà révoqué/);
  });
  it('établissement d\'un compte figé tant qu\'il a des rôles actifs ; district figé pour un chef de district', async () => {
    const { e, est, dir } = await world();
    const b = await e.establishment('B-1');
    await expect(e.db.query('UPDATE staff_member SET establishment_id=NULL WHERE sub=$1', [dir])).rejects.toThrow(/figé/);
    await expect(e.db.query('UPDATE staff_member SET establishment_id=$2 WHERE sub=$1', [dir, b])).rejects.toThrow(/figé/);
    await expect(e.db.query("UPDATE staff_member SET establishment_id=(SELECT id FROM establishment WHERE code='A-1') WHERE sub='op-1'")).rejects.toThrow(/figé/);
    const chief = (await e.call('POST', '/v1/admin/staff', await e.tok('op-1'), { username: 'chef.q', phone: '237690000044', district: 'Q-1', roles: [{ role: 'chef_district' }] })).json() as { sub: string };
    await expect(e.db.query("UPDATE staff_member SET district=NULL WHERE sub=$1", [chief.sub])).rejects.toThrow(/district figé/);
    await expect(e.db.query("UPDATE staff_member SET district='Q-2' WHERE sub=$1", [chief.sub])).rejects.toThrow(/district figé/);
    await expect(e.db.query('UPDATE staff_member SET sub=$2 WHERE sub=$1', [dir, 'autre'])).rejects.toThrow(/immuable/);
    await expect(e.db.query('DELETE FROM staff_member')).rejects.toThrow(/suppression interdite/);
    expect(est).toBeTruthy();
  });
  it('le déclencheur « district requis » protège aussi l\'insertion directe d\'un chef de district', async () => {
    const { e } = await world();
    await e.db.query("INSERT INTO staff_member (id, sub, status, created_at, created_by) VALUES (gen_random_uuid(), 'nat-1', 'active', now(), 't')");
    await expect(e.db.query("INSERT INTO staff_role (id, staff_id, role, granted_by, granted_at) SELECT gen_random_uuid(), id, 'chef_district', 't', now() FROM staff_member WHERE sub='nat-1'")).rejects.toThrow(/district requis/);
    await e.db.query("UPDATE staff_member SET district='D-1' WHERE sub='nat-1'");
    await e.db.query("INSERT INTO staff_role (id, staff_id, role, granted_by, granted_at) SELECT gen_random_uuid(), id, 'chef_district', 't', now() FROM staff_member WHERE sub='nat-1'");
  });
  it('les opérations normales (désactivation, réactivation de l\'opérateur, rôles) continuent de fonctionner', async () => {
    const { e, est, dir } = await world();
    const doc = await e.staff(dir, 'dr.a', est, [{ role: 'medecin' }]);
    expect((await e.call('POST', `/v1/admin/staff/${doc}/disable`, await e.tok(dir), { reason: 'x' })).statusCode).toBe(200);
    await e.db.query("UPDATE staff_member SET status='disabled' WHERE sub='op-1'");
    await bootstrapOperator(e.db, 'op-1', { reactivate: true });
    expect((await e.rt.staff.bySub('op-1'))!.status).toBe('active');
  });
});
