import { afterEach, describe, expect, it } from 'vitest';
import { formatCode, parseCode } from '../../src/cards/codes.js';
import { cleanup, makeCardEnv, secretsOf, type CardEnv } from './helpers.js';

afterEach(cleanup);

const DEVICE_KEY = 'd'.repeat(43);
const ctx = (e: CardEnv) => ({ sub: 'u-test', kind: 'staff' as const, establishmentId: e.est });

/** Smartphone d'émission : l'agent enrôle son appareil (L2) puis appelle avec la clé d'appareil. */
async function phoneOf(e: CardEnv, sub = e.agent) {
  const over = { azp: 'syfa-android-pro', sid: `ph-${sub}`, phone_number: '237677000555' };
  const t = await e.tok(sub, over);
  const reg = await e.post('/v1/auth/devices', { deviceKey: DEVICE_KEY, label: 'Téléphone d\'émission' }, { authorization: `Bearer ${t}` });
  expect(reg.statusCode).toBe(201);
  const deviceId = (reg.json() as { id: string }).id;
  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    e.call(method, url, t, payload, { 'x-device-key': DEVICE_KEY });
  return { t, deviceId, call };
}

describe('réserves de codes pour l\'émission hors ligne (onglet 5.2, 5.3)', () => {
  it('l\'appareil reçoit des cartes pré-attribuées (identifiants, numéros, codes valides) ; elles n\'ouvrent rien', async () => {
    const e = await makeCardEnv();
    const ph = await phoneOf(e);
    const r = await ph.call('POST', '/v1/cards/reserve', { type: 'temporaire', count: 5 });
    expect(r.statusCode).toBe(201);
    expect(r.headers['cache-control']).toBe('no-store');
    const cards = r.json() as Array<{ id: string; number: string; type: string; token: string; code: string }>;
    expect(cards).toHaveLength(5);
    expect(new Set(cards.map((c) => c.number)).size).toBe(5);
    for (const c of cards) {
      expect(c.number).toMatch(/^CT-2026-\d{7}$/);
      expect(c.token).toMatch(/^CS1:[A-Z2-7]{26}$/);
      expect(parseCode(c.code)).not.toBeNull();
      expect(await e.status(c.id)).toBe('reservee');
      expect(await e.rt.cards.resolve(c.token, ctx(e))).toEqual({ ok: false, reason: 'not_activated' });
      expect(await e.rt.cards.resolve(c.code, ctx(e))).toEqual({ ok: false, reason: 'not_activated' });
      const s = await secretsOf(e, c.id);
      expect([s.token, formatCode(s.code)]).toEqual([c.token, c.code]);
    }
  });
  it('conditions : droit d\'émission, appareil enregistré, plafond paramétré, type valide', async () => {
    const e = await makeCardEnv();
    const sec = await e.staff(e.director, 'sec.a', e.est, [{ role: 'secretaire' }]);
    expect((await e.call('POST', '/v1/cards/reserve', await e.tok(sec), { type: 'adulte', count: 1 })).statusCode).toBe(403);
    expect((await e.call('POST', '/v1/cards/reserve', await e.tok(e.agent), { type: 'adulte', count: 1 })).statusCode).toBe(409); // poste partagé : pas d'appareil
    const ph = await phoneOf(e);
    expect((await ph.call('POST', '/v1/cards/reserve', { type: 'adulte', count: 21 })).statusCode).toBe(400); // plus que le plafond d'une demande
    expect((await ph.call('POST', '/v1/cards/reserve', { type: 'adulte', count: 0 })).statusCode).toBe(400);
    expect((await ph.call('POST', '/v1/cards/reserve', { type: 'autre', count: 1 })).statusCode).toBe(400);
    expect((await ph.call('POST', '/v1/cards/reserve', { type: 'adulte', count: 15 })).statusCode).toBe(201);
    expect((await ph.call('POST', '/v1/cards/reserve', { type: 'adulte', count: 6 })).statusCode).toBe(409); // 15 + 6 > 20
    expect((await ph.call('POST', '/v1/cards/reserve', { type: 'adulte', count: 5 })).statusCode).toBe(201);
  });
  it('rattachement à la synchronisation avec scan de contrôle hors ligne : carte ACTIVE ; l\'ancienne est révoquée ; SMS neutre', async () => {
    const e = await makeCardEnv();
    const p = await e.patient({ telephone: '237677888001' });
    const old = await e.issue(p);
    await e.activateCard(old.id);
    const ph = await phoneOf(e);
    const [card] = (await ph.call('POST', '/v1/cards/reserve', { type: 'temporaire', count: 1 })).json() as Array<{ id: string; token: string }>;
    const issuedAt = new Date(e.clock.now.getTime() - 3 * 3600_000).toISOString();
    const scanAt = new Date(e.clock.now.getTime() - 3 * 3600_000 + 60_000).toISOString();
    const r = await ph.call('POST', '/v1/cards/reserve/bind', { cardId: card!.id, patientId: p, issuedAt, controlScanAt: scanAt });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: card!.id, status: 'active', type: 'temporaire' });
    expect(await e.status(old.id)).toBe('revoquee');
    expect(await e.rt.cards.resolve(card!.token, ctx(e))).toMatchObject({ ok: true, patientId: p });
    expect((await e.db.query<{ activated_at: Date }>('SELECT activated_at FROM card WHERE id=$1', [card!.id])).rows[0]!.activated_at.toISOString()).toBe(scanAt);
    expect(e.sms.sent.filter((s) => s.to === '237677888001').at(-1)!.text).toMatch(/active/);
    expect((await e.db.query("SELECT count(*)::int AS n FROM card_event WHERE type='issued' AND (details->>'horsLigne')='true'")).rows[0]).toMatchObject({ n: 1 });
  });
  it('sans scan de contrôle déclaré : carte « émise » (à activer par un scan en ligne) ; délai compté depuis l\'émission hors ligne', async () => {
    const e = await makeCardEnv();
    const p = await e.patient();
    const ph = await phoneOf(e);
    const [card] = (await ph.call('POST', '/v1/cards/reserve', { type: 'adulte', count: 1 })).json() as Array<{ id: string; token: string }>;
    const issuedAt = new Date(e.clock.now.getTime() - 86400_000).toISOString();
    const r = await ph.call('POST', '/v1/cards/reserve/bind', { cardId: card!.id, patientId: p, issuedAt });
    expect(r.json()).toMatchObject({ status: 'emise' });
    expect(await e.rt.cards.resolve(card!.token, ctx(e))).toEqual({ ok: false, reason: 'not_activated' });
    expect((r.json() as { activationDeadline: string }).activationDeadline).toBe(new Date(new Date(issuedAt).getTime() + 90 * 86400_000).toISOString());
    expect((await e.activateCard(card!.id)).statusCode).toBe(200);
  });
  it('idempotent (reprise de synchronisation) ; autre patient → 409 ; heure future ou scan avant l\'émission → 400', async () => {
    const e = await makeCardEnv();
    const [p, q] = [await e.patient(), await e.patient()];
    const ph = await phoneOf(e);
    const [card] = (await ph.call('POST', '/v1/cards/reserve', { type: 'adulte', count: 1 })).json() as Array<{ id: string }>;
    const issuedAt = new Date(e.clock.now.getTime() - 600_000).toISOString();
    const body = { cardId: card!.id, patientId: p, issuedAt, controlScanAt: issuedAt };
    expect((await ph.call('POST', '/v1/cards/reserve/bind', body)).statusCode).toBe(200);
    const again = await ph.call('POST', '/v1/cards/reserve/bind', body);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id: card!.id, status: 'active' });
    expect((await ph.call('POST', '/v1/cards/reserve/bind', { ...body, patientId: q })).statusCode).toBe(409);
    const [c2] = (await ph.call('POST', '/v1/cards/reserve', { type: 'adulte', count: 1 })).json() as Array<{ id: string }>;
    const future = new Date(e.clock.now.getTime() + 3600_000).toISOString();
    expect((await ph.call('POST', '/v1/cards/reserve/bind', { cardId: c2!.id, patientId: q, issuedAt: future })).statusCode).toBe(400);
    expect((await ph.call('POST', '/v1/cards/reserve/bind', { cardId: c2!.id, patientId: q, issuedAt, controlScanAt: new Date(new Date(issuedAt).getTime() - 1000).toISOString() })).statusCode).toBe(400);
    expect((await ph.call('POST', '/v1/cards/reserve/bind', { cardId: c2!.id, patientId: q, issuedAt: 'hier' })).statusCode).toBe(400);
  });
  it('une carte de réserve ne se rattache que depuis SON appareil et SON établissement', async () => {
    const e = await makeCardEnv();
    const p = await e.patient();
    const ph = await phoneOf(e);
    const [card] = (await ph.call('POST', '/v1/cards/reserve', { type: 'adulte', count: 1 })).json() as Array<{ id: string }>;
    const agent2 = await e.staff(e.director, 'agent.b', e.est, [{ role: 'agent_emission' }]);
    const t2 = await e.tok(agent2, { azp: 'syfa-android-pro', sid: 'ph-b', phone_number: '237677000556' });
    await e.post('/v1/auth/devices', { deviceKey: 'e'.repeat(43) }, { authorization: `Bearer ${t2}` });
    const body = { cardId: card!.id, patientId: p, issuedAt: new Date(e.clock.now.getTime() - 1000).toISOString() };
    expect((await e.call('POST', '/v1/cards/reserve/bind', t2, body, { 'x-device-key': 'e'.repeat(43) })).statusCode).toBe(403); // autre appareil
    expect((await e.call('POST', '/v1/cards/reserve/bind', await e.tok(e.agent), body)).statusCode).toBe(409); // poste partagé sans appareil
    expect((await ph.call('POST', '/v1/cards/reserve/bind', body)).statusCode).toBe(200);
  });
});

