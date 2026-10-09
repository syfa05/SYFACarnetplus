import { afterEach, describe, expect, it } from 'vitest';
import { generateCode, generateToken, formatCode, tokenSha, codeSha } from '../../src/cards/codes.js';
import { CardService } from '../../src/cards/service.js';
import { cleanup, makeCardEnv, secretsOf, type CardEnv } from './helpers.js';

afterEach(cleanup);

const events = async (e: CardEnv, type?: string) =>
  (await e.db.query<{ type: string; actor_sub: string | null; details: Record<string, unknown>; card_id: string | null }>(
    `SELECT type, actor_sub, details, card_id FROM card_event ${type ? 'WHERE type=$1' : ''} ORDER BY id`, type ? [type] : [])).rows;
const ctx = (e: CardEnv) => ({ sub: 'u-test', kind: 'staff' as const, establishmentId: e.est });

describe('F-CARTE-01 — une carte imprimée n\'ouvre aucun dossier avant son scan de contrôle', () => {
  it('émise : refusée par jeton ET par code de secours ; refus journalisé sans la valeur scannée', async () => {
    const e = await makeCardEnv();
    const p = await e.patient();
    const card = await e.issue(p);
    expect(card.status).toBe('emise');
    const s = await secretsOf(e, card.id);
    expect(await e.rt.cards.resolve(s.token, ctx(e))).toEqual({ ok: false, reason: 'not_activated' });
    expect(await e.rt.cards.resolve(formatCode(s.code), ctx(e))).toEqual({ ok: false, reason: 'not_activated' });
    const ev = await events(e, 'scan_refused');
    expect(ev).toHaveLength(2);
    expect(JSON.stringify(ev)).not.toContain(s.token);
    expect(JSON.stringify(ev)).not.toContain(s.code);
  });
  it('après le scan de contrôle : active, et résolue vers le bon dossier', async () => {
    const e = await makeCardEnv();
    const p = await e.patient();
    const card = await e.issue(p);
    const r = await e.activateCard(card.id);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: card.id, status: 'active' });
    const s = await secretsOf(e, card.id);
    expect(await e.rt.cards.resolve(s.token, ctx(e))).toMatchObject({ ok: true, patientId: p, cardId: card.id });
    expect(await e.rt.cards.resolve(formatCode(s.code).toLowerCase(), ctx(e))).toMatchObject({ ok: true, patientId: p });
  });
  it('le scan de contrôle peut se faire avec le code de secours ; le titulaire reçoit un SMS neutre', async () => {
    const e = await makeCardEnv();
    const p = await e.patient();
    const card = await e.issue(p);
    const s = await secretsOf(e, card.id);
    expect((await e.call('POST', '/v1/cards/activate', await e.tok(e.agent), { scan: formatCode(s.code) })).statusCode).toBe(200);
    const sms = e.sms.sent.at(-1)!;
    expect(sms.text).toMatch(/carte santé/);
    expect(sms.text).not.toMatch(/https?:|www\.|\/|hôpital|clinique|centre|Hôpital|A-1|Yaound/i);
  });
  it('valeurs inconnues ou illisibles : refus (le format est contrôlé avant toute recherche)', async () => {
    const e = await makeCardEnv();
    expect(await e.rt.cards.resolve(generateToken(), ctx(e))).toEqual({ ok: false, reason: 'unknown' });
    expect(await e.rt.cards.resolve('K7X-4M2-9PQ', ctx(e))).toEqual({ ok: false, reason: 'invalid_format' });
    expect(await e.rt.cards.resolve(undefined, ctx(e))).toEqual({ ok: false, reason: 'invalid_format' });
    expect((await e.call('POST', '/v1/cards/activate', await e.tok(e.agent), { scan: 'pas-une-carte' })).statusCode).toBe(400);
    expect((await e.call('POST', '/v1/cards/activate', await e.tok(e.agent), { scan: generateToken() })).statusCode).toBe(404);
  });
  it('un dossier non actif (provisoire, décédé) ne reçoit pas de carte et une carte déjà émise ne l\'identifie plus', async () => {
    const e = await makeCardEnv();
    const p = await e.patient();
    const card = await e.issue(p);
    await e.activateCard(card.id);
    await e.db.query("UPDATE patient SET statut_dossier='decede' WHERE id=$1", [p]);
    const s = await secretsOf(e, card.id);
    expect(await e.rt.cards.resolve(s.token, ctx(e))).toEqual({ ok: false, reason: 'patient_not_active' });
    expect((await e.call('POST', '/v1/cards', await e.tok(e.agent), { patientId: p, type: 'adulte' })).statusCode).toBe(409);
  });
});

