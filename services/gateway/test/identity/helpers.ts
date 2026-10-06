import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import type { Db, Queryable } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrate.js';
import { loadIdentityConfig } from '../../src/identity/config.js';
import { IdentityService } from '../../src/identity/service.js';
import type { FhirReferenceReassigner } from '../../src/identity/fhir-port.js';
import type { PatientInput } from '../../src/identity/types.js';

const wrap = (q: PGlite | Parameters<Parameters<PGlite['transaction']>[0]>[0]): Queryable => ({
  query: (sql, params) => q.query(sql, params as never) as never,
  exec: (sql) => q.exec(sql),
});

export async function makeDb(): Promise<{ db: Db; raw: PGlite }> {
  const raw = new PGlite();
  const db: Db = { ...wrap(raw), transaction: (fn) => raw.transaction((tx) => fn(wrap(tx))) };
  await migrate(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  return { db, raw };
}

export async function makeService(fhir?: FhirReferenceReassigner) {
  const { db, raw } = await makeDb();
  return { db, raw, service: new IdentityService(db, loadIdentityConfig({}), fhir) };
}

export const base = (over: Partial<PatientInput> = {}): PatientInput => ({
  nom: 'Mbarga', prenoms: 'Jean Pierre', dateNaissance: '1985-03-12', sexe: 'M',
  lieuNaissance: 'Yaoundé', niveauIdentite: 2, langue: 'fr', ...over,
});
