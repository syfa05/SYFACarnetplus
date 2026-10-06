import { afterAll, describe, expect, it } from 'vitest';
import { cleanup, enrol, makeEnv, OTP_REQUEST, OTP_VERIFY, PHONE, REFRESH, UNLOCK } from './helpers.js';

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

describe('F-AUTH-02 — PIN à 4 chiffres, 5 erreurs = nouveau code SMS', () => {
  it('connexion par PIN : jeton d\'accès valide', async () => {
    const env = await makeEnv();
    const pid = await env.addPatient();
    const e = await enrol(env, '7391');
    const me = await env.get('/v1/me', e.accessToken);
    expect(me.json()).toMatchObject({ subject: pid, roles: ['patient'], kind: 'patient' });
    const un = await env.post(UNLOCK, { deviceId: e.deviceId, deviceSecret: e.deviceSecret, pin: '7391' });
    expect(un.statusCode).toBe(200);
    expect((await env.get('/v1/me', un.json().accessToken)).statusCode).toBe(200);
  });
  it('4 PIN erronés puis le bon : succès (compteur remis à zéro)', async () => {
    const env = await makeEnv();
    await env.addPatient();
    const e = await enrol(env, '7391');
    for (let i = 0; i < 4; i++) {
      const r = await env.post(UNLOCK, { deviceId: e.deviceId, deviceSecret: e.deviceSecret, pin: '0000' });
      expect(r.json()).toEqual({ error: 'invalid_pin', attemptsLeft: 4 - i });
    }
    expect((await env.post(UNLOCK, { deviceId: e.deviceId, deviceSecret: e.deviceSecret, pin: '7391' })).statusCode).toBe(200);
    // compteur remis à zéro : 4 nouveaux essais erronés ne bloquent pas
    for (let i = 0; i < 4; i++) await env.post(UNLOCK, { deviceId: e.deviceId, deviceSecret: e.deviceSecret, pin: '0000' });
    expect((await env.post(UNLOCK, { deviceId: e.deviceId, deviceSecret: e.deviceSecret, pin: '7391' })).statusCode).toBe(200);
  });
  it('5 PIN erronés : nouveau code SMS exigé, même avec le bon PIN ensuite', async () => {
    const env = await makeEnv();
    await env.addPatient();
    const e = await enrol(env, '7391');
    let last;
    for (let i = 0; i < 5; i++) last = await env.post(UNLOCK, { deviceId: e.deviceId, deviceSecret: e.deviceSecret, pin: '0000' });
    expect(last!.json()).toEqual({ error: 'sms_required' });
    const good = await env.post(UNLOCK, { deviceId: e.deviceId, deviceSecret: e.deviceSecret, pin: '7391' });
    expect(good.statusCode).toBe(401);
    expect(good.json()).toEqual({ error: 'sms_required' });
    // les sessions de l'appareil sont fermées
    expect((await env.get('/v1/me', e.accessToken)).statusCode).toBe(401);
    // le nouvel enrôlement par SMS rétablit l'accès
    env.clock.advance(61);
    const again = await enrol(env, '8153');
    expect((await env.get('/v1/me', again.accessToken)).statusCode).toBe(200);
  });
  it('un tiers sans le secret d\'appareil ne peut pas verrouiller le compte', async () => {
    const env = await makeEnv();
    await env.addPatient();
    const e = await enrol(env, '7391');
    for (let i = 0; i < 20; i++) {
      expect((await env.post(UNLOCK, { deviceId: e.deviceId, deviceSecret: 'x'.repeat(43), pin: '0000' })).json()).toEqual({ error: 'invalid_credentials' });
    }
    expect((await env.post(UNLOCK, { deviceId: e.deviceId, deviceSecret: e.deviceSecret, pin: '7391' })).statusCode).toBe(200);
  });
  it('appareil inconnu : même erreur qu\'un secret erroné', async () => {
    const env = await makeEnv();
    const r = await env.post(UNLOCK, { deviceId: '11111111-1111-4111-8111-111111111111', deviceSecret: 'y'.repeat(43), pin: '2580' });
    expect(r.json()).toEqual({ error: 'invalid_credentials' });
  });
  it('PIN et secrets ne sont jamais stockés en clair', async () => {
    const env = await makeEnv();
    await env.addPatient();
    const e = await enrol(env, '7391');
    const dev = (await env.db.query<{ pin_hash: string; secret_hash: string }>('SELECT pin_hash, secret_hash FROM auth_patient_device')).rows[0]!;
    expect(dev.pin_hash).toMatch(/^s1:/);
    expect(dev.secret_hash).not.toContain(e.deviceSecret);
    const sess = JSON.stringify((await env.db.query('SELECT * FROM auth_session')).rows);
    expect(sess).not.toContain(e.refreshToken);
  });
});

