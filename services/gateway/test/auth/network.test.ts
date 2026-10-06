import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadAuthConfig } from '../../src/auth/config.js';
import { isWeakPin, NetworkPolicy, normalizeIp } from '../../src/auth/network.js';
import { loadConfig, parseTrustProxy } from '../../src/config.js';
import { AUDIENCE, cleanup, ISSUER, makeEnv, type Env } from './helpers.js';

afterAll(cleanup);

const inject = (env: Env, url: string, remoteAddress: string, opts: { token?: string; headers?: Record<string, string>; method?: 'GET' | 'POST'; payload?: unknown; app?: Env['app'] } = {}) =>
  (opts.app ?? env.app).inject({
    method: opts.method ?? 'GET', url, remoteAddress, payload: opts.payload as never,
    headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers ?? {}) },
  });

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

const PROXY = '10.0.0.7';
const NETS_PROXY = { AUTH_ALLOWED_NETWORKS: '10.20.0.0/16,10.0.0.0/24', AUTH_RATE_IP_PER_MINUTE: '10000' };

const appWith = (env: Env, trustProxy: string) =>
  buildApp(loadConfig({ OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, TRUST_PROXY: trustProxy }), env.rt);

const get = async (env: Env, app: Env['app'], peer: string, headers: Record<string, string>, sid = 'w') =>
  app.inject({ method: 'GET', url: '/v1/me', remoteAddress: peer,
    headers: { authorization: `Bearer ${await env.signPro({ azp: 'syfa-web', sid, phone_number: '237677000111' })}`, ...headers } });
const events = async (env: Env) => (await env.db.query<{ type: string }>("SELECT type FROM auth_event WHERE type IN ('proxy_untrusted','network_denied') ORDER BY id")).rows.map((r) => r.type);

describe('Q8 — confiance au reverse proxy (limitation de débit non contournable)', () => {
  it('TRUST_PROXY : « true » et un nombre de sauts refusés ; liste de CIDR acceptée', () => {
    expect(() => parseTrustProxy('true')).toThrow(/liste des adresses/);
    expect(() => parseTrustProxy('1')).toThrow();
    expect(() => parseTrustProxy('0')).toThrow();
    expect(() => parseTrustProxy(',')).toThrow();
    expect(() => parseTrustProxy('10.0.0.0/33')).toThrow();
    expect(() => parseTrustProxy('pas-une-adresse')).toThrow();
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('10.0.0.1, 192.168.1.1/32, 10.0.5.0/24, fd00::1')).toEqual(['10.0.0.1', '192.168.1.1/32', '10.0.5.0/24', 'fd00::1']);
    expect(() => parseTrustProxy('10.0.0.0/8')).toThrow(/trop large/);
    expect(() => parseTrustProxy('fd00::/16')).toThrow(/trop large/);
    expect(() => loadConfig({ OIDC_ISSUER: 'a', OIDC_AUDIENCE: 'b', TRUST_PROXY: 'true' })).toThrow();
  });
  const refresh = (env: Env, app: Env['app'], xff: string, from = '10.0.0.1') =>
    inject(env, '/v1/auth/patient/refresh', from, { method: 'POST', payload: { refreshToken: 'a'.repeat(43) }, headers: { 'x-forwarded-for': xff }, app });

  it('avec un proxy de confiance (liste) : faire varier le début de X-Forwarded-For ne change pas le compteur', async () => {
    const env = await makeEnv({ AUTH_RATE_IP_PER_MINUTE: '3' });
    const app = buildApp(loadConfig({ OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, TRUST_PROXY: '10.0.0.1' }), env.rt);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await refresh(env, app, `1.1.1.${i}, 9.9.9.9`)).statusCode); // le proxy a ajouté 9.9.9.9
    expect(codes).toEqual([401, 401, 401, 429, 429, 429]);
    expect((await refresh(env, app, '1.1.1.1, 8.8.8.8')).statusCode).toBe(401); // autre client réel : autre compteur
  });
  it('sans proxy de confiance : X-Forwarded-For est ignoré (adresse de la connexion)', async () => {
    const env = await makeEnv({ AUTH_RATE_IP_PER_MINUTE: '3' });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await refresh(env, env.app, `7.7.7.${i}`, '10.0.0.1')).statusCode);
    expect(codes).toEqual([401, 401, 401, 429, 429]);
  });
});

