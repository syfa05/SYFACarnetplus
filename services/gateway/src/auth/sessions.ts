import type { Db, Queryable } from '../db/db.js';
import type { AuthConfig, ClientClass } from './config.js';

export type SessionCheck = { ok: true } | { ok: false; reason: 'unknown' | 'revoked' | 'idle' | 'expired' };

/**
 * Sessions et inactivité (F-AUTH-04). L'inactivité est contrôlée par la passerelle elle-même, quelle que soit
 * la configuration du fournisseur d'identité : une session inactive depuis plus que la limite ne revit jamais.
 */
export class SessionStore {
  constructor(
    private readonly db: Db,
    private readonly config: AuthConfig,
    private readonly now: () => Date,
  ) {}

  async create(
    q: Queryable,
    s: { id: string; kind: 'patient' | 'professional'; subject: string; clientClass: ClientClass; deviceId?: string | null;
         refreshHash?: string | null; maxSeconds?: number | null },
  ): Promise<void> {
    const now = this.now();
    await q.query(
      `INSERT INTO auth_session (id, kind, subject, client_class, device_id, refresh_hash, created_at, last_activity, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8) ON CONFLICT (id) DO NOTHING`,
      [s.id, s.kind, s.subject, s.clientClass, s.deviceId ?? null, s.refreshHash ?? null, now.toISOString(),
       s.maxSeconds ? new Date(now.getTime() + s.maxSeconds * 1000).toISOString() : null],
    );
  }

  /**
   * Professionnels : crée la session au premier jeton vu, puis enregistre l'activité — en une seule requête.
   * Retourne faux si la session est révoquée, inactive depuis trop longtemps ou de type différent.
   */
  async touchOrCreate(id: string, subject: string, clientClass: ClientClass): Promise<boolean> {
    const now = this.now();
    const nowIso = now.toISOString();
    const idleLimit = new Date(now.getTime() - this.config.idleSeconds[clientClass] * 1000).toISOString();
    const { rows } = await this.db.query(
      `INSERT INTO auth_session (id, kind, subject, client_class, created_at, last_activity)
       VALUES ($1,'professional',$2,$3,$4,$4)
       ON CONFLICT (id) DO UPDATE SET last_activity=$4
       WHERE auth_session.revoked_at IS NULL AND auth_session.client_class=$3 AND auth_session.subject=$2
         AND auth_session.last_activity > $5 AND (auth_session.expires_at IS NULL OR auth_session.expires_at > $4)
       RETURNING id`,
      [id, subject, clientClass, nowIso, idleLimit]);
    if (rows.length) return true;
    await this.closeIfIdle(id, idleLimit);
    return false;
  }

  /** Enregistre une activité si — et seulement si — la session est encore valide. */
  async touch(id: string, clientClass: ClientClass): Promise<SessionCheck> {
    const now = this.now();
    const idleLimit = new Date(now.getTime() - this.config.idleSeconds[clientClass] * 1000).toISOString();
    const nowIso = now.toISOString();
    const upd = await this.db.query(
      `UPDATE auth_session SET last_activity=$2
       WHERE id=$1 AND client_class=$3 AND revoked_at IS NULL AND last_activity > $4 AND (expires_at IS NULL OR expires_at > $2)
       RETURNING id`,
      [id, nowIso, clientClass, idleLimit],
    );
    if (upd.rows.length) return { ok: true };
    const row = (await this.db.query<{ revoked_at: unknown; last_activity: Date; expires_at: Date | null }>(
      'SELECT revoked_at, last_activity, expires_at FROM auth_session WHERE id=$1 AND client_class=$2', [id, clientClass])).rows[0];
    if (!row) return { ok: false, reason: 'unknown' };
    if (row.revoked_at) return { ok: false, reason: 'revoked' };
    if (row.expires_at && new Date(row.expires_at) <= now) return { ok: false, reason: 'expired' };
    await this.closeIfIdle(id, idleLimit);
    return { ok: false, reason: 'idle' };
  }

  /** Une session inactive trop longtemps est fermée pour de bon (aucun retour possible, même si l'horloge recule). */
  private async closeIfIdle(id: string, idleLimit: string): Promise<void> {
    await this.db.query(
      "UPDATE auth_session SET revoked_at=$3, revoked_reason='idle' WHERE id=$1 AND revoked_at IS NULL AND last_activity <= $2",
      [id, idleLimit, this.now().toISOString()]);
  }

  async revoke(q: Queryable, id: string, reason: string): Promise<void> {
    await q.query('UPDATE auth_session SET revoked_at=$2, revoked_reason=$3 WHERE id=$1 AND revoked_at IS NULL', [id, this.now().toISOString(), reason]);
  }

  /** Ferme les sessions professionnelles d'un utilisateur sur les types de client exigeant un appareil. */
  async revokeProfessional(q: Queryable, subject: string, classes: ClientClass[], reason: string): Promise<void> {
    await q.query(
      "UPDATE auth_session SET revoked_at=$2, revoked_reason=$3 WHERE subject=$1 AND kind='professional' AND client_class = ANY($4::text[]) AND revoked_at IS NULL",
      [subject, this.now().toISOString(), reason, classes]);
  }

  async revokeForDevice(q: Queryable, deviceId: string, reason: string): Promise<void> {
    await q.query('UPDATE auth_session SET revoked_at=$2, revoked_reason=$3 WHERE device_id=$1 AND revoked_at IS NULL', [deviceId, this.now().toISOString(), reason]);
  }
}
