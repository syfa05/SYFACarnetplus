import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadAuthConfig } from '../../src/auth/config.js';
import { loadConfig, parseTrustProxy } from '../../src/config.js';
import { AUDIENCE, cleanup, ISSUER, makeEnv, type Env } from './helpers.js';

afterAll(cleanup);

const INSIDE = '10.20.1.1';
const OUTSIDE = '203.0.113.5';
const NETS = { AUTH_ALLOWED_NETWORKS: '10.20.0.0/16', AUTH_RATE_IP_PER_MINUTE: '10000' };
const key = (i: number | string) => String(i).padStart(2, '0').repeat(22);

const call = (env: Env, method: 'GET' | 'POST' | 'DELETE', url: string, ip: string, o: { token?: string; payload?: unknown; headers?: Record<string, string>; app?: Env['app'] } = {}) =>
  (o.app ?? env.app).inject({ method, url, remoteAddress: ip, payload: o.payload as never,
    headers: { ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.headers ?? {}) } });
const enrol = (env: Env, token: string, k: string, ip = INSIDE, app?: Env['app']) =>
  call(env, 'POST', '/v1/auth/devices', ip, { token, payload: { deviceKey: k }, app });
const phone = (env: Env, sid = 'p1', extra: Record<string, unknown> = {}) =>
  env.signPro({ azp: 'syfa-android-pro', sid, sub: 'victime', phone_number: '237677000111', ...extra });

describe('R1 — l\'enrôlement d\'un appareil est réservé au réseau des établissements', () => {
  it('depuis l\'extérieur : refusé (403), rien d\'enregistré, aucun SMS ; depuis l\'établissement : accepté', async () => {
    const env = await makeEnv(NETS);
    const t = await phone(env);
    const out = await enrol(env, t, key(1), OUTSIDE);
    expect(out.statusCode).toBe(403);
    expect(out.json()).toEqual({ error: 'network_not_allowed' });
    expect((await env.db.query('SELECT 1 FROM auth_professional_device')).rows).toHaveLength(0);
    expect(env.sms.sent).toHaveLength(0);
    // l'attaquant ne peut donc pas utiliser l'application Android : appareil non enregistré
    expect((await call(env, 'GET', '/v1/me', OUTSIDE, { token: t, headers: { 'x-device-key': key(1) } })).json()).toEqual({ error: 'device_not_registered' });
    expect((await enrol(env, t, key(1), INSIDE)).statusCode).toBe(201);
    expect(env.sms.sent).toHaveLength(1);
  });
  it('l\'appareil enrôlé à l\'établissement fonctionne ensuite partout (mobilité) ; la révocation reste possible de l\'extérieur', async () => {
    const env = await makeEnv(NETS);
    const t = await phone(env);
    const id = (await enrol(env, t, key(1))).json().id;
    expect((await call(env, 'GET', '/v1/me', OUTSIDE, { token: t, headers: { 'x-device-key': key(1) } })).statusCode).toBe(200);
    expect((await call(env, 'GET', '/v1/auth/devices', OUTSIDE, { token: t, headers: { 'x-device-key': key(1) } })).statusCode).toBe(200);
    expect((await call(env, 'DELETE', `/v1/auth/devices/${id}`, OUTSIDE, { token: t, headers: { 'x-device-key': key(1) } })).statusCode).toBe(204);
  });
  it('le refus est tracé (une fois par minute) sans conserver l\'adresse', async () => {
    const env = await makeEnv(NETS);
    const t = await phone(env);
    for (let i = 0; i < 4; i++) await enrol(env, t, key(i), OUTSIDE);
    const ev = (await env.db.query("SELECT details FROM auth_event WHERE type='network_denied'")).rows;
    expect(ev).toEqual([{ details: { contexte: 'device_enrolment' } }]);
    expect(JSON.stringify(ev)).not.toContain(OUTSIDE);
  });
  it('désactivable explicitement (le temps qu\'un code d\'enrôlement existe) ; jeton web depuis l\'extérieur toujours refusé', async () => {
    const env = await makeEnv({ ...NETS, AUTH_DEVICE_ENROLMENT_NETWORK_ONLY: 'false' });
    expect((await enrol(env, await phone(env), key(1), OUTSIDE)).statusCode).toBe(201);
    expect((await call(env, 'GET', '/v1/me', OUTSIDE, { token: await env.signPro({ azp: 'syfa-web', sid: 'w' }) })).statusCode).toBe(403);
  });
  it('même un jeton « poste partagé » enrôle depuis le réseau, jamais depuis l\'extérieur', async () => {
    const env = await makeEnv(NETS);
    const web = await env.signPro({ azp: 'syfa-web', sid: 'w1', sub: 'victime' });
    expect((await enrol(env, web, key(1), OUTSIDE)).statusCode).toBe(403);
    expect((await enrol(env, web, key(1), INSIDE)).statusCode).toBe(201);
  });
});

