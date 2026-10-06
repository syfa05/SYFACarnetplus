import type { Pool, PoolClient } from 'pg';
import type { Db, Queryable } from './db.js';

const wrap = (c: Pool | PoolClient): Queryable => ({
  query: (sql, params) => c.query(sql, params as never) as never,
  exec: (sql) => c.query(sql),
});

/** Adaptateur PostgreSQL (pg) pour l'interface `Db`. */
export function pgDb(pool: Pool): Db {
  return {
    ...wrap(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  };
}
