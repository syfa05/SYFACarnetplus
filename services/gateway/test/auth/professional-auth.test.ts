import { afterAll, describe, expect, it } from 'vitest';
import { cleanup, makeEnv, type Env } from './helpers.js';

afterAll(cleanup);

const DEVICE_KEY = 'k'.repeat(43);
const dk = (k = DEVICE_KEY) => ({ 'x-device-key': k });
const me = (env: Env, token: string, headers: Record<string, string> = {}) => env.get('/v1/me', token, headers);
const registerDevice = (env: Env, token: string, key = DEVICE_KEY, label = 'Téléphone de service') =>
  env.post('/v1/auth/devices', { deviceKey: key, label }, { authorization: `Bearer ${token}` });

describe('F-AUTH-03 — pas de connexion professionnelle sans second facteur', () => {
  it('refuse un jeton sans second facteur ; accepte amr=otp ou acr >= 2', async () => {
    const env = await makeEnv();
    const pwdOnly = await env.signPro({ amr: ['pwd'] });
    const r = await me(env, pwdOnly);
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'mfa_required' });
    expect((await me(env, await env.signPro({ amr: undefined }))).json()).toEqual({ error: 'mfa_required' });
    expect((await me(env, await env.signPro({ amr: ['pwd', 'otp'] }))).statusCode).toBe(200);
    expect((await me(env, await env.signPro({ amr: undefined, acr: '2', sid: 's2' }))).statusCode).toBe(200);
    expect((await me(env, await env.signPro({ amr: undefined, acr: '1', sid: 's3' }))).json()).toEqual({ error: 'mfa_required' });
    expect((await me(env, await env.signPro({ amr: undefined, acr: 'pasunnombre', sid: 's4' }))).statusCode).toBe(401);
  });
  it('refuse : client inconnu, émetteur ou audience erronés, algorithme non prévu, sans sujet ni session', async () => {
    const env = await makeEnv();
    const cases: Array<[string, Record<string, unknown>, { alg?: string }?]> = [
      ['client inconnu', { azp: 'autre-client' }],
      ['sans client', { azp: undefined }],
      ['mauvais émetteur', { iss: 'http://evil/realms/x' }],
      ['mauvaise audience', { aud: 'autre' }],
      ['sans sid', { sid: undefined }],
      ['sans sujet', { sub: '' }],
      ['HS256', {}, { alg: 'HS256' }],
    ];
    for (const [label, over, opts] of cases) {
      const res = await me(env, await env.signPro(over, opts));
      expect(res.statusCode, label).toBe(401);
    }
    expect((await me(env, 'garbage')).statusCode).toBe(401);
    expect((await env.get('/v1/me')).statusCode).toBe(401);
  });
  it('un jeton de patient ne passe pas pour un jeton de professionnel (et inversement)', async () => {
    const env = await makeEnv();
    const me1 = await me(env, await env.signPro({ amr: ['pwd', 'otp'] }));
    expect(me1.json()).toMatchObject({ kind: 'professional', roles: ['medecin'] });
  });
});

describe('F-AUTH-04 — inactivité : 15 min (poste partagé), 30 min (smartphone)', () => {
  it('poste partagé : 14 min d\'inactivité tolérées, 16 min refusées, sans retour possible', async () => {
    const env = await makeEnv();
    const t = await env.signPro({ azp: 'syfa-web', sid: 'pc-1' });
    expect((await me(env, t)).statusCode).toBe(200);
    env.clock.advance(14 * 60);
    expect((await me(env, t)).statusCode).toBe(200); // l'activité prolonge
    env.clock.advance(14 * 60);
    expect((await me(env, t)).statusCode).toBe(200);
    env.clock.advance(16 * 60);
    const r = await me(env, t);
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'session_expired' });
    env.clock.advance(-10 * 60); // même en revenant dans la fenêtre, une session expirée ne revit pas
    expect((await me(env, t)).statusCode).toBe(401);
  });
  it('smartphone : 29 min tolérées, 31 min refusées', async () => {
    const env = await makeEnv();
    const t = await env.signPro({ azp: 'syfa-android-pro', sid: 'ph-1', phone_number: '237677000111' });
    await registerDevice(env, t);
    expect((await me(env, t, dk())).statusCode).toBe(200);
    env.clock.advance(29 * 60);
    expect((await me(env, t, dk())).statusCode).toBe(200);
    env.clock.advance(31 * 60);
    expect((await me(env, t, dk())).json()).toEqual({ error: 'session_expired' });
  });
  it('les durées sont paramétrables', async () => {
    const env = await makeEnv({ AUTH_IDLE_SHARED_PC_SECONDS: '600' });
    const t = await env.signPro({ sid: 'pc-2' });
    expect((await me(env, t)).statusCode).toBe(200);
    env.clock.advance(11 * 60);
    expect((await me(env, t)).statusCode).toBe(401);
  });
  it('une session par client : le même sid sur deux types de client est indépendant', async () => {
    const env = await makeEnv();
    const web = await env.signPro({ azp: 'syfa-web', sid: 'same' });
    const phone = await env.signPro({ azp: 'syfa-android-pro', sid: 'same', phone_number: '237677000111' });
    await registerDevice(env, phone);
    await me(env, web);
    env.clock.advance(20 * 60); // poste partagé expiré (15), smartphone encore valide (30)
    expect((await me(env, web)).statusCode).toBe(401);
    expect((await me(env, phone, dk())).statusCode).toBe(200);
  });
  it('un jeton volé ne peut pas rouvrir la session d\'un autre utilisateur (même sid)', async () => {
    const env = await makeEnv();
    await me(env, await env.signPro({ sid: 'shared', sub: 'alice' }));
    expect((await me(env, await env.signPro({ sid: 'shared', sub: 'mallory' }))).statusCode).toBe(401);
  });
  it('déconnexion : la session est fermée', async () => {
    const env = await makeEnv();
    const t = await env.signPro({ sid: 'out-1' });
    await me(env, t);
    expect((await env.post('/v1/auth/logout', {}, { authorization: `Bearer ${t}` })).statusCode).toBe(204);
    expect((await me(env, t)).statusCode).toBe(401);
  });
});

describe('systèmes — client credentials', () => {
  it('un client système déclaré passe sans second facteur ni session ; sans déclaration, refusé', async () => {
    const env = await makeEnv();
    const sys = await env.signPro({ azp: 'syfa-system', sid: undefined, amr: undefined, sub: 'service-account-syfa-system' });
    expect((await me(env, sys)).json()).toMatchObject({ kind: 'system' });
    const unknown = await env.signPro({ azp: 'client-non-declare', sid: undefined, amr: undefined, sub: 'service-account-x' });
    expect((await me(env, unknown)).statusCode).toBe(401);
    expect((await env.db.query("SELECT 1 FROM auth_session WHERE subject LIKE 'service-account%'")).rows).toHaveLength(0);
  });
  it('un système ne peut pas gérer d\'appareils ni de session', async () => {
    const env = await makeEnv();
    const sys = await env.signPro({ azp: 'syfa-system', sid: undefined, amr: undefined, sub: 'service-account-syfa-system' });
    expect((await env.post('/v1/auth/devices', { deviceKey: DEVICE_KEY }, { authorization: `Bearer ${sys}` })).statusCode).toBe(403);
    expect((await env.post('/v1/auth/logout', {}, { authorization: `Bearer ${sys}` })).statusCode).toBe(403);
  });
});
