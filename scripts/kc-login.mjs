#!/usr/bin/env node
// Obtient un VRAI jeton Keycloak (flux navigateur, PKCE) et vérifie ce que la passerelle en fait.
// Sert à valider le second facteur (F-AUTH-03) de bout en bout : claims `acr`/`amr` réellement émis par Keycloak,
// puis réponse réelle de la passerelle (`/v1/me`).
//
// Usage : node scripts/kc-login.mjs [--acr 1|2] [--keycloak URL] [--realm syfa] [--gateway URL] [--port 3000]
//   1. le script affiche une adresse : l'ouvrir dans un navigateur et se connecter (mot de passe, puis TOTP si demandé) ;
//   2. il reçoit le code sur http://localhost:<port>/cb, l'échange, affiche les claims et appelle la passerelle.
// Client utilisé : syfa-web (redirection http://localhost:3000/* déclarée dans le realm).
// Code de sortie : 0 si la passerelle se comporte comme attendu (acr >= 2 → accepté ; sinon → refusé « mfa_required »).

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

export const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function pkcePair(verifier = b64url(randomBytes(32))) {
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export function authorizeUrl({ keycloak, realm, clientId, redirectUri, challenge, state, acr }) {
  const u = new URL(`${keycloak}/realms/${realm}/protocol/openid-connect/auth`);
  u.search = new URLSearchParams({
    client_id: clientId, response_type: 'code', scope: 'openid', redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: 'S256', state, ...(acr ? { acr_values: acr } : {}),
  }).toString();
  return u.toString();
}

/** Décode les claims d'un jeton SANS vérifier la signature (affichage seulement : la vérification est faite par la passerelle). */
export function decodeJwt(token) {
  const part = token.split('.')[1];
  if (!part) throw new Error('jeton illisible');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/** Ce que la passerelle doit répondre d'après les claims (même règle que src/auth/hook.ts : amr ∋ « otp » OU acr >= 2). */
export function expectedGatewayOutcome(claims, { amr = 'otp', acrMin = 2 } = {}) {
  const amrOk = Array.isArray(claims.amr) && claims.amr.includes(amr);
  const acr = Number(claims.acr);
  const mfa = amrOk || (Number.isFinite(acr) && acr >= acrMin);
  return mfa ? { status: 200 } : { status: 401, error: 'mfa_required' };
}

export async function exchangeCode({ fetchImpl = fetch, keycloak, realm, clientId, code, redirectUri, verifier }) {
  const res = await fetchImpl(`${keycloak}/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirectUri, code_verifier: verifier }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`échange du code refusé (HTTP ${res.status}) : ${body.error_description ?? body.error ?? ''}`);
  return body;
}

export function waitForCode({ port, state, timeoutMs = 300_000 }) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url, `http://localhost:${port}`);
      if (u.pathname !== '/cb') { res.writeHead(404).end(); return; }
      const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(ok ? 'Connexion reçue : vous pouvez fermer cet onglet.' : 'Réponse invalide (state ou code absent).');
      clearTimeout(timer);
      server.close();
      ok ? resolve(u.searchParams.get('code')) : reject(new Error(u.searchParams.get('error_description') ?? 'réponse de connexion invalide'));
    });
    const timer = setTimeout(() => { server.close(); reject(new Error('délai dépassé : aucune connexion reçue')); }, timeoutMs);
    server.listen(port, '127.0.0.1');
  });
}

async function main() {
  const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
  const keycloak = arg('keycloak', 'http://localhost:8081');
  const realm = arg('realm', 'syfa');
  const gateway = arg('gateway', 'http://localhost:8080');
  const port = Number(arg('port', '3000'));
  const acr = arg('acr');
  const clientId = 'syfa-web';
  const redirectUri = `http://localhost:${port}/cb`;
  const { verifier, challenge } = pkcePair();
  const state = b64url(randomBytes(16));

  console.log(`\nOuvrez cette adresse dans un navigateur et connectez-vous (acr_values demandé : ${acr ?? 'aucun'}) :\n\n${authorizeUrl({ keycloak, realm, clientId, redirectUri, challenge, state, acr })}\n`);
  const code = await waitForCode({ port, state });
  const tokens = await exchangeCode({ keycloak, realm, clientId, code, redirectUri, verifier });
  const claims = decodeJwt(tokens.access_token);

  console.log('Claims du jeton d\'accès émis par Keycloak :');
  for (const k of ['iss', 'azp', 'aud', 'sid', 'acr', 'amr', 'phone_number', 'exp']) console.log(`  ${k.padEnd(13)} ${JSON.stringify(claims[k])}`);
  console.log(`  ${'realm roles'.padEnd(13)} ${JSON.stringify(claims.realm_access?.roles ?? [])}`);

  const expected = expectedGatewayOutcome(claims);
  const res = await fetch(`${gateway}/v1/me`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
  const body = await res.json().catch(() => ({}));
  console.log(`\nPasserelle ${gateway}/v1/me → HTTP ${res.status} ${JSON.stringify(body)}`);
  const ok = res.status === expected.status && (!expected.error || body.error === expected.error);
  console.log(ok ? `CONFORME : attendu HTTP ${expected.status}${expected.error ? ` (${expected.error})` : ''}.` : `NON CONFORME : attendu HTTP ${expected.status}${expected.error ? ` (${expected.error})` : ''}.`);
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(`Échec : ${e.message}`); process.exit(2); });