describe('appareil d\'émission perdu : réserve annulée (onglet 5.6)', () => {
  it('révocation de l\'appareil par son propriétaire : cartes de réserve non utilisées révoquées, dans la liste, journalisées ; cartes déjà rattachées intactes', async () => {
    const e = await makeCardEnv();
    const p = await e.patient();
    const ph = await phoneOf(e);
    const cards = (await ph.call('POST', '/v1/cards/reserve', { type: 'adulte', count: 3 })).json() as Array<{ id: string; token: string }>;
    const issuedAt = new Date(e.clock.now.getTime() - 1000).toISOString();
    await ph.call('POST', '/v1/cards/reserve/bind', { cardId: cards[0]!.id, patientId: p, issuedAt, controlScanAt: issuedAt });
    expect((await ph.call('DELETE', `/v1/auth/devices/${ph.deviceId}`)).statusCode).toBe(204);
    expect(await e.status(cards[0]!.id)).toBe('active'); // déjà attribuée : le patient garde sa carte
    expect(await e.status(cards[1]!.id)).toBe('revoquee');
    expect(await e.status(cards[2]!.id)).toBe('revoquee');
    const list = (await e.rt.cards.revocations(0)).entries;
    expect(list).toHaveLength(2);
    expect((await e.db.query("SELECT count(*)::int AS n FROM card_event WHERE type='reserve_cancelled'")).rows[0]).toMatchObject({ n: 2 });
    expect(await e.rt.cards.resolve(cards[1]!.token, ctx(e))).toEqual({ ok: false, reason: 'revoked' });
  });
  it('après annulation, le rattachement d\'une carte émise hors ligne est refusé et journalisé', async () => {
    const e = await makeCardEnv();
    const p = await e.patient();
    const ph = await phoneOf(e);
    const [card] = (await ph.call('POST', '/v1/cards/reserve', { type: 'adulte', count: 1 })).json() as Array<{ id: string }>;
    await e.db.query("UPDATE auth_professional_device SET status='revoked', revoked_at=now() WHERE id=$1", [ph.deviceId]);
    await expect(e.rt.cards.bindReserved(await e.agentRecord(), ph.deviceId, { cardId: card!.id, patientId: p, issuedAt: new Date(e.clock.now.getTime() - 1000).toISOString() }))
      .rejects.toMatchObject({ code: 'reserve_cancelled', status: 409 });
    expect((await e.db.query("SELECT count(*)::int AS n FROM card_event WHERE type='scan_refused' AND (details->>'motif')='reserve_annulee'")).rows[0]).toMatchObject({ n: 1 });
  });
  it('désactivation du compte de l\'agent (appareils révoqués) : sa réserve est annulée aussi', async () => {
    const e = await makeCardEnv();
    const ph = await phoneOf(e);
    const cards = (await ph.call('POST', '/v1/cards/reserve', { type: 'adulte', count: 2 })).json() as Array<{ id: string }>;
    expect((await e.call('POST', `/v1/admin/staff/${e.agent}/disable`, await e.tok(e.director), { reason: 'départ' })).statusCode).toBe(200);
    for (const c of cards) expect(await e.status(c.id)).toBe('revoquee');
  });
  it('un nouvel appareil n\'hérite pas de la réserve de l\'ancien', async () => {
    const e = await makeCardEnv();
    const ph = await phoneOf(e);
    const [card] = (await ph.call('POST', '/v1/cards/reserve', { type: 'adulte', count: 1 })).json() as Array<{ id: string }>;
    await ph.call('DELETE', `/v1/auth/devices/${ph.deviceId}`);
    const t = await e.tok(e.agent, { azp: 'syfa-android-pro', sid: 'ph-new', phone_number: '237677000555' });
    const reg = await e.post('/v1/auth/devices', { deviceKey: 'n'.repeat(43) }, { authorization: `Bearer ${t}` });
    expect(reg.statusCode).toBe(201);
    const r = await e.call('POST', '/v1/cards/reserve/bind', t, { cardId: card!.id, patientId: await e.patient(), issuedAt: new Date(e.clock.now.getTime() - 1000).toISOString() }, { 'x-device-key': 'n'.repeat(43) });
    expect(r.statusCode).toBe(403);
  });
});
