import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Db, Queryable } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrate.js';
import { pgDb } from '../../src/db/pg.js';
import { loadIdentityConfig } from '../../src/identity/config.js';
import { FieldCrypto, generateMasterKey } from '../../src/identity/crypto.js';
import type { FhirReferenceReassigner } from '../../src/identity/fhir-port.js';
import { IdentityService } from '../../src/identity/service.js';
import type { PatientInput } from '../../src/identity/types.js';

/**
 * Par défaut : PGlite (PostgreSQL en WebAssembly, sans installation).
 * Avec TEST_DATABASE_URL : vrai PostgreSQL, un schéma isolé par test (requis pour la concurrence).
 */
export const REAL_PG = Boolean(process.env.TEST_DATABASE_URL);
const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const cleanups: Array<() => Promise<void>> = [];

export async function cleanup(): Promise<void> {
  for (const c of cleanups.splice(0)) await c().catch(() => {});
}

const wrap = (q: PGlite | Parameters<Parameters<PGlite['transaction']>[0]>[0]): Queryable => ({
  query: (sql, params) => q.query(sql, params as never) as never,
  exec: (sql) => q.exec(sql),
});

export async function makeDb(): Promise<Db> {
  if (REAL_PG) {
    const schema = `t_${randomUUID().replace(/-/g, '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, options: `-c search_path=${schema}` });
    cleanups.push(async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    const db = pgDb(pool);
    await migrate(db, MIGRATIONS);
    return db;
  }
  const raw = new PGlite();
  const db: Db = { ...wrap(raw), transaction: (fn) => raw.transaction((tx) => fn(wrap(tx))) };
  await migrate(db, MIGRATIONS);
  return db;
}

export const testCrypto = () => new FieldCrypto(generateMasterKey());

export async function makeService(fhir?: FhirReferenceReassigner, crypto = testCrypto()) {
  const db = await makeDb();
  return { db, raw: db as Queryable, crypto, service: new IdentityService(db, loadIdentityConfig({}), crypto, fhir) };
}

export const base = (over: Partial<PatientInput> = {}): PatientInput => ({
  nom: 'Mbarga', prenoms: 'Jean Pierre', dateNaissance: '1985-03-12', sexe: 'M',
  lieuNaissance: 'Yaoundé', niveauIdentite: 2, langue: 'fr', ...over,
});

/** Ligne de délégation factice (colonnes chiffrées : valeurs opaques, jamais relues par ces tests). */
export const DELEGATION_SQL =
  "INSERT INTO companion_delegation VALUES (gen_random_uuid(), $1, 'opaque', 'opaque', now(), now() + interval '1 day', 'x')";
