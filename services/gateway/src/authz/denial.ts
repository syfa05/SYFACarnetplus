import type { RateLimiter } from '../auth/rate-limit.js';
import type { Db } from '../db/db.js';

export interface DenialRow {
  actorSub: string | null; actorKind: string; establishmentId: string | null; patientId?: string | null;
  action: string; data: string; reason: string; condition?: string | null;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cut = (v: string | null | undefined, n: number) => (typeof v === 'string' ? v.slice(0, n) : null);

/**
 * Journal des refus d'accès (T-ACC-01/02). Au plus `perWindow` lignes par acteur, donnée, action et motif et par
 * fenêtre : un compte authentifié sans droit ne peut pas remplir la table à volonté. Un échec de journalisation ne
 * change jamais la décision (le refus est déjà pris).
 */
export class DenialLog {
  constructor(
    private readonly db: Db,
    private readonly limiter: RateLimiter,
    private readonly now: () => Date,
    private readonly cfg: { perWindow: number; windowSeconds: number },
  ) {}

  async record(r: DenialRow): Promise<void> {
    try {
      const key = `${r.actorKind}|${r.actorSub ?? ''}|${r.data}|${r.action}|${r.reason}`;
      if (!(await this.limiter.hit('denial-log', key, this.cfg.perWindow, this.cfg.windowSeconds)).allowed) return;
      await this.db.query(
        'INSERT INTO access_denial (at, actor_sub, actor_kind, establishment_id, patient_id, action, data, reason, condition) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [this.now().toISOString(), cut(r.actorSub, 128), cut(r.actorKind, 32), r.establishmentId && UUID.test(r.establishmentId) ? r.establishmentId : null,
         r.patientId && UUID.test(r.patientId) ? r.patientId : null, cut(r.action, 32), cut(r.data, 64), cut(r.reason, 64), cut(r.condition, 8)]);
    } catch {
      /* journalisation au mieux */
    }
  }
}
