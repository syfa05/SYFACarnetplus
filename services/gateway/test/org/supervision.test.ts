import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, makeOrgEnv, type OrgEnv } from './helpers.js';

afterEach(cleanup);

/** Opérateur + établissement + directeur ; le directeur crée un médecin (action contrôlée par le niveau supérieur). */
async function setup(district?: string) {
  const e = await makeOrgEnv();
  const est = await e.establishment('A-1', district ? { district } : {});
  const dir = await e.staff('op-1', 'dir.a', est, [{ role: 'directeur_medical' }]);
  await e.staff(dir, 'dr.a', est, [{ role: 'medecin' }]);
  return { e, est, dir };
}
const pending = async (e: OrgEnv, sub: string) => (await e.call('GET', '/v1/admin/reviews', await e.tok(sub))).json() as Array<{ id: string; action: string; actorSub: string }>;
const chiefOf = async (e: OrgEnv, username: string, district: string) => {
  const sub = (await e.call('POST', '/v1/admin/staff', await e.tok('op-1'), { username, phone: '237690000031', establishmentId: await e.establishment(`C-${username.replace(/\W/g, '').toUpperCase()}`), roles: [{ role: 'directeur_medical' }] })).json() as { sub: string };
  await e.call('POST', `/v1/admin/staff/${sub.sub}/roles`, await e.tok('op-1'), { role: 'chef_district' });
  await e.db.query("UPDATE staff_member SET district=$2, establishment_id=NULL WHERE sub=$1", [sub.sub, district]);
  return sub.sub;
};