describe('R3 — un proxy sans TRUST_PROXY est un refus bruyant, pas une ouverture silencieuse', () => {
  const DEV = { AUTH_ALLOWED_NETWORKS: '127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16', AUTH_RATE_IP_PER_MINUTE: '10000' };
  it.each(['x-forwarded-for', 'forwarded', 'x-real-ip'])('en-tête %s sans proxy de confiance déclaré : refusé et tracé', async (header) => {
    const env = await makeEnv(DEV);
    const web = await env.signPro({ azp: 'syfa-web', sid: 'w' });
    // proxy interne (adresse autorisée) devant un client externe : avant correction, 200
    const r = await call(env, 'GET', '/v1/me', '10.0.0.1', { token: web, headers: { [header]: OUTSIDE } });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: 'network_not_allowed' }); // même réponse : rien sur la configuration
    const ev = (await env.db.query("SELECT type FROM auth_event WHERE type IN ('proxy_untrusted','network_denied')")).rows;
    expect(ev).toEqual([{ type: 'proxy_untrusted' }]);
    // sans proxy : adresse interne directe, acceptée
    expect((await call(env, 'GET', '/v1/me', '10.0.0.1', { token: await env.signPro({ azp: 'syfa-web', sid: 'w2' }) })).statusCode).toBe(200);
  });
  it('le même refus protège l\'enrôlement d\'appareil', async () => {
    const env = await makeEnv(DEV);
    const t = await phone(env);
    const r = await call(env, 'POST', '/v1/auth/devices', '10.0.0.1', { token: t, payload: { deviceKey: key(1) }, headers: { 'x-forwarded-for': OUTSIDE } });
    expect(r.statusCode).toBe(403);
    expect((await env.db.query('SELECT 1 FROM auth_professional_device')).rows).toHaveLength(0);
  });
  it('avec le proxy déclaré : l\'adresse du client réel est évaluée', async () => {
    const env = await makeEnv(DEV);
    const app = buildApp(loadConfig({ OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, TRUST_PROXY: '10.0.0.1' }), env.rt);
    const web = await env.signPro({ azp: 'syfa-web', sid: 'w' });
    expect((await call(env, 'GET', '/v1/me', '10.0.0.1', { token: web, app, headers: { 'x-forwarded-for': OUTSIDE } })).statusCode).toBe(403);
    expect((await call(env, 'GET', '/v1/me', '10.0.0.1', { token: web, app, headers: { 'x-forwarded-for': '192.168.4.4' } })).statusCode).toBe(200);
  });
  it('R4 — les plages de proxys trop larges sont refusées ; adresses exactes acceptées', () => {
    for (const bad of ['10.0.0.0/8', '172.16.0.0/16', '0.0.0.0/0', 'fd00::/32']) expect(() => parseTrustProxy(bad), bad).toThrow(/trop large/);
    expect(parseTrustProxy('10.0.0.7')).toEqual(['10.0.0.7']);
    expect(parseTrustProxy('10.0.0.0/24')).toEqual(['10.0.0.0/24']);
  });
});

