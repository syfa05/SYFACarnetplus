import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { DirectoryError, KeycloakDirectory } from '../../src/org/directory.js';
import { loadDirectory, loadOrgConfig, UnconfiguredDirectory } from '../../src/org/config.js';

/** Serveur HTTP simulé : reproduit les échanges lus dans la documentation de l'API d'administration (NON un vrai Keycloak). */
interface Seen { method: string; url: string; auth?: string; body: string }
async function fake(handler: (req: IncomingMessage, body: string, seen: Seen[]) => { status: number; headers?: Record<string, string>; json?: unknown } | 'hang') {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      const r = handler(req, body, seen);
      if (r === 'hang') return;
      res.writeHead(r.status, { 'content-type': 'application/json', ...r.headers });
      res.end(r.json === undefined ? '' : JSON.stringify(r.json));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((ok) => { s.closeAllConnections(); s.close(ok); }))); });

const TOKEN = { status: 200, json: { access_token: 'tok-1', expires_in: 300 } };

describe('adaptateur Keycloak (serveur simulé)', () => {
  it('crée le compte désactivé avec mot de passe temporaire, TOTP à configurer et téléphone ; retourne le sub du Location', async () => {
    const f = await fake((req) => req.url!.endsWith('/token') ? TOKEN : { status: 201, headers: { location: `http://x/admin/realms/syfa/users/9f1c2d3e-aaaa-bbbb-cccc-000000000001` } });
    const d = new KeycloakDirectory(f.url, 'syfa', 'syfa-directory', 's3cret');
    expect(await d.createUser({ username: 'dr.a', email: 'a@b.cm', phone: '237690000001', temporaryPassword: 'Tmp-Passw0rd-xyz' })).toEqual({ sub: '9f1c2d3e-aaaa-bbbb-cccc-000000000001' });
    const [tok, create] = f.seen;
    expect(tok).toMatchObject({ method: 'POST', url: '/realms/syfa/protocol/openid-connect/token' });
    expect(tok!.body).toContain('grant_type=client_credentials');
    expect(create).toMatchObject({ method: 'POST', url: '/admin/realms/syfa/users', auth: 'Bearer tok-1' });
    expect(JSON.parse(create!.body)).toMatchObject({
      username: 'dr.a', enabled: false, attributes: { phone_number: ['237690000001'] }, requiredActions: ['CONFIGURE_TOTP'],
      credentials: [{ type: 'password', temporary: true }],
    });
  });
  it('nom déjà pris → conflit ; autre statut → indisponible', async () => {
    let status = 409;
    const f = await fake((req) => req.url!.endsWith('/token') ? TOKEN : { status });
    const d = new KeycloakDirectory(f.url, 'syfa', 'c', 's');
    await expect(d.createUser({ username: 'x', phone: '1', temporaryPassword: 'p' })).rejects.toMatchObject({ code: 'conflict' });
    status = 500;
    await expect(d.createUser({ username: 'x', phone: '1', temporaryPassword: 'p' })).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('activation : lit la représentation complète puis la réécrit (le téléphone n\'est pas effacé)', async () => {
    const rep = { id: 'u1234567', username: 'dr.a', enabled: false, attributes: { phone_number: ['237690000001'] } };
    const f = await fake((req) => req.url!.endsWith('/token') ? TOKEN : req.method === 'GET' ? { status: 200, json: rep } : { status: 204 });
    await new KeycloakDirectory(f.url, 'syfa', 'c', 's').setEnabled('u1234567', true);
    const put = f.seen.find((s) => s.method === 'PUT')!;
    expect(put.url).toBe('/admin/realms/syfa/users/u1234567');
    expect(JSON.parse(put.body)).toEqual({ ...rep, enabled: true });
  });
  it('jeton d\'accès mis en cache entre deux appels', async () => {
    const f = await fake((req) => req.url!.endsWith('/token') ? TOKEN : req.method === 'GET' ? { status: 200, json: {} } : { status: 204 });
    const d = new KeycloakDirectory(f.url, 'syfa', 'c', 's');
    await d.setEnabled('u1234567', true); await d.setEnabled('u1234567', false);
    expect(f.seen.filter((s) => s.url.endsWith('/token'))).toHaveLength(1);
  });
  it('jeton refusé, lecture introuvable, délai dépassé : indisponible, sans jamais reprendre le message externe', async () => {
    const f1 = await fake(() => ({ status: 401, json: { error_description: 'Patient Jean Dupont' } }));
    await expect(new KeycloakDirectory(f1.url, 'syfa', 'c', 's').setEnabled('u1234567', true)).rejects.toMatchObject({ code: 'unavailable' });
    const f2 = await fake((req) => req.url!.endsWith('/token') ? TOKEN : { status: 404 });
    await expect(new KeycloakDirectory(f2.url, 'syfa', 'c', 's').setEnabled('u1234567', true)).rejects.toBeInstanceOf(DirectoryError);
    const f3 = await fake(() => 'hang');
    const err = await new KeycloakDirectory(f3.url, 'syfa', 'c', 's', 150).setEnabled('u1234567', true).catch((e) => e);
    expect(err).toBeInstanceOf(DirectoryError);
    expect(JSON.stringify([err.message, String(err.cause)])).not.toMatch(/Jean|Dupont|127\.0\.0\.1/);
  });
});

describe('configuration', () => {
  it('annuaire non configuré par défaut ; configuré à partir de l\'émetteur OIDC ; incohérences refusées', () => {
    expect(loadDirectory('http://kc/realms/syfa', {})).toBeInstanceOf(UnconfiguredDirectory);
    expect(loadDirectory('http://kc/realms/syfa', { DIRECTORY_CLIENT_ID: 'a', DIRECTORY_CLIENT_SECRET: 'b' })).toBeInstanceOf(KeycloakDirectory);
    expect(() => loadDirectory('http://kc/realms/syfa', { DIRECTORY_CLIENT_ID: 'a' })).toThrow();
    expect(() => loadDirectory('http://kc/autre', { DIRECTORY_CLIENT_ID: 'a', DIRECTORY_CLIENT_SECRET: 'b' })).toThrow();
  });
  it('annuaire non configuré : création indisponible', async () => {
    await expect(new UnconfiguredDirectory().createUser()).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('règles paramétrables, lues strictement', () => {
    expect(loadOrgConfig({})).toEqual({ engine: { releaseDelayHours: 72, emergencyMotiveMinLength: 10 }, homologatedClients: [], minNetworkPrefix: { v4: 8, v6: 32 }, denialLog: { perWindow: 5, windowSeconds: 60 }, reconcile: { intervalSeconds: 60, batch: 200 }, reviews: { pageMax: 100, maxScan: 5000 }, denialRetentionDays: 90 });
    expect(() => loadOrgConfig({ ORG_DENIAL_RETENTION_DAYS: '30' })).toThrow(); // plancher de 90 jours
    expect(loadOrgConfig({ ORG_RELEASE_DELAY_HOURS: '48', ORG_HOMOLOGATED_CLIENTS: 'dme-1, dme-2' })).toMatchObject({ engine: { releaseDelayHours: 48 }, homologatedClients: ['dme-1', 'dme-2'] });
    expect(() => loadOrgConfig({ ORG_RELEASE_DELAY_HOURS: '72h' })).toThrow();
    expect(() => loadOrgConfig({ ORG_RELEASE_DELAY_HOURS: '-1' })).toThrow();
  });
});