describe('F-CARTE-02 — une carte bloquée est refusée en ligne immédiatement, hors ligne dès la synchronisation, et la tentative est journalisée', () => {
  it('blocage par l\'agent : refus immédiat en ligne (jeton et code), tentative journalisée, historique intact', async () => {
    const e = await makeCardEnv();
    const p = await e.patient();
    const card = await e.issue(p);
    await e.activateCard(card.id);
    const s = await secretsOf(e, card.id);
    expect(await e.rt.cards.resolve(s.token, ctx(e))).toMatchObject({ ok: true });
    const r = await e.call('POST', `/v1/cards/${card.id}/block`, await e.tok(e.agent), { reason: 'perdue' });
    expect(r.statusCode).toBe(200);
    expect(await e.rt.cards.resolve(s.token, ctx(e))).toEqual({ ok: false, reason: 'blocked' });
    expect(await e.rt.cards.resolve(formatCode(s.code), ctx(e))).toEqual({ ok: false, reason: 'blocked' });
    const refused = (await events(e, 'scan_refused')).filter((x) => x.details.motif === 'blocked');
    expect(refused).toHaveLength(2);
    expect(refused[0]!.card_id).toBe(card.id);
    expect((await events(e, 'blocked'))).toHaveLength(1);
    expect(await e.identity.resolve(p)).not.toBeNull(); // le dossier n'est pas affecté
  });
  it('hors ligne : l\'appareil accepte tant qu\'il n\'a pas synchronisé, refuse dès qu\'il a reçu la liste', async () => {
    const e = await makeCardEnv();
    const p = await e.patient();
    const card = await e.issue(p);
    await e.activateCard(card.id);
    const s = await secretsOf(e, card.id);
    // l'appareil a sa liste locale (vide) à la dernière synchronisation
    const device = new Set<string>();
    let last = 0;
    const sync = async () => {
      const r = await e.call('GET', `/v1/cards/revocations?since=${last}`, await e.signSystem());
      expect(r.statusCode).toBe(200);
      const j = r.json() as { entries: Array<{ seq: number; tokenSha: string; codeSha: string }>; latest: number };
      for (const x of j.entries) { device.add(x.tokenSha); device.add(x.codeSha); }
      last = j.latest;
    };
    await sync();
    const { isScanRevoked } = await import('../../src/cards/codes.js');
    expect(isScanRevoked(device, s.token)).toBe(false);
    await e.call('POST', `/v1/cards/${card.id}/block`, await e.tok(e.agent), { reason: 'volée' });
    expect(isScanRevoked(device, s.token)).toBe(false); // pas encore synchronisé : accepté, les scans sont à journaliser (lot L12)
    await sync();
    expect(isScanRevoked(device, s.token)).toBe(true);
    expect(isScanRevoked(device, formatCode(s.code))).toBe(true);
    expect(isScanRevoked(device, generateToken())).toBe(false);
  });
  it('liste incrémentale : empreintes seulement (aucun jeton ni code), ordre, pagination, reprise', async () => {
    const e = await makeCardEnv();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await e.issue(await e.patient());
      await e.activateCard(c.id);
      await e.call('POST', `/v1/cards/${c.id}/block`, await e.tok(e.agent), { reason: `r${i}` });
      ids.push(c.id);
    }
    const sys = await e.signSystem();
    const p1 = (await e.call('GET', '/v1/cards/revocations?since=0&limit=2', sys)).json() as { entries: Array<{ seq: number; tokenSha: string }>; latest: number; more: boolean };
    expect(p1.entries).toHaveLength(2);
    expect(p1.more).toBe(true);
    const p2 = (await e.call('GET', `/v1/cards/revocations?since=${p1.latest}&limit=10`, sys)).json() as typeof p1;
    expect(p2.entries).toHaveLength(3);
    expect(p2.more).toBe(false);
    expect([...p1.entries, ...p2.entries].map((x) => x.seq)).toEqual([...p1.entries, ...p2.entries].map((x) => x.seq).sort((a, b) => a - b));
    const s0 = await secretsOf(e, ids[0]!);
    expect(p1.entries[0]!.tokenSha).toBe(tokenSha(s0.token));
    expect(JSON.stringify([p1, p2])).not.toContain(s0.token);
    expect(JSON.stringify([p1, p2])).not.toContain(s0.code);
    const none = (await e.call('GET', `/v1/cards/revocations?since=${p2.latest}`, sys)).json() as typeof p1;
    expect(none).toMatchObject({ entries: [], latest: p2.latest, more: false });
    expect(codeSha(s0.code)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('liste : réservée aux clients système et aux appareils enregistrés ; paramètres invalides → 400', async () => {
    const e = await makeCardEnv();
    const p = await e.patient();
    for (const t of [await e.tok(e.agent), await e.tok(e.director), await e.tok('op-1')]) expect((await e.call('GET', '/v1/cards/revocations', t)).statusCode).toBe(403); // poste partagé : pas d'appareil
    expect((await e.call('GET', '/v1/cards/revocations', await e.signSystem())).statusCode).toBe(200);
    expect((await e.call('GET', '/v1/cards/revocations?since=-1', await e.signSystem())).statusCode).toBe(400);
    expect((await e.call('GET', '/v1/cards/revocations?limit=0', await e.signSystem())).statusCode).toBe(400);
    expect(p).toBeTruthy();
  });
  it('blocage par le titulaire (application) : seulement SES cartes ; SMS neutre', async () => {
    const e = await makeCardEnv();
    const p = await e.patient({ telephone: '237677999001' });
    const other = await e.patient({ telephone: '237677999002' });
    const c = await e.issue(p);
    await e.activateCard(c.id);
    const oc = await e.issue(other);
    await e.activateCard(oc.id);
    const { enrol } = await import('../auth/helpers.js');
    const token = (await enrol(e, '2580', '237677999001')).accessToken;
    const r = await e.call('POST', '/v1/cards/mine/block', token);
    expect(r.json()).toEqual({ blocked: 1 });
    expect(await e.status(c.id)).toBe('bloquee');
    expect(await e.status(oc.id)).toBe('active');
    expect(e.sms.sent.filter((s) => s.to === '237677999001').at(-1)!.text).toMatch(/bloquée/);
    expect((await e.call('POST', '/v1/cards/mine/block', token)).statusCode).toBe(404); // plus rien à bloquer
  });
});

describe('une seule carte active par patient ; ancienne carte valable jusqu\'à l\'activation de la nouvelle', () => {
  it('temporaire puis définitive : la temporaire reste valable jusqu\'à l\'activation de la définitive, puis est révoquée', async () => {
    const e = await makeCardEnv();
    const p = await e.patient();
    const temp = await e.issue(p, 'temporaire');
    await e.activateCard(temp.id);
    const final = await e.issue(p, 'adulte');
    expect(await e.status(temp.id)).toBe('active'); // pas de trou : le patient garde une carte valide
    const st = await secretsOf(e, temp.id);
    expect(await e.rt.cards.resolve(st.token, ctx(e))).toMatchObject({ ok: true });
    const fs = await secretsOf(e, final.id);
    expect(await e.rt.cards.resolve(fs.token, ctx(e))).toMatchObject({ ok: false, reason: 'not_activated' });
    await e.activateCard(final.id);
    expect(await e.status(temp.id)).toBe('revoquee');
    expect(await e.status(final.id)).toBe('active');
    expect(await e.rt.cards.resolve(st.token, ctx(e))).toEqual({ ok: false, reason: 'revoked' });
    const act = (await e.db.query<{ n: number }>("SELECT count(*)::int AS n FROM card WHERE patient_id=$1 AND status='active'", [p])).rows[0]!.n;
    expect(act).toBe(1);
    // la révocation de l'ancienne figure dans la liste des révoquées
    expect((await e.rt.cards.revocations(0)).entries.map((x) => x.tokenSha)).toContain(tokenSha(st.token));
  });
  it('réémission avant activation (rebut) : la carte émise mais non activée est révoquée aussitôt, l\'active reste valable', async () => {
    const e = await makeCardEnv();
    const p = await e.patient();
    const c1 = await e.issue(p);
    await e.activateCard(c1.id);
    const c2 = await e.issue(p);
    const c3 = await e.issue(p); // c2 mal imprimée
    expect(await e.status(c1.id)).toBe('active');
    expect(await e.status(c2.id)).toBe('revoquee');
    expect(await e.status(c3.id)).toBe('emise');
    expect((await e.activateCard(c2.id)).statusCode).toBe(409); // carte révoquée
    expect((await e.activateCard(c3.id)).statusCode).toBe(200);
    expect(await e.status(c1.id)).toBe('revoquee');
  });
  it('perte (P9) : carte bloquée, carte temporaire immédiate, définitive ensuite ; la bloquée reste bloquée', async () => {
    const e = await makeCardEnv();
    const p = await e.patient();
    const c1 = await e.issue(p);
    await e.activateCard(c1.id);
    await e.call('POST', `/v1/cards/${c1.id}/block`, await e.tok(e.agent), { reason: 'perdue' });
    const temp = await e.issue(p, 'temporaire');
    await e.activateCard(temp.id);
    const fin = await e.issue(p);
    await e.activateCard(fin.id);
    expect(await e.status(c1.id)).toBe('bloquee');
    expect(await e.status(temp.id)).toBe('revoquee');
    expect(await e.status(fin.id)).toBe('active');
    expect((await e.call('POST', `/v1/cards/${c1.id}/block`, await e.tok(e.agent), { reason: 'encore' })).statusCode).toBe(409);
  });
  it('la base refuse deux cartes actives, la suppression, la modification des identifiants et les transitions interdites', async () => {
    const e = await makeCardEnv();
    const p = await e.patient();
    const c1 = await e.issue(p); await e.activateCard(c1.id);
    const c2 = await e.issue(p);
    await expect(e.db.query("UPDATE card SET status='active' WHERE id=$1", [c2.id])).rejects.toThrow(/card_one_active|unique|duplicate/i);
    await expect(e.db.query('DELETE FROM card')).rejects.toThrow(/suppression interdite/);
    await expect(e.db.query("UPDATE card SET number='CS-1999-0000001' WHERE id=$1", [c1.id])).rejects.toThrow(/immuables/);
    await expect(e.db.query("UPDATE card SET token_idx='x' WHERE id=$1", [c1.id])).rejects.toThrow(/immuables/);
    await expect(e.db.query("UPDATE card SET patient_id=(SELECT id FROM patient WHERE id<>$2 LIMIT 1) WHERE id=$1", [c1.id, p])).rejects.toThrow();
    await e.db.query("UPDATE card SET status='revoquee', revoked_at=now() WHERE id=$1", [c2.id]);
    await expect(e.db.query("UPDATE card SET status='active' WHERE id=$1", [c2.id])).rejects.toThrow(/transition/);
    await expect(e.db.query("UPDATE card SET status='emise' WHERE id=$1", [c1.id])).rejects.toThrow(/transition/);
    await expect(e.db.query("UPDATE card_event SET type='x'")).rejects.toThrow(/ajout seul/);
    await expect(e.db.query('DELETE FROM card_revocation')).rejects.toThrow(/ajout seul/);
    await expect(e.db.query('TRUNCATE card_event')).rejects.toThrow(/ajout seul/);
  });
  it('même par SQL direct, une carte qui devient bloquée ou révoquée entre dans la liste des révoquées', async () => {
    const e = await makeCardEnv();
    const c = await e.issue(await e.patient());
    await e.activateCard(c.id);
    const before = (await e.rt.cards.revocations(0)).entries.length;
    await e.db.query("UPDATE card SET status='bloquee' WHERE id=$1", [c.id]);
    await e.db.query("UPDATE card SET status='revoquee', revoked_at=now() WHERE id=$1", [c.id]);
    const after = (await e.rt.cards.revocations(0)).entries;
    expect(after.length).toBe(before + 2);
    expect(after.map((x) => x.reason).slice(-2)).toEqual(['bloquee', 'revoquee']);
  });
  it('concurrence : deux activations simultanées de deux cartes du même patient → une seule active', async () => {
    const e = await makeCardEnv();
    const p = await e.patient();
    const c1 = await e.issue(p);
    await e.db.query("INSERT INTO card (id, patient_id, type, number, status, token_enc, token_idx, token_sha, code_enc, code_idx, code_sha, establishment_id, issued_at, activation_deadline, created_at) SELECT gen_random_uuid(), patient_id, type, 'CS-2026-9999999', 'emise', token_enc||'x', 'ti2', 'ts2', code_enc||'x', 'ci2', 'cs2', establishment_id, issued_at, activation_deadline, created_at FROM card WHERE id=$1", [c1.id]);
    const other = (await e.db.query<{ id: string }>("SELECT id FROM card WHERE number='CS-2026-9999999'")).rows[0]!.id;
    const results = await Promise.allSettled([
      e.db.query("UPDATE card SET status='active' WHERE id=$1", [c1.id]),
      e.db.query("UPDATE card SET status='active' WHERE id=$1", [other]),
    ]);
    const actives = (await e.db.query<{ n: number }>("SELECT count(*)::int AS n FROM card WHERE patient_id=$1 AND status='active'", [p])).rows[0]!.n;
    expect(actives).toBe(1);
    expect(results.filter((r) => r.status === 'rejected').length).toBeGreaterThanOrEqual(0);
  });
});

describe('révocation automatique des cartes non activées (90 jours)', () => {
  it('avant l\'échéance : conservée ; à l\'échéance : révoquée ; une carte active n\'est jamais balayée', async () => {
    const e = await makeCardEnv();
    const pending = await e.issue(await e.patient());
    const active = await e.issue(await e.patient());
    await e.activateCard(active.id);
    e.clock.advance(90 * 86400 - 1);
    expect(await e.rt.cards.sweepExpired()).toBe(0);
    expect(await e.status(pending.id)).toBe('emise');
    e.clock.advance(1);
    expect(await e.rt.cards.sweepExpired()).toBe(1);
    expect(await e.status(pending.id)).toBe('revoquee');
    expect(await e.status(active.id)).toBe('active');
    expect((await events(e, 'expired'))).toHaveLength(1);
    expect((await e.rt.cards.revocations(0)).entries.map((x) => x.reason)).toContain('revoquee');
    expect(await e.rt.cards.sweepExpired()).toBe(0); // idempotent
  });
  it('activation tentée après l\'échéance, sans balayage préalable : refusée (410) et la carte est révoquée', async () => {
    const e = await makeCardEnv();
    const c = await e.issue(await e.patient());
    e.clock.advance(91 * 86400);
    await expect(e.rt.cards.activate(await e.agentRecord(), (await secretsOf(e, c.id)).token)).rejects.toMatchObject({ code: 'card_expired', status: 410 });
    expect(await e.status(c.id)).toBe('revoquee');
  });
  it('le délai est un paramètre', async () => {
    const e = await makeCardEnv();
    const svc = new CardService(e.db, e.fieldCrypto, e.identity, e.sms, { t: () => '', dict: () => ({}) } as never, async () => {}, { ...(await import('../../src/cards/config.js')).loadCardsConfig({}), activationDeadlineDays: 7 }, () => e.clock.now);
    const p = await e.patient();
    const a = await e.agentRecord();
    const c = await svc.issue(a, { patientId: p, type: 'adulte' });
    e.clock.advance(7 * 86400);
    expect(await svc.sweepExpired()).toBe(1);
    expect(await e.status(c.id)).toBe('revoquee');
  });
});

describe('unicité des identifiants : collisions de code de secours rattrapées', () => {
  it('un code déjà pris est retiré au sort (nouvelle tentative), jamais deux cartes avec le même code', async () => {
    const e = await makeCardEnv();
    const first = await e.issue(await e.patient());
    const taken = (await secretsOf(e, first.id)).code;
    const codes = [taken, taken, generateCode()];
    const svc = new CardService(e.db, e.fieldCrypto, e.identity, e.sms, ({ t: () => '' } as never), async () => {}, (await import('../../src/cards/config.js')).loadCardsConfig({}), () => e.clock.now, { token: generateToken, code: () => codes.shift() ?? generateCode() });
    const c = await svc.issue(await e.agentRecord(), { patientId: await e.patient(), type: 'adulte' });
    expect((await secretsOf(e, c.id)).code).not.toBe(taken);
    expect((await e.db.query<{ n: number }>('SELECT count(DISTINCT code_idx)::int AS n FROM card')).rows[0]!.n).toBe(2);
  });
  it('si les collisions persistent, l\'émission échoue proprement (jamais de doublon)', async () => {
    const e = await makeCardEnv();
    const first = await e.issue(await e.patient());
    const taken = (await secretsOf(e, first.id)).code;
    const svc = new CardService(e.db, e.fieldCrypto, e.identity, e.sms, { t: () => '' } as never, async () => {}, (await import('../../src/cards/config.js')).loadCardsConfig({}), () => e.clock.now, { token: generateToken, code: () => taken });
    await expect(svc.issue(await e.agentRecord(), { patientId: await e.patient(), type: 'adulte' })).rejects.toThrow();
    expect((await e.db.query<{ n: number }>('SELECT count(*)::int AS n FROM card')).rows[0]!.n).toBe(1);
  });
});
