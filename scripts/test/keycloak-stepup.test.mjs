// Teste le script de configuration du step-up contre un Keycloak SIMULÉ en mémoire. Le simulateur reproduit le
// comportement lu dans le code de Keycloak 26.8.0 (AuthenticationManagementResource) : nouvelles exécutions DISABLED,
// priorités croissantes, PUT {id, requirement, priority}, alias de configuration uniques, flux « built-in » intouchables.
// Il valide la LOGIQUE du script ; il ne remplace pas une exécution contre un vrai Keycloak.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Admin, configure, diff, waitForRealm, EXPECTED, FLOW } from '../../infra/keycloak/configure-stepup.mjs';

const PROVIDERS = { 'auth-cookie': 2, 'conditional-level-of-authentication': 2, 'auth-username-password-form': 2, 'auth-otp-form': 2 };
const HTTP = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (body === undefined ? '' : JSON.stringify(body)) });

function fakeKeycloak({ clientAttrs = { 'default.acr.values': '2', 'minimum.acr.value': '2' }, password = 'secret' } = {}) {
  let n = 0;
  const id = () => `id-${++n}`;
  const flows = new Map();           // alias -> { id, alias, providerId, topLevel, builtIn }
  const execs = [];                  // { id, parent, requirement, priority, authenticator, flowId, authenticatorFlow, configId }
  const configs = new Map();         // id -> { id, alias, config }
  const realm = { realm: 'syfa', browserFlow: 'browser', otpPolicyType: 'totp' };
  const actions = { CONFIGURE_TOTP: { alias: 'CONFIGURE_TOTP', providerId: 'CONFIGURE_TOTP', enabled: true, defaultAction: false, priority: 10 } };
  flows.set('browser', { id: id(), alias: 'browser', providerId: 'basic-flow', topLevel: true, builtIn: true });
  const calls = [];
  const flowById = (fid) => [...flows.values()].find((f) => f.id === fid);
  const children = (flow) => execs.filter((e) => e.parent === flow.id).sort((a, b) => a.priority - b.priority);
  const nextPriority = (flow) => { const c = children(flow); return c.length ? c.at(-1).priority + 1 : 0; };
  const flatten = (flow, level, out) => {
    for (const e of children(flow)) {
      const sub = e.authenticatorFlow ? flowById(e.flowId) : null;
      out.push({ id: e.id, level, index: out.length, priority: e.priority, requirement: e.requirement, authenticationFlow: e.authenticatorFlow,
        providerId: e.authenticator, displayName: sub ? sub.alias : e.authenticator, flowId: e.flowId, authenticationConfig: e.configId });
      if (sub) flatten(sub, level + 1, out);
    }
    return out;
  };

  const handler = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const u = new URL(url);
    const body = typeof init.body === 'string' && init.headers?.['content-type'] === 'application/json' ? JSON.parse(init.body) : init.body;
    if (u.pathname.endsWith('/.well-known/openid-configuration')) return HTTP(200, {});
    if (u.pathname === '/realms/master/protocol/openid-connect/token') {
      return body.get('password') === password && body.get('client_id') === 'admin-cli' ? HTTP(200, { access_token: 'tok' }) : HTTP(401, { error: 'invalid_grant' });
    }
    if (init.headers?.authorization !== 'Bearer tok') return HTTP(401, {});
    const p = u.pathname.replace('/admin/realms/syfa', '');
    calls.push(`${method} ${p}`);
    let m;
    if (p === '' && method === 'GET') return HTTP(200, { ...realm });
    if (p === '' && method === 'PUT') { if (!flows.has(body.browserFlow)) return HTTP(400, {}); Object.assign(realm, body); return HTTP(204); }
    if (p === '/authentication/flows' && method === 'GET') return HTTP(200, [...flows.values()].filter((f) => f.topLevel));
    if (p === '/authentication/flows' && method === 'POST') {
      if (!body.alias) return HTTP(409, {});
      if (flows.has(body.alias)) return HTTP(409, { errorMessage: `Flow ${body.alias} already exists` });
      flows.set(body.alias, { id: id(), alias: body.alias, providerId: body.providerId, topLevel: Boolean(body.topLevel), builtIn: Boolean(body.builtIn) });
      return HTTP(201);
    }
    if ((m = /^\/authentication\/flows\/([^/]+)\/executions\/flow$/.exec(p)) && method === 'POST') {
      const parent = flows.get(m[1]);
      if (!parent) return HTTP(400, {});
      if (parent.builtIn) return HTTP(400, { error: 'It is illegal to add sub-flow to a built in flow' });
      if (flows.has(body.alias)) return HTTP(409, {});
      const f = { id: id(), alias: body.alias, providerId: body.type, topLevel: false, builtIn: false };
      flows.set(body.alias, f);
      execs.push({ id: id(), parent: parent.id, requirement: 'DISABLED', priority: nextPriority(parent), authenticator: null, flowId: f.id, authenticatorFlow: true });
      return HTTP(201);
    }
    if ((m = /^\/authentication\/flows\/([^/]+)\/executions\/execution$/.exec(p)) && method === 'POST') {
      const parent = flows.get(m[1]);
      if (!parent) return HTTP(400, {});
      if (parent.builtIn) return HTTP(400, { error: 'It is illegal to add execution to a built in flow' });
      if (!PROVIDERS[body.provider]) return HTTP(400, { error: `No authentication provider found for id: ${body.provider}` });
      execs.push({ id: id(), parent: parent.id, requirement: 'DISABLED', priority: nextPriority(parent), authenticator: body.provider, authenticatorFlow: false });
      return HTTP(201);
    }
    if ((m = /^\/authentication\/flows\/([^/]+)\/executions$/.exec(p))) {
      const flow = flows.get(m[1]);
      if (!flow) return HTTP(404);
      if (method === 'GET') return HTTP(200, flatten(flow, 0, []));
      if (method === 'PUT') {
        const e = execs.find((x) => x.id === body.id);
        if (!e) return HTTP(404, {});
        if (!['REQUIRED', 'ALTERNATIVE', 'DISABLED', 'CONDITIONAL'].includes(body.requirement) || typeof body.priority !== 'number') return HTTP(400, {});
        e.requirement = body.requirement; e.priority = body.priority; // priorité absente = 0 côté serveur : le script doit la renvoyer
        return HTTP(204);
      }
    }
    if ((m = /^\/authentication\/executions\/([^/]+)\/config$/.exec(p)) && method === 'POST') {
      const e = execs.find((x) => x.id === m[1]);
      if (!e) return HTTP(404, {});
      if (!body.alias) return HTTP(409, {});
      if ([...configs.values()].some((c) => c.alias === body.alias)) return HTTP(409, { errorMessage: 'already exists' });
      const cid = id(); configs.set(cid, { id: cid, alias: body.alias, config: body.config }); e.configId = cid;
      return HTTP(201);
    }
    if ((m = /^\/authentication\/config\/([^/]+)$/.exec(p)) && method === 'GET') return configs.has(m[1]) ? HTTP(200, configs.get(m[1])) : HTTP(404);
    if ((m = /^\/authentication\/required-actions\/([^/]+)$/.exec(p))) {
      if (!actions[m[1]]) return HTTP(404);
      if (method === 'GET') return HTTP(200, { ...actions[m[1]] });
      if (method === 'PUT') { Object.assign(actions[m[1]], body); return HTTP(204); }
    }
    if (p === '/clients' && method === 'GET') {
      const cid = u.searchParams.get('clientId');
      return HTTP(200, ['syfa-web', 'syfa-android-pro'].includes(cid) ? [{ clientId: cid, attributes: clientAttrs }] : []);
    }
    return HTTP(404, { unhandled: `${method} ${p}` });
  };
  return { fetchImpl: handler, calls, execs, flows, configs, realm, actions };
}

