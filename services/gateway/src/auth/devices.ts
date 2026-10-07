import { randomUUID } from 'node:crypto';
import type { Db } from '../db/db.js';
import { describeFailure } from '../identity/errors.js';
import type { AuthConfig } from './config.js';
import type { AuthCrypto } from './crypto.js';
import { AuthError } from './errors.js';
import type { AuthEvents } from './events.js';
import type { RateLimiter } from './rate-limit.js';
import type { SessionStore } from './sessions.js';
import type { SmsSender, Translator } from './sms.js';

const DEVICE_KEY = /^[A-Za-z0-9_-]{32,128}$/;
const PHONE = /^2376\d{8}$/;

export interface ProfessionalDevice {
  id: string;
  label: string | null;
  status: 'pending' | 'active' | 'revoked';
  createdAt: string;
  lastSeenAt: string | null;
}

/**
 * Appareils des professionnels : enregistrement, vérification, alerte « nouvel appareil » (onglet 6.2).
 * La clé d'appareil est générée sur l'appareil ; seule son empreinte est conservée.
 */
export class ProfessionalDeviceService {
  constructor(
    private readonly db: Db,
    private readonly config: AuthConfig,
    private readonly crypto: AuthCrypto,
    private readonly sms: SmsSender,
    private readonly i18n: Translator,
    private readonly sessions: SessionStore,
    private readonly events: AuthEvents,
    private readonly limiter: RateLimiter,
    private readonly now: () => Date,
  ) {}

  private hash(subject: string, key: string): string {
    return this.crypto.hmac('device', `${subject}\0${key}`);
  }