describe('Q4 — restriction réseau des postes partagés', () => {
  const web = (env: Env, sid = 'w1') => env.signPro({ azp: 'syfa-web', sid });

  it('adresse autorisée : accepté ; adresse extérieure : 403, aucune session créée', async () => {
    const env = await makeEnv({ AUTH_ALLOWED_NETWORKS: '10.20.0.0/16,192.168.5.0/24,2001:db8::/32' });
    const t = await web(env);
    for (const ip of ['10.20.3.4', '192.168.5.200', '2001:db8:1::5', '::ffff:10.20.9.9']) expect((await inject(env, '/v1/me', ip, { token: t })).statusCode, ip).toBe(200);
    const t2 = await web(env, 'w2');
    for (const ip of ['203.0.113.5', '10.21.0.1', '192.168.6.1', '2001:db9::1', '8.8.8.8']) {
      const r = await inject(env, '/v1/me', ip, { token: t2 });
      expect(r.statusCode, ip).toBe(403);
      expect(r.json()).toEqual({ error: 'network_not_allowed' });
    }
    expect((await env.db.query("SELECT 1 FROM auth_session WHERE id LIKE '%:w2:%' OR id = 'kc:w2:syfa-web'")).rows).toHaveLength(0);
  });
  it('le refus est tracé une fois par minute et par utilisateur, sans adresse IP', async () => {
    const env = await makeEnv();
    const t = await web(env);
    for (let i = 0; i < 5; i++) await inject(env, '/v1/me', '203.0.113.5', { token: t });
    const ev = (await env.db.query<{ details: unknown }>("SELECT details FROM auth_event WHERE type='network_denied'")).rows;
    expect(ev).toHaveLength(1);
    expect(JSON.stringify(ev)).not.toContain('203.0.113.5');
    env.clock.advance(61);
    await inject(env, '/v1/me', '203.0.113.5', { token: t });
    expect((await env.db.query("SELECT 1 FROM auth_event WHERE type='network_denied'")).rows).toHaveLength(2);
  });
  it('X-Forwarded-For ne donne pas accès (sans proxy de confiance) ; avec un proxy de confiance, seule l\'entrée ajoutée par le proxy compte', async () => {
    const env = await makeEnv({ AUTH_ALLOWED_NETWORKS: '10.20.0.0/16' });
    const t = await web(env);
    const spoof = await inject(env, '/v1/me', '203.0.113.5', { token: t, headers: { 'x-forwarded-for': '10.20.1.1' } });
    expect(spoof.statusCode).toBe(403);
    const proxied = buildApp(loadConfig({ OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, TRUST_PROXY: '10.0.0.1' }), env.rt);
    // le proxy (10.0.0.1) a vu le client réel 203.0.113.5 ; l'appelant a ajouté une fausse adresse autorisée devant
    const forged = await inject(env, '/v1/me', '10.0.0.1', { token: t, app: proxied, headers: { 'x-forwarded-for': '10.20.1.1, 203.0.113.5' } });
    expect(forged.statusCode).toBe(403);
    const real = await inject(env, '/v1/me', '10.0.0.1', { token: t, app: proxied, headers: { 'x-forwarded-for': '10.20.1.1' } });
    expect(real.statusCode).toBe(200);
  });
  it('les smartphones (une fois enrôlés), les patients et les systèmes ne sont pas concernés ; restriction désactivable ou extensible', async () => {
    const env = await makeEnv({ AUTH_ALLOWED_NETWORKS: '10.20.0.0/16' });
    const phone = await env.signPro({ azp: 'syfa-android-pro', sid: 'p1', phone_number: '237677000111' });
    await inject(env, '/v1/auth/devices', '10.20.1.1', { method: 'POST', token: phone, payload: { deviceKey: 'k'.repeat(43) } }); // enrôlement : sur le réseau de l'établissement
    expect((await inject(env, '/v1/me', '203.0.113.5', { token: phone, headers: { 'x-device-key': 'k'.repeat(43) } })).statusCode).toBe(200);
    const sys = await env.signPro({ azp: 'syfa-system', sid: undefined, amr: undefined, sub: 'service-account-syfa-system' });
    expect((await inject(env, '/v1/me', '203.0.113.5', { token: sys })).statusCode).toBe(200);
    const open = await makeEnv({ AUTH_ALLOWED_NETWORKS: '10.20.0.0/16', AUTH_NETWORK_RESTRICTED_CLASSES: '' });
    expect((await inject(open, '/v1/me', '203.0.113.5', { token: await web(open) })).statusCode).toBe(200);
    const both = await makeEnv({ AUTH_ALLOWED_NETWORKS: '10.20.0.0/16', AUTH_NETWORK_RESTRICTED_CLASSES: 'shared_pc,smartphone' });
    const ph2 = await both.signPro({ azp: 'syfa-android-pro', sid: 'p2' });
    expect((await inject(both, '/v1/me', '203.0.113.5', { token: ph2 })).statusCode).toBe(403);
  });
  it('par défaut : boucle locale seulement (refus par défaut) ; configuration invalide refusée', async () => {
    const env = await makeEnv();
    const t = await web(env);
    expect((await inject(env, '/v1/me', '127.0.0.1', { token: t })).statusCode).toBe(200);
    expect((await inject(env, '/v1/me', '10.1.2.3', { token: await web(env, 'w9') })).statusCode).toBe(403);
    for (const bad of ['10.0.0.0/40', 'abc', '10.0.0.0/8/9', '10.0.0.0/x', '1.2.3']) expect(() => loadAuthConfig({ AUTH_ALLOWED_NETWORKS: bad }), bad).toThrow();
    expect(() => loadAuthConfig({ AUTH_NETWORK_RESTRICTED_CLASSES: 'shared_pc', AUTH_ALLOWED_NETWORKS: ',' })).toThrow();
    expect(() => loadAuthConfig({ AUTH_NETWORK_RESTRICTED_CLASSES: 'patient_app' })).toThrow();
  });
  it('NetworkPolicy : normalisation et adresses illisibles refusées', () => {
    expect(normalizeIp('::ffff:10.1.2.3')).toBe('10.1.2.3');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
    expect(normalizeIp('n/a')).toBeNull();
    const p = new NetworkPolicy(['10.0.0.0/8', '203.0.113.7']);
    expect(p.allows('10.255.255.255')).toBe(true);
    expect(p.allows('203.0.113.7')).toBe(true);
    expect(p.allows('203.0.113.8')).toBe(false);
    expect(p.allows(undefined)).toBe(false);
    expect(p.allows('')).toBe(false);
    expect(p.allows('10.0.0.1, 8.8.8.8')).toBe(false);
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

describe('R7 — « tout le réseau » n\'est pas une restriction', () => {
  it.each(['0.0.0.0/0', '::/0', '10.0.0.0/8,0.0.0.0/0'])('%s refusé', (nets) => {
    expect(() => loadAuthConfig({ AUTH_ALLOWED_NETWORKS: nets })).toThrow(/autorise tout le réseau/);
  });
  it('permis explicitement en vidant les classes restreintes', () => {
    expect(() => loadAuthConfig({ AUTH_ALLOWED_NETWORKS: '0.0.0.0/0', AUTH_NETWORK_RESTRICTED_CLASSES: '' })).toThrow(); // la liste reste invalide : à retirer
    expect(loadAuthConfig({ AUTH_NETWORK_RESTRICTED_CLASSES: '' }).networkRestrictedClasses).toEqual([]);
  });
});

describe('S3 — la garde réseau contrôle l\'effet, pas seulement la configuration', () => {
  it('liste TRUST_PROXY erronée (le proxy réel n\'est pas dans la liste) : refus et trace', async () => {
    const env = await makeEnv(NETS_PROXY);
    const app = appWith(env, PROXY);
    const r = await get(env, app, '10.0.0.8', { 'x-forwarded-for': OUTSIDE }); // avant correction : 200
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: 'network_not_allowed' });
    expect(await events(env)).toEqual(['proxy_untrusted']);
  });
  it('liste correcte : le client réel est évalué (extérieur refusé, établissement accepté)', async () => {
    const env = await makeEnv(NETS_PROXY);
    const app = appWith(env, PROXY);
    expect((await get(env, app, PROXY, { 'x-forwarded-for': OUTSIDE })).statusCode).toBe(403);
    expect(await events(env)).toEqual(['network_denied']); // refus normal, pas un défaut de configuration
    expect((await get(env, app, PROXY, { 'x-forwarded-for': '10.20.1.1' }, 'w2')).statusCode).toBe(200);
    expect((await get(env, app, PROXY, { 'x-forwarded-for': `10.20.1.1, ${PROXY}` }, 'w3')).statusCode).toBe(200); // chaîne de proxys
    expect((await get(env, app, PROXY, { 'x-forwarded-for': `${OUTSIDE}, 10.20.1.1` }, 'w4')).statusCode).toBe(200); // l'adresse de gauche (forgée) est sans effet : seule celle du proxy compte
  });
  it('proxy déclaré mais qui ne transmet pas l\'adresse du client : refus', async () => {
    const env = await makeEnv(NETS_PROXY);
    const app = appWith(env, PROXY);
    expect((await get(env, app, PROXY, {})).statusCode).toBe(403); // aucun en-tête
    expect((await get(env, app, PROXY, { 'x-real-ip': OUTSIDE }, 'w2')).statusCode).toBe(403); // seulement X-Real-IP (non lu)
    expect((await get(env, app, PROXY, { forwarded: `for=${OUTSIDE}` }, 'w3')).statusCode).toBe(403);
    expect(new Set(await events(env))).toEqual(new Set(['proxy_untrusted']));
  });
  it('pair non déclaré avec en-tête de proxy : refus, même si le pair est une adresse autorisée', async () => {
    const env = await makeEnv(NETS_PROXY);
    const app = appWith(env, PROXY);
    expect((await get(env, app, '10.20.9.9', { 'x-forwarded-for': '10.20.1.1' })).statusCode).toBe(403);
    expect(await events(env)).toEqual(['proxy_untrusted']);
  });
  it('client direct, sans proxy ni en-tête : évalué sur son adresse', async () => {
    const env = await makeEnv(NETS_PROXY);
    const app = appWith(env, PROXY);
    expect((await get(env, app, '10.20.1.1', {})).statusCode).toBe(200);
    expect((await get(env, app, OUTSIDE, {}, 'w2')).statusCode).toBe(403);
    expect(await events(env)).toEqual(['network_denied']);
  });
  it('sans TRUST_PROXY : aucun en-tête de proxy toléré (cas d\'origine)', async () => {
    const env = await makeEnv(NETS_PROXY);
    expect((await get(env, env.app, '10.0.0.7', { 'x-forwarded-for': OUTSIDE })).statusCode).toBe(403);
    expect((await get(env, env.app, '10.20.1.1', {}, 'w2')).statusCode).toBe(200);
  });
  it('la même garde protège l\'enrôlement d\'appareil (liste erronée, proxy muet)', async () => {
    const env = await makeEnv(NETS_PROXY);
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
    const env = await makeEnv({ ...NETS_PROXY, AUTH_RATE_IP_PER_MINUTE: '2' });
    const app = appWith(env, PROXY);
    const hit = (xff: string) => app.inject({ method: 'POST', url: '/v1/auth/patient/refresh', remoteAddress: PROXY, payload: { refreshToken: 'a'.repeat(43) } as never, headers: { 'x-forwarded-for': xff } });
    expect([(await hit('1.1.1.1')).statusCode, (await hit('1.1.1.1')).statusCode, (await hit('1.1.1.1')).statusCode]).toEqual([401, 401, 429]);
    expect((await hit('2.2.2.2')).statusCode).toBe(401);
  });
});
