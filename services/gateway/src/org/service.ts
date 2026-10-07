import { randomBytes, randomUUID } from 'node:crypto';
import { decideAdmin, CONTROLLED_BY_UPPER_LEVEL, type AdminAction, type AdminContext, type AdminTarget } from '../authz/admin.js';
import { STAFF_ROLES, type Decision, type StaffRole } from '../authz/types.js';
import { AuthError } from '../auth/errors.js';
import type { AuthEvents } from '../auth/events.js';
import { parseCidr } from '../auth/network.js';
import type { SessionStore } from '../auth/sessions.js';
import type { Db, Queryable } from '../db/db.js';
import { describeFailure } from '../identity/errors.js';
import { DirectoryError, type DirectoryPort } from './directory.js';
import { toActor, type StaffRecord, type StaffRepository } from './repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE = /^2376\d{8}$/;
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,63}$/i;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
const CODE = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;

export interface RoleInput { role: StaffRole; serviceId?: string | null }
export interface EstablishmentView { id: string; code: string; name: string; district: string | null; allowedNetworks: string[]; status: string }
export interface ReviewItem { id: string; at: string; actorSub: string; action: string; establishmentId: string | null; targetSub: string | null }

const bad = (): never => { throw new AuthError('validation', 400); };

/** Réseaux autorisés : adresses ou CIDR valides ; « tout Internet » (préfixe 0) refusé. */
export function validateNetworks(list: unknown): string[] {
  if (!Array.isArray(list) || list.length > 50) return bad();
  return list.map((c) => {
    if (typeof c !== 'string') return bad();
    try {
      const p = parseCidr(c);
      if (p.prefix === 0) return bad();
    } catch {
      return bad();
    }
    return c.trim();
  });
}

/**
 * Établissements, personnel, rôles, désactivation et contrôle de niveau supérieur (lot L3). Chaque opération est
 * autorisée par le moteur (`decideAdmin`) ; un refus est journalisé (`access_denial`) et renvoie 403.
 */
export class OrgService {
  constructor(
    private readonly db: Db,
    private readonly repo: StaffRepository,
    private readonly directory: DirectoryPort,
    private readonly sessions: SessionStore,
    private readonly events: AuthEvents,
    private readonly now: () => Date,
  ) {}

  // -- autorisation -------------------------------------------------------------------------------------------

  private async authorize(actor: StaffRecord, action: AdminAction, target?: AdminTarget, context?: AdminContext): Promise<void> {
    const d: Decision = decideAdmin({ actor: toActor(actor), action, target, context });
    if (d.allow) return;
    await this.db.query(
      `INSERT INTO access_denial (at, actor_sub, actor_kind, establishment_id, action, data, reason, condition) VALUES ($1,$2,'staff',$3,'admin',$4,$5,$6)`,
      [this.now().toISOString(), actor.sub, actor.establishmentId, action, d.reason, d.condition ?? null]);
    throw new AuthError('forbidden', 403);
  }