  /**
   * Enrôle un appareil en TROIS temps, sans jamais appeler un service externe pendant qu'une transaction est ouverte :
   *  1. réservation (courte transaction) : l'appareil est `pending`, inutilisable ; plafonds, numéro et quota contrôlés ;
   *  2. alerte « nouvel appareil » (SMS), hors transaction ; si elle échoue, la réservation est supprimée et le quota rendu ;
   *  3. activation (courte transaction) : l'appareil devient `active`.
   * Un appareil n'est donc utilisable que si son alerte a été acceptée. Garantie : l'alerte part AU MOINS une fois par
   * appareil (si l'activation échoue après l'envoi, la reprise renvoie l'alerte) — jamais un appareil actif sans alerte,
   * et jamais de réservation fantôme durable (une réservation orpheline expire après `pendingSeconds`).
   */
  async register(subject: string, deviceKey: string, label: string | undefined, phone: string | undefined, lang = 'fr'): Promise<{ id: string; created: boolean }> {
    if (!DEVICE_KEY.test(deviceKey ?? '')) throw new AuthError('validation', 400);
    const keyHash = this.hash(subject, deviceKey);
    const cfg = this.config.device;

    // -- 1. réservation
    let reservation: { id: string; existing: boolean; mustAlert: boolean };
    try {
      reservation = await this.db.transaction(async (tx) => {
        // Un seul enrôlement à la fois par professionnel : le plafond ne peut pas être dépassé en parallèle.
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`device:${subject}`]);
        const ex = (await tx.query<{ id: string; status: string }>('SELECT id, status FROM auth_professional_device WHERE subject=$1 AND key_hash=$2', [subject, keyHash])).rows[0];
        if (ex?.status === 'revoked') throw new AuthError('device_revoked', 409); // définitif : il faut une nouvelle clé, donc un nouvel enrôlement alerté
        if (ex?.status === 'active') return { id: ex.id, existing: true, mustAlert: false }; // idempotent : ni alerte ni quota
        const live = new Date(this.now().getTime() - cfg.pendingSeconds * 1000).toISOString();
        const others = Number((await tx.query<{ n: string }>(
          `SELECT count(*) AS n FROM auth_professional_device
           WHERE subject=$1 AND id <> $2 AND (status='active' OR (status='pending' AND pending_since > $3))`,
          [subject, ex?.id ?? randomUUID(), live])).rows[0]!.n);
        if (others >= cfg.maxActive) throw new AuthError('device_limit_reached', 409);
        const mustAlert = others > 0 || this.config.alertOnFirstProfessionalDevice;
        if (mustAlert && !(phone && PHONE.test(phone))) throw new AuthError('phone_required', 409);
        // Chaque nouvel appareil déclenche une alerte SMS : pas d'inondation (coût, harcèlement) — au-delà du quota, refus.
        const q = await this.limiter.hit('device-register', subject, cfg.registrationsPerWindow, cfg.registrationWindowSeconds, tx);
        if (!q.allowed) throw new AuthError('too_many_requests', 429, { retryAfterSeconds: q.retryAfterSeconds });
        const nowIso = this.now().toISOString();
        if (ex) {
          // `pending` : reprise après interruption (l'alerte a pu partir ou non) — compte comme une nouvelle tentative.
          await tx.query("UPDATE auth_professional_device SET pending_since=$2, label=COALESCE($3, label) WHERE id=$1", [ex.id, nowIso, label?.slice(0, 80) ?? null]);
          return { id: ex.id, existing: false, mustAlert };
        }
        const id = randomUUID();
        await tx.query(
          `INSERT INTO auth_professional_device (id, subject, key_hash, label, status, pending_since, created_at, last_seen_at) VALUES ($1,$2,$3,$4,'pending',$5,$5,$5)`,
          [id, subject, keyHash, label?.slice(0, 80) ?? null, nowIso]);
        return { id, existing: false, mustAlert };
      });
    } catch (e) {
      // Les refus sont tracés APRÈS la transaction (et jamais pendant qu'on tient une connexion).
      if (e instanceof AuthError && e.code === 'phone_required') await this.events.record(this.db, 'device_enrolment_refused', subject, { raison: 'phone_required' });
      throw e;
    }
    if (reservation.existing) return { id: reservation.id, created: false };

    // -- 2. alerte, hors transaction (SMS neutre : sans lien, établissement ni donnée médicale)
    if (reservation.mustAlert) {
      try {
        await this.sms.send(phone!, this.i18n.t(lang, 'sms.new_device'));
      } catch (e) {
        await this.db.transaction(async (tx) => {
          await tx.query("DELETE FROM auth_professional_device WHERE id=$1 AND status='pending'", [reservation.id]);
          await this.limiter.refund('device-register', subject, cfg.registrationWindowSeconds, tx); // un échec de notre côté ne consomme pas le quota
          await this.events.record(tx, 'device_alert_failed', subject, { cause: describeFailure(e) });
        });
        throw new AuthError('alert_failed', 503);
      }
    }

    // -- 3. activation
    return this.db.transaction(async (tx) => {
      const act = await tx.query("UPDATE auth_professional_device SET status='active', pending_since=NULL WHERE id=$1 AND status='pending' RETURNING id", [reservation.id]);
      if (!act.rows.length) {
        // Activé entre-temps par une reprise concurrente : succès idempotent ; révoqué ou expiré : refus.
        const now = (await tx.query<{ status: string }>('SELECT status FROM auth_professional_device WHERE id=$1', [reservation.id])).rows[0];
        if (now?.status === 'active') return { id: reservation.id, created: false };
        throw new AuthError('enrolment_interrupted', 409);
      }
      if (reservation.mustAlert) await this.events.record(tx, 'device_alert_sent', subject);
      await this.events.record(tx, 'professional_device_registered', subject, { appareil: reservation.id });
      return { id: reservation.id, created: true };
    });
  }

  /** Appareil actif correspondant à la clé présentée, ou null. Met à jour la dernière activité. */
  async verify(subject: string, deviceKey: string | undefined): Promise<string | null> {
    if (!deviceKey || !DEVICE_KEY.test(deviceKey)) return null;
    const { rows } = await this.db.query<{ id: string }>(
      "UPDATE auth_professional_device SET last_seen_at=$3 WHERE subject=$1 AND key_hash=$2 AND status='active' RETURNING id",
      [subject, this.hash(subject, deviceKey), this.now().toISOString()]);
    return rows[0]?.id ?? null;
  }

  async list(subject: string): Promise<ProfessionalDevice[]> {
    const { rows } = await this.db.query<{ id: string; label: string | null; status: 'pending' | 'active' | 'revoked'; created_at: Date; last_seen_at: Date | null }>(
      'SELECT id, label, status, created_at, last_seen_at FROM auth_professional_device WHERE subject=$1 ORDER BY created_at, id', [subject]);
    return rows.map((r) => ({ id: r.id, label: r.label, status: r.status, createdAt: new Date(r.created_at).toISOString(), lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null }));
  }

  /**
   * Révoque un appareil et ferme ses sessions. `subject` limite la portée à ses propres appareils ;
   * la révocation par un directeur médical ou l'opérateur passe par le moteur d'autorisation (lot L3).
   */
  async revoke(deviceId: string, opts: { subject?: string; reason: string; actor: string }): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ subject: string }>(
        `UPDATE auth_professional_device SET status='revoked', revoked_at=$2
         WHERE id=$1 AND status IN ('active','pending') AND ($3::text IS NULL OR subject=$3) RETURNING subject`,
        [deviceId, this.now().toISOString(), opts.subject ?? null]);
      if (!rows.length) return false;
      await this.sessions.revokeProfessional(tx, rows[0]!.subject, this.config.deviceRequiredClasses, opts.reason);
      await this.events.record(tx, 'professional_device_revoked', rows[0]!.subject, { appareil: deviceId, acteur: opts.actor, raison: opts.reason });
      return true;
    });
  }
}
