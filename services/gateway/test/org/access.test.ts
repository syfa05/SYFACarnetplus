import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { requireAccess } from '../../src/authz/guard.js';
import { loadConfig } from '../../src/config.js';
import { enrol } from '../auth/helpers.js';
import { cleanup, makeOrgEnv, type OrgEnv } from './helpers.js';

afterEach(cleanup);

const CONFIG = loadConfig({ OIDC_ISSUER: 'http://kc.test/realms/syfa', OIDC_AUDIENCE: 'syfa-gateway' });
const episode = (establishmentId: string, over = {}) => ({ establishmentId, serviceId: null, serviceScoped: false, expiresAt: new Date('2026-10-08T10:00:00Z'), closedAt: null, ...over });

/**
 * Route de démonstration : appelle le moteur par le garde, exactement comme le feront les services de données.
 * (Aucune route de données n'existe encore : lots L5 et L6.) Le contexte vient d'un en-tête pour piloter les cas.
 */
async function appWithRoute(e: OrgEnv, episodeOf: (est: string | null) => unknown) {
  const guard = e.rt.access;
  return buildApp(CONFIG, e.rt, (secured) => {
    secured.get('/v1/test/patients/:id/summary', {
      preHandler: requireAccess(guard, (req) => ({
        patientId: (req.params as { id: string }).id, action: 'C', data: 'summary',
        context: { episode: episodeOf(req.staff?.establishmentId ?? null) as never, opposedProfessionals: String(req.headers['x-opposed'] ?? '').split(',').filter(Boolean) },
      })),
    }, async (req) => ({ ok: true, fields: req.access && 'fields' in req.access ? req.access.fields ?? null : null }));
  });
}

async function world() {
  const e = await makeOrgEnv();
  const est = await e.establishment('A-1');
  const dir = await e.staff('op-1', 'dir.a', est, [{ role: 'directeur_medical' }]);
  const doc = await e.staff(dir, 'dr.a', est, [{ role: 'medecin' }]);
  const sec = await e.staff(dir, 'sec.a', est, [{ role: 'secretaire' }]);
  const pha = await e.staff(dir, 'ph.a', est, [{ role: 'pharmacien' }]);
  const patient = await e.addPatient();
  return { e, est, dir, doc, sec, pha, patient };
}
const get = (app: Awaited<ReturnType<typeof appWithRoute>>, id: string, token?: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: `/v1/test/patients/${id}/summary`, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });

describe('autorisation par appel direct à l\'API (T-ACC-01 à T-ACC-05)', () => {
  it('sans jeton : 401 avant tout calcul de droit', async () => {
    const { e, est, patient } = await world();
    expect((await get(await appWithRoute(e, () => episode(est)), patient)).statusCode).toBe(401);
  });
  it('T-ACC-01 : la secrétaire n\'ouvre pas le résumé, le refus est journalisé', async () => {
    const { e, est, sec, patient } = await world();
    const app = await appWithRoute(e, () => episode(est));
    const r = await get(app, patient, await e.tok(sec));
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: 'forbidden' }); // aucun motif renvoyé à l'appelant
    expect((await e.db.query('SELECT reason, data, action, patient_id FROM access_denial WHERE actor_sub=$1', [sec])).rows).toEqual([{ reason: 'role_not_permitted', data: 'summary', action: 'C', patient_id: patient }]);
  });
  it('T-ACC-02 : médecin sans prise en charge ouverte, ou d\'un autre établissement : refus journalisé', async () => {
    const { e, est, doc, patient } = await world();
    expect((await get(await appWithRoute(e, () => undefined), patient, await e.tok(doc))).statusCode).toBe(403);
    expect((await get(await appWithRoute(e, () => episode('autre-etablissement')), patient, await e.tok(doc))).statusCode).toBe(403);
    expect((await e.db.query('SELECT reason FROM access_denial WHERE actor_sub=$1 ORDER BY id', [doc])).rows.map((r) => (r as { reason: string }).reason)).toEqual(['episode_required', 'other_establishment']);
    expect((await get(await appWithRoute(e, () => episode(est)), patient, await e.tok(doc))).statusCode).toBe(200);
  });
  it('T-ACC-03 : le pharmacien ne lit que les allergies (champs renvoyés au service)', async () => {
    const { e, est, pha, patient } = await world();
    const r = await get(await appWithRoute(e, () => episode(est)), patient, await e.tok(pha));
    expect(r.json()).toEqual({ ok: true, fields: ['allergies'] });
  });
  it('T-ACC-05 : professionnel sous opposition refusé ; un autre professionnel passe', async () => {
    const { e, est, doc, dir, patient } = await world();
    const app = await appWithRoute(e, () => episode(est));
    expect((await get(app, patient, await e.tok(doc), { 'x-opposed': doc })).statusCode).toBe(403);
    expect((await get(app, patient, await e.tok(dir), { 'x-opposed': doc })).statusCode).toBe(200);
  });
  it('un compte sans fiche du personnel n\'a aucun droit, même avec le rôle dans son jeton', async () => {
    const { e, est, patient } = await world();
    const r = await get(await appWithRoute(e, () => episode(est)), patient, await e.tok('inconnu', { realm_access: { roles: ['medecin', 'directeur_medical'] } }));
    expect(r.statusCode).toBe(403);
    expect((await e.db.query("SELECT reason FROM access_denial WHERE actor_sub='inconnu'")).rows).toEqual([{ reason: 'no_staff_record' }]);
  });
  it('compte désactivé : 401 avant même le moteur', async () => {
    const { e, est, doc, dir, patient } = await world();
    const t = await e.tok(doc);
    await e.call('POST', `/v1/admin/staff/${doc}/disable`, await e.tok(dir), { reason: 'x' });
    expect((await get(await appWithRoute(e, () => episode(est)), patient, t)).statusCode).toBe(401);
  });
  it('principal de type système : aucun accès au contenu', async () => {
    const { e, est, patient } = await world();
    const sys = await e.signPro({ azp: 'syfa-system', sub: 'svc-1', sid: undefined, amr: undefined });
    expect((await get(await appWithRoute(e, () => episode(est)), patient, sys)).statusCode).toBe(403);
  });
  it('principal patient : seulement son propre dossier', async () => {
    const { e, est } = await world();
    const mine = await e.addPatient({ telephone: '237690000077' });
    const other = await e.addPatient({ telephone: '237690000078' });
    const t = (await enrol(e, '2580', '237690000077')).accessToken;
    const app = await appWithRoute(e, () => episode(est));
    expect((await get(app, mine, t)).statusCode).toBe(200);
    expect((await get(app, other, t)).statusCode).toBe(403);
  });
});

describe('liste de réseaux par établissement', () => {
  it('quand l\'établissement a sa liste, elle remplace la liste globale pour ses postes', async () => {
    const e = await makeOrgEnv({ AUTH_ALLOWED_NETWORKS: '127.0.0.0/8' });
    const a = await e.establishment('A-1', { allowedNetworks: ['10.99.0.0/16'] });
    const b = await e.establishment('B-1');
    const da = await e.staff('op-1', 'dir.a', a, [{ role: 'directeur_medical' }]);
    const db = await e.staff('op-1', 'dir.b', b, [{ role: 'directeur_medical' }]);
    const from = async (sub: string, ip: string) => (await e.app.inject({ method: 'GET', url: '/v1/me', remoteAddress: ip, headers: { authorization: `Bearer ${await e.tok(sub)}` } })).statusCode;
    expect(await from(da, '10.99.4.4')).toBe(200);
    expect(await from(da, '127.0.0.1')).toBe(403); // la liste de l'établissement remplace la globale
    expect(await from(da, '10.98.0.1')).toBe(403);
    expect(await from(db, '127.0.0.1')).toBe(200); // sans liste propre : liste globale
    expect(await from(db, '10.99.4.4')).toBe(403);
    expect(await from('op-1', '127.0.0.1')).toBe(200); // opérateur : liste globale
  });
  it('modifiable par l\'opérateur, effet immédiat', async () => {
    const e = await makeOrgEnv({ AUTH_ALLOWED_NETWORKS: '127.0.0.0/8' });
    const a = await e.establishment('A-1');
    const da = await e.staff('op-1', 'dir.a', a, [{ role: 'directeur_medical' }]);
    const from = async (ip: string) => (await e.app.inject({ method: 'GET', url: '/v1/me', remoteAddress: ip, headers: { authorization: `Bearer ${await e.tok(da)}` } })).statusCode;
    expect(await from('127.0.0.1')).toBe(200);
    await e.call('PUT', `/v1/admin/establishments/${a}/networks`, await e.tok('op-1'), { allowedNetworks: ['10.50.0.0/16'] });
    expect(await from('127.0.0.1')).toBe(403);
    expect(await from('10.50.1.2')).toBe(200);
    await e.call('PUT', `/v1/admin/establishments/${a}/networks`, await e.tok('op-1'), { allowedNetworks: [] });
    expect(await from('127.0.0.1')).toBe(200);
  });
});