describe('contrôle des actions du directeur médical par le niveau supérieur', () => {
  it('la création d\'un compte par un directeur est à contrôler ; celle de l\'opérateur ne l\'est pas', async () => {
    const { e, dir } = await setup();
    const rows = (await e.db.query<{ actor_sub: string; action: string; review_required: boolean }>('SELECT actor_sub, action, review_required FROM admin_action WHERE action IN (\'account.create\') ')).rows;
    expect(rows.map((r) => [r.actor_sub, r.review_required]).sort()).toEqual([[dir, true], ['op-1', false]].sort());
  });
  it('sans chef de district : l\'opérateur contrôle ; le directeur ne voit rien et ne peut pas contrôler', async () => {
    const { e, dir } = await setup();
    expect(await pending(e, dir)).toEqual([]);
    const todo = await pending(e, 'op-1');
    expect(todo).toHaveLength(1);
    expect(todo[0]).toMatchObject({ action: 'account.create', actorSub: dir });
    expect((await e.call('POST', `/v1/admin/reviews/${todo[0]!.id}`, await e.tok(dir), { outcome: 'approved' })).statusCode).toBe(403);
    expect((await e.call('POST', `/v1/admin/reviews/${todo[0]!.id}`, await e.tok('op-1'), { outcome: 'approved', comment: 'conforme' })).statusCode).toBe(204);
    expect(await pending(e, 'op-1')).toEqual([]);
    expect((await e.call('POST', `/v1/admin/reviews/${todo[0]!.id}`, await e.tok('op-1'), { outcome: 'contested' })).statusCode).toBe(409); // une seule revue
    expect((await e.db.query('SELECT reviewed_by, review_outcome FROM admin_action WHERE id=$1', [todo[0]!.id])).rows[0]).toMatchObject({ reviewed_by: 'op-1', review_outcome: 'approved' });
  });
  it('avec un chef de district intégré : lui seul contrôle son district, pas l\'opérateur', async () => {
    const { e, dir } = await setup('Centre-1');
    const chief = await chiefOf(e, 'chef.c1', 'Centre-1');
    const other = await chiefOf(e, 'chef.c2', 'Littoral-2');
    expect(await pending(e, 'op-1')).toEqual([]); // l'opérateur n'est plus le niveau supérieur de ce district
    expect(await pending(e, other)).toEqual([]);
    const todo = await pending(e, chief);
    expect(todo.map((x) => x.actorSub)).toContain(dir);
    const id = todo[0]!.id;
    expect((await e.call('POST', `/v1/admin/reviews/${id}`, await e.tok('op-1'), { outcome: 'approved' })).statusCode).toBe(403);
    expect((await e.call('POST', `/v1/admin/reviews/${id}`, await e.tok(other), { outcome: 'approved' })).statusCode).toBe(403);
    expect((await e.call('POST', `/v1/admin/reviews/${id}`, await e.tok(chief), { outcome: 'contested', comment: 'à justifier' })).statusCode).toBe(204);
  });
  it('personne ne contrôle ses propres actions : refus du moteur ET de la base', async () => {
    const { e, dir } = await setup();
    // un compte cumulant directeur et opérateur ne contrôle pas sa propre action
    await e.db.query("INSERT INTO staff_role (id, staff_id, role, granted_by, granted_at) SELECT gen_random_uuid(), id, 'operateur', 'test', now() FROM staff_member WHERE sub=$1", [dir]);
    expect(await pending(e, dir)).toEqual([]);
    const id = (await e.db.query<{ id: string }>('SELECT id FROM admin_action WHERE actor_sub=$1', [dir])).rows[0]!.id;
    expect((await e.call('POST', `/v1/admin/reviews/${id}`, await e.tok(dir), { outcome: 'approved' })).statusCode).toBe(403);
    // même en contournant le service, la base refuse
    await expect(e.db.query("UPDATE admin_action SET reviewed_by=$2, reviewed_at=now(), review_outcome='approved' WHERE id=$1", [id, dir])).rejects.toThrow();
  });
  it('les refus de contrôle sont journalisés', async () => {
    const { e, dir } = await setup();
    const id = (await pending(e, 'op-1'))[0]!.id;
    await e.call('POST', `/v1/admin/reviews/${id}`, await e.tok(dir), { outcome: 'approved' });
    expect((await e.db.query("SELECT reason FROM access_denial WHERE actor_sub=$1 AND data='supervision.review'", [dir])).rows).toHaveLength(1);
  });
  it('entrées invalides : identifiant, résultat → 400 ; inconnu → 404', async () => {
    const { e } = await setup();
    const op = await e.tok('op-1');
    expect((await e.call('POST', '/v1/admin/reviews/pas-un-uuid', op, { outcome: 'approved' })).statusCode).toBe(400);
    expect((await e.call('POST', '/v1/admin/reviews/11111111-1111-4111-8111-111111111111', op, { outcome: 'peut-être' })).statusCode).toBe(400);
    expect((await e.call('POST', '/v1/admin/reviews/11111111-1111-4111-8111-111111111111', op, { outcome: 'approved' })).statusCode).toBe(404);
  });
});

describe('journal des actions d\'administration : ajout seul', () => {
  it('ni suppression, ni modification d\'une action, ni revue répétée ; refus d\'accès en ajout seul', async () => {
    const { e, dir } = await setup();
    const id = (await e.db.query<{ id: string }>('SELECT id FROM admin_action WHERE actor_sub=$1', [dir])).rows[0]!.id;
    await expect(e.db.query('DELETE FROM admin_action WHERE id=$1', [id])).rejects.toThrow(/ajout seul/);
    await expect(e.db.query("UPDATE admin_action SET action='autre' WHERE id=$1", [id])).rejects.toThrow();
    await expect(e.db.query("UPDATE admin_action SET review_required=false WHERE id=$1", [id])).rejects.toThrow();
    await e.call('POST', `/v1/admin/reviews/${id}`, await e.tok('op-1'), { outcome: 'approved' });
    await expect(e.db.query("UPDATE admin_action SET review_outcome='contested' WHERE id=$1", [id])).rejects.toThrow();
    await e.call('POST', '/v1/admin/establishments', await e.tok(dir), { code: 'X', name: 'X' }); // refus → access_denial
    await expect(e.db.query('DELETE FROM access_denial')).rejects.toThrow(/ajout seul/);
    await expect(e.db.query("UPDATE access_denial SET reason='x'")).rejects.toThrow(/ajout seul/);
  });
});
