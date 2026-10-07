import { describe, expect, it } from 'vitest';
import { loadAuthConfig } from '../../src/auth/config.js';
import { loadConfig } from '../../src/config.js';
import { AuthCrypto, generateAuthKey } from '../../src/auth/crypto.js';
import { Translator } from '../../src/auth/sms.js';
import { fileURLToPath } from 'node:url';

describe('configuration d\'authentification (paramétrable, principe 9)', () => {
  it('valeurs par défaut du dossier : OTP 6 chiffres / 10 min / 3 essais, PIN 4 chiffres / 5 essais, 15 et 30 min', () => {
    const c = loadAuthConfig({});
    expect(c.otp).toMatchObject({ length: 6, ttlSeconds: 600, maxAttempts: 3 });
    expect(c.pin).toEqual({ length: 4, maxAttempts: 5, rejectWeak: true });
    expect(c.idleSeconds).toMatchObject({ shared_pc: 900, smartphone: 1800 });
    expect(c.clientClasses).toEqual({ 'syfa-web': 'shared_pc', 'syfa-android-pro': 'smartphone' });
  });
  it.each([
    [{ AUTH_OTP_TTL_SECONDS: '0' }],
    [{ AUTH_PIN_MAX_ATTEMPTS: 'x' }],
    [{ AUTH_CLIENT_CLASSES: 'web:inconnu' }],
    [{ AUTH_DEVICE_REQUIRED_CLASSES: 'patient_app' }],
    [{ AUTH_ACCESS_TOKEN_SECONDS: '3600' }], // dépasserait l'inactivité d'un poste partagé
    [{ AUTH_PIN_LENGTH: '2' }],
  ])('refuse une configuration absurde %j', (env) => {
    expect(() => loadAuthConfig(env)).toThrow();
  });
});

describe('secrets d\'authentification', () => {
  const c = new AuthCrypto(generateAuthKey());
  it('codes numériques : longueur exacte, chiffres seulement, bien répartis', () => {
    const counts = new Array(10).fill(0) as number[];
    for (let i = 0; i < 3000; i++) {
      const code = c.numericCode(6);
      expect(code).toMatch(/^\d{6}$/);
      for (const ch of code) counts[Number(ch)]!++;
    }
    for (const n of counts) expect(n).toBeGreaterThan(1500); // ~1800 attendus par chiffre
  });
  it('PIN : haché avec sel et poivre, vérifié en temps constant, lié à l\'appareil', async () => {
    const h1 = await c.hashPin('dev-1', '1234');
    const h2 = await c.hashPin('dev-1', '1234');
    expect(h1).not.toBe(h2); // sel aléatoire
    expect(await c.verifyPin('dev-1', '1234', h1)).toBe(true);
    expect(await c.verifyPin('dev-1', '1235', h1)).toBe(false);
    expect(await c.verifyPin('dev-2', '1234', h1)).toBe(false); // lié à l'appareil
    expect(await new AuthCrypto(generateAuthKey()).verifyPin('dev-1', '1234', h1)).toBe(false); // poivre
    expect(await c.verifyPin('dev-1', '1234', 'format-inconnu')).toBe(false);
  });
  it('secrets : 256 bits, empreinte stable, comparaison sûre ; clés invalides refusées', () => {
    const a = c.newSecret();
    expect(Buffer.from(a.secret, 'base64url')).toHaveLength(32);
    expect(c.secretHash(a.secret)).toBe(a.hash);
    expect(AuthCrypto.equal(a.hash, a.hash)).toBe(true);
    expect(AuthCrypto.equal(a.hash, c.newSecret().hash)).toBe(false);
    expect(c.hmac('otp', 'x')).not.toBe(c.hmac('device', 'x')); // sous-clés par usage
    expect(() => new AuthCrypto('court')).toThrow();
    expect(() => AuthCrypto.fromEnv({})).toThrow();
  });
});