describe('R5 — plafond d\'appareils et inondation d\'alertes', () => {
  it('au plus 5 appareils actifs : le 6e est refusé (409), sans SMS', async () => {
    const env = await makeEnv(NETS);
    const t = await phone(env);
    for (let i = 0; i < 5; i++) expect((await enrol(env, t, key(i))).statusCode).toBe(201);
    const sixth = await enrol(env, t, key(5));
    expect(sixth.statusCode).toBe(409);
    expect(sixth.json()).toEqual({ error: 'device_limit_reached' });
    expect(env.sms.sent).toHaveLength(5);
    expect((await env.db.query("SELECT 1 FROM auth_professional_device WHERE status='active'")).rows).toHaveLength(5);
  });
  it('un nouvel enregistrement = exactement une alerte ; le réenregistrement ne coûte ni alerte ni quota', async () => {
    const env = await makeEnv(NETS);
    const t = await phone(env);
    for (let i = 0; i < 3; i++) { await enrol(env, t, key(0)); await enrol(env, t, key(1)); }
    expect(env.sms.sent).toHaveLength(2);
    expect((await enrol(env, t, key(2))).statusCode).toBe(201);
    expect(env.sms.sent).toHaveLength(3);
  });
  it('rotation (enregistrer, révoquer, recommencer) : quota horaire, jamais d\'appareil sans alerte', async () => {
    const env = await makeEnv(NETS);
    // la révocation ferme les sessions smartphone de l'utilisateur : chaque tour repart d'une session neuve
    for (let i = 0; i < 5; i++) {
      const r = await enrol(env, await phone(env, `e${i}`), key(i));
      expect(r.statusCode).toBe(201);
      await call(env, 'DELETE', `/v1/auth/devices/${r.json().id}`, INSIDE, { token: await phone(env, `d${i}`), headers: { 'x-device-key': key(i) } });
    }
    const flood = await enrol(env, await phone(env, 'sx'), key(9));
    expect(flood.statusCode).toBe(429);
    expect(Number(flood.headers['retry-after'])).toBeGreaterThan(0);
    expect(env.sms.sent).toHaveLength(5);
    expect((await env.db.query("SELECT 1 FROM auth_professional_device WHERE key_hash IS NOT NULL")).rows).toHaveLength(5); // le 6e n'existe pas
    env.clock.advance(3601);
    expect((await enrol(env, await phone(env, 'sy'), key(9))).statusCode).toBe(201); // nouvelle fenêtre
  });
  it('enregistrements simultanés : jamais plus que le plafond', async () => {
    const env = await makeEnv({ ...NETS, AUTH_DEVICE_MAX_ACTIVE: '3', AUTH_DEVICE_REGISTRATIONS_PER_WINDOW: '50' });
    const t = await phone(env);
    const res = await Promise.all(Array.from({ length: 8 }, (_, i) => enrol(env, t, key(i))));
    expect(res.filter((r) => r.statusCode === 201)).toHaveLength(3);
    expect(res.filter((r) => r.statusCode === 409)).toHaveLength(5);
    expect((await env.db.query("SELECT 1 FROM auth_professional_device WHERE status='active'")).rows).toHaveLength(3);
    expect(env.sms.sent).toHaveLength(3);
  });
  it('plafonds propres à chaque utilisateur et paramétrables', async () => {
    const env = await makeEnv({ ...NETS, AUTH_DEVICE_MAX_ACTIVE: '1' });
    expect((await enrol(env, await phone(env), key(1))).statusCode).toBe(201);
    expect((await enrol(env, await phone(env), key(2))).statusCode).toBe(409);
    const autre = await env.signPro({ azp: 'syfa-android-pro', sid: 'o', sub: 'autre' });
    expect((await enrol(env, autre, key(3))).statusCode).toBe(201);
    for (const bad of [{ AUTH_DEVICE_MAX_ACTIVE: '0' }, { AUTH_DEVICE_REGISTRATIONS_PER_WINDOW: 'x' }, { AUTH_DEVICE_REGISTRATION_WINDOW_SECONDS: '0' }]) expect(() => loadAuthConfig(bad)).toThrow();
    expect(loadAuthConfig({}).device).toEqual({ maxActive: 5, registrationsPerWindow: 5, registrationWindowSeconds: 3600 });
  });
});

describe('R7 — « tout le réseau » n\'est pas une restriction', () => {
  it.each(['0.0.0.0/0', '::/0', '10.0.0.0/8,0.0.0.0/0'])('%s refusé', (nets) => {
    expect(() => loadAuthConfig({ AUTH_ALLOWED_NETWORKS: nets })).toThrow(/autorise tout le réseau/);
  });
  it('permis explicitement en vidant les classes restreintes', () => {
    expect(() => loadAuthConfig({ AUTH_ALLOWED_NETWORKS: '0.0.0.0/0', AUTH_NETWORK_RESTRICTED_CLASSES: '' })).toThrow(); // la liste reste invalide : à retirer
    expect(loadAuthConfig({ AUTH_NETWORK_RESTRICTED_CLASSES: '' }).networkRestrictedClasses).toEqual([]);
  });
});
