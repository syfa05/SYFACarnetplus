// Contrôles statiques du realm Keycloak et du Compose. Ils ne remplacent PAS un import dans un Keycloak réel
// (un import a déjà échoué en revue sur une valeur refusée) : ils évitent seulement de réintroduire les erreurs connues.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const realm = JSON.parse(read('infra/keycloak/syfa-realm.json'));
const profile = JSON.parse(realm.components['org.keycloak.userprofile.UserProfileProvider'][0].config['kc.user.profile.config'][0]);

test('profil utilisateur : politique des attributs non déclarés absente ou valeur acceptée par Keycloak', () => {
  // Valeurs acceptées : ENABLED, ADMIN_VIEW, ADMIN_EDIT. « DISABLED » est refusée à l'import ; l'absence = désactivée.
  const v = profile.unmanagedAttributePolicy;
  assert.ok(v === undefined || ['ENABLED', 'ADMIN_VIEW', 'ADMIN_EDIT'].includes(v), `unmanagedAttributePolicy invalide : ${v}`);
});

test('profil utilisateur : attributs de base déclarés, phone_number modifiable par l\'administrateur seulement', () => {
  const by = Object.fromEntries(profile.attributes.map((a) => [a.name, a]));
  for (const n of ['username', 'email', 'firstName', 'lastName', 'phone_number']) assert.ok(by[n], `attribut manquant : ${n}`);
  assert.deepEqual(by.phone_number.permissions.edit, ['admin']);
  assert.match('237677000111', new RegExp(by.phone_number.validations.pattern.pattern));
});

test('clients : PKCE S256, inactivité 15 / 30 min, client système sans parcours humain, audience de la passerelle', () => {
  const c = Object.fromEntries(realm.clients.map((x) => [x.clientId, x]));
  assert.equal(c['syfa-web'].attributes['client.session.idle.timeout'], '900');
  assert.equal(c['syfa-android-pro'].attributes['client.session.idle.timeout'], '1800');
  for (const id of ['syfa-web', 'syfa-android-pro']) {
    assert.equal(c[id].attributes['pkce.code.challenge.method'], 'S256');
    assert.equal(c[id].directAccessGrantsEnabled, false);
    assert.ok(c[id].protocolMappers.some((m) => m.config['included.client.audience'] === 'syfa-gateway'));
  }
  assert.equal(c['syfa-system'].serviceAccountsEnabled, true);
  assert.equal(c['syfa-system'].standardFlowEnabled, false);
});

test('realm : second facteur TOTP, blocage après échecs, mot de passe robuste', () => {
  assert.equal(realm.otpPolicyType, 'totp');
  assert.equal(realm.otpPolicyDigits, 6);
  assert.equal(realm.bruteForceProtected, true);
  assert.match(realm.passwordPolicy, /length\(12\)/);
  assert.ok(realm.requiredActions.some((a) => a.alias === 'CONFIGURE_TOTP' && a.defaultAction === true));
});

test('Compose : image Keycloak épinglée (jamais « latest » ni sans étiquette) et services optionnels hors du démarrage par défaut', () => {
  const compose = read('infra/docker-compose.yml');
  const kc = /image:\s*\$\{KEYCLOAK_IMAGE:-([^}]+)\}/.exec(compose);
  assert.ok(kc, 'KEYCLOAK_IMAGE avec valeur par défaut attendue');
  assert.match(kc[1], /^quay\.io\/keycloak\/keycloak:\d+\.\d+\.\d+$/);
  for (const svc of ['hapi-fhir', 'minio', 'vault', 'postgres-fhir']) {
    const block = new RegExp(`\\n  ${svc}:[\\s\\S]*?(?=\\n  [a-z-]+:\\n|\\nvolumes:)`).exec(compose)?.[0] ?? '';
    assert.match(block, /profiles:\s*\[full\]/, `${svc} devrait être dans le profil « full »`);
  }
});
