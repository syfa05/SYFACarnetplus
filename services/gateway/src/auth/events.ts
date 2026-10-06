import type { Queryable } from '../db/db.js';

/**
 * Événements d'authentification, en ajout seul. Règle : jamais de code, de PIN, de secret ni de jeton, et jamais
 * le message d'une erreur externe (utiliser describeFailure).
 */
export class AuthEvents {
  constructor(private readonly now: () => Date) {}
  async record(q: Queryable, type: string, subject: string | null, details: Record<string, unknown> = {}): Promise<void> {
    await q.query('INSERT INTO auth_event (at, type, subject, details) VALUES ($1,$2,$3,$4::jsonb)', [
      this.now().toISOString(), type, subject, JSON.stringify(details),
    ]);
  }
}
