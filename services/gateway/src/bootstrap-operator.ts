import pg from 'pg';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { pgDb } from './db/pg.js';
import { bootstrapOperator } from './org/bootstrap.js';

// Usage : DATABASE_URL=... node dist/bootstrap-operator.js <sub> [--habilite] [--reactivate]
const [sub, ...flags] = process.argv.slice(2);
if (!sub) throw new Error('usage : bootstrap-operator <sub> [--habilite] [--reactivate]');
const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const db = pgDb(pool);
await migrate(db, config.migrationsDir);
await bootstrapOperator(db, sub, { habilite: flags.includes('--habilite'), reactivate: flags.includes('--reactivate') });
await pool.end();
console.log('opérateur enregistré');
