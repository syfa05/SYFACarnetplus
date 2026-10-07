#!/usr/bin/env node
// Configure l'authentification « step-up » du realm syfa (second facteur dans les jetons, F-AUTH-03).
//
// Pourquoi un script et pas le JSON du realm : à l'import, Keycloak ne crée les flux et les actions requises PAR DÉFAUT
// que si le realm importé n'en déclare AUCUN (RealmManager.setupAuthenticationFlows / setupRequiredActions, 26.8.0).
// Déclarer un flux personnalisé dans le JSON ferait donc disparaître les flux standard (mot de passe oublié, accès direct…).
// On importe le realm sans flux, puis ce script, idempotent, ajoute le flux et le lie au realm.
//
// Appels d'administration utilisés (vérifiés dans AuthenticationManagementResource, Keycloak 26.8.0) :
//   POST /flows · POST /flows/{alias}/executions/flow · POST /flows/{alias}/executions/execution
//   GET|PUT /flows/{alias}/executions · POST /executions/{id}/config · GET|PUT /required-actions/{alias}
//
// Flux construit (identique au guide « step-up » de Keycloak) :
//   syfa-browser
//     ├─ Cookie                                  ALTERNATIVE
//     └─ syfa-browser-forms                      ALTERNATIVE
//          ├─ syfa-level-1                       CONDITIONAL
//          │    ├─ Condition – niveau 1 (max 36000 s)   REQUIRED
//          │    └─ Username Password Form               REQUIRED
//          └─ syfa-level-2                       CONDITIONAL
//               ├─ Condition – niveau 2 (max 0)         REQUIRED   → l'OTP est exigé à CHAQUE nouvelle connexion
//               └─ OTP Form                             REQUIRED
//
// Usage : node configure-stepup.mjs [--check]
//   --check : ne modifie rien ; vérifie et sort en code 1 si la configuration n'est pas conforme.
// Environnement : KEYCLOAK_URL (défaut http://localhost:8081), KEYCLOAK_REALM (syfa), KEYCLOAK_ADMIN (admin),
//   KEYCLOAK_ADMIN_PASSWORD (obligatoire), KEYCLOAK_WAIT_SECONDS (attente de démarrage, défaut 120).

import { fileURLToPath } from 'node:url';

export const FLOW = 'syfa-browser';
export const FORMS = 'syfa-browser-forms';
export const L1 = 'syfa-level-1';
export const L2 = 'syfa-level-2';
export const LOA = 'conditional-level-of-authentication';

/** Structure attendue, à plat, dans l'ordre : [niveau, fournisseur ou alias de sous-flux, exigence, configuration]. */
export const EXPECTED = [
  [0, 'auth-cookie', 'ALTERNATIVE', null],
  [0, FORMS, 'ALTERNATIVE', null],
  [1, L1, 'CONDITIONAL', null],
  [2, LOA, 'REQUIRED', { alias: 'syfa-loa-1', config: { 'loa-condition-level': '1', 'loa-max-age': '36000' } }],
  [2, 'auth-username-password-form', 'REQUIRED', null],
  [1, L2, 'CONDITIONAL', null],
  [2, LOA, 'REQUIRED', { alias: 'syfa-loa-2', config: { 'loa-condition-level': '2', 'loa-max-age': '0' } }],
  [2, 'auth-otp-form', 'REQUIRED', null],
];

