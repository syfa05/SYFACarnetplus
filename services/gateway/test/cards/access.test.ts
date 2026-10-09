import { afterEach, describe, expect, it } from 'vitest';
import { enrol } from '../auth/helpers.js';
import { cleanup, makeCardEnv, secretsOf, type CardEnv } from './helpers.js';

afterEach(cleanup);

const noSecrets = (body: unknown, s?: { token: string; code: string }) => {
  const t = typeof body === 'string' ? body : JSON.stringify(body);
  expect(t).not.toMatch(/CS1:/);
  if (s) { expect(t).not.toContain(s.token); expect(t).not.toContain(s.code); }
};
const denied = (e: CardEnv, actor: string) => e.db.query<{ reason: string; data: string }>("SELECT reason, data FROM access_denial WHERE actor_sub=$1 AND action='admin' ORDER BY id", [actor]).then((r) => r.rows);

describe('qui peut émettre, activer, bloquer (onglet 2.3) — par appel direct à l\'API', () => {
  it('émission : agent d\'émission et directeur médical ; secrétaire, médecin, pharmacien, opérateur refusés et journalisés', async () => {
    const e = await makeCardEnv();
    const p = await e.patient();
    const others: Record<string, string> = {};
    for (const role of ['secretaire', 'medecin', 'pharmacien', 'infirmier', 'laboratoire', 'chef_service'] as const) {
      others[role] = await e.staff(e.director, `u.${role}`, e.est, [role === 'chef_service' ? { role, serviceId: ((await e.call('POST', `/v1/admin/establishments/${e.est}/services`, await e.tok(e.director), { name: 'S' })).json() as { id: string }).id } : { role }]);
    }
    for (const [role, sub] of Object.entries(others)) {
      const r = await e.call('POST', '/v1/cards', await e.tok(sub), { patientId: p, type: 'adulte' });
      expect(r.statusCode, role).toBe(403);
      expect(r.json()).toEqual({ error: 'forbidden' });
    }
    expect((await e.call('POST', '/v1/cards', await e.tok('op-1'), { patientId: p, type: 'adulte' })).statusCode).toBe(403); // l'opérateur ne bloque que
    expect((await e.call('POST', '/v1/cards', await e.tok(e.director), { patientId: p, type: 'adulte' })).statusCode).toBe(201);
    expect((await e.call('POST', '/v1/cards', await e.tok(e.agent), { patientId: p, type: 'temporaire' })).statusCode).toBe(201);
    expect((await denied(e, others.secretaire!))[0]).toMatchObject({ data: 'card.issue', reason: 'role_not_permitted' });
    const count = (await e.db.query<{ n: number }>("SELECT count(*)::int AS n FROM card_event WHERE type='issued'")).rows[0]!.n;
    expect(count).toBe(2); // aucune émission cachée par un refus
  });
  it('un patient, un système, un compte sans fiche : aucune émission, aucun blocage par la voie du personnel', async () => {
    const e = await makeCardEnv();
    const p = await e.patient({ telephone: '237677999010' });
    const c = await e.issue(p);
    await e.activateCard(c.id);
    const patientTok = (await enrol(e, '2580', '237677999010')).accessToken;
    for (const t of [patientTok, await e.signSystem(), await e.tok('inconnu-1', { realm_access: { roles: ['agent_emission', 'directeur_medical', 'operateur'] } })]) {
      expect((await e.call('POST', '/v1/cards', t, { patientId: p, type: 'adulte' })).statusCode).toBe(403);
      expect((await e.call('POST', '/v1/cards/activate', t, { scan: 'x' })).statusCode).toBe(403);
      expect((await e.call('POST', `/v1/cards/${c.id}/block`, t, { reason: 'x' })).statusCode).toBe(403);
      expect((await e.call('GET', `/v1/patients/${p}/cards`, t)).statusCode).toBe(403);
      expect((await e.call('POST', '/v1/cards/reserve', t, { type: 'adulte', count: 1 })).statusCode).toBe(403);
    }
    expect(await e.status(c.id)).toBe('active');
  });
  it('blocage : agent, directeur (n\'importe quel centre) et opérateur ; secrétaire et médecin refusés', async () => {
    const e = await makeCardEnv();
    const b = await e.establishment('B-1');
    const agentB = await e.staff('op-1', 'dir.b', b, [{ role: 'directeur_medical' }]);
    const doc = await e.staff(e.director, 'dr.a', e.est, [{ role: 'medecin' }]);
    const sec = await e.staff(e.director, 'sec.a', e.est, [{ role: 'secretaire' }]);
    const mk = async () => { const c = await e.issue(await e.patient()); await e.activateCard(c.id); return c.id; };
    for (const who of [doc, sec]) expect((await e.call('POST', `/v1/cards/${await mk()}/block`, await e.tok(who), { reason: 'x' })).statusCode).toBe(403);
    for (const who of [e.agent, e.director, agentB, 'op-1']) {
      const id = await mk();
      expect((await e.call('POST', `/v1/cards/${id}/block`, await e.tok(who), { reason: 'perdue' })).statusCode, who).toBe(200);
      expect(await e.status(id)).toBe('bloquee');
    }
  });
  it('activation : seulement dans l\'établissement émetteur ; l\'opérateur n\'active pas', async () => {
    const e = await makeCardEnv();
    const b = await e.establishment('B-1');
    const dirB = await e.staff('op-1', 'dir.b', b, [{ role: 'directeur_medical' }]);
    const c = await e.issue(await e.patient());
    const s = await secretsOf(e, c.id);
    expect((await e.call('POST', '/v1/cards/activate', await e.tok(dirB), { scan: s.token })).statusCode).toBe(403);
    expect((await e.call('POST', '/v1/cards/activate', await e.tok('op-1'), { scan: s.token })).statusCode).toBe(403);
    expect(await e.status(c.id)).toBe('emise');
    expect((await e.call('POST', '/v1/cards/activate', await e.tok(e.agent), { scan: s.token })).statusCode).toBe(200);
    expect((await e.call('POST', '/v1/cards/activate', await e.tok(e.agent), { scan: s.token })).statusCode).toBe(409); // déjà active
  });
  it('un agent d\'un autre centre peut émettre pour n\'importe quel patient (n\'importe quel centre participant)', async () => {
    const e = await makeCardEnv();
    const b = await e.establishment('B-1');
    const agentB = await e.staff('op-1', 'dir.b', b, [{ role: 'directeur_medical' }]);
    const r = await e.call('POST', '/v1/cards', await e.tok(agentB), { patientId: await e.patient(), type: 'temporaire' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ establishmentId: b });
  });
});

