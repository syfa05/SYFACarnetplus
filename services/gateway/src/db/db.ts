// Interface minimale sur la base : satisfaite par `pg` (via un adaptateur) et par PGlite (tests).
export interface Queryable {
  /** Exécute un script SQL (plusieurs instructions, sans paramètres). */
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Db extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}
