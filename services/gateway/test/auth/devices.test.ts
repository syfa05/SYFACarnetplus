import { afterAll, describe, expect, it } from 'vitest';
import { loadAuthConfig } from '../../src/auth/config.js';
import { vi } from 'vitest';
import { cleanup, makeEnv, type Env } from './helpers.js';

afterAll(cleanup);

const DEVICE_KEY = 'k'.repeat(43);
const dk = (k = DEVICE_KEY) => ({ 'x-device-key': k });
const me = (env: Env, token: string, headers: Record<string, string> = {}) => env.get('/v1/me', token, headers);
const registerDevice = (env: Env, token: string, key = DEVICE_KEY, label = 'Téléphone de service') =>
  env.post('/v1/auth/devices', { deviceKey: key, label }, { authorization: `Bearer ${token}` });

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

describe('appareils des professionnels (onglet 6.2)', () => {
  const phone = { azp: 'syfa-android-pro', sid: 'ph-dev', phone_number: '237677000111' };

  it('smartphone sans appareil enregistré : refusé ; poste partagé : pas d\'appareil exigé', async () => {
    const env = await makeEnv();
    const t = await env.signPro(phone);
    expect((await me(env, t)).json()).toEqual({ error: 'device_not_registered' });
    expect((await me(env, t, dk('z'.repeat(43)))).json()).toEqual({ error: 'device_not_registered' });
    expect((await me(env, await env.signPro({ sid: 'pc-x' }))).statusCode).toBe(200);
  });
  it('enregistrement : alerte « nouvel appareil » par SMS neutre ; réenregistrement idempotent sans nouvelle alerte', async () => {
    const env = await makeEnv();
    const t = await env.signPro(phone);
    const r = await registerDevice(env, t);
    expect(r.statusCode).toBe(201);
    expect(env.sms.sent).toHaveLength(1);
    expect(env.sms.sent[0]!.to).toBe('237677000111');
    expect(env.sms.sent[0]!.text).not.toMatch(/https?:|www\.|\//);
    expect(env.sms.sent[0]!.text).not.toMatch(/hôpital|clinique|centre|pharmacie|patient/i);
    const again = await registerDevice(env, t);
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(r.json().id);
    expect(env.sms.sent).toHaveLength(1);
    expect((await me(env, t, dk())).statusCode).toBe(200);
    // second appareil : nouvelle alerte
    expect((await registerDevice(env, t, 'q'.repeat(43), 'Tablette')).statusCode).toBe(201);
    expect(env.sms.sent).toHaveLength(2);
  });
  it('alerte en anglais selon la langue du jeton', async () => {
    const env = await makeEnv();
    await registerDevice(env, await env.signPro({ ...phone, locale: 'en-GB' }));
    expect(env.sms.sent[0]!.text).toMatch(/new device/);
  });
  it('sans numéro de téléphone valide : enrôlement refusé (409), rien d\'enregistré, aucune alerte possible donc aucun appareil', async () => {
    const env = await makeEnv();
    for (const [i, claim] of [undefined, '', '690000001', '23767700011', 'abc'].entries()) {
      const t = await env.signPro({ azp: 'syfa-android-pro', sid: `np${i}`, phone_number: claim });
      const r = await registerDevice(env, t);
      expect(r.statusCode, String(claim)).toBe(409);
      expect(r.json()).toEqual({ error: 'phone_required' });
    }
    expect((await env.db.query('SELECT 1 FROM auth_professional_device')).rows).toHaveLength(0);
    expect(env.sms.sent).toHaveLength(0);
    expect((await env.db.query("SELECT 1 FROM auth_event WHERE type='device_enrolment_refused'")).rows.length).toBeGreaterThan(0);
  });
  it('échec de l\'envoi de l\'alerte : enrôlement annulé (503), aucun appareil, quota intact, aucun message externe conservé', async () => {
    const env = await makeEnv();
    const t = await env.signPro(phone);
    env.sms.failNext = true;
    const r = await registerDevice(env, t);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: 'alert_failed' });
    expect((await env.db.query('SELECT 1 FROM auth_professional_device')).rows).toHaveLength(0);
    expect((await env.get('/v1/me', t, dk())).json()).toEqual({ error: 'device_not_registered' }); // inutilisable
    const ev = JSON.stringify((await env.db.query("SELECT details FROM auth_event WHERE type='device_alert_failed'")).rows);
    expect(ev).toContain('Error:HTTP_503');
    expect(ev).not.toMatch(/Dupont/);
    // un nouvel essai réussit, et un seul enregistrement est compté dans le quota
    expect((await registerDevice(env, t)).statusCode).toBe(201);
    expect(env.sms.sent).toHaveLength(1);
    expect((await env.db.query("SELECT 1 FROM auth_rate_limit WHERE key LIKE 'device-register:%'")).rows).toHaveLength(1);
    expect(Number((await env.db.query<{ hits: number }>("SELECT hits FROM auth_rate_limit WHERE key LIKE 'device-register:%'")).rows[0]!.hits)).toBe(1);
  });
  it('le réenregistrement d\'un appareil existant ne demande ni numéro ni alerte', async () => {
    const env = await makeEnv();
    const t = await env.signPro(phone);
    await registerDevice(env, t);
    // même utilisateur, jeton sans numéro, même clé : rien de nouveau
    const sameUser = await env.signPro({ azp: 'syfa-android-pro', sid: 'again2', phone_number: undefined, sub: 'pro-1' });
    expect((await registerDevice(env, sameUser)).statusCode).toBe(200);
    expect(env.sms.sent).toHaveLength(1);
  });
  it('première alerte désactivable : le premier appareil n\'exige pas de numéro, le suivant oui', async () => {
    const env = await makeEnv({ AUTH_ALERT_ON_FIRST_DEVICE: 'false' });
    const t = await env.signPro({ azp: 'syfa-android-pro', sid: 'f1', phone_number: undefined });
    expect((await registerDevice(env, t, 'a'.repeat(43))).statusCode).toBe(201);
    expect(env.sms.sent).toHaveLength(0);
    expect((await registerDevice(env, t, 'b'.repeat(43))).statusCode).toBe(409); // deuxième appareil : alerte obligatoire
  });
  it('révocation : l\'appareil et les sessions sont refusés ; un appareil révoqué ne se réenregistre pas', async () => {
    const env = await makeEnv();
    const t = await env.signPro(phone);
    const id = (await registerDevice(env, t)).json().id;
    expect((await env.get('/v1/auth/devices', t, dk())).json()).toHaveLength(1);
    const del = await env.app.inject({ method: 'DELETE', url: `/v1/auth/devices/${id}`, headers: { authorization: `Bearer ${t}`, ...dk() } });
    expect(del.statusCode).toBe(204);
    expect((await me(env, t, dk())).statusCode).toBe(401);
    const fresh = await env.signPro({ ...phone, sid: 'ph-after-revoke' }); // session ouverte après la révocation
    expect((await registerDevice(env, fresh)).statusCode).toBe(409);
    expect((await registerDevice(env, fresh, 'n'.repeat(43))).statusCode).toBe(201); // nouvelle clé : alertée
  });
  it('on ne voit ni ne révoque que ses propres appareils', async () => {
    const env = await makeEnv();
    const alice = await env.signPro({ ...phone, sub: 'alice', sid: 'a' });
    const id = (await registerDevice(env, alice)).json().id;
    const bob = await env.signPro({ azp: 'syfa-web', sub: 'bob', sid: 'b' });
    expect((await env.get('/v1/auth/devices', bob)).json()).toEqual([]);
    const del = await env.app.inject({ method: 'DELETE', url: `/v1/auth/devices/${id}`, headers: { authorization: `Bearer ${bob}` } });
    expect(del.statusCode).toBe(404);
    expect((await me(env, alice, dk())).statusCode).toBe(200);
  });
  it('la clé d\'appareil n\'est jamais stockée en clair ; validation de format', async () => {
    const env = await makeEnv();
    const t = await env.signPro(phone);
    expect((await registerDevice(env, t, 'court')).statusCode).toBe(400);
    expect((await registerDevice(env, t, 'é'.repeat(40))).statusCode).toBe(400);
    await registerDevice(env, t);
    const row = JSON.stringify((await env.db.query('SELECT * FROM auth_professional_device')).rows);
    expect(row).not.toContain(DEVICE_KEY);
    const ev = JSON.stringify((await env.db.query('SELECT * FROM auth_event')).rows);
    expect(ev).not.toContain(DEVICE_KEY);
    expect(ev).not.toContain('237677000111');
  });
  it('un patient ne peut pas gérer d\'appareils professionnels', async () => {
    const env = await makeEnv();
    await env.addPatient();
    const { enrol } = await import('./helpers.js');
    const e = await enrol(env);
    expect((await env.post('/v1/auth/devices', { deviceKey: DEVICE_KEY }, { authorization: `Bearer ${e.accessToken}` })).statusCode).toBe(403);
  });
});

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
    const web = await env.signPro({ azp: 'syfa-web', sid: 'w1', sub: 'victime', phone_number: '237677000111' });
    expect((await enrol(env, web, key(1), OUTSIDE)).statusCode).toBe(403);
    expect((await enrol(env, web, key(1), INSIDE)).statusCode).toBe(201);
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
    const autre = await env.signPro({ azp: 'syfa-android-pro', sid: 'o', sub: 'autre', phone_number: '237677000112' });
    expect((await enrol(env, autre, key(3))).statusCode).toBe(201);
    for (const bad of [{ AUTH_DEVICE_MAX_ACTIVE: '0' }, { AUTH_DEVICE_REGISTRATIONS_PER_WINDOW: 'x' }, { AUTH_DEVICE_REGISTRATION_WINDOW_SECONDS: '0' }]) expect(() => loadAuthConfig(bad)).toThrow();
    expect(loadAuthConfig({}).device).toEqual({ maxActive: 5, registrationsPerWindow: 5, registrationWindowSeconds: 3600, pendingSeconds: 300 });
  });
});

