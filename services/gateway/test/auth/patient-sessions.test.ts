import { afterAll, describe, expect, it } from 'vitest';
import { REAL_PG } from '../identity/helpers.js';
import { cleanup, enrol, makeEnv, OTP_REQUEST, OTP_VERIFY, PHONE, REFRESH, UNLOCK } from './helpers.js';

afterAll(cleanup);

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
  it('présentation simultanée du même jeton (relecture avant rotation) : la session est révoquée, aucun des deux ne continue', async () => {
    const env = await makeEnv({ AUTH_RATE_IP_PER_MINUTE: '100000', AUTH_OTP_MAX_PER_HOUR: '1000', AUTH_OTP_MAX_VERIFY_PER_HOUR: '1000' });
    await env.addPatient();
    for (let trial = 0; trial < (REAL_PG ? 15 : 3); trial++) {
      env.clock.advance(61);
      const e = await enrol(env, '2580');
      const res = await Promise.all([REFRESH, REFRESH].map((u) => env.post(u, { refreshToken: e.refreshToken })));
      const codes = res.map((r) => r.statusCode).sort();
      expect(codes, `essai ${trial}`).toEqual([200, 401]); // un seul gagne, jamais deux
      const winner = res.find((r) => r.statusCode === 200)!.json();
      // le jeton déjà échangé a été présenté deux fois : vol probable → la session entière est fermée, gagnant compris
      expect((await env.get('/v1/me', winner.accessToken)).statusCode, `accès du gagnant, essai ${trial}`).toBe(401);
      expect((await env.post(REFRESH, { refreshToken: winner.refreshToken })).statusCode, `rafraîchissement du gagnant, essai ${trial}`).toBe(401);
      expect((await env.db.query("SELECT 1 FROM auth_session WHERE id=$1 AND revoked_reason='refresh_reuse'", [JSON.parse(Buffer.from(winner.accessToken.split('.')[1], 'base64url').toString()).sid])).rows).toHaveLength(1);
    }
    expect((await env.db.query("SELECT 1 FROM auth_event WHERE type='refresh_reuse'")).rows.length).toBeGreaterThan(0);
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
