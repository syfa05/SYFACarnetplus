import { afterAll, describe, expect, it } from 'vitest';
import { isWeakPin } from '../../src/auth/network.js';
import { cleanup, enrol, makeEnv, OTP_REQUEST, OTP_VERIFY, PHONE, UNLOCK } from './helpers.js';

afterAll(cleanup);

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

describe('Q3 — PIN triviaux', () => {
  it.each(['0000', '1111', '1234', '4321', '0123', '9876', '1212', '5656', '1122', '7733'])('%s est refusé', (pin) => {
    expect(isWeakPin(pin)).toBe(true);
  });
  it.each(['2580', '7391', '1357', '8153', '4926', '1928'])('%s est accepté', (pin) => {
    expect(isWeakPin(pin)).toBe(false);
  });
  it('refusé avant tout essai : ni code, ni quota consommés ; désactivable', async () => {
    const env = await makeEnv();
    await env.addPatient();
    await env.post(OTP_REQUEST, { telephone: PHONE }); await env.rt.patients.drain();
    const r = await env.post(OTP_VERIFY, { telephone: PHONE, code: env.sms.code(), pin: '1234' });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'weak_pin' });
    expect((await env.db.query<{ attempts: number }>('SELECT attempts FROM auth_otp')).rows[0]!.attempts).toBe(0);
    expect((await env.post(OTP_VERIFY, { telephone: PHONE, code: env.sms.code(), pin: '2580' })).statusCode).toBe(200); // le même code sert encore
    const lax = await makeEnv({ AUTH_PIN_REJECT_WEAK: 'false' });
    await lax.addPatient();
    await lax.post(OTP_REQUEST, { telephone: PHONE }); await lax.rt.patients.drain();
    expect((await lax.post(OTP_VERIFY, { telephone: PHONE, code: lax.sms.code(), pin: '1234' })).statusCode).toBe(200);
  });
});
