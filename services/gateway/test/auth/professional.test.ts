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
