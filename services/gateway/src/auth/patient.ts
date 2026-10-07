import { randomUUID } from 'node:crypto';
import type { Db, Queryable } from '../db/db.js';
import { describeFailure } from '../identity/errors.js';
import type { IdentityService } from '../identity/service.js';
import type { AuthConfig } from './config.js';
import { AuthCrypto } from './crypto.js';
import { AuthError } from './errors.js';
import { isWeakPin } from './network.js';
import { AuthEvents } from './events.js';
import type { RateLimiter } from './rate-limit.js';
import type { SessionStore } from './sessions.js';
import type { SmsSender, Translator } from './sms.js';
import type { PatientTokens } from './tokens.js';

const PHONE = /^2376\d{8}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PatientSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}
export interface PatientEnrolment extends PatientSession {
  deviceId: string;
  deviceSecret: string;
}

/**
 * Authentification des patients : téléphone + code SMS (F-AUTH-01), puis PIN (F-AUTH-02).
 * Le PIN est vérifié par le serveur : seul un compteur côté serveur est réellement opposable (un compteur
 * côté application se contourne sur un appareil compromis). Aucune donnée sur l'existence d'un compte ne fuit.
 */
export class PatientAuthService {
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly db: Db,
    private readonly config: AuthConfig,
    private readonly crypto: AuthCrypto,
    private readonly identity: IdentityService,
    private readonly sms: SmsSender,
    private readonly i18n: Translator,
    private readonly tokens: PatientTokens,
    private readonly sessions: SessionStore,
    private readonly limiter: RateLimiter,
    private readonly events: AuthEvents,
    private readonly now: () => Date,
  ) {}

  /** Attend la fin des envois de SMS en cours (arrêt propre, tests). */
  async drain(): Promise<void> {
    await Promise.all([...this.inflight]);
  }

  // ---- code SMS ---------------------------------------------------------------------------------------------

  async requestOtp(telephone: string): Promise<void> {
    if (!PHONE.test(telephone ?? '')) throw new AuthError('validation', 400);
    // Mêmes limites pour tout numéro, connu ou non : la réponse ne dit rien sur l'existence du compte.
    // Le plafond horaire ne compte que les demandes acceptées (= SMS réellement envoyés) : un renvoi trop
    // rapide est refusé sans entamer le quota de la fenêtre.
    const min = await this.limiter.hit('otp-req-min', telephone, 1, this.config.otp.resendMinSeconds);
    if (!min.allowed) throw new AuthError('too_many_requests', 429, { retryAfterSeconds: min.retryAfterSeconds });
    const quota = await this.limiter.hit('otp-req-quota', telephone, this.config.otp.maxPerHour, this.config.otp.quotaWindowSeconds);
    if (!quota.allowed) throw new AuthError('too_many_requests', 429, { retryAfterSeconds: quota.retryAfterSeconds });
    const candidates = await this.identity.findLoginCandidates(telephone);
    // Numéro sans compte univoque : on fait exactement le même travail (code « fantôme » jamais envoyé), pour que le
    // temps de réponse et les écritures ne distinguent pas un numéro connu d'un numéro inconnu.
    const patient = candidates.length === 1 ? candidates[0]! : null;
    const id = randomUUID();
    const code = this.crypto.numericCode(this.config.otp.length);
    const now = this.now();
    const phoneIdx = this.crypto.hmac('phone', telephone);
    await this.db.transaction(async (tx) => {
      await tx.query('UPDATE auth_otp SET superseded_at=$2 WHERE phone_idx=$1 AND consumed_at IS NULL AND superseded_at IS NULL', [phoneIdx, now.toISOString()]);
      await tx.query(
        'INSERT INTO auth_otp (id, patient_id, phone_idx, code_hash, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, patient?.id ?? null, phoneIdx, this.crypto.hmac('otp', `${id}:${code}`), now.toISOString(),
         new Date(now.getTime() + this.config.otp.ttlSeconds * 1000).toISOString()],
      );
      await this.events.record(tx, 'otp_requested', patient?.id ?? null, { resultat: patient ? 'envoye' : 'sans_compte' });
    });
    if (!patient) return;
    // Envoi détaché : le temps de réponse ne distingue pas un numéro connu d'un numéro inconnu.
    const text = this.i18n.t(patient.langue, 'sms.otp', { code, minutes: Math.round(this.config.otp.ttlSeconds / 60) });
    const job = this.sms.send(telephone, text).catch(async (e) => {
      await this.events.record(this.db, 'sms_failed', patient.id, { cause: describeFailure(e) }).catch(() => {});
    });
    const tracked = job.finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
  }

  async verifyOtp(telephone: string, code: string, pin: string, label?: string): Promise<PatientEnrolment> {
    if (!PHONE.test(telephone ?? '') || !new RegExp(`^\\d{${this.config.otp.length}}$`).test(code ?? '') || !this.validPin(pin)) {
      throw new AuthError('validation', 400);
    }
    // Refusé avant tout essai : un PIN trivial ne consomme ni code ni quota.
    if (this.config.pin.rejectWeak && isWeakPin(pin)) throw new AuthError('weak_pin', 400);
    const verify = await this.limiter.hit('otp-verify-hour', telephone, this.config.otp.maxVerifyPerHour, this.config.otp.quotaWindowSeconds);
    if (!verify.allowed) throw new AuthError('too_many_requests', 429, { retryAfterSeconds: verify.retryAfterSeconds });

    const now = this.now();
    const phoneIdx = this.crypto.hmac('phone', telephone);
    const otp = (await this.db.query<{ id: string; patient_id: string | null; code_hash: string; expires_at: Date }>(
      `SELECT id, patient_id, code_hash, expires_at FROM auth_otp
       WHERE phone_idx=$1 AND consumed_at IS NULL AND superseded_at IS NULL ORDER BY created_at DESC LIMIT 1`, [phoneIdx])).rows[0];
    if (!otp) {
      this.crypto.hmac('otp', `none:${code}`); // même travail qu'un vrai essai
      throw new AuthError('invalid_code', 401);
    }
    if (new Date(otp.expires_at) <= now) {
      await this.events.record(this.db, 'otp_expired', otp.patient_id);
      throw new AuthError('invalid_code', 401);
    }
    // L'essai est compté AVANT la comparaison : 3 essais au plus, même en requêtes simultanées.
    const attempt = await this.db.query<{ attempts: number }>(
      'UPDATE auth_otp SET attempts = attempts + 1 WHERE id=$1 AND consumed_at IS NULL AND attempts < $2 RETURNING attempts',
      [otp.id, this.config.otp.maxAttempts]);
    if (!attempt.rows.length) throw new AuthError('invalid_code', 401);
    const n = Number(attempt.rows[0]!.attempts);
    if (!AuthCrypto.equal(this.crypto.hmac('otp', `${otp.id}:${code}`), otp.code_hash)) {
      await this.events.record(this.db, n >= this.config.otp.maxAttempts ? 'otp_locked' : 'otp_failed', otp.patient_id, { essai: n });
      throw new AuthError('invalid_code', 401);
    }
    if (!otp.patient_id) throw new AuthError('invalid_code', 401); // code « fantôme » : jamais valable
    const patient = await this.identity.resolve(otp.patient_id);
    if (!patient || patient.statutDossier !== 'actif') throw new AuthError('invalid_code', 401);

    const deviceId = randomUUID();
    const device = this.crypto.newSecret();
    const pinHash = await this.crypto.hashPin(deviceId, pin);
    return this.db.transaction(async (tx) => {
      // Usage unique : seul le premier appel qui consomme le code réussit.
      const used = await tx.query('UPDATE auth_otp SET consumed_at=$2 WHERE id=$1 AND consumed_at IS NULL RETURNING id', [otp.id, this.now().toISOString()]);
      if (!used.rows.length) throw new AuthError('invalid_code', 401);
      if (this.config.revokeOtherDevicesOnEnrol) await this.revokePatientDevices(tx, patient.id, 'replaced_by_sms_enrolment');
      await tx.query(
        `INSERT INTO auth_patient_device (id, patient_id, secret_hash, pin_hash, label, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
        [deviceId, patient.id, device.hash, pinHash, label?.slice(0, 80) ?? null, this.now().toISOString()]);
      await this.events.record(tx, 'device_enrolled', patient.id, { appareil: deviceId });
      const session = await this.openSession(tx, patient.id, deviceId);
      return { deviceId, deviceSecret: device.secret, ...session };
    });
  }

  // ---- PIN --------------------------------------------------------------------------------------------------

  async unlock(deviceId: string, deviceSecret: string, pin: string): Promise<PatientSession> {
    if (!UUID.test(deviceId ?? '') || typeof deviceSecret !== 'string' || !deviceSecret || !this.validPin(pin)) throw new AuthError('validation', 400);
    const row = (await this.db.query<{ id: string; patient_id: string; secret_hash: string; pin_hash: string; status: string }>(
      'SELECT id, patient_id, secret_hash, pin_hash, status FROM auth_patient_device WHERE id=$1', [deviceId])).rows[0];
    const secretOk = AuthCrypto.equal(this.crypto.secretHash(deviceSecret), row?.secret_hash ?? 'absent');
    if (!row || !secretOk || row.status === 'revoked') throw new AuthError('invalid_credentials', 401);
    if (row.status === 'sms_required') throw new AuthError('sms_required', 401);

    // Tentative comptée AVANT la comparaison : au plus `maxAttempts` essais entre deux succès.
    const attempt = await this.db.query<{ pin_attempts: number }>(
      `UPDATE auth_patient_device SET pin_attempts = pin_attempts + 1
       WHERE id=$1 AND status='active' AND pin_attempts < $2 RETURNING pin_attempts`, [deviceId, this.config.pin.maxAttempts]);
    if (!attempt.rows.length) throw new AuthError('sms_required', 401);
    const n = Number(attempt.rows[0]!.pin_attempts);

    if (!(await this.crypto.verifyPin(deviceId, pin, row.pin_hash))) {
      await this.events.record(this.db, 'pin_failed', row.patient_id, { appareil: deviceId, essai: n });
      if (n >= this.config.pin.maxAttempts) {
        // F-AUTH-02 : après 5 PIN erronés, un nouveau code SMS est exigé.
        await this.db.transaction(async (tx) => {
          await tx.query("UPDATE auth_patient_device SET status='sms_required', revoked_reason='pin_locked' WHERE id=$1 AND status='active'", [deviceId]);
          await this.sessions.revokeForDevice(tx, deviceId, 'pin_locked');
          await this.events.record(tx, 'pin_locked', row.patient_id, { appareil: deviceId });
        });
        throw new AuthError('sms_required', 401);
      }
      throw new AuthError('invalid_pin', 401, { attemptsLeft: this.config.pin.maxAttempts - n });
    }
    return this.db.transaction(async (tx) => {
      await tx.query('UPDATE auth_patient_device SET pin_attempts=0, last_used_at=$2 WHERE id=$1', [deviceId, this.now().toISOString()]);
      await this.sessions.revokeForDevice(tx, deviceId, 'replaced_by_unlock');
      return this.openSession(tx, row.patient_id, deviceId);
    });
  }

  // ---- session ----------------------------------------------------------------------------------------------

  private validPin(pin: unknown): boolean {
    return typeof pin === 'string' && new RegExp(`^\\d{${this.config.pin.length}}$`).test(pin);
  }

  private async openSession(tx: Queryable, patientId: string, deviceId: string): Promise<PatientSession> {
    const sid = randomUUID();
    const refresh = this.crypto.newSecret();
    await this.sessions.create(tx, {
      id: sid, kind: 'patient', subject: patientId, clientClass: 'patient_app', deviceId,
      refreshHash: refresh.hash, maxSeconds: this.config.patientSessionMaxSeconds,
    });
    const access = await this.tokens.issue({ sub: patientId, sid });
    return { accessToken: access.token, refreshToken: refresh.secret, expiresIn: access.expiresIn };
  }

  /**
   * Rotation du jeton de rafraîchissement. Toute la décision se prend dans UNE transaction qui verrouille la ligne de
   * session : deux présentations simultanées du même jeton ne peuvent pas lire l'ancien état en parallèle. La seconde
   * attend la première, trouve le jeton déjà échangé (`prev_refresh_hash`) et révoque la session — gagnant compris :
   * un même jeton présenté deux fois, c'est un jeton copié. Conséquence : une application doit sérialiser ses
   * rafraîchissements (deux requêtes simultanées avec le même jeton ferment la session).
   */
  async refresh(refreshToken: string): Promise<PatientSession> {
    if (typeof refreshToken !== 'string' || refreshToken.length < 20 || refreshToken.length > 200) throw new AuthError('validation', 400);
    const hash = this.crypto.secretHash(refreshToken);
    const result = await this.db.transaction(async (tx) => {
      const row = (await tx.query<{ id: string; subject: string; device_id: string; refresh_hash: string | null }>(
        `SELECT id, subject, device_id, refresh_hash FROM auth_session
         WHERE kind='patient' AND (refresh_hash=$1 OR prev_refresh_hash=$1) FOR UPDATE`, [hash])).rows[0];
      if (!row) return null;
      if (row.refresh_hash !== hash) {
        // Jeton déjà échangé, présenté à nouveau : vol probable, la session est révoquée (et la révocation est validée).
        await this.sessions.revoke(tx, row.id, 'refresh_reuse');
        await this.events.record(tx, 'refresh_reuse', row.subject, { session: row.id });
        return null;
      }
      if (!(await this.sessions.touch(row.id, 'patient_app', tx)).ok) return null;
      const dev = (await tx.query<{ status: string }>('SELECT status FROM auth_patient_device WHERE id=$1', [row.device_id])).rows[0];
      if (dev?.status !== 'active') return null;
      const next = this.crypto.newSecret();
      await tx.query('UPDATE auth_session SET prev_refresh_hash=refresh_hash, refresh_hash=$2 WHERE id=$1', [row.id, next.hash]);
      return { sub: row.subject, sid: row.id, refreshToken: next.secret };
    });
    if (!result) throw new AuthError('invalid_refresh', 401);
    const access = await this.tokens.issue({ sub: result.sub, sid: result.sid });
    return { accessToken: access.token, refreshToken: result.refreshToken, expiresIn: access.expiresIn };
  }

  async logout(sessionId: string): Promise<void> {
    await this.sessions.revoke(this.db, sessionId, 'logout');
  }

  async revokePatientDevices(q: Queryable, patientId: string, reason: string): Promise<void> {
    const devices = await q.query<{ id: string }>(
      "UPDATE auth_patient_device SET status='revoked', revoked_reason=$2 WHERE patient_id=$1 AND status <> 'revoked' RETURNING id", [patientId, reason]);
    for (const d of devices.rows) await this.sessions.revokeForDevice(q, d.id, reason);
    if (devices.rows.length) await this.events.record(q, 'devices_revoked', patientId, { nombre: devices.rows.length, raison: reason });
  }
}