describe('textes SMS (principe 8, F-JRN-02)', () => {
  const tr = new Translator(fileURLToPath(new URL('../../../../i18n', import.meta.url)));
  it.each(['fr', 'en'])('%s : modèles sans lien, sans établissement, sans donnée médicale', (lang) => {
    for (const text of [tr.t(lang, 'sms.otp', { code: '123456', minutes: 10 }), tr.t(lang, 'sms.new_device')]) {
      expect(text).not.toMatch(/https?:|www\.|\.com|\.cm|\//i);
      expect(text).not.toMatch(/hôpital|clinique|centre de|pharmacie|hospital|clinic|diagnos|traitement|treatment/i);
      expect(text).not.toMatch(/\{\w+\}/); // aucune variable non remplacée
    }
    expect(tr.t(lang, 'sms.otp', { code: '123456', minutes: 10 })).toContain('123456');
  });
  it('clé absente : erreur explicite (jamais un texte vide envoyé)', () => {
    expect(() => tr.t('fr', 'sms.inexistant')).toThrow();
  });
});

describe('booléens et nombres de l\'environnement : jamais de faute de frappe silencieuse', () => {
  const AUTH_BOOLS: Array<[string, (c: ReturnType<typeof loadAuthConfig>) => boolean, boolean]> = [
    ['AUTH_DEVICE_ENROLMENT_NETWORK_ONLY', (c) => c.deviceEnrolmentNetworkOnly, true],
    ['AUTH_PIN_REJECT_WEAK', (c) => c.pin.rejectWeak, true],
    ['AUTH_REVOKE_OTHER_DEVICES_ON_ENROL', (c) => c.revokeOtherDevicesOnEnrol, true],
    ['AUTH_ALERT_ON_FIRST_DEVICE', (c) => c.alertOnFirstProfessionalDevice, true],
  ];
  const INVALID = ['treu', 'flase', 'TRUE', 'False', 'True', '1', '0', 'yes', 'no', 'on', 'off', ' true', 'true ', 'oui', 'vrai', 'null'];
  const base = { OIDC_ISSUER: 'http://kc/realms/x', OIDC_AUDIENCE: 'a' };

  it.each(AUTH_BOOLS)('%s : « true » et « false » seuls sont acceptés ; vide ou absent = défaut sûr', (key, read, def) => {
    expect(read(loadAuthConfig({ [key]: 'true' }))).toBe(true);
    expect(read(loadAuthConfig({ [key]: 'false' }))).toBe(false);
    expect(read(loadAuthConfig({}))).toBe(def);
    expect(read(loadAuthConfig({ [key]: '' }))).toBe(def);
    for (const v of INVALID) expect(() => loadAuthConfig({ [key]: v }), `${key}=${v}`).toThrow(key);
  });
  it('AUTO_MIGRATE : même rigueur', () => {
    expect(loadConfig({ ...base, AUTO_MIGRATE: 'true' }).autoMigrate).toBe(true);
    expect(loadConfig({ ...base, AUTO_MIGRATE: 'false' }).autoMigrate).toBe(false);
    expect(loadConfig(base).autoMigrate).toBe(false);
    for (const v of INVALID) expect(() => loadConfig({ ...base, AUTO_MIGRATE: v }), v).toThrow('AUTO_MIGRATE');
  });
  it('la faute de frappe sur la restriction d\'enrôlement ne la désactive plus (cas relevé en revue)', () => {
    expect(() => loadAuthConfig({ AUTH_DEVICE_ENROLMENT_NETWORK_ONLY: 'treu' })).toThrow(/true.*false/);
    expect(() => loadAuthConfig({ AUTH_DEVICE_ENROLMENT_NETWORK_ONLY: 'flase' })).toThrow();
  });
  it('PORT : entier entre 1 et 65535 ; les nombres de sécurité refusent « 3x », « -1 », « 1.5 »', () => {
    expect(loadConfig({ ...base, PORT: '9090' }).port).toBe(9090);
    expect(loadConfig(base).port).toBe(8080);
    for (const v of ['0', '65536', 'abc', '80x', '-1', '1.5', ' 80']) expect(() => loadConfig({ ...base, PORT: v }), v).toThrow('PORT');
    for (const v of ['3x', '-1', '1.5', '0x10', '1e3']) expect(() => loadAuthConfig({ AUTH_OTP_MAX_ATTEMPTS: v }), v).toThrow('AUTH_OTP_MAX_ATTEMPTS');
  });
});
