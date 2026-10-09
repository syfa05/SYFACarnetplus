import { randomUUID } from 'node:crypto';
import type { AdminAction } from '../authz/admin.js';
import { AuthError } from '../auth/errors.js';
import type { SmsSender, Translator } from '../auth/sms.js';
import type { Db, Queryable } from '../db/db.js';
import { describeFailure } from '../identity/errors.js';
import type { FieldCrypto } from '../identity/crypto.js';
import type { IdentityService } from '../identity/service.js';
import type { Patient } from '../identity/types.js';
import type { StaffRecord } from '../org/repository.js';
import type { CardsConfig } from './config.js';
import { codeSha, formatCode, generateCode, generateToken, parseScan, scanSha, tokenSha, type Scan } from './codes.js';
import { buildCardLayout, renderCardPdf, type CardKind } from './pdf.js';

export type CardStatus = 'reservee' | 'emise' | 'active' | 'bloquee' | 'revoquee';
const TYPES: readonly CardKind[] = ['adulte', 'enfant', 'temporaire'];
const PREFIX: Record<CardKind, string> = { adulte: 'CS', enfant: 'CE', temporaire: 'CT' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86_400_000;
/** Écart d'horloge toléré d'un appareil hors ligne (heure d'émission ou de scan de contrôle annoncée à la synchronisation). */
const CLOCK_SKEW_MS = 5 * 60_000;

const bad = (code = 'validation'): never => { throw new AuthError(code, 400); };

export interface CardView {
  id: string; number: string; type: CardKind; status: CardStatus;
  establishmentId: string | null; issuedAt: string | null; activationDeadline: string | null; activatedAt: string | null;
}
export interface ReservedCard { id: string; number: string; type: CardKind; token: string; code: string }
export type ScanResult =
  | { ok: true; cardId: string; patientId: string; type: CardKind }
  | { ok: false; reason: 'invalid_format' | 'unknown' | 'not_activated' | 'blocked' | 'revoked' | 'patient_not_active' };
export interface RevocationEntry { seq: number; tokenSha: string; codeSha: string; reason: 'bloquee' | 'revoquee'; at: string }
export interface ActorCtx { sub: string | null; kind: 'staff' | 'patient' | 'system'; establishmentId: string | null }

interface Row {
  id: string; patient_id: string | null; type: CardKind; number: string; status: CardStatus;
  token_enc: string; code_enc: string; establishment_id: string | null; issued_at: Date | null; activation_deadline: Date | null;
  activated_at: Date | null; reserve_device: string | null;
}
const COLS = 'id, patient_id, type, number, status, token_enc, code_enc, establishment_id, issued_at, activation_deadline, activated_at, reserve_device';
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const view = (r: Row): CardView => ({ id: r.id, number: r.number, type: r.type, status: r.status, establishmentId: r.establishment_id, issuedAt: iso(r.issued_at), activationDeadline: iso(r.activation_deadline), activatedAt: iso(r.activated_at) });
const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/**
 * Cycle de vie des cartes santé (onglet 3.2, parcours P6 et P9, chapitres 7 et 11.5). États : réservée → émise → active →
 * bloquée → révoquée. Règles garanties en base (voir 004_cards.sql) ET ici : une seule carte active par patient ; une carte n'est
 * active qu'après son scan de contrôle (F-CARTE-01) ; une carte bloquée ou révoquée est refusée aussitôt (F-CARTE-02) et figure
 * dans la liste des révoquées. L'ancienne carte reste valable jusqu'à l'ACTIVATION de la nouvelle (décision du porteur de projet).
 */
export class CardService {
  constructor(
    private readonly db: Db,
    private readonly crypto: FieldCrypto,
    private readonly identity: IdentityService,
    private readonly sms: SmsSender,
    private readonly i18n: Translator,
    private readonly gate: (actor: StaffRecord, action: AdminAction, target?: { establishmentId?: string | null }) => Promise<void>,
    private readonly cfg: CardsConfig,
    private readonly now: () => Date,
    /** Générateurs d'identifiants (injectables pour tester les collisions). */
    private readonly gen: { token: () => string; code: () => string } = { token: generateToken, code: generateCode },
    /** Gabarit et rendu (injectables pour contrôler ce qui est réellement imprimé). */
    private readonly printer: { layout: typeof buildCardLayout; render: typeof renderCardPdf } = { layout: buildCardLayout, render: renderCardPdf },
  ) {}

  // -- outils ---------------------------------------------------------------------------------------------------

  private aad = (id: string, col: 'token' | 'code') => `card:${id}:${col}`;

  private async ev(q: Queryable, type: string, a: ActorCtx, o: { cardId?: string | null; patientId?: string | null; details?: Record<string, unknown> } = {}): Promise<void> {
    await q.query('INSERT INTO card_event (at, card_id, patient_id, type, actor_sub, actor_kind, establishment_id, details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
      [this.now().toISOString(), o.cardId ?? null, o.patientId ?? null, type, a.sub, a.kind, a.establishmentId, JSON.stringify(o.details ?? {})]);
  }

  private staffCtx = (a: StaffRecord): ActorCtx => ({ sub: a.sub, kind: 'staff', establishmentId: a.establishmentId });

  /** Les collisions de code de secours (espace de 31^8) sont attendues à grande échelle : l'unicité est celle de la base, on retente. */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        const msg = String((e as Error).message ?? '');
        if (i < 5 && (e as { code?: string }).code === '23505' && /card_(token|code)_idx_key/.test(`${msg} ${(e as { constraint?: string }).constraint ?? ''}`)) continue;
        throw e;
      }
    }
  }

  private async nextNumber(q: Queryable, type: CardKind): Promise<string> {
    const year = this.now().getUTCFullYear();
    const r = await q.query<{ n: number }>(
      'INSERT INTO card_counter (prefix, year, n) VALUES ($1,$2,1) ON CONFLICT (prefix, year) DO UPDATE SET n = card_counter.n + 1 RETURNING n', [PREFIX[type], year]);
    return `${PREFIX[type]}-${year}-${String(r.rows[0]!.n).padStart(7, '0')}`;
  }

  private async insertCard(q: Queryable, o: { patientId: string | null; type: CardKind; status: 'emise' | 'reservee' | 'active'; establishmentId: string; by: string; issuedAt: Date | null; deadline: Date | null; reserveDevice?: string; activatedAt?: Date | null }): Promise<{ id: string; number: string; token: string; code: string }> {
    const id = randomUUID();
    const token = this.gen.token();
    const code = this.gen.code();
    const number = await this.nextNumber(q, o.type);
    await q.query(
      `INSERT INTO card (id, patient_id, type, number, status, token_enc, token_idx, token_sha, code_enc, code_idx, code_sha, establishment_id, issued_by, issued_at,
                         activation_deadline, activated_by, activated_at, reserve_device, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [id, o.patientId, o.type, number, o.status, this.crypto.encrypt(token, this.aad(id, 'token')), this.crypto.blindIndex('card-token', token), tokenSha(token),
       this.crypto.encrypt(code, this.aad(id, 'code')), this.crypto.blindIndex('card-code', code), codeSha(code), o.establishmentId, o.by,
       o.issuedAt?.toISOString() ?? null, o.deadline?.toISOString() ?? null, o.status === 'active' ? o.by : null, o.activatedAt?.toISOString() ?? null,
       o.reserveDevice ?? null, this.now().toISOString()]);
    return { id, number, token, code };
  }

  /** Dossier actif du patient (suit la fusion) ; sinon refus. */
  private async activePatient(id: unknown): Promise<Patient> {
    if (typeof id !== 'string' || !UUID.test(id)) return bad();
    const p = await this.identity.resolve(id);
    if (!p) throw new AuthError('not_found', 404);
    if (p.statutDossier !== 'actif') throw new AuthError('patient_not_active', 409);
    return p;
  }

  private async notify(patientId: string, key: 'sms.card_activated' | 'sms.card_blocked', a: ActorCtx, cardId: string | null): Promise<void> {
    try {
      const p = await this.identity.resolve(patientId);
      if (!p?.telephone) { await this.ev(this.db, 'notification_skipped', a, { cardId, patientId, details: { motif: 'sans_telephone' } }); return; }
      await this.sms.send(p.telephone, this.i18n.t(p.langue, key)); // texte neutre : ni établissement, ni lien, ni donnée médicale
    } catch (e) {
      await this.ev(this.db, 'notification_failed', a, { cardId, patientId, details: { cause: describeFailure(e) } }).catch(() => {});
    }
  }

  private async byId(q: Queryable, id: unknown, lock = false): Promise<Row | null> {
    if (typeof id !== 'string' || !UUID.test(id)) return null;
    return (await q.query<Row>(`SELECT ${COLS} FROM card WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0] ?? null;
  }

  private async byScan(q: Queryable, s: Scan, lock = false): Promise<Row | null> {
    const col = s.kind === 'token' ? 'token_idx' : 'code_idx';
    const idx = this.crypto.blindIndex(s.kind === 'token' ? 'card-token' : 'card-code', s.value);
    return (await q.query<Row>(`SELECT ${COLS} FROM card WHERE ${col}=$1${lock ? ' FOR UPDATE' : ''}`, [idx])).rows[0] ?? null;
  }

  private async revokeRow(q: Queryable, c: Row, reason: string, a: ActorCtx, type = 'revoked'): Promise<void> {
    await q.query("UPDATE card SET status='revoquee', revoked_at=$2, revoked_reason=$3 WHERE id=$1 AND status <> 'revoquee'", [c.id, this.now().toISOString(), reason]);
    await this.ev(q, type, a, { cardId: c.id, patientId: c.patient_id, details: { raison: reason } });
  }

  /** Révoque les cartes émises mais pas encore activées du patient (rebut : la carte mal imprimée n'ouvre rien). */
  private async revokePending(q: Queryable, patientId: string, a: ActorCtx): Promise<void> {
    const { rows } = await q.query<Row>(`SELECT ${COLS} FROM card WHERE patient_id=$1 AND status='emise' FOR UPDATE`, [patientId]);
    for (const c of rows) await this.revokeRow(q, c, 'remplacee_avant_activation', a);
  }

  /** Active la carte ; l'ancienne carte active du patient est révoquée dans la même transaction (une seule carte active). */
  private async makeActive(q: Queryable, c: Row, a: ActorCtx, at: Date): Promise<void> {
    const prev = await q.query<Row>(`SELECT ${COLS} FROM card WHERE patient_id=$1 AND status='active' AND id <> $2 FOR UPDATE`, [c.patient_id, c.id]);
    for (const p of prev.rows) await this.revokeRow(q, p, 'remplacee', a);
    await q.query("UPDATE card SET status='active', activated_by=$2, activated_at=$3 WHERE id=$1", [c.id, a.sub, at.toISOString()]);
    await this.ev(q, 'activated', a, { cardId: c.id, patientId: c.patient_id });
  }

  // -- émission et impression -------------------------------------------------------------------------------------

  /**
   * Émission en établissement (agent d'émission ou directeur médical) : nouvel identifiant aléatoire et nouveau code de secours.
   * La carte est « émise » : elle n'ouvre RIEN avant son scan de contrôle. Les secrets ne sont jamais renvoyés en JSON : ils ne
   * figurent que dans le fichier d'impression (`print`).
   */
  async issue(actor: StaffRecord, i: { patientId: string; type: CardKind }): Promise<CardView> {
    await this.gate(actor, 'card.issue', { establishmentId: actor.establishmentId });
    if (!TYPES.includes(i?.type)) bad();
    const patient = await this.activePatient(i.patientId);
    const establishmentId = actor.establishmentId!;
    const a = this.staffCtx(actor);
    return this.withRetry(() => this.db.transaction(async (tx) => {
      await tx.query('SELECT 1 FROM patient WHERE id=$1 FOR UPDATE', [patient.id]);
      await this.revokePending(tx, patient.id, a);
      const now = this.now();
      const c = await this.insertCard(tx, { patientId: patient.id, type: i.type, status: 'emise', establishmentId, by: actor.sub, issuedAt: now, deadline: new Date(now.getTime() + this.cfg.activationDeadlineDays * DAY) });
      await this.ev(tx, 'issued', a, { cardId: c.id, patientId: patient.id, details: { type: i.type, numero: c.number } });
      return view((await this.byId(tx, c.id))!);
    }));
  }

  /**
   * Fichier d'impression (PDF au gabarit officiel). Possible seulement tant que la carte est « émise » et seulement dans
   * l'établissement émetteur ; chaque génération est journalisée. Le fichier n'est jamais conservé par la passerelle.
   */
  async print(actor: StaffRecord, cardId: string): Promise<Buffer> {
    await this.gate(actor, 'card.issue', { establishmentId: actor.establishmentId });
    const c = await this.byId(this.db, cardId);
    if (!c || c.establishment_id !== actor.establishmentId) throw new AuthError('forbidden', 403);
    if (c.status !== 'emise') throw new AuthError('card_not_printable', 409);
    if (!this.cfg.assistanceNumber) throw new AuthError('assistance_number_missing', 409);
    const p = await this.identity.resolve(c.patient_id!);
    if (!p || p.statutDossier !== 'actif') throw new AuthError('patient_not_active', 409);
    const est = (await this.db.query<{ name: string }>('SELECT name FROM establishment WHERE id=$1', [c.establishment_id])).rows[0];
    const layout = this.printer.layout({
      kind: c.type, surname: p.nom, givenNames: p.prenoms, birthDate: dmy(p.dateNaissance), number: c.number,
      issuedDate: dmy(new Date(c.issued_at!).toISOString().slice(0, 10)), token: this.crypto.decrypt(c.token_enc, this.aad(c.id, 'token')),
      backupCode: this.crypto.decrypt(c.code_enc, this.aad(c.id, 'code')), issuerName: est?.name ?? '', assistanceNumber: this.cfg.assistanceNumber,
    }, this.i18n.dict('fr'), this.i18n.dict('en'));
    const pdf = await this.printer.render(layout);
    await this.ev(this.db, 'printed', this.staffCtx(actor), { cardId: c.id, patientId: c.patient_id });
    return pdf;
  }

  // -- scan de contrôle, résolution ---------------------------------------------------------------------------------

  /** Scan de contrôle à la remise : vérifie la lisibilité et ACTIVE la carte ; le titulaire reçoit un SMS neutre. */
  async activate(actor: StaffRecord, scanRaw: unknown): Promise<CardView> {
    await this.gate(actor, 'card.activate', { establishmentId: actor.establishmentId });
    const a = this.staffCtx(actor);
    const scan = parseScan(scanRaw);
    if (!scan) { await this.ev(this.db, 'scan_refused', a, { details: { motif: 'format' } }); throw new AuthError('invalid_scan', 400); }
    const result = await this.db.transaction(async (tx) => {
      const c = await this.byScan(tx, scan, true);
      if (!c) { await this.ev(tx, 'scan_refused', a, { details: { motif: 'inconnue' } }); return { err: new AuthError('card_unknown', 404) }; }
      if (c.establishment_id !== actor.establishmentId) return { err: new AuthError('forbidden', 403) };
      if (c.status === 'active') return { err: new AuthError('already_active', 409) };
      if (c.status !== 'emise') return { err: new AuthError(c.status === 'reservee' ? 'card_not_issued' : 'card_revoked', 409) };
      if (this.now() >= new Date(c.activation_deadline!)) {
        await this.revokeRow(tx, c, 'non_activee', a, 'expired');
        return { err: new AuthError('card_expired', 410) };
      }
      const p = await this.identity.resolve(c.patient_id!, tx);
      if (!p || p.statutDossier !== 'actif') return { err: new AuthError('patient_not_active', 409) };
      await this.makeActive(tx, c, a, this.now());
      return { card: view((await this.byId(tx, c.id))!), patientId: c.patient_id!, id: c.id };
    });
    if ('err' in result) throw result.err; // renvoyée APRÈS validation de la transaction (journal du scan refusé, révocation d'une carte expirée)
    await this.notify(result.patientId, 'sms.card_activated', a, result.id);
    return result.card;
  }

  /**
   * Résolution d'une carte scannée ou saisie (utilisée par l'ouverture d'une prise en charge, lot L5) : seule une carte ACTIVE,
   * d'un dossier actif, identifie un patient. Tout refus est journalisé (jamais la valeur scannée) ; le blocage des saisies
   * de code de secours erronées (5 puis 15 minutes) est appliqué par l'appelant (L5).
   */
  async resolve(scanRaw: unknown, ctx: ActorCtx): Promise<ScanResult> {
    const refuse = async (reason: Extract<ScanResult, { ok: false }>['reason'], c?: Row): Promise<ScanResult> => {
      await this.ev(this.db, 'scan_refused', ctx, { cardId: c?.id, patientId: c?.patient_id, details: { motif: reason } });
      return { ok: false, reason };
    };
    const scan = parseScan(scanRaw);
    if (!scan) return refuse('invalid_format');
    const c = await this.byScan(this.db, scan);
    if (!c) return refuse('unknown');
    if (c.status === 'bloquee') return refuse('blocked', c);
    if (c.status === 'revoquee') return refuse('revoked', c);
    if (c.status !== 'active') return refuse('not_activated', c);
    const p = await this.identity.resolve(c.patient_id!);
    if (!p || p.statutDossier !== 'actif') return refuse('patient_not_active', c);
    return { ok: true, cardId: c.id, patientId: p.id, type: c.type };
  }

  // -- blocage, révocation ----------------------------------------------------------------------------------------------

  /** Blocage par le personnel (agent, directeur : n'importe quel centre sur présentation de la CNI ; opérateur : blocage seul). */
  async block(actor: StaffRecord, cardId: string, reason: string): Promise<CardView> {
    await this.gate(actor, 'card.block', { establishmentId: actor.establishmentId });
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 200) bad();
    const a = this.staffCtx(actor);
    const out = await this.db.transaction(async (tx) => {
      const c = await this.byId(tx, cardId, true);
      if (!c) throw new AuthError('not_found', 404);
      const v = await this.blockRow(tx, c, a, reason.trim());
      return { v, patientId: c.patient_id! };
    });
    await this.notify(out.patientId, 'sms.card_blocked', a, cardId);
    return out.v;
  }

  private async blockRow(tx: Queryable, c: Row, a: ActorCtx, reason: string): Promise<CardView> {
    if (c.status === 'bloquee') throw new AuthError('already_blocked', 409);
    if (c.status !== 'emise' && c.status !== 'active') throw new AuthError(c.status === 'reservee' ? 'card_not_issued' : 'card_revoked', 409);
    await tx.query("UPDATE card SET status='bloquee', blocked_at=$2, blocked_by=$3, blocked_reason=$4 WHERE id=$1", [c.id, this.now().toISOString(), a.sub, reason]);
    await this.ev(tx, 'blocked', a, { cardId: c.id, patientId: c.patient_id, details: { raison: reason } });
    return view((await this.byId(tx, c.id))!);
  }

  /** Blocage par le titulaire (application, rubrique « Ma carte ») : toutes ses cartes émises ou actives. */
  async blockOwn(patientId: string, reason = 'perte'): Promise<{ blocked: number }> {
    const a: ActorCtx = { sub: patientId, kind: 'patient', establishmentId: null };
    const n = await this.db.transaction(async (tx) => {
      const { rows } = await tx.query<Row>(`SELECT ${COLS} FROM card WHERE patient_id=$1 AND status IN ('emise','active') FOR UPDATE`, [patientId]);
      for (const c of rows) await this.blockRow(tx, c, a, reason);
      return rows.length;
    });
    if (!n) throw new AuthError('not_found', 404);
    await this.notify(patientId, 'sms.card_blocked', a, null);
    return { blocked: n };
  }

  /**
   * Révocation par un autre lot (décès, passage à l'autonomie : l'ancienne carte enfant est révoquée) : toutes les cartes non
   * révoquées du patient. `q` : transaction de l'appelant.
   */
  async revokeForPatient(patientId: string, reason: string, a: ActorCtx, q: Queryable = this.db): Promise<number> {
    const { rows } = await q.query<Row>(`SELECT ${COLS} FROM card WHERE patient_id=$1 AND status <> 'revoquee' FOR UPDATE`, [patientId]);
    for (const c of rows) await this.revokeRow(q, c, reason, a);
    return rows.length;
  }

  /** Balayage : les cartes émises mais non activées dans le délai (90 jours par défaut) sont révoquées automatiquement. */
  async sweepExpired(): Promise<number> {
    const a: ActorCtx = { sub: null, kind: 'system', establishmentId: null };
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<Row>(`SELECT ${COLS} FROM card WHERE status='emise' AND activation_deadline <= $1 FOR UPDATE`, [this.now().toISOString()]);
      for (const c of rows) await this.revokeRow(tx, c, 'non_activee', a, 'expired');
      return rows.length;
    });
  }

  // -- consultation -----------------------------------------------------------------------------------------------------

  /** Cartes d'un patient pour l'agent (jamais le jeton ni le code de secours). */
  async listForPatient(actor: StaffRecord, patientId: string): Promise<CardView[]> {
    await this.gate(actor, 'card.activate', { establishmentId: actor.establishmentId });
    if (!UUID.test(patientId ?? '')) bad();
    const { rows } = await this.db.query<Row>(`SELECT ${COLS} FROM card WHERE patient_id=$1 ORDER BY created_at DESC, id`, [patientId]);
    return rows.map(view);
  }

  /** Carte numérique de l'application : la carte ACTIVE du titulaire, avec son QR code et son code de secours. */
  async digitalCard(patientId: string): Promise<{ number: string; type: CardKind; token: string; code: string }> {
    const c = (await this.db.query<Row>(`SELECT ${COLS} FROM card WHERE patient_id=$1 AND status='active'`, [patientId])).rows[0];
    if (!c) throw new AuthError('not_found', 404);
    return { number: c.number, type: c.type, token: this.crypto.decrypt(c.token_enc, this.aad(c.id, 'token')), code: formatCode(this.crypto.decrypt(c.code_enc, this.aad(c.id, 'code'))) };
  }

  // -- réserves de codes (émission hors ligne) ---------------------------------------------------------------------------

  /**
   * Réserve de cartes pré-attribuées à CET appareil d'émission (onglet 5.2) : identifiants et numéros générés ici, remis une fois
   * à l'appareil. Elles n'ont pas de titulaire : elles n'ouvrent rien tant qu'elles ne sont pas attribuées (`bindReserved`).
   */
  async reserve(actor: StaffRecord, deviceId: string | null, type: CardKind, count: number): Promise<ReservedCard[]> {
    await this.gate(actor, 'card.issue', { establishmentId: actor.establishmentId });
    if (!TYPES.includes(type) || !Number.isInteger(count) || count < 1 || count > this.cfg.reserveMax) bad();
    if (!deviceId) throw new AuthError('device_required', 409);
    const a = this.staffCtx(actor);
    return this.withRetry(() => this.db.transaction(async (tx) => {
      const dev = await tx.query("SELECT id FROM auth_professional_device WHERE id=$1 AND subject=$2 AND status='active' FOR UPDATE", [deviceId, actor.sub]);
      if (!dev.rows.length) throw new AuthError('device_required', 409);
      const open = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM card WHERE reserve_device=$1 AND status='reservee'", [deviceId]);
      if (open.rows[0]!.n + count > this.cfg.reserveMax) throw new AuthError('reserve_full', 409);
      const out: ReservedCard[] = [];
      for (let i = 0; i < count; i++) {
        const c = await this.insertCard(tx, { patientId: null, type, status: 'reservee', establishmentId: actor.establishmentId!, by: actor.sub, issuedAt: null, deadline: null, reserveDevice: deviceId });
        out.push({ id: c.id, number: c.number, type, token: c.token, code: formatCode(c.code) });
      }
      await this.ev(tx, 'reserved', a, { details: { appareil: deviceId, nombre: count, type } });
      return out;
    }));
  }

  /**
   * Synchronisation d'une carte émise hors ligne avec un code de réserve : « active » si le scan de contrôle a été fait devant le
   * titulaire (heure déclarée par l'appareil), sinon « émise ». Idempotent (reprise de synchronisation). Une réserve annulée
   * (appareil perdu) est refusée.
   */
  async bindReserved(actor: StaffRecord, deviceId: string | null, i: { cardId: string; patientId: string; issuedAt: string; controlScanAt?: string }): Promise<CardView> {
    await this.gate(actor, 'card.issue', { establishmentId: actor.establishmentId });
    if (!deviceId) throw new AuthError('device_required', 409);
    const issuedAt = new Date(i?.issuedAt);
    const scanAt = i?.controlScanAt === undefined ? null : new Date(i.controlScanAt);
    const now = this.now();
    const futureLimit = now.getTime() + CLOCK_SKEW_MS;
    if (!Number.isFinite(issuedAt.getTime()) || issuedAt.getTime() > futureLimit) bad('invalid_time');
    if (scanAt && (!Number.isFinite(scanAt.getTime()) || scanAt.getTime() < issuedAt.getTime() || scanAt.getTime() > futureLimit)) bad('invalid_time');
    const patient = await this.activePatient(i.patientId);
    const a = this.staffCtx(actor);
    const out = await this.db.transaction(async (tx) => {
      const c = await this.byId(tx, i.cardId, true);
      if (!c || c.reserve_device !== deviceId || c.establishment_id !== actor.establishmentId) throw new AuthError('forbidden', 403);
      if (c.status === 'revoquee') { await this.ev(tx, 'scan_refused', a, { cardId: c.id, details: { motif: 'reserve_annulee' } }); return { err: new AuthError('reserve_cancelled', 409) }; } // journalisé : l'erreur est levée après validation
      if (c.status !== 'reservee') {
        if (c.patient_id === patient.id) return { v: view(c), activated: false }; // reprise de synchronisation
        return { err: new AuthError('card_already_bound', 409) };
      }
      await tx.query('SELECT 1 FROM patient WHERE id=$1 FOR UPDATE', [patient.id]);
      await this.revokePending(tx, patient.id, a);
      await tx.query("UPDATE card SET patient_id=$2, status='emise', issued_by=$3, issued_at=$4, activation_deadline=$5 WHERE id=$1",
        [c.id, patient.id, actor.sub, issuedAt.toISOString(), new Date(issuedAt.getTime() + this.cfg.activationDeadlineDays * DAY).toISOString()]);
      await this.ev(tx, 'issued', a, { cardId: c.id, patientId: patient.id, details: { type: c.type, numero: c.number, horsLigne: true } });
      const bound = (await this.byId(tx, c.id))!;
      if (scanAt) await this.makeActive(tx, bound, a, scanAt);
      return { v: view((await this.byId(tx, c.id))!), activated: Boolean(scanAt) };
    });
    if ('err' in out) throw out.err;
    if (out.activated) await this.notify(patient.id, 'sms.card_activated', a, i.cardId);
    return out.v;
  }

  // -- liste des cartes révoquées (serveurs locaux et appareils) --------------------------------------------------------

  /** Cartes bloquées ou révoquées depuis `since` (incrémental : l'appelant rappelle avec le dernier `seq` reçu). */
  async revocations(since: number, limit?: number): Promise<{ entries: RevocationEntry[]; latest: number; more: boolean }> {
    if (!Number.isInteger(since) || since < 0) bad();
    const page = Math.min(limit ?? this.cfg.revocationPageMax, this.cfg.revocationPageMax);
    if (!Number.isInteger(page) || page < 1) bad();
    const { rows } = await this.db.query<{ seq: string; token_sha: string; code_sha: string; reason: 'bloquee' | 'revoquee'; at: Date }>(
      'SELECT seq, token_sha, code_sha, reason, at FROM card_revocation WHERE seq > $1 ORDER BY seq LIMIT $2', [since, page + 1]);
    const entries = rows.slice(0, page).map((r) => ({ seq: Number(r.seq), tokenSha: r.token_sha, codeSha: r.code_sha, reason: r.reason, at: new Date(r.at).toISOString() }));
    return { entries, latest: entries.length ? entries[entries.length - 1]!.seq : since, more: rows.length > page };
  }

  /** Empreinte utilisée par la liste, pour une saisie (aide aux tests et à l'application). */
  static scanHash(raw: unknown): string | null {
    const s = parseScan(raw);
    return s ? scanSha(s) : null;
  }
}