describe('aucune fuite des secrets de la carte', () => {
  it('ni jeton ni code de secours dans les réponses d\'émission, d\'activation, de blocage, de liste ; journal sans valeur scannée', async () => {
    const e = await makeCardEnv();
    const p = await e.patient();
    const issue = await e.call('POST', '/v1/cards', await e.tok(e.agent), { patientId: p, type: 'adulte' });
    const id = (issue.json() as { id: string }).id;
    const s = await secretsOf(e, id);
    noSecrets(issue.body, s);
    const act = await e.call('POST', '/v1/cards/activate', await e.tok(e.agent), { scan: s.token });
    noSecrets(act.body, s);
    const list = await e.call('GET', `/v1/patients/${p}/cards`, await e.tok(e.agent));
    expect((list.json() as unknown[]).length).toBe(1);
    noSecrets(list.body, s);
    noSecrets((await e.call('POST', `/v1/cards/${id}/block`, await e.tok(e.agent), { reason: 'x' })).body, s);
    noSecrets((await e.call('GET', '/v1/cards/revocations', await e.signSystem())).body, s);
    const all = JSON.stringify((await e.db.query('SELECT * FROM card_event')).rows) + JSON.stringify((await e.db.query('SELECT * FROM access_denial')).rows) + JSON.stringify((await e.db.query('SELECT * FROM auth_event')).rows);
    expect(all).not.toContain(s.token);
    expect(all).not.toContain(s.code);
    // en base : chiffrés, jamais en clair
    const row = JSON.stringify((await e.db.query('SELECT token_enc, code_enc, token_idx, code_idx FROM card')).rows);
    expect(row).not.toContain(s.token);
    expect(row).not.toContain(s.code);
  });
  it('un chiffré copié sur une autre carte ne se déchiffre pas (le jeton est lié à sa ligne)', async () => {
    const e = await makeCardEnv();
    const a = await e.issue(await e.patient());
    const b = await e.issue(await e.patient());
    const ra = (await e.db.query<{ token_enc: string }>('SELECT token_enc FROM card WHERE id=$1', [a.id])).rows[0]!;
    expect(() => e.fieldCrypto.decrypt(ra.token_enc, `card:${b.id}:token`)).toThrow();
  });
});

describe('carte numérique et blocage par le titulaire (application)', () => {
  it('le titulaire voit SA carte active (QR et code) ; sans carte active : 404 ; jamais celle d\'un autre', async () => {
    const e = await makeCardEnv();
    const p = await e.patient({ telephone: '237677999020' });
    const other = await e.patient({ telephone: '237677999021' });
    const token = (await enrol(e, '2580', '237677999020')).accessToken;
    expect((await e.call('GET', '/v1/cards/mine', token)).statusCode).toBe(404);
    const c = await e.issue(p);
    expect((await e.call('GET', '/v1/cards/mine', token)).statusCode).toBe(404); // émise : pas encore active
    await e.activateCard(c.id);
    const oc = await e.issue(other); await e.activateCard(oc.id);
    const r = await e.call('GET', '/v1/cards/mine', token);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const s = await secretsOf(e, c.id);
    expect(r.json()).toMatchObject({ number: c.number, token: s.token });
    expect(JSON.stringify(r.json())).not.toContain((await secretsOf(e, oc.id)).token);
    expect((await e.call('GET', '/v1/cards/mine', await e.tok(e.agent))).statusCode).toBe(403); // le personnel n'a pas de « carte numérique »
  });
});