const admin = (kc, password = 'secret') => new Admin({ baseUrl: 'http://kc', realm: 'syfa', user: 'admin', password, fetchImpl: kc.fetchImpl });
const run = (kc, check = false) => configure({ admin: admin(kc), check, log: () => {} });

test('application sur un realm neuf : flux créé, conforme, lié au realm, CONFIGURE_TOTP par défaut', async () => {
  const kc = fakeKeycloak();
  const r = await run(kc);
  assert.equal(r.ok, true, JSON.stringify(r.results.filter((x) => !x.ok)));
  assert.ok(r.mutations > 0);
  assert.equal(kc.realm.browserFlow, FLOW);
  assert.equal(kc.actions.CONFIGURE_TOTP.defaultAction, true);
  const a = admin(kc); await a.login();
  assert.deepEqual(await diff(a), []);
  // les configurations de niveau ont les bonnes valeurs
  const cfg = [...kc.configs.values()].map((c) => [c.alias, c.config['loa-condition-level'], c.config['loa-max-age']]).sort();
  assert.deepEqual(cfg, [['syfa-loa-1', '1', '36000'], ['syfa-loa-2', '2', '0']]);
});

test('le flux « browser » natif n\'est jamais modifié', async () => {
  const kc = fakeKeycloak();
  await run(kc);
  assert.ok(kc.calls.every((c) => !/flows\/browser\//.test(c)), 'aucun appel sur le flux natif');
  assert.equal(kc.flows.get('browser').builtIn, true);
});

test('idempotent : une seconde exécution ne modifie rien', async () => {
  const kc = fakeKeycloak();
  await run(kc);
  const second = await run(kc);
  assert.equal(second.ok, true);
  assert.equal(second.mutations, 0);
});

test('--check ne modifie rien : non conforme avant, conforme après application', async () => {
  const kc = fakeKeycloak();
  const before = await run(kc, true);
  assert.equal(before.ok, false);
  assert.equal(before.mutations, 0);
  assert.equal(kc.flows.has(FLOW), false);
  await run(kc);
  const after = await run(kc, true);
  assert.equal(after.ok, true);
  assert.equal(after.mutations, 0);
});

test('les priorités sont conservées (le PUT renvoie la priorité actuelle) : l\'ordre des exécutions est celui attendu', async () => {
  const kc = fakeKeycloak();
  await run(kc);
  const a = admin(kc); await a.login();
  const flat = await a.call('GET', `/authentication/flows/${FLOW}/executions`);
  assert.deepEqual(flat.map((e) => [e.level, e.authenticationFlow ? e.displayName : e.providerId, e.requirement]), EXPECTED.map(([l, n, r]) => [l, n, r]));
  assert.ok(flat.some((e) => e.priority > 0), 'les priorités ne sont pas toutes remises à 0');
});

test('dérive détectée : exigence modifiée, configuration modifiée, exécution supprimée', async () => {
  const kc = fakeKeycloak();
  await run(kc);
  const otp = kc.execs.find((e) => e.authenticator === 'auth-otp-form');
  otp.requirement = 'DISABLED';
  let r = await run(kc, true);
  assert.equal(r.ok, false);
  assert.match(r.results[0].detail, /auth-otp-form : exigence DISABLED au lieu de REQUIRED/);
  otp.requirement = 'REQUIRED';
  [...kc.configs.values()].find((c) => c.alias === 'syfa-loa-2').config['loa-condition-level'] = '1';
  r = await run(kc, true);
  assert.match(r.results[0].detail, /syfa-loa-2 : loa-condition-level=1 au lieu de 2/);
  [...kc.configs.values()].find((c) => c.alias === 'syfa-loa-2').config['loa-condition-level'] = '2';
  kc.execs.splice(kc.execs.indexOf(otp), 1);
  r = await run(kc, true);
  assert.equal(r.ok, false);
  assert.match(r.results[0].detail, /exécutions au lieu de 8|manquante/);
});

test('un flux existant mais non conforme n\'est pas « réparé » en silence : il est signalé', async () => {
  const kc = fakeKeycloak();
  await run(kc);
  kc.execs.find((e) => e.authenticator === 'auth-cookie').requirement = 'DISABLED';
  const r = await run(kc);
  assert.equal(r.ok, false);
  assert.equal(r.mutations, 0);
});

test('clients : niveau par défaut et minimum contrôlés', async () => {
  const kc = fakeKeycloak({ clientAttrs: { 'default.acr.values': '1' } });
  const r = await run(kc);
  const failing = r.results.filter((x) => !x.ok).map((x) => x.name);
  assert.deepEqual(failing, ['client syfa-web : niveau 2 par défaut et minimum', 'client syfa-android-pro : niveau 2 par défaut et minimum']);
  assert.equal(r.ok, false);
});

test('mauvais mot de passe administrateur : échec net', async () => {
  const kc = fakeKeycloak();
  await assert.rejects(() => configure({ admin: admin(kc, 'faux'), log: () => {} }), /connexion administrateur refusée/);
});

test('attente du démarrage : réessaie puis réussit ; abandonne après le délai', async () => {
  let tries = 0;
  const fetchImpl = async () => { if (++tries < 3) throw new Error('ECONNREFUSED'); return HTTP(200, {}); };
  await waitForRealm({ baseUrl: 'http://kc', realm: 'syfa', seconds: 60, fetchImpl, sleep: async () => {} });
  assert.equal(tries, 3);
  await assert.rejects(() => waitForRealm({ baseUrl: 'http://kc', realm: 'syfa', seconds: 0, fetchImpl: async () => { throw new Error('x'); }, sleep: async () => {} }), /ne répond pas/);
});
