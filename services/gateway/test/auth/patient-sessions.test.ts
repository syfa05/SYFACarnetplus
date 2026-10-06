import { afterAll, describe, expect, it } from 'vitest';
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
