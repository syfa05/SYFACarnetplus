import { createRemoteJWKSet } from 'jose';
import pg from 'pg';
import { buildApp } from './app.js';
import { loadAuthConfig } from './auth/config.js';
import { AuthCrypto } from './auth/crypto.js';
import { createAuthRuntime } from './auth/factory.js';
import { HttpSmsSender, Translator } from './auth/sms.js';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { pgDb } from './db/pg.js';
import { loadIdentityConfig } from './identity/config.js';
import { FieldCrypto } from './identity/crypto.js';
import { IdentityService } from './identity/service.js';
import { loadDirectory, loadOrgConfig } from './org/config.js';

const need = (v: string | undefined, name: string): string => {
  if (!v) throw new Error(`Variable d'environnement manquante : ${name}`);
  return v;
};

const config = loadConfig();
const db = pgDb(new pg.Pool({ connectionString: need(config.databaseUrl, 'DATABASE_URL') }));
if (config.autoMigrate) await migrate(db, config.migrationsDir);

const org = loadOrgConfig();
const rt = createAuthRuntime({
  directory: loadDirectory(config.oidcIssuer),
  engine: org.engine,
  org,
  homologatedClients: org.homologatedClients,
  auth: loadAuthConfig(),
  db,
  identity: new IdentityService(db, loadIdentityConfig(), FieldCrypto.fromEnv()),
  crypto: AuthCrypto.fromEnv(),
  sms: new HttpSmsSender(need(config.smsUrl, 'SMS_URL')),
  i18n: new Translator(config.i18nDir),
  keycloakKey: createRemoteJWKSet(new URL(config.jwksUrl)),
  patientPrivateKeyPem: Buffer.from(need(process.env.PATIENT_JWT_PRIVATE_KEY_B64, 'PATIENT_JWT_PRIVATE_KEY_B64'), 'base64').toString('utf8'),
});

const app = buildApp(config, rt);
await app.listen({ port: config.port, host: '0.0.0.0' });

// Rattrapage périodique des écarts avec le fournisseur d'identité (activation / désactivation distante échouée).
setInterval(() => { rt.org.reconcilePending().catch(() => {}); }, 60_000).unref();