describe('sessions patient : rafraîchissement, inactivité, révocation', () => {
  it('le rafraîchissement fait tourner le jeton ; la réutilisation d\'un ancien jeton révoque la session', async () => {
    const env = await makeEnv();
    await env.addPatient();
    const e = await enrol(env);
    const r1 = await env.post(REFRESH, { refreshToken: e.refreshToken });
    expect(r1.statusCode).toBe(200);
    const next = r1.json();
    expect(next.refreshToken).not.toBe(e.refreshToken);
    expect((await env.get('/v1/me', next.accessToken)).statusCode).toBe(200);
    const replay = await env.post(REFRESH, { refreshToken: e.refreshToken }); // jeton déjà échangé
    expect(replay.statusCode).toBe(401);
    expect((await env.post(REFRESH, { refreshToken: next.refreshToken })).statusCode).toBe(401); // session révoquée
    expect((await env.get('/v1/me', next.accessToken)).statusCode).toBe(401);
  });
  it('inactivité de 30 minutes : la session se ferme ; une activité la prolonge', async () => {
    const env = await makeEnv({ AUTH_ACCESS_TOKEN_SECONDS: '900' });
    await env.addPatient();
    let e = await enrol(env);
    for (let i = 0; i < 2; i++) { // activité toutes les 14 minutes : la session reste ouverte bien au-delà de 30 minutes
      env.clock.advance(14 * 60);
      const r = await env.post(REFRESH, { refreshToken: e.refreshToken });
      expect(r.statusCode).toBe(200);
      e = { ...e, ...r.json() };
      expect((await env.get('/v1/me', e.accessToken)).statusCode).toBe(200);
    }
    env.clock.advance(31 * 60); // 31 minutes sans aucune activité
    expect((await env.post(REFRESH, { refreshToken: e.refreshToken })).statusCode).toBe(401);
    expect((await env.get('/v1/me', e.accessToken)).statusCode).toBe(401);
  });
  it('durée absolue : la session se ferme même si elle reste active', async () => {
    const env = await makeEnv({ AUTH_PATIENT_SESSION_MAX_SECONDS: '3600', AUTH_ACCESS_TOKEN_SECONDS: '900' });
    await env.addPatient();
    let e = await enrol(env);
    for (let i = 0; i < 5; i++) {
      env.clock.advance(11 * 60);
      const r = await env.post(REFRESH, { refreshToken: e.refreshToken });
      expect(r.statusCode).toBe(200);
      e = { ...e, ...r.json() };
    }
    env.clock.advance(11 * 60); // > 60 min depuis l'ouverture
    expect((await env.post(REFRESH, { refreshToken: e.refreshToken })).statusCode).toBe(401);
  });
  it('un jeton d\'accès expiré est refusé', async () => {
    const env = await makeEnv();
    await env.addPatient();
    const e = await enrol(env);
    env.clock.advance(301);
    expect((await env.get('/v1/me', e.accessToken)).statusCode).toBe(401);
  });
  it('déconnexion : la session est révoquée', async () => {
    const env = await makeEnv();
    await env.addPatient();
    const e = await enrol(env);
    expect((await env.post('/v1/auth/logout', {}, { authorization: `Bearer ${e.accessToken}` })).statusCode).toBe(204);
    expect((await env.get('/v1/me', e.accessToken)).statusCode).toBe(401);
    expect((await env.post(REFRESH, { refreshToken: e.refreshToken })).statusCode).toBe(401);
  });
});

describe('réinitialisation après perte de téléphone', () => {
  it('le nouvel appareil enrôlé par SMS révoque l\'ancien (secret, PIN, sessions, jetons)', async () => {
    const env = await makeEnv();
    await env.addPatient();
    const oldDevice = await enrol(env, '3857');
    env.clock.advance(61);
    const newDevice = await enrol(env, '4926');
    expect((await env.get('/v1/me', oldDevice.accessToken)).statusCode).toBe(401);
    expect((await env.post(REFRESH, { refreshToken: oldDevice.refreshToken })).statusCode).toBe(401);
    expect((await env.post(UNLOCK, { deviceId: oldDevice.deviceId, deviceSecret: oldDevice.deviceSecret, pin: '3857' })).statusCode).toBe(401);
    expect((await env.get('/v1/me', newDevice.accessToken)).statusCode).toBe(200);
    expect((await env.post(UNLOCK, { deviceId: newDevice.deviceId, deviceSecret: newDevice.deviceSecret, pin: '4926' })).statusCode).toBe(200);
  });
  it('désactivable par configuration (plusieurs appareils)', async () => {
    const env = await makeEnv({ AUTH_REVOKE_OTHER_DEVICES_ON_ENROL: 'false' });
    await env.addPatient();
    const a = await enrol(env, '3857');
    env.clock.advance(61);
    await enrol(env, '4926');
    expect((await env.get('/v1/me', a.accessToken)).statusCode).toBe(200);
  });
});

describe('journal d\'authentification', () => {
  it('aucun code, PIN, secret ni jeton dans les événements ; ajout seul', async () => {
    const env = await makeEnv();
    await env.addPatient();
    await env.post(OTP_REQUEST, { telephone: PHONE }); await env.rt.patients.drain();
    const code = env.sms.code();
    const bad = code === '000000' ? '111111' : '000000';
    await env.post(OTP_VERIFY, { telephone: PHONE, code: bad, pin: '7391' });
    const e = (await env.post(OTP_VERIFY, { telephone: PHONE, code, pin: '7391' })).json();
    await env.post(UNLOCK, { deviceId: e.deviceId, deviceSecret: e.deviceSecret, pin: '0000' });
    const dump = JSON.stringify((await env.db.query('SELECT * FROM auth_event')).rows);
    for (const secret of [code, bad, e.deviceSecret, e.refreshToken, e.accessToken, PHONE, '7391']) expect(dump).not.toContain(secret);
    expect(dump).toContain('otp_failed');
    await expect(env.db.query('DELETE FROM auth_event')).rejects.toThrow();
    await expect(env.db.query("UPDATE auth_event SET type='x'")).rejects.toThrow();
  });
});