export class Admin {
  constructor({ baseUrl, realm, user, password, fetchImpl = fetch, log = () => {} }) {
    Object.assign(this, { baseUrl: baseUrl.replace(/\/$/, ''), realm, user, password, fetchImpl, log });
    this.token = null;
    this.mutations = 0;
  }
  async login() {
    const res = await this.fetchImpl(`${this.baseUrl}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: this.user, password: this.password }),
    });
    if (!res.ok) throw new Error(`connexion administrateur refusée (HTTP ${res.status})`);
    this.token = (await res.json()).access_token;
  }
  async call(method, path, body) {
    const res = await this.fetchImpl(`${this.baseUrl}/admin/realms/${this.realm}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (method !== 'GET') this.mutations++;
    if (!res.ok && !(method === 'GET' && res.status === 404)) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${path} → HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    if (res.status === 404) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
}

/** Attend que le realm réponde (Keycloak peut mettre une minute à démarrer et à importer). */
export async function waitForRealm({ baseUrl, realm, seconds, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    try {
      const r = await fetchImpl(`${baseUrl}/realms/${realm}/.well-known/openid-configuration`);
      if (r.ok) return;
    } catch { /* pas encore démarré */ }
    if (Date.now() > deadline) throw new Error(`le realm « ${realm} » ne répond pas après ${seconds} s`);
    log('en attente de Keycloak…');
    await sleep(3000);
  }
}

/** Liste à plat des exécutions du flux, avec leur niveau d'imbrication. */
async function listExecutions(admin) {
  return (await admin.call('GET', `/authentication/flows/${FLOW}/executions`)) ?? [];
}
const labelOf = (e) => (e.authenticationFlow ? e.displayName : e.providerId);

/** Écarts entre la structure réelle et la structure attendue (liste vide = conforme). */
export async function diff(admin) {
  const problems = [];
  const execs = await listExecutions(admin);
  if (execs.length !== EXPECTED.length) problems.push(`${execs.length} exécutions au lieu de ${EXPECTED.length}`);
  for (const [i, [level, label, requirement, cfg]] of EXPECTED.entries()) {
    const e = execs[i];
    if (!e) { problems.push(`exécution manquante : ${label}`); continue; }
    if (e.level !== level || labelOf(e) !== label) problems.push(`#${i} : « ${labelOf(e)} » (niveau ${e.level}) au lieu de « ${label} » (niveau ${level})`);
    else if (e.requirement !== requirement) problems.push(`${label} : exigence ${e.requirement} au lieu de ${requirement}`);
    if (cfg) {
      const c = e.authenticationConfig ? await admin.call('GET', `/authentication/config/${e.authenticationConfig}`) : null;
      for (const [k, v] of Object.entries(cfg.config)) if (c?.config?.[k] !== v) problems.push(`${cfg.alias} : ${k}=${c?.config?.[k] ?? '(absent)'} au lieu de ${v}`);
    }
  }
  return problems;
}

/** Crée le flux (s'il n'existe pas) : exécutions, exigences, configurations. */
async function build(admin) {
  const post = (path, body) => admin.call('POST', path, body);
  await post('/authentication/flows', { alias: FLOW, description: 'SYFA : mot de passe (niveau 1) puis second facteur TOTP (niveau 2)', providerId: 'basic-flow', topLevel: true, builtIn: false });
  await post(`/authentication/flows/${FLOW}/executions/execution`, { provider: 'auth-cookie' });
  await post(`/authentication/flows/${FLOW}/executions/flow`, { alias: FORMS, type: 'basic-flow', provider: 'registration-page-form', description: 'SYFA : niveaux d\'authentification' });
  for (const alias of [L1, L2]) await post(`/authentication/flows/${FORMS}/executions/flow`, { alias, type: 'basic-flow', provider: 'registration-page-form', description: alias });
  await post(`/authentication/flows/${L1}/executions/execution`, { provider: LOA });
  await post(`/authentication/flows/${L1}/executions/execution`, { provider: 'auth-username-password-form' });
  await post(`/authentication/flows/${L2}/executions/execution`, { provider: LOA });
  await post(`/authentication/flows/${L2}/executions/execution`, { provider: 'auth-otp-form' });

  // Exigences (les nouvelles exécutions sont DISABLED) puis configurations des conditions.
  const execs = await listExecutions(admin);
  for (const [i, [, , requirement, cfg]] of EXPECTED.entries()) {
    const e = execs[i];
    // PUT : l'identifiant, l'exigence ET la priorité actuelle (sinon la priorité serait remise à 0)
    await admin.call('PUT', `/authentication/flows/${FLOW}/executions`, { id: e.id, requirement, priority: e.priority });
    if (cfg) await post(`/authentication/executions/${e.id}/config`, cfg);
  }
}

export async function configure({ admin, check = false, log = console.log }) {
  await admin.login();
  const results = [];
  const record = (name, ok, detail = '') => { results.push({ name, ok, detail }); log(`${ok ? 'OK  ' : 'KO  '} ${name}${detail ? ` — ${detail}` : ''}`); };

  // 1. flux
  const flows = (await admin.call('GET', '/authentication/flows')) ?? [];
  const exists = flows.some((f) => f.alias === FLOW);
  if (!exists && !check) { log(`création du flux « ${FLOW} »…`); await build(admin); }
  const problems = exists || !check ? await diff(admin) : [`flux « ${FLOW} » absent`];
  record(`flux « ${FLOW} » conforme (niveau 1 : mot de passe, niveau 2 : OTP)`, problems.length === 0, problems.join(' ; '));

  // 2. flux navigateur du realm
  let realm = await admin.call('GET', '');
  if (realm.browserFlow !== FLOW && !check && problems.length === 0) {
    log(`liaison du flux navigateur à « ${FLOW} »…`);
    await admin.call('PUT', '', { ...realm, browserFlow: FLOW }); // représentation complète, comme la console d'administration
    realm = await admin.call('GET', '');
  }
  record(`flux navigateur du realm = « ${FLOW} »`, realm.browserFlow === FLOW, realm.browserFlow !== FLOW ? `actuel : ${realm.browserFlow}` : '');

  // 3. action requise CONFIGURE_TOTP par défaut pour les nouveaux utilisateurs
  let totp = await admin.call('GET', '/authentication/required-actions/CONFIGURE_TOTP');
  if (totp && !(totp.enabled && totp.defaultAction) && !check) {
    await admin.call('PUT', '/authentication/required-actions/CONFIGURE_TOTP', { ...totp, enabled: true, defaultAction: true });
    totp = await admin.call('GET', '/authentication/required-actions/CONFIGURE_TOTP');
  }
  record('CONFIGURE_TOTP activée et par défaut', Boolean(totp?.enabled && totp?.defaultAction), totp ? '' : 'action requise absente');

  // 4. clients : niveau demandé par défaut et minimum (contrôle seulement : ils sont déclarés dans le realm importé)
  for (const clientId of ['syfa-web', 'syfa-android-pro']) {
    const [c] = (await admin.call('GET', `/clients?clientId=${clientId}`)) ?? [];
    const a = c?.attributes ?? {};
    record(`client ${clientId} : niveau 2 par défaut et minimum`, a['default.acr.values'] === '2' && a['minimum.acr.value'] === '2',
      c ? `default.acr.values=${a['default.acr.values'] ?? '(absent)'} minimum.acr.value=${a['minimum.acr.value'] ?? '(absent)'}` : 'client absent');
  }
  return { ok: results.every((r) => r.ok), results, mutations: admin.mutations };
}

// ---- exécution en ligne de commande ------------------------------------------------------------------------------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  if (!env.KEYCLOAK_ADMIN_PASSWORD) { console.error('KEYCLOAK_ADMIN_PASSWORD est obligatoire'); process.exit(2); }
  const baseUrl = env.KEYCLOAK_URL ?? 'http://localhost:8081';
  const realm = env.KEYCLOAK_REALM ?? 'syfa';
  const check = process.argv.includes('--check');
  try {
    await waitForRealm({ baseUrl, realm, seconds: Number(env.KEYCLOAK_WAIT_SECONDS ?? 120), log: console.log });
    const admin = new Admin({ baseUrl, realm, user: env.KEYCLOAK_ADMIN ?? 'admin', password: env.KEYCLOAK_ADMIN_PASSWORD });
    const r = await configure({ admin, check });
    console.log(r.ok ? `\nConforme (${r.mutations} modification(s) effectuée(s)).` : '\nNON conforme.');
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`Échec : ${e.message}`);
    process.exit(2);
  }
}
