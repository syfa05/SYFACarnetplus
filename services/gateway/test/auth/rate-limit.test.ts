import { afterAll, describe, expect, it } from 'vitest';
import { loadAuthConfig } from '../../src/auth/config.js';
import { cleanup, makeEnv, OTP_VERIFY, PHONE, type Env } from './helpers.js';

afterAll(cleanup);

const DEVICE_KEY = 'k'.repeat(43);

describe('limitation de débit sur toutes les routes d\'authentification', () => {
  it('par adresse : 429 avec Retry-After au-delà du seuil, y compris sans jeton ; fenêtre qui se réarme', async () => {
    const env = await makeEnv({ AUTH_RATE_IP_PER_MINUTE: '3' });
    const routes: Array<() => ReturnType<Env['post']>> = [
      () => env.post('/v1/auth/patient/otp/request', { telephone: '237699999999' }),
      () => env.post('/v1/auth/patient/otp/verify', { telephone: '237699999999', code: '123456', pin: '1234' }),
      () => env.post('/v1/auth/patient/unlock', { deviceId: '11111111-1111-4111-8111-111111111111', deviceSecret: 'a'.repeat(43), pin: '1234' }),
      () => env.post('/v1/auth/patient/refresh', { refreshToken: 'a'.repeat(43) }),
      () => env.post('/v1/auth/devices', { deviceKey: DEVICE_KEY }),
    ];
    // chaque route partage le même compteur par adresse
    for (let i = 0; i < 3; i++) expect((await routes[i]!()).statusCode).not.toBe(429);
    for (const route of routes) {
      const r = await route();
      expect(r.statusCode).toBe(429);
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      expect(r.json()).toMatchObject({ error: 'too_many_requests' });
    }
    env.clock.advance(61);
    expect((await routes[0]!()).statusCode).not.toBe(429);
  });
  it('les routes hors authentification ne sont pas concernées', async () => {
    const env = await makeEnv({ AUTH_RATE_IP_PER_MINUTE: '1' });
    for (let i = 0; i < 5; i++) expect((await env.get('/health')).statusCode).toBe(200);
  });
  it('la limite ne dépend pas de l\'existence du numéro (pas d\'oracle)', async () => {
    const env = await makeEnv();
    await env.addPatient();
    const a = await env.post('/v1/auth/patient/otp/request', { telephone: '237690000001' });
    const b = await env.post('/v1/auth/patient/otp/request', { telephone: '237690000001' });
    const c = await env.post('/v1/auth/patient/otp/request', { telephone: '237699999999' });
    const d = await env.post('/v1/auth/patient/otp/request', { telephone: '237699999999' });
    expect([a.statusCode, b.statusCode]).toEqual([c.statusCode, d.statusCode]);
  });
  it('aucune adresse IP ni numéro en clair dans la table de limitation', async () => {
    const env = await makeEnv();
    await env.post('/v1/auth/patient/otp/request', { telephone: '237690000001' });
    const dump = JSON.stringify((await env.db.query('SELECT * FROM auth_rate_limit')).rows);
    expect(dump).not.toContain('237690000001');
    expect(dump).not.toContain('127.0.0.1');
  });
});

describe('réponses d\'erreur', () => {
  it('une erreur interne ne renvoie qu\'un code générique', async () => {
    const env = await makeEnv();
    await env.db.query('DROP TABLE auth_rate_limit'); // panne de la base : le limiteur échoue
    const r = await env.post('/v1/auth/patient/otp/request', { telephone: '237690000001' });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: 'internal_error' }); // refus, jamais une ouverture
  });
});

describe('Q2 — quotas et fenêtres paramétrables', () => {
  it('valeurs par défaut du dossier et variables d\'environnement', () => {
    const d = loadAuthConfig({});
    expect(d.otp).toMatchObject({ maxPerHour: 5, maxVerifyPerHour: 30, quotaWindowSeconds: 3600 });
    expect(d.rateLimit).toEqual({ ipLimit: 30, ipWindowSeconds: 60 });
    const c = loadAuthConfig({ AUTH_OTP_MAX_VERIFY_PER_HOUR: '7', AUTH_OTP_QUOTA_WINDOW_SECONDS: '120', AUTH_RATE_IP_WINDOW_SECONDS: '10' });
    expect(c.otp).toMatchObject({ maxVerifyPerHour: 7, quotaWindowSeconds: 120 });
    expect(c.rateLimit.ipWindowSeconds).toBe(10);
  });
  it('le plafond de vérifications et les fenêtres sont bien appliqués', async () => {
    const env = await makeEnv({ AUTH_OTP_MAX_VERIFY_PER_HOUR: '2', AUTH_OTP_QUOTA_WINDOW_SECONDS: '120', AUTH_RATE_IP_PER_MINUTE: '100' });
    await env.addPatient();
    const body = { telephone: PHONE, code: '000000', pin: '2580' };
    expect((await env.post(OTP_VERIFY, body)).statusCode).toBe(401);
    expect((await env.post(OTP_VERIFY, body)).statusCode).toBe(401);
    expect((await env.post(OTP_VERIFY, body)).statusCode).toBe(429);
    env.clock.advance(121); // nouvelle fenêtre de 120 s
    expect((await env.post(OTP_VERIFY, body)).statusCode).toBe(401);
  });
  it('fenêtre de la limitation par adresse paramétrable', async () => {
    const env = await makeEnv({ AUTH_RATE_IP_PER_MINUTE: '1', AUTH_RATE_IP_WINDOW_SECONDS: '5' });
    const post = () => env.post('/v1/auth/patient/refresh', { refreshToken: 'a'.repeat(43) });
    expect((await post()).statusCode).toBe(401);
    expect((await post()).statusCode).toBe(429);
    env.clock.advance(6);
    expect((await post()).statusCode).toBe(401);
  });
});

describe('Q14 — corps des routes d\'authentification limités', () => {
  it('au-delà de 4 Ko : 413, avant toute lecture', async () => {
    const env = await makeEnv();
    for (const url of ['/v1/auth/patient/otp/request', '/v1/auth/patient/otp/verify', '/v1/auth/patient/unlock', '/v1/auth/patient/refresh']) {
      const r = await env.post(url, { telephone: 'x'.repeat(5000) });
      expect(r.statusCode, url).toBe(413);
    }
    // routes avec jeton : sans jeton, refus (401) avant même la lecture du corps ; avec jeton, 413
    expect((await env.post('/v1/auth/devices', { deviceKey: 'k'.repeat(5000) })).statusCode).toBe(401);
    const t = await env.signPro({ azp: 'syfa-web', sid: 'big' });
    expect((await env.post('/v1/auth/devices', { deviceKey: 'k'.repeat(5000) }, { authorization: `Bearer ${t}` })).statusCode).toBe(413);
  });
});
