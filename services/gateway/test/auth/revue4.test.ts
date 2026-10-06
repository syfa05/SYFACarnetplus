import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { AUDIENCE, cleanup, ISSUER, makeEnv, type Env } from './helpers.js';

afterAll(cleanup);

const OUTSIDE = '203.0.113.5';
const NETS = { AUTH_ALLOWED_NETWORKS: '10.20.0.0/16,10.0.0.0/24', AUTH_RATE_IP_PER_MINUTE: '10000' };
const PROXY = '10.0.0.7';

const appWith = (env: Env, trustProxy: string) =>
  buildApp(loadConfig({ OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, TRUST_PROXY: trustProxy }), env.rt);

const get = async (env: Env, app: Env['app'], peer: string, headers: Record<string, string>, sid = 'w') =>
  app.inject({ method: 'GET', url: '/v1/me', remoteAddress: peer,
    headers: { authorization: `Bearer ${await env.signPro({ azp: 'syfa-web', sid, phone_number: '237677000111' })}`, ...headers } });
const events = async (env: Env) => (await env.db.query<{ type: string }>("SELECT type FROM auth_event WHERE type IN ('proxy_untrusted','network_denied') ORDER BY id")).rows.map((r) => r.type);

describe('S3 — la garde réseau contrôle l\'effet, pas seulement la configuration', () => {
  it('liste TRUST_PROXY erronée (le proxy réel n\'est pas dans la liste) : refus et trace', async () => {
    const env = await makeEnv(NETS);
    const app = appWith(env, PROXY);
    const r = await get(env, app, '10.0.0.8', { 'x-forwarded-for': OUTSIDE }); // avant correction : 200
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: 'network_not_allowed' });
    expect(await events(env)).toEqual(['proxy_untrusted']);
  });
  it('liste correcte : le client réel est évalué (extérieur refusé, établissement accepté)', async () => {
    const env = await makeEnv(NETS);
    const app = appWith(env, PROXY);
    expect((await get(env, app, PROXY, { 'x-forwarded-for': OUTSIDE })).statusCode).toBe(403);
    expect(await events(env)).toEqual(['network_denied']); // refus normal, pas un défaut de configuration
    expect((await get(env, app, PROXY, { 'x-forwarded-for': '10.20.1.1' }, 'w2')).statusCode).toBe(200);
    expect((await get(env, app, PROXY, { 'x-forwarded-for': `10.20.1.1, ${PROXY}` }, 'w3')).statusCode).toBe(200); // chaîne de proxys
    expect((await get(env, app, PROXY, { 'x-forwarded-for': `${OUTSIDE}, 10.20.1.1` }, 'w4')).statusCode).toBe(200); // l'adresse de gauche (forgée) est sans effet : seule celle du proxy compte
  });
  it('proxy déclaré mais qui ne transmet pas l\'adresse du client : refus', async () => {
    const env = await makeEnv(NETS);
    const app = appWith(env, PROXY);
    expect((await get(env, app, PROXY, {})).statusCode).toBe(403); // aucun en-tête
    expect((await get(env, app, PROXY, { 'x-real-ip': OUTSIDE }, 'w2')).statusCode).toBe(403); // seulement X-Real-IP (non lu)
    expect((await get(env, app, PROXY, { forwarded: `for=${OUTSIDE}` }, 'w3')).statusCode).toBe(403);
    expect(new Set(await events(env))).toEqual(new Set(['proxy_untrusted']));
  });
  it('pair non déclaré avec en-tête de proxy : refus, même si le pair est une adresse autorisée', async () => {
    const env = await makeEnv(NETS);
    const app = appWith(env, PROXY);
    expect((await get(env, app, '10.20.9.9', { 'x-forwarded-for': '10.20.1.1' })).statusCode).toBe(403);
    expect(await events(env)).toEqual(['proxy_untrusted']);
  });
  it('client direct, sans proxy ni en-tête : évalué sur son adresse', async () => {
    const env = await makeEnv(NETS);
    const app = appWith(env, PROXY);
    expect((await get(env, app, '10.20.1.1', {})).statusCode).toBe(200);
    expect((await get(env, app, OUTSIDE, {}, 'w2')).statusCode).toBe(403);
    expect(await events(env)).toEqual(['network_denied']);
  });
  it('sans TRUST_PROXY : aucun en-tête de proxy toléré (cas d\'origine)', async () => {
    const env = await makeEnv(NETS);
    expect((await get(env, env.app, '10.0.0.7', { 'x-forwarded-for': OUTSIDE })).statusCode).toBe(403);
    expect((await get(env, env.app, '10.20.1.1', {}, 'w2')).statusCode).toBe(200);
  });
  it('la même garde protège l\'enrôlement d\'appareil (liste erronée, proxy muet)', async () => {
    const env = await makeEnv(NETS);
    const app = appWith(env, PROXY);
    const t = await env.signPro({ azp: 'syfa-android-pro', sid: 'a', phone_number: '237677000111' });
    const enrol = (peer: string, headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/v1/auth/devices', remoteAddress: peer, payload: { deviceKey: 'k'.repeat(43) } as never, headers: { authorization: `Bearer ${t}`, ...headers } });
    expect((await enrol('10.0.0.8', { 'x-forwarded-for': OUTSIDE })).statusCode).toBe(403);
    expect((await enrol(PROXY, {})).statusCode).toBe(403);
    expect((await env.db.query('SELECT 1 FROM auth_professional_device')).rows).toHaveLength(0);
    expect((await enrol(PROXY, { 'x-forwarded-for': '10.20.1.1' })).statusCode).toBe(201);
  });
  it('la limitation de débit par adresse utilise bien l\'adresse du client derrière le proxy', async () => {
    const env = await makeEnv({ ...NETS, AUTH_RATE_IP_PER_MINUTE: '2' });
    const app = appWith(env, PROXY);
    const hit = (xff: string) => app.inject({ method: 'POST', url: '/v1/auth/patient/refresh', remoteAddress: PROXY, payload: { refreshToken: 'a'.repeat(43) } as never, headers: { 'x-forwarded-for': xff } });
    expect([(await hit('1.1.1.1')).statusCode, (await hit('1.1.1.1')).statusCode, (await hit('1.1.1.1')).statusCode]).toEqual([401, 401, 429]);
    expect((await hit('2.2.2.2')).statusCode).toBe(401);
  });
});