  private async record(q: Queryable, actor: StaffRecord, action: string, o: { establishmentId?: string | null; targetSub?: string | null; details?: Record<string, unknown> }): Promise<void> {
    const establishmentId = o.establishmentId ?? actor.establishmentId;
    const district = establishmentId
      ? (await q.query<{ district: string | null }>('SELECT district FROM establishment WHERE id=$1', [establishmentId])).rows[0]?.district ?? null
      : actor.district;
    const roles = actor.roles.map((r) => r.role);
    // Les actions du directeur médical sont contrôlées par le niveau supérieur.
    const review = roles.includes('directeur_medical') && CONTROLLED_BY_UPPER_LEVEL.includes(action);
    await q.query(
      `INSERT INTO admin_action (id, at, actor_sub, actor_roles, action, establishment_id, district, target_sub, details, review_required)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
      [randomUUID(), this.now().toISOString(), actor.sub, roles, action, establishmentId, district, o.targetSub ?? null, JSON.stringify(o.details ?? {}), review]);
  }

  // -- établissements et services ----------------------------------------------------------------------------

  async createEstablishment(actor: StaffRecord, i: { code: string; name: string; district?: string; allowedNetworks?: string[] }): Promise<{ id: string }> {
    await this.authorize(actor, 'establishment.manage');
    if (!CODE.test(i.code) || !i.name?.trim() || i.name.length > 120 || (i.district?.length ?? 0) > 80) bad();
    const networks = validateNetworks(i.allowedNetworks ?? []);
    const id = randomUUID();
    try {
      await this.db.transaction(async (tx) => {
        await tx.query('INSERT INTO establishment (id, code, name, district, allowed_networks, created_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [id, i.code, i.name.trim(), i.district?.trim() || null, networks, this.now().toISOString(), actor.sub]);
        await this.record(tx, actor, 'establishment.create', { establishmentId: id, details: { code: i.code } });
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new AuthError('conflict', 409);
      throw e;
    }
    return { id };
  }

  async setNetworks(actor: StaffRecord, establishmentId: string, networks: unknown): Promise<void> {
    await this.authorize(actor, 'establishment.manage');
    const list = validateNetworks(networks);
    if (!UUID.test(establishmentId)) bad();
    await this.db.transaction(async (tx) => {
      const r = await tx.query('UPDATE establishment SET allowed_networks=$2 WHERE id=$1 RETURNING id', [establishmentId, list]);
      if (!r.rows.length) throw new AuthError('not_found', 404);
      await this.record(tx, actor, 'establishment.networks', { establishmentId, details: { reseaux: list.length } });
    });
  }

  async createService(actor: StaffRecord, establishmentId: string, name: string): Promise<{ id: string }> {
    if (!UUID.test(establishmentId)) bad();
    await this.authorize(actor, 'service.manage', { establishmentId });
    if (!name?.trim() || name.length > 80) bad();
    const id = randomUUID();
    try {
      await this.db.transaction(async (tx) => {
        const e = await tx.query("SELECT 1 FROM establishment WHERE id=$1 AND status='active'", [establishmentId]);
        if (!e.rows.length) throw new AuthError('not_found', 404);
        await tx.query('INSERT INTO service_unit (id, establishment_id, name, created_at) VALUES ($1,$2,$3,$4)', [id, establishmentId, name.trim(), this.now().toISOString()]);
        await this.record(tx, actor, 'service.create', { establishmentId });
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new AuthError('conflict', 409);
      throw e;
    }
    return { id };
  }

  async listEstablishments(actor: StaffRecord): Promise<EstablishmentView[]> {
    const all = actor.roles.some((r) => r.role === 'operateur');
    if (!all && !actor.establishmentId) throw new AuthError('forbidden', 403);
    const { rows } = await this.db.query<{ id: string; code: string; name: string; district: string | null; allowed_networks: string[]; status: string }>(
      `SELECT id, code, name, district, allowed_networks, status FROM establishment ${all ? '' : 'WHERE id=$1'} ORDER BY code`, all ? [] : [actor.establishmentId]);
    return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, district: r.district, allowedNetworks: r.allowed_networks, status: r.status }));
  }

  // -- personnel ----------------------------------------------------------------------------------------------

  private async checkRoles(q: Queryable, establishmentId: string, roles: RoleInput[]): Promise<RoleInput[]> {
    if (!Array.isArray(roles) || roles.length < 1 || roles.length > 6) return bad();
    const out: RoleInput[] = [];
    for (const r of roles) {
      if (!STAFF_ROLES.includes(r?.role)) bad();
      const serviceId = r.serviceId ?? null;
      if (serviceId !== null) {
        if (!UUID.test(serviceId)) bad();
        const s = await q.query('SELECT 1 FROM service_unit WHERE id=$1 AND establishment_id=$2', [serviceId, establishmentId]);
        if (!s.rows.length) bad();
      }
      if (r.role === 'chef_service' && serviceId === null) bad(); // un chef de service l'est d'UN service
      out.push({ role: r.role, serviceId });
    }
    return out;
  }

  /**
   * Crée un compte du personnel. Ordre : compte désactivé chez le fournisseur d'identité → enregistrement local (rôles,
   * établissement) → activation. Si l'activation échoue, le compte local existe mais reste inutilisable : `activate`
   * reprend ; si l'enregistrement local échoue, le compte distant reste désactivé (aucun droit sans enregistrement local).
   */
  async createStaff(actor: StaffRecord, i: { username: string; email?: string; phone: string; establishmentId: string; roles: RoleInput[] }): Promise<{ sub: string; temporaryPassword: string }> {
    if (!UUID.test(i.establishmentId ?? '')) bad();
    if (!USERNAME.test(i.username ?? '') || !PHONE.test(i.phone ?? '') || (i.email !== undefined && !EMAIL.test(i.email))) bad();
    const roles = await this.checkRoles(this.db, i.establishmentId, i.roles);
    await this.authorize(actor, 'account.create', { establishmentId: i.establishmentId, roles: roles.map((r) => r.role) });
    const e = await this.db.query("SELECT 1 FROM establishment WHERE id=$1 AND status='active'", [i.establishmentId]);
    if (!e.rows.length) throw new AuthError('not_found', 404);

    const temporaryPassword = randomBytes(18).toString('base64url');
    let sub: string;
    try {
      ({ sub } = await this.directory.createUser({ username: i.username, email: i.email, phone: i.phone, temporaryPassword }));
    } catch (err) {
      if (err instanceof DirectoryError && err.code === 'conflict') throw new AuthError('conflict', 409);
      throw new AuthError('directory_unavailable', 502);
    }
    const staffId = randomUUID();
    const nowIso = this.now().toISOString();
    await this.db.transaction(async (tx) => {
      await tx.query('INSERT INTO staff_member (id, sub, establishment_id, status, created_at, created_by) VALUES ($1,$2,$3,\'active\',$4,$5)', [staffId, sub, i.establishmentId, nowIso, actor.sub]);
      for (const r of roles) {
        await tx.query('INSERT INTO staff_role (id, staff_id, role, service_id, granted_by, granted_at) VALUES ($1,$2,$3,$4,$5,$6)', [randomUUID(), staffId, r.role, r.serviceId, actor.sub, nowIso]);
      }
      await this.record(tx, actor, 'account.create', { establishmentId: i.establishmentId, targetSub: sub, details: { roles: roles.map((r) => r.role) } });
    });
    try {
      await this.directory.setEnabled(sub, true);
    } catch (err) {
      await this.events.record(this.db, 'staff_enable_failed', sub, { cause: describeFailure(err) });
      throw new AuthError('directory_unavailable', 502, { sub });
    }
    return { sub, temporaryPassword };
  }

  /** Reprend l'activation chez le fournisseur d'identité d'un compte créé localement (idempotent). */
  async activate(actor: StaffRecord, sub: string): Promise<void> {
    const t = await this.repo.bySub(sub);
    if (!t) throw new AuthError('not_found', 404);
    await this.authorize(actor, 'account.create', { establishmentId: t.establishmentId, roles: t.roles.map((r) => r.role), staffSub: sub });
    if (t.status !== 'active') throw new AuthError('conflict', 409); // un compte désactivé ne se réactive pas par ici
    try {
      await this.directory.setEnabled(sub, true);
    } catch {
      throw new AuthError('directory_unavailable', 502);
    }
  }

  async assignRole(actor: StaffRecord, sub: string, r: RoleInput): Promise<{ id: string }> {
    const t = await this.repo.bySub(sub);
    if (!t || t.status !== 'active') throw new AuthError('not_found', 404);
    let role: RoleInput;
    if (t.establishmentId) role = (await this.checkRoles(this.db, t.establishmentId, [r]))[0]!;
    else if (STAFF_ROLES.includes(r?.role)) role = { role: r.role, serviceId: null };
    else return bad();
    await this.authorize(actor, 'role.assign', { establishmentId: t.establishmentId, serviceId: role.serviceId, staffSub: sub, roles: [role.role] });
    const id = randomUUID();
    try {
      await this.db.transaction(async (tx) => {
        await tx.query('INSERT INTO staff_role (id, staff_id, role, service_id, granted_by, granted_at) VALUES ($1,$2,$3,$4,$5,$6)', [id, t.id, role.role, role.serviceId ?? null, actor.sub, this.now().toISOString()]);
        await this.record(tx, actor, 'role.assign', { establishmentId: t.establishmentId, targetSub: sub, details: { role: role.role } });
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new AuthError('conflict', 409);
      throw e;
    }
    return { id };
  }

  async revokeRole(actor: StaffRecord, sub: string, roleId: string): Promise<void> {
    if (!UUID.test(roleId)) bad();
    const t = await this.repo.bySub(sub);
    const g = t?.roles.find((r) => r.id === roleId);
    if (!t || !g) throw new AuthError('not_found', 404);
    await this.authorize(actor, 'role.assign', { establishmentId: t.establishmentId, serviceId: g.serviceId, staffSub: sub, roles: [g.role] });
    await this.db.transaction(async (tx) => {
      await tx.query('UPDATE staff_role SET revoked_at=$2, revoked_by=$3 WHERE id=$1 AND revoked_at IS NULL', [roleId, this.now().toISOString(), actor.sub]);
      await this.record(tx, actor, 'role.revoke', { establishmentId: t.establishmentId, targetSub: sub, details: { role: g.role } });
    });
  }

  /**
   * Désactivation IMMÉDIATE : l'état local est contrôlé à chaque requête (aucun jeton ne survit), les sessions et les
   * appareils sont révoqués dans la même transaction ; le fournisseur d'identité est prévenu ensuite (défense en profondeur,
   * son échec n'affaiblit pas l'effet local).
   */
  async disableStaff(actor: StaffRecord, sub: string, reason: string): Promise<{ directory: 'ok' | 'pending' }> {
    const t = await this.repo.bySub(sub);
    if (!t) throw new AuthError('not_found', 404);
    await this.authorize(actor, 'account.disable', { establishmentId: t.establishmentId, staffSub: sub, roles: t.roles.map((r) => r.role) });
    if (!reason?.trim() || reason.length > 200) bad();
    const nowIso = this.now().toISOString();
    const changed = await this.db.transaction(async (tx) => {
      const r = await tx.query("UPDATE staff_member SET status='disabled', disabled_at=$2, disabled_by=$3, disabled_reason=$4 WHERE id=$1 AND status='active' RETURNING id", [t.id, nowIso, actor.sub, reason.trim()]);
      if (!r.rows.length) return false;
      await this.sessions.revokeAll(tx, sub, 'account_disabled');
      await tx.query("UPDATE auth_professional_device SET status='revoked', revoked_at=$2 WHERE subject=$1 AND status IN ('active','pending')", [sub, nowIso]);
      await this.events.record(tx, 'staff_disabled', sub, { acteur: actor.sub });
      await this.record(tx, actor, 'account.disable', { establishmentId: t.establishmentId, targetSub: sub, details: { raison: reason.trim() } });
      return true;
    });
    if (!changed) throw new AuthError('conflict', 409);
    try {
      await this.directory.setEnabled(sub, false);
      return { directory: 'ok' };
    } catch (err) {
      await this.events.record(this.db, 'staff_disable_directory_failed', sub, { cause: describeFailure(err) });
      return { directory: 'pending' };
    }
  }

  // -- contrôle de niveau supérieur ----------------------------------------------------------------------------

  private async reviewContext(q: Queryable, row: { actor_sub: string; actor_roles: string[]; establishment_id: string | null; district: string | null }, actor: StaffRecord, cache: Map<string, boolean>): Promise<AdminContext> {
    const d = row.district;
    if (d && !cache.has(d)) cache.set(d, await this.repo.districtChiefAvailable(d, q));
    return {
      entry: { actorSub: row.actor_sub, actorRoles: row.actor_roles as StaffRole[], establishmentId: row.establishment_id, district: d },
      districtChiefAvailable: d ? cache.get(d) : false,
      actorDistrict: actor.district,
    };
  }

  /** Actions en attente de contrôle que cet acteur a le droit de contrôler. */
  async pendingReviews(actor: StaffRecord): Promise<ReviewItem[]> {
    const { rows } = await this.db.query<{ id: string; at: Date; actor_sub: string; actor_roles: string[]; action: string; establishment_id: string | null; district: string | null; target_sub: string | null }>(
      'SELECT id, at, actor_sub, actor_roles, action, establishment_id, district, target_sub FROM admin_action WHERE review_required AND reviewed_by IS NULL ORDER BY at LIMIT 500');
    const cache = new Map<string, boolean>();
    const out: ReviewItem[] = [];
    for (const r of rows) {
      const d = decideAdmin({ actor: toActor(actor), action: 'supervision.review', context: await this.reviewContext(this.db, r, actor, cache) });
      if (d.allow) out.push({ id: r.id, at: new Date(r.at).toISOString(), actorSub: r.actor_sub, action: r.action, establishmentId: r.establishment_id, targetSub: r.target_sub });
    }
    return out;
  }

  async review(actor: StaffRecord, id: string, outcome: 'approved' | 'contested', comment?: string): Promise<void> {
    if (!UUID.test(id) || (outcome !== 'approved' && outcome !== 'contested') || (comment?.length ?? 0) > 500) bad();
    let refused: string | null = null;
    try {
    await this.db.transaction(async (tx) => {
      const row = (await tx.query<{ actor_sub: string; actor_roles: string[]; establishment_id: string | null; district: string | null; review_required: boolean; reviewed_by: string | null }>(
        'SELECT actor_sub, actor_roles, establishment_id, district, review_required, reviewed_by FROM admin_action WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!row || !row.review_required) throw new AuthError('not_found', 404);
      if (row.reviewed_by) throw new AuthError('conflict', 409);
      const d = decideAdmin({ actor: toActor(actor), action: 'supervision.review', context: await this.reviewContext(tx, row, actor, new Map()) });
      if (!d.allow) { refused = d.reason; throw new AuthError('forbidden', 403); }
      await tx.query('UPDATE admin_action SET reviewed_by=$2, reviewed_at=$3, review_outcome=$4, review_comment=$5 WHERE id=$1',
        [id, actor.sub, this.now().toISOString(), outcome, comment?.trim() || null]);
    });
    } catch (e) {
      // Le refus est journalisé hors de la transaction annulée.
      if (refused) await this.db.query(
        `INSERT INTO access_denial (at, actor_sub, actor_kind, establishment_id, action, data, reason) VALUES ($1,$2,'staff',$3,'admin','supervision.review',$4)`,
        [this.now().toISOString(), actor.sub, actor.establishmentId, refused]);
      throw e;
    }
  }
}
