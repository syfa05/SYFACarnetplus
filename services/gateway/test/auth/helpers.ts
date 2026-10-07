import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generateKeyPair, SignJWT, type KeyLike } from 'jose';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadAuthConfig, type AuthConfig } from '../../src/auth/config.js';
import { AuthCrypto, generateAuthKey } from '../../src/auth/crypto.js';
import { createAuthRuntime } from '../../src/auth/factory.js';
import type { AuthRuntime } from '../../src/auth/runtime.js';
import { Translator, type SmsSender } from '../../src/auth/sms.js';
import { loadConfig } from '../../src/config.js';
import { loadIdentityConfig } from '../../src/identity/config.js';
import { IdentityService } from '../../src/identity/service.js';
import type { PatientInput } from '../../src/identity/types.js';
import { base, makeDb, testCrypto } from '../identity/helpers.js';

export { cleanup } from '../identity/helpers.js';

export const ISSUER = 'http://kc.test/realms/syfa';
export const AUDIENCE = 'syfa-gateway';
export const PHONE = '237690000001';

export class FakeSms implements SmsSender {
  sent: Array<{ to: string; text: string }> = [];
  failNext = false;
  /** Appels de `send` commencés (avant la fin de la barrière). */
  started = 0;
  /** Si défini, `send` attend cette promesse avant d'aboutir (simule un fournisseur lent). */
  gate?: Promise<void>;
  /** Appelé au début de chaque envoi (inspection de l'état de la base à cet instant). */
  onSend?: () => Promise<void>;
  async send(to: string, text: string) {
    this.started++;
    await this.onSend?.();
    if (this.gate) await this.gate;
    if (this.failNext) { this.failNext = false; throw Object.assign(new Error('Patient Jean Dupont'), { code: 'HTTP_503' }); }
    this.sent.push({ to, text });
  }
  /** Dernier code à 6 chiffres envoyé à ce numéro. */
  code(to = PHONE): string {
    const m = [...this.sent].reverse().find((s) => s.to === to);
    const code = m?.text.match(/\b(\d{6})\b/)?.[1];
    if (!code) throw new Error('aucun code envoyé');
    return code;
  }
}

export interface Env {
  app: FastifyInstance;
  rt: AuthRuntime;
  db: Awaited<ReturnType<typeof makeDb>>;
  identity: IdentityService;
  sms: FakeSms;
  clock: { now: Date; advance(seconds: number): void };
  authConfig: AuthConfig;
  signPro(over?: Record<string, unknown>, opts?: { alg?: string; kid?: string }): Promise<string>;
  /** Inscrit un patient actif avec ce téléphone. */
  addPatient(over?: Partial<PatientInput>): Promise<string>;
  post(url: string, body: unknown, headers?: Record<string, string>): Promise<LightMyRequestResponse>;
  get(url: string, token?: string, headers?: Record<string, string>): Promise<LightMyRequestResponse>;
}

export async function makeEnv(authEnv: NodeJS.ProcessEnv = {}): Promise<Env> {
  const db = await makeDb();
  const clock = { now: new Date('2026-10-06T10:00:00Z'), advance(s: number) { this.now = new Date(this.now.getTime() + s * 1000); } };
  const now = () => clock.now;
  const authConfig = loadAuthConfig({ AUTH_SYSTEM_CLIENTS: 'syfa-system', ...authEnv });
  const identity = new IdentityService(db, loadIdentityConfig({}), testCrypto(), undefined, now);
  const sms = new FakeSms();
  const kc = await generateKeyPair('RS256');
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const rt = createAuthRuntime({
    auth: authConfig, db, identity, crypto: new AuthCrypto(generateAuthKey()), sms,
    i18n: new Translator(fileURLToPath(new URL('../../../../i18n', import.meta.url))),
    keycloakKey: kc.publicKey, now,
    patientPrivateKeyPem: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  });
  const app = buildApp(loadConfig({ OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE }), rt);
  let n = 0;
  return {
    app, rt, db, identity, sms, clock, authConfig,
    async signPro(over = {}, opts = {}) {
      const claims = { azp: 'syfa-web', sid: 'sid-1', amr: ['pwd', 'otp'], realm_access: { roles: ['medecin'] }, ...over } as Record<string, unknown>;
      let jwt = new SignJWT(claims).setProtectedHeader({ alg: opts.alg ?? 'RS256' })
        .setIssuer((over.iss as string) ?? ISSUER).setAudience((over.aud as string) ?? AUDIENCE).setExpirationTime('1h');
      if (!('sub' in over)) jwt = jwt.setSubject('pro-1');
      else if (over.sub) jwt = jwt.setSubject(over.sub as string);
      return jwt.sign(opts.alg === 'HS256' ? new TextEncoder().encode('secret-secret-secret-secret-secret!') : (kc.privateKey as KeyLike));
    },
    async addPatient(over = {}) {
      const r = await identity.register(base({ nom: `Patient${n}`, prenoms: 'Test', dateNaissance: `19${50 + (n % 40)}-0${1 + (n % 9)}-1${n % 9}`, telephone: PHONE, ...over }), 'test', { confirmNew: true, justification: 'test' });
      n++;
      if (r.outcome !== 'created') throw new Error(r.outcome);
      return r.patient.id;
    },
    post: (url, payload, headers = {}) => app.inject({ method: 'POST', url, payload: payload as never, headers }),
    get: (url, token, headers = {}) => app.inject({ method: 'GET', url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } }),
  };
}

export const OTP_REQUEST = '/v1/auth/patient/otp/request';
export const OTP_VERIFY = '/v1/auth/patient/otp/verify';
export const UNLOCK = '/v1/auth/patient/unlock';
export const REFRESH = '/v1/auth/patient/refresh';

/** Parcours complet : demande de code, vérification, retourne l'enrôlement. */
export async function enrol(env: Env, pin = '2580', phone = PHONE) {
  await env.post(OTP_REQUEST, { telephone: phone });
  await env.rt.patients.drain();
  const res = await env.post(OTP_VERIFY, { telephone: phone, code: env.sms.code(phone), pin });
  if (res.statusCode !== 200) throw new Error(`enrol: ${res.statusCode} ${res.body}`);
  return res.json() as { deviceId: string; deviceSecret: string; accessToken: string; refreshToken: string; expiresIn: number };
}

