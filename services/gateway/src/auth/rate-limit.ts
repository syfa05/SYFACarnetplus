import type { Queryable } from '../db/db.js';
import type { AuthCrypto } from './crypto.js';

export interface RateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Limitation de débit à fenêtre fixe, partagée entre instances (PostgreSQL). Les clés sont des empreintes :
 * ni adresse IP ni numéro de téléphone en clair dans la base.
 */
export class RateLimiter {
  constructor(
    private readonly db: Queryable,
    private readonly crypto: AuthCrypto,
    private readonly now: () => Date,
  ) {}

  /** `q` : connexion de la transaction en cours (évite de réclamer une seconde connexion pendant qu'on en tient une). */
  async hit(label: string, subject: string, limit: number, windowSeconds: number, q: Queryable = this.db): Promise<RateDecision> {
    const nowS = Math.floor(this.now().getTime() / 1000);
    const windowStart = nowS - (nowS % windowSeconds);
    const key = `${label}:${this.crypto.hmac('ratelimit', subject)}`;
    const { rows } = await q.query<{ hits: number }>(
      `INSERT INTO auth_rate_limit (key, window_start, hits) VALUES ($1,$2,1)
       ON CONFLICT (key, window_start) DO UPDATE SET hits = auth_rate_limit.hits + 1 RETURNING hits`,
      [key, windowStart],
    );
    const hits = Number(rows[0]!.hits);
    return { allowed: hits <= limit, retryAfterSeconds: windowStart + windowSeconds - nowS };
  }

  /** Annule une prise (opération finalement non réalisée) : un échec côté serveur ne doit pas consommer le quota. */
  async refund(label: string, subject: string, windowSeconds: number, q: Queryable = this.db): Promise<void> {
    const nowS = Math.floor(this.now().getTime() / 1000);
    await q.query('UPDATE auth_rate_limit SET hits = GREATEST(hits - 1, 0) WHERE key=$1 AND window_start=$2',
      [`${label}:${this.crypto.hmac('ratelimit', subject)}`, nowS - (nowS % windowSeconds)]);
  }

  /** Purge des fenêtres échues (tâche périodique). */
  async purge(olderThanSeconds = 86_400): Promise<void> {
    await this.db.query('DELETE FROM auth_rate_limit WHERE window_start < $1', [Math.floor(this.now().getTime() / 1000) - olderThanSeconds]);
  }
}
