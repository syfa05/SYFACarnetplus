import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { authorizeUrl, decodeJwt, exchangeCode, expectedGatewayOutcome, pkcePair, waitForCode } from '../kc-login.mjs';

test('PKCE S256 : vecteur de test de la RFC 7636 (annexe B)', () => {
  const { challenge } = pkcePair('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const a = pkcePair(), b = pkcePair();
  assert.notEqual(a.verifier, b.verifier);
  assert.ok(a.verifier.length >= 43 && a.verifier.length <= 128);
});

test('adresse d\'autorisation : PKCE, état, niveau demandé', () => {
  const u = new URL(authorizeUrl({ keycloak: 'http://kc', realm: 'syfa', clientId: 'syfa-web', redirectUri: 'http://localhost:3000/cb', challenge: 'C', state: 'S', acr: '2' }));
  assert.equal(u.pathname, '/realms/syfa/protocol/openid-connect/auth');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('acr_values'), '2');
  assert.equal(u.searchParams.get('state'), 'S');
  assert.equal(new URL(authorizeUrl({ keycloak: 'http://kc', realm: 'r', clientId: 'c', redirectUri: 'x', challenge: 'C', state: 'S' })).searchParams.has('acr_values'), false);
});

test('résultat attendu de la passerelle : même règle que le contrôle réel (amr « otp » ou acr >= 2)', () => {
  assert.deepEqual(expectedGatewayOutcome({ acr: '2' }), { status: 200 });
  assert.deepEqual(expectedGatewayOutcome({ acr: '1', amr: ['pwd', 'otp'] }), { status: 200 });
  for (const claims of [{ acr: '1' }, { acr: '0' }, {}, { acr: 'x' }, { amr: ['pwd'] }]) assert.deepEqual(expectedGatewayOutcome(claims), { status: 401, error: 'mfa_required' });
});

test('décodage des claims', () => {
  const jwt = `x.${Buffer.from(JSON.stringify({ acr: '2', sid: 's' })).toString('base64url')}.y`;
  assert.deepEqual(decodeJwt(jwt), { acr: '2', sid: 's' });
  assert.throws(() => decodeJwt('illisible'), /illisible/);
});

test('échange du code : paramètres PKCE envoyés ; refus remonté clairement', async () => {
  let seen;
  const ok = await exchangeCode({ keycloak: 'http://kc', realm: 'syfa', clientId: 'syfa-web', code: 'CODE', redirectUri: 'http://localhost:3000/cb', verifier: 'V',
    fetchImpl: async (url, init) => { seen = { url, body: init.body }; return { ok: true, status: 200, json: async () => ({ access_token: 'T' }) }; } });
  assert.equal(ok.access_token, 'T');
  assert.equal(seen.url, 'http://kc/realms/syfa/protocol/openid-connect/token');
  assert.equal(seen.body.get('grant_type'), 'authorization_code');
  assert.equal(seen.body.get('code_verifier'), 'V');
  await assert.rejects(() => exchangeCode({ keycloak: 'http://kc', realm: 'syfa', clientId: 'c', code: 'c', redirectUri: 'r', verifier: 'v',
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'Code not valid' }) }) }), /HTTP 400.*Code not valid/);
});

const get = (port, path) => new Promise((resolve, reject) => request({ host: '127.0.0.1', port, path }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject).end());

test('réception du code : état vérifié, code rendu ; état erroné refusé', async () => {
  const port = 39871;
  const waiting = waitForCode({ port, state: 'bon', timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await get(port, '/cb?code=ABC&state=bon'), 200);
  assert.equal(await waiting, 'ABC');
  const bad = waitForCode({ port, state: 'bon', timeoutMs: 5000 });
  bad.catch(() => {});
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await get(port, '/cb?code=ABC&state=faux'), 400);
  await assert.rejects(bad);
});
