import { afterAll, describe, expect, it, vi } from 'vitest';
import { cleanup, makeEnv, OTP_REQUEST, OTP_VERIFY, PHONE, type Env } from './helpers.js';

afterAll(cleanup);

describe('F-AUTH-01 — téléphone + code SMS (6 chiffres, 10 min, 3 essais)', () => {
  it('envoie un code à 6 chiffres, neutre, sans lien ni établissement', async () => {
    const env = await makeEnv();
    await env.addPatient();
    const res = await env.post(OTP_REQUEST, { telephone: PHONE });
    expect(res.statusCode).toBe(202);
    await env.rt.patients.drain();
    expect(env.sms.sent).toHaveLength(1);
    const { to, text } = env.sms.sent[0]!;
    expect(to).toBe(PHONE);
    expect(env.sms.code()).toMatch(/^\d{6}$/);
    expect(text).not.toMatch(/https?:|www\.|\.com|\.cm|\//i); // F-JRN-02 : aucun lien
    expect(text).not.toMatch(/hôpital|hopital|clinique|centre|pharmacie|hospital|clinic|diagnos|patient/i);
  });
  it('code valable 10 minutes : accepté à 9 min 59, refusé à 10 min 01', async () => {
    const env = await makeEnv();
    await env.addPatient();
    await env.post(OTP_REQUEST, { telephone: PHONE }); await env.rt.patients.drain();
    const code = env.sms.code();
    env.clock.advance(601);
    expect((await env.post(OTP_VERIFY, { telephone: PHONE, code, pin: '2580' })).statusCode).toBe(401);
    const env2 = await makeEnv();
    await env2.addPatient();
    await env2.post(OTP_REQUEST, { telephone: PHONE }); await env2.rt.patients.drain();
    env2.clock.advance(599);
    expect((await env2.post(OTP_VERIFY, { telephone: PHONE, code: env2.sms.code(), pin: '2580' })).statusCode).toBe(200);
  });
  it('3 essais au plus : le 4e échoue même avec le bon code', async () => {
    const env = await makeEnv();
    await env.addPatient();
    await env.post(OTP_REQUEST, { telephone: PHONE }); await env.rt.patients.drain();
    const good = env.sms.code();
    const bad = good === '000000' ? '111111' : '000000';
    for (let i = 0; i < 3; i++) expect((await env.post(OTP_VERIFY, { telephone: PHONE, code: bad, pin: '2580' })).statusCode).toBe(401);
    const res = await env.post(OTP_VERIFY, { telephone: PHONE, code: good, pin: '2580' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_code' });
  });
  it('le 3e essai peut être le bon', async () => {
    const env = await makeEnv();
    await env.addPatient();
    await env.post(OTP_REQUEST, { telephone: PHONE }); await env.rt.patients.drain();
    const good = env.sms.code();
    const bad = good === '000000' ? '111111' : '000000';
    await env.post(OTP_VERIFY, { telephone: PHONE, code: bad, pin: '2580' });
    await env.post(OTP_VERIFY, { telephone: PHONE, code: bad, pin: '2580' });
    expect((await env.post(OTP_VERIFY, { telephone: PHONE, code: good, pin: '2580' })).statusCode).toBe(200);
  });
  it('usage unique : un code déjà utilisé est refusé (réutilisation)', async () => {
    const env = await makeEnv();
    await env.addPatient();
    await env.post(OTP_REQUEST, { telephone: PHONE }); await env.rt.patients.drain();
    const code = env.sms.code();
    expect((await env.post(OTP_VERIFY, { telephone: PHONE, code, pin: '2580' })).statusCode).toBe(200);
    expect((await env.post(OTP_VERIFY, { telephone: PHONE, code, pin: '2580' })).statusCode).toBe(401);
  });
  it('deux vérifications simultanées du bon code : une seule réussit', async () => {
    const env = await makeEnv();
    await env.addPatient();
    await env.post(OTP_REQUEST, { telephone: PHONE }); await env.rt.patients.drain();
    const code = env.sms.code();
    const res = await Promise.all([1, 2, 3].map(() => env.post(OTP_VERIFY, { telephone: PHONE, code, pin: '2580' })));
    expect(res.filter((r) => r.statusCode === 200)).toHaveLength(1);
  });
  it('un nouveau code invalide le précédent', async () => {
    const env = await makeEnv();
    await env.addPatient();
    await env.post(OTP_REQUEST, { telephone: PHONE }); await env.rt.patients.drain();
    const first = env.sms.code();
    env.clock.advance(61);
    await env.post(OTP_REQUEST, { telephone: PHONE }); await env.rt.patients.drain();
    const second = env.sms.code();
    if (first !== second) expect((await env.post(OTP_VERIFY, { telephone: PHONE, code: first, pin: '2580' })).statusCode).toBe(401);
    expect((await env.post(OTP_VERIFY, { telephone: PHONE, code: second, pin: '2580' })).statusCode).toBe(200);
  });
  it('renvoi limité : 1 par minute et 5 par heure, pour tout numéro', async () => {
    const env = await makeEnv();
    await env.addPatient();
    expect((await env.post(OTP_REQUEST, { telephone: PHONE })).statusCode).toBe(202);
    const tooSoon = await env.post(OTP_REQUEST, { telephone: PHONE });
    expect(tooSoon.statusCode).toBe(429);
    expect(Number(tooSoon.headers['retry-after'])).toBeGreaterThan(0);
    for (let i = 0; i < 4; i++) { env.clock.advance(61); expect((await env.post(OTP_REQUEST, { telephone: PHONE })).statusCode).toBe(202); }
    env.clock.advance(61);
    expect((await env.post(OTP_REQUEST, { telephone: PHONE })).statusCode).toBe(429); // 6e dans l'heure
  });
  it('numéro inconnu, ambigu ou dossier non actif : même réponse, aucun SMS', async () => {
    const env = await makeEnv();
    const known = await env.addPatient();
    const known1 = await env.post(OTP_REQUEST, { telephone: PHONE });
    const unknown = await env.post(OTP_REQUEST, { telephone: '237699999999' });
    expect({ s: unknown.statusCode, b: unknown.json() }).toEqual({ s: known1.statusCode, b: known1.json() });
    await env.rt.patients.drain();
    expect(env.sms.sent.map((m) => m.to)).toEqual([PHONE]);
    // deux dossiers actifs pour le même numéro : pas de compte univoque
    await env.addPatient();
    env.clock.advance(61);
    env.sms.sent = [];
    expect((await env.post(OTP_REQUEST, { telephone: PHONE })).statusCode).toBe(202);
    await env.rt.patients.drain();
    expect(env.sms.sent).toHaveLength(0);
    // dossier décédé
    const env2 = await makeEnv();
    const id = await env2.addPatient();
    await env2.db.query("UPDATE patient SET statut_dossier='decede' WHERE id=$1", [id]);
    await env2.post(OTP_REQUEST, { telephone: PHONE }); await env2.rt.patients.drain();
    expect(env2.sms.sent).toHaveLength(0);
    expect(known).toBeTruthy();
  });
  it('code envoyé dans la langue du patient', async () => {
    const env = await makeEnv();
    await env.addPatient({ langue: 'en' });
    await env.post(OTP_REQUEST, { telephone: PHONE }); await env.rt.patients.drain();
    expect(env.sms.sent[0]!.text).toMatch(/sign-in code/);
  });
  it('échec d\'envoi : réponse identique, trace sans message externe', async () => {
    const env = await makeEnv();
    await env.addPatient();
    env.sms.failNext = true;
    expect((await env.post(OTP_REQUEST, { telephone: PHONE })).statusCode).toBe(202);
    await env.rt.patients.drain();
    const ev = JSON.stringify((await env.db.query('SELECT details FROM auth_event WHERE type=$1', ['sms_failed'])).rows);
    expect(ev).toContain('Error:HTTP_503');
    expect(ev).not.toMatch(/Dupont/);
  });
  it('entrées invalides : 400 sans toucher aux compteurs', async () => {
    const env = await makeEnv();
    await env.addPatient();
    for (const body of [{}, { telephone: '690000001' }, { telephone: PHONE, extra: 1 }, { telephone: 12 }]) {
      expect((await env.post(OTP_REQUEST, body)).statusCode).toBe(400);
    }
    await env.post(OTP_REQUEST, { telephone: PHONE }); await env.rt.patients.drain();
    for (const body of [{ telephone: PHONE, code: '12345', pin: '2580' }, { telephone: PHONE, code: 'abcdef', pin: '2580' }, { telephone: PHONE, code: env.sms.code(), pin: '12' }]) {
      expect((await env.post(OTP_VERIFY, body)).statusCode).toBe(400);
    }
    expect((await env.db.query<{ attempts: number }>('SELECT attempts FROM auth_otp')).rows[0]!.attempts).toBe(0);
  });
});

describe('Q12 — numéro connu ou inconnu : même travail, mêmes écritures', () => {
  /** Séquence des instructions SQL exécutées (verbe + table), valeurs exclues. */
  const trace = (env: Env) => {
    const sqls: string[] = [];
    const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim().replace(/\bVALUES\b.*$/, 'VALUES').slice(0, 60);
    const db = env.db as unknown as { query: (s: string, p?: unknown[]) => Promise<unknown>; transaction: (fn: (tx: { query: (s: string, p?: unknown[]) => Promise<unknown> }) => Promise<unknown>) => Promise<unknown> };
    const q = db.query.bind(db); const t = db.transaction.bind(db);
    vi.spyOn(db, 'query').mockImplementation((s, p) => { sqls.push(norm(s)); return q(s, p); });
    vi.spyOn(db, 'transaction').mockImplementation((fn) => t((tx) => fn({ ...tx, query: (s: string, p?: unknown[]) => { sqls.push(`tx:${norm(s)}`); return tx.query(s, p); } } as never)));
    return sqls;
  };
  it('mêmes instructions SQL et même réponse', async () => {
    const known = await makeEnv();
    await known.addPatient();
    const kSql = trace(known);
    const kRes = await known.post(OTP_REQUEST, { telephone: PHONE });
    const unknown = await makeEnv();
    const uSql = trace(unknown);
    const uRes = await unknown.post(OTP_REQUEST, { telephone: PHONE });
    expect(uSql).toEqual(kSql);
    expect([uRes.statusCode, uRes.json()]).toEqual([kRes.statusCode, kRes.json()]);
    vi.restoreAllMocks();
  });
  it('le code « fantôme » se comporte comme un vrai : 3 essais puis verrouillage, jamais valable', async () => {
    const env = await makeEnv();
    await env.post(OTP_REQUEST, { telephone: '237699999999' });
    const row = (await env.db.query<{ patient_id: unknown }>('SELECT patient_id FROM auth_otp')).rows[0]!;
    expect(row.patient_id).toBeNull();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await env.post(OTP_VERIFY, { telephone: '237699999999', code: String(100000 + i), pin: '2580' })).statusCode);
    expect(codes).toEqual([401, 401, 401, 401, 401]);
    expect((await env.db.query<{ attempts: number }>('SELECT attempts FROM auth_otp')).rows[0]!.attempts).toBe(3);
    expect(env.sms.sent).toHaveLength(0);
  });
  it('un code fantôme n\'invalide pas le vrai code d\'un autre numéro, et un compte créé ensuite fonctionne', async () => {
    const env = await makeEnv();
    await env.post(OTP_REQUEST, { telephone: PHONE }); // aucun compte pour l'instant
    env.clock.advance(61);
    await env.addPatient();
    await env.post(OTP_REQUEST, { telephone: PHONE }); await env.rt.patients.drain();
    expect((await env.post(OTP_VERIFY, { telephone: PHONE, code: env.sms.code(), pin: '2580' })).statusCode).toBe(200);
  });
});