describe('enrôlement en trois temps : aucun appel externe sous transaction (réserve de la revue externe)', () => {
  const pending = async (env: Env) => (await env.db.query<{ status: string }>('SELECT status FROM auth_professional_device ORDER BY created_at')).rows.map((r) => r.status);
  /** Fait échouer l'activation (3e temps) comme le ferait une panne de base juste après l'envoi du SMS. */
  const breakActivation = (env: Env) => {
    const db = env.db as unknown as { transaction: (fn: (tx: { query: (s: string, p?: unknown[]) => Promise<unknown> }) => Promise<unknown>) => Promise<unknown> };
    const real = db.transaction.bind(db);
    return vi.spyOn(db, 'transaction').mockImplementation((fn) => real((tx) => fn({ ...tx, query: (sql: string, p?: unknown[]) => {
      if (/SET status='active'/.test(sql)) throw new Error('db down');
      return tx.query(sql, p);
    } } as never)));
  };

  it('l\'appareil est « pending » (inutilisable) au moment où le SMS part, puis « active »', async () => {
    const env = await makeEnv(NETS);
    const t = await phone(env);
    let seen: string[] = [];
    let usable = 0;
    env.sms.onSend = async () => {
      seen = await pending(env);
      usable = (await call(env, 'GET', '/v1/me', INSIDE, { token: t, headers: { 'x-device-key': key(1) } })).statusCode;
    };
    expect((await enrol(env, t, key(1))).statusCode).toBe(201);
    expect(seen).toEqual(['pending']);
    expect(usable).toBe(401); // pas encore utilisable
    expect(await pending(env)).toEqual(['active']);
    expect((await call(env, 'GET', '/v1/me', INSIDE, { token: t, headers: { 'x-device-key': key(1) } })).statusCode).toBe(200);
  });
  it('un fournisseur SMS lent ne bloque pas les autres enrôlements du même professionnel (aucune transaction ni verrou tenus pendant l\'envoi)', async () => {
    const env = await makeEnv(NETS);
    let release!: () => void;
    env.sms.gate = new Promise<void>((r) => (release = r));
    const t = await phone(env);
    const a = enrol(env, t, key(1));
    const b = enrol(env, t, key(2));
    await vi.waitFor(() => expect(env.sms.started).toBe(2)); // B a franchi la réservation pendant que A attend son SMS
    expect(await pending(env)).toEqual(['pending', 'pending']);
    release();
    expect([(await a).statusCode, (await b).statusCode]).toEqual([201, 201]);
    expect(await pending(env)).toEqual(['active', 'active']);
  });
  it('SMS accepté puis activation en échec : l\'appareil reste inutilisable ; la reprise réussit (alerte renvoyée : au moins une fois)', async () => {
    const env = await makeEnv(NETS);
    const t = await phone(env);
    const spy = breakActivation(env);
    expect((await enrol(env, t, key(1))).statusCode).toBe(500); // panne : erreur générique, rien d'autre
    spy.mockRestore();
    expect(env.sms.sent).toHaveLength(1);                       // l'alerte est partie
    expect(await pending(env)).toEqual(['pending']);            // mais l'appareil n'est pas actif
    expect((await call(env, 'GET', '/v1/me', INSIDE, { token: t, headers: { 'x-device-key': key(1) } })).json()).toEqual({ error: 'device_not_registered' });
    const retry = await enrol(env, t, key(1));
    expect(retry.statusCode).toBe(201);
    expect(env.sms.sent).toHaveLength(2);                       // renvoi documenté
    expect(await pending(env)).toEqual(['active']);             // une seule ligne, jamais de doublon
    expect((await call(env, 'GET', '/v1/me', INSIDE, { token: t, headers: { 'x-device-key': key(1) } })).statusCode).toBe(200);
  });
  it('une réservation orpheline compte dans le plafond jusqu\'à son expiration, puis plus', async () => {
    const env = await makeEnv({ ...NETS, AUTH_DEVICE_MAX_ACTIVE: '1' });
    const t = await phone(env);
    const spy = breakActivation(env);
    await enrol(env, t, key(1));
    spy.mockRestore();
    expect((await enrol(env, await phone(env, 'p2'), key(2))).statusCode).toBe(409); // la réservation compte encore
    env.clock.advance(301);
    expect((await enrol(env, await phone(env, 'p3'), key(2))).statusCode).toBe(201); // expirée : ne bloque plus
    expect((await env.db.query("SELECT 1 FROM auth_professional_device WHERE status='active'")).rows).toHaveLength(1);
  });
  it('échec du SMS : réservation supprimée (aucune ligne), quota rendu exactement, nouvel essai possible', async () => {
    const env = await makeEnv(NETS);
    const t = await phone(env);
    env.sms.failNext = true;
    expect((await enrol(env, t, key(1))).json()).toEqual({ error: 'alert_failed' });
    expect(await pending(env)).toEqual([]);
    expect((await env.db.query<{ hits: number }>("SELECT hits FROM auth_rate_limit WHERE key LIKE 'device-register:%'")).rows.map((r) => Number(r.hits))).toEqual([0]);
    expect((await enrol(env, t, key(1))).statusCode).toBe(201);
    expect((await env.db.query<{ hits: number }>("SELECT hits FROM auth_rate_limit WHERE key LIKE 'device-register:%'")).rows.map((r) => Number(r.hits))).toEqual([1]);
  });
  it('un appareil en attente se révoque comme un autre ; une révocation pendant l\'envoi bloque l\'activation', async () => {
    const env = await makeEnv(NETS);
    const t = await phone(env);
    env.sms.onSend = async () => {
      const id = (await env.db.query<{ id: string }>('SELECT id FROM auth_professional_device')).rows[0]!.id;
      await env.rt.devices.revoke(id, { reason: 'test', actor: 'victime' });
    };
    const r = await enrol(env, t, key(1));
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'enrolment_interrupted' });
    expect(await pending(env)).toEqual(['revoked']);
  });
});
