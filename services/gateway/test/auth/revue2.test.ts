import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadAuthConfig } from '../../src/auth/config.js';
import { isWeakPin, NetworkPolicy, normalizeIp } from '../../src/auth/network.js';
import { loadConfig, parseTrustProxy } from '../../src/config.js';
import { AUDIENCE, cleanup, ISSUER, makeEnv, OTP_REQUEST, OTP_VERIFY, PHONE, type Env } from './helpers.js';

afterAll(cleanup);

const inject = (env: Env, url: string, remoteAddress: string, opts: { token?: string; headers?: Record<string, string>; method?: 'GET' | 'POST'; payload?: unknown; app?: Env['app'] } = {}) =>
  (opts.app ?? env.app).inject({
    method: opts.method ?? 'GET', url, remoteAddress, payload: opts.payload as never,
    headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers ?? {}) },
  });

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
