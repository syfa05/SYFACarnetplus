import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db.js';

/** Applique dans l'ordre les fichiers *.sql pas encore appliqués (une transaction par fichier). */
export async function migrate(db: Db, dir: string): Promise<string[]> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migration')).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(readFileSync(join(dir, file), 'utf8'));
      await tx.query('INSERT INTO schema_migration (name) VALUES ($1)', [file]);
    });
    applied.push(file);
  }
  return applied;
}