describe('notifications SMS (principe 6) et validation', () => {
  it('l\'échec du SMS n\'annule pas l\'activation ; il est journalisé sans le message du prestataire', async () => {
    const e = await makeCardEnv();
    const c = await e.issue(await e.patient());
    e.sms.failNext = true;
    expect((await e.activateCard(c.id)).statusCode).toBe(200);
    expect(await e.status(c.id)).toBe('active');
    const ev = (await e.db.query<{ details: Record<string, string> }>("SELECT details FROM card_event WHERE type='notification_failed'")).rows;
    expect(ev).toHaveLength(1);
    expect(JSON.stringify(ev)).not.toContain('Jean Dupont');
    expect(ev[0]!.details.cause).toMatch(/^Error:HTTP_503$/);
  });
  it('patient sans téléphone : pas de SMS, événement « notification_skipped »', async () => {
    const e = await makeCardEnv();
    const p = await e.addPatient({ telephone: undefined as never });
    const c = await e.issue(p);
    const before = e.sms.sent.length;
    expect((await e.activateCard(c.id)).statusCode).toBe(200);
    expect(e.sms.sent.length).toBe(before);
    expect((await e.db.query("SELECT count(*)::int AS n FROM card_event WHERE type='notification_skipped'")).rows[0]).toMatchObject({ n: 1 });
  });
  it('SMS d\'activation et de blocage : neutres, sans lien, sans établissement, bilingues', async () => {
    const e = await makeCardEnv();
    for (const [langue, expectAct, expectBlk] of [['fr', /carte santé est maintenant active/, /carte santé a été bloquée/], ['en', /health card is now active/, /health card has been blocked/]] as const) {
      const p = await e.patient({ langue });
      const phone = ((await e.identity.resolve(p))!).telephone!;
      const c = await e.issue(p);
      await e.activateCard(c.id);
      await e.call('POST', `/v1/cards/${c.id}/block`, await e.tok(e.agent), { reason: 'x' });
      const mine = e.sms.sent.filter((s) => s.to === phone).map((s) => s.text);
      expect(mine[0]).toMatch(expectAct);
      expect(mine[1]).toMatch(expectBlk);
      for (const t of mine) { expect(t).not.toMatch(/https?:|www\.|\//); expect(t).not.toMatch(/Hôpital|A-1|CS-20|CS1/); }
    }
  });
  it('entrées invalides : type, identifiant, champ inconnu → 400 ; patient inconnu → 404 ; raison vide → 400', async () => {
    const e = await makeCardEnv();
    const t = await e.tok(e.agent);
    const p = await e.patient();
    for (const bad of [{ patientId: p, type: 'platine' }, { patientId: 'x', type: 'adulte' }, { patientId: p, type: 'adulte', extra: 1 }, { type: 'adulte' }, {}]) {
      expect((await e.call('POST', '/v1/cards', t, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await e.call('POST', '/v1/cards', t, { patientId: '11111111-1111-4111-8111-111111111111', type: 'adulte' })).statusCode).toBe(404);
    const c = await e.issue(p);
    await e.activateCard(c.id);
    expect((await e.call('POST', `/v1/cards/${c.id}/block`, t, { reason: '' })).statusCode).toBe(400);
    expect((await e.call('POST', '/v1/cards/pas-un-uuid/block', t, { reason: 'x' })).statusCode).toBe(404);
    expect((await e.call('POST', `/v1/cards/${c.id}/block`, t, { reason: 'x', autre: 1 })).statusCode).toBe(400);
  });
  it('un dossier fusionné : la carte est attribuée au dossier conservé', async () => {
    const e = await makeCardEnv();
    const keep = await e.patient();
    const lose = await e.addPatient({ nom: 'AutreNom', telephone: '237677999030' });
    await e.identity.merge(keep, lose, 'test', 'doublon');
    const c = await e.issue(lose);
    expect((await e.db.query<{ patient_id: string }>('SELECT patient_id FROM card WHERE id=$1', [c.id])).rows[0]!.patient_id).toBe(keep);
  });
  it('révocation par un autre lot (décès, autonomie) : toutes les cartes non révoquées, dans la liste', async () => {
    const e = await makeCardEnv();
    const p = await e.patient();
    const a = await e.issue(p); await e.activateCard(a.id);
    const b = await e.issue(p);
    expect(await e.rt.cards.revokeForPatient(p, 'deces', { sub: null, kind: 'system', establishmentId: null })).toBe(2);
    expect([await e.status(a.id), await e.status(b.id)]).toEqual(['revoquee', 'revoquee']);
    expect((await e.rt.cards.revocations(0)).entries).toHaveLength(2);
    expect(await e.rt.cards.revokeForPatient(p, 'deces', { sub: null, kind: 'system', establishmentId: null })).toBe(0);
  });
});
