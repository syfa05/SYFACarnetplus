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
  status: 'active' | 'revoked';
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
   * Enregistre un appareil. Un nouvel appareil n'existe que si son alerte « nouvel appareil » (SMS) a été ENVOYÉE :
   * pas de numéro de téléphone valide → refus (409) ; échec de l'envoi → l'enregistrement est annulé (503).
   * L'enrôlement se fait à l'établissement, un agent présent peut donc relancer.
   */
  async register(subject: string, deviceKey: string, label: string | undefined, phone: string | undefined, lang = 'fr'): Promise<{ id: string; created: boolean }> {
    if (!DEVICE_KEY.test(deviceKey ?? '')) throw new AuthError('validation', 400);
    const keyHash = this.hash(subject, deviceKey);
    const id = randomUUID();
    try {
      return await this.db.transaction(async (tx) => {
        // Un seul enregistrement à la fois par professionnel : le plafond ci-dessous ne peut pas être dépassé en parallèle.
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`device:${subject}`]);
        const ex = (await tx.query<{ id: string; status: string }>('SELECT id, status FROM auth_professional_device WHERE subject=$1 AND key_hash=$2', [subject, keyHash])).rows[0];
        if (ex) {
          // Un appareil révoqué (perdu, volé) le reste : il faut une nouvelle clé, donc un nouvel enregistrement alerté.
          if (ex.status === 'revoked') throw new AuthError('device_revoked', 409);
          return { id: ex.id, created: false }; // idempotent : ni nouvelle alerte ni quota consommé
        }
        const others = Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM auth_professional_device WHERE subject=$1 AND status='active'", [subject])).rows[0]!.n);
        if (others >= this.config.device.maxActive) throw new AuthError('device_limit_reached', 409);
        const mustAlert = others > 0 || this.config.alertOnFirstProfessionalDevice;
        if (mustAlert && !(phone && PHONE.test(phone))) {
          throw new AuthError('phone_required', 409);
        }
        // Chaque nouvel appareil déclenche une alerte SMS : on ne laisse pas inonder la victime (coût et harcèlement) —
        // au-delà du quota, l'enregistrement est refusé. Le compteur est annulé avec la transaction en cas d'échec.
        const q = await this.limiter.hit('device-register', subject, this.config.device.registrationsPerWindow, this.config.device.registrationWindowSeconds, tx);
        if (!q.allowed) throw new AuthError('too_many_requests', 429, { retryAfterSeconds: q.retryAfterSeconds });
        await tx.query(
          `INSERT INTO auth_professional_device (id, subject, key_hash, label, created_at, last_seen_at) VALUES ($1,$2,$3,$4,$5,$5)`,
          [id, subject, keyHash, label?.slice(0, 80) ?? null, this.now().toISOString()]);
        if (mustAlert) {
          // SMS neutre (sans lien, établissement ni donnée médicale), envoyé AVANT la validation : s'il échoue, rien n'est enregistré.
          try {
            await this.sms.send(phone!, this.i18n.t(lang, 'sms.new_device'));
          } catch (e) {
            throw new AuthError('alert_failed', 503, { cause: describeFailure(e) });
          }
          await this.events.record(tx, 'device_alert_sent', subject);
        }
        await this.events.record(tx, 'professional_device_registered', subject, { appareil: id });
        return { id, created: true };
      });
    } catch (e) {
      // Les refus qui annulent la transaction sont tracés APRÈS elle (et sur une connexion libre, jamais pendant qu'on en tient une).
      if (e instanceof AuthError && e.code === 'phone_required') await this.events.record(this.db, 'device_enrolment_refused', subject, { raison: 'phone_required' });
      if (e instanceof AuthError && e.code === 'alert_failed') await this.events.record(this.db, 'device_alert_failed', subject, { cause: e.details.cause });
      throw e;
    }
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
    const { rows } = await this.db.query<{ id: string; label: string | null; status: 'active' | 'revoked'; created_at: Date; last_seen_at: Date | null }>(
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
         WHERE id=$1 AND status='active' AND ($3::text IS NULL OR subject=$3) RETURNING subject`,
        [deviceId, this.now().toISOString(), opts.subject ?? null]);
      if (!rows.length) return false;
      await this.sessions.revokeProfessional(tx, rows[0]!.subject, this.config.deviceRequiredClasses, opts.reason);
      await this.events.record(tx, 'professional_device_revoked', rows[0]!.subject, { appareil: deviceId, acteur: opts.actor, raison: opts.reason });
      return true;
    });
  }
}
