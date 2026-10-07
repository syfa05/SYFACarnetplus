import { randomBytes, randomUUID } from 'node:crypto';
import { decideAdmin, CONTROLLED_BY_UPPER_LEVEL, type AdminAction, type AdminContext, type AdminTarget } from '../authz/admin.js';
import type { DenialLog } from '../authz/denial.js';
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
/** Rôles sans établissement : comptes nationaux ou de district. */
const NATIONAL: readonly StaffRole[] = ['chef_district', 'superviseur_pev', 'operateur', 'administrateur_habilite'];

export interface RoleInput { role: StaffRole; serviceId?: string | null }
export interface EstablishmentView { id: string; code: string; name: string; district: string | null; allowedNetworks?: string[]; status: string }
export interface ReviewItem { id: string; at: string; actorSub: string; action: string; establishmentId: string | null; targetSub: string | null }
export interface ReviewPage { items: ReviewItem[]; next: string | null }

const bad = (): never => { throw new AuthError('validation', 400); };

/** Réseaux autorisés : adresses ou CIDR valides ; les plages équivalentes à « tout Internet » sont refusées (préfixe minimal). */
export function validateNetworks(list: unknown, min: { v4: number; v6: number } = { v4: 8, v6: 32 }): string[] {
  if (!Array.isArray(list) || list.length > 50) return bad();
  return list.map((c) => {
    if (typeof c !== 'string') return bad();
    try {
      const p = parseCidr(c);
      if (p.prefix < (p.family === 'ipv4' ? min.v4 : min.v6)) return bad();
    } catch {
      return bad();
    }
    return c.trim();
  });
}

/** Mot de passe temporaire : 18 octets aléatoires (24 caractères), changé à la première connexion. */
const tempPassword = () => randomBytes(18).toString('base64url');

/**
 * Établissements, personnel, rôles, désactivation et contrôle de niveau supérieur (lot L3). Chaque opération est
 * autorisée par le moteur (`decideAdmin`) AVANT toute lecture ou validation qui révélerait l'état de la base ; un
 * refus est journalisé (`access_denial`, limité en débit) et renvoie 403.
 */
export class OrgService {
  constructor(
    private readonly db: Db,
    private readonly repo: StaffRepository,
    private readonly directory: DirectoryPort,
    private readonly sessions: SessionStore,
    private readonly events: AuthEvents,
    private readonly denials: DenialLog,
    private readonly minNetworkPrefix: { v4: number; v6: number },
    private readonly now: () => Date,
  ) {}

  // -- autorisation -------------------------------------------------------------------------------------------

  private async authorize(actor: StaffRecord, action: AdminAction, target?: AdminTarget, context?: AdminContext): Promise<void> {
    const d: Decision = decideAdmin({ actor: toActor(actor), action, target, context });
    if (d.allow) return;
    await this.denials.record({ actorSub: actor.sub, actorKind: 'staff', establishmentId: actor.establishmentId, action: 'admin', data: action, reason: d.reason, condition: d.condition });
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
    const networks = validateNetworks(i.allowedNetworks ?? [], this.minNetworkPrefix);
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
    const list = validateNetworks(networks, this.minNetworkPrefix);
    if (!UUID.test(establishmentId)) bad();
    await this.db.transaction(async (tx) => {
      const r = await tx.query('UPDATE establishment SET allowed_networks=$2 WHERE id=$1 RETURNING id', [establishmentId, list]);
      if (!r.rows.length) throw new AuthError('not_found', 404);
      await this.record(tx, actor, 'establishment.networks', { establishmentId, details: { reseaux: list.length } });
    });
  }

  async createService(actor: StaffRecord, establishmentId: string, name: string): Promise<{ id: string }> {
    await this.authorize(actor, 'service.manage', { establishmentId });
    if (!UUID.test(establishmentId) || !name?.trim() || name.length > 80) bad();
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

  /**
   * Liste des établissements : l'opérateur voit tout, un directeur le sien. Seuls ceux qui gèrent les services de l'établissement
   * (directeur, opérateur) obtiennent les réseaux autorisés (topologie des postes) ; les autres rôles sont refusés et journalisés.
   */
  async listEstablishments(actor: StaffRecord): Promise<EstablishmentView[]> {
    const all = actor.roles.some((r) => r.role === 'operateur');
    await this.authorize(actor, 'service.manage', { establishmentId: actor.establishmentId });
    const { rows } = await this.db.query<{ id: string; code: string; name: string; district: string | null; allowed_networks: string[]; status: string }>(
      `SELECT id, code, name, district, allowed_networks, status FROM establishment ${all ? '' : 'WHERE id=$1'} ORDER BY code`, all ? [] : [actor.establishmentId]);
    return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, district: r.district, allowedNetworks: r.allowed_networks, status: r.status }));
  }

  // -- personnel ----------------------------------------------------------------------------------------------

  /** Forme des rôles demandés, sans accès à la base (faite AVANT l'autorisation : aucune information sur la base n'en sort). */
  private shapeRoles(roles: unknown): RoleInput[] {
    if (!Array.isArray(roles) || roles.length < 1 || roles.length > 6) return bad();
    const seen = new Set<string>();
    return roles.map((r: RoleInput) => {
      if (!r || typeof r !== 'object' || !STAFF_ROLES.includes(r.role)) return bad();
      const serviceId = r.serviceId ?? null;
      if (serviceId !== null && (typeof serviceId !== 'string' || !UUID.test(serviceId))) return bad();
      if (r.role === 'chef_service' && serviceId === null) return bad(); // un chef de service l'est d'UN service
      const key = `${r.role}|${serviceId ?? ''}`;
      if (seen.has(key)) return bad(); // pas de doublon
      seen.add(key);
      return { role: r.role, serviceId };
    });
  }

  /** Les services demandés appartiennent-ils à l'établissement ? (après autorisation) */
  private async checkServices(q: Queryable, establishmentId: string | null, roles: RoleInput[]): Promise<void> {
    for (const r of roles) {
      if (!r.serviceId) continue;
      if (!establishmentId) return bad();
      const s = await q.query('SELECT 1 FROM service_unit WHERE id=$1 AND establishment_id=$2', [r.serviceId, establishmentId]);
      if (!s.rows.length) bad();
    }
  }

  /**
   * Crée un compte du personnel. Toute validation locale précède la création distante. Ordre : compte désactivé chez
   * le fournisseur d'identité → fiche locale (établissement, rôles) → activation. Échec de la fiche locale : le compte
   * distant est supprimé (compensation) ; échec d'activation : 502, la fiche porte `directory_sync='enable'` et
   * `reconcileDirectory` / `activate` reprennent. Comptes nationaux (chef de district, superviseur PEV) : sans établissement.
   */
  async createStaff(actor: StaffRecord, i: { username: string; email?: string; phone: string; establishmentId?: string; district?: string; roles: RoleInput[] }): Promise<{ sub: string; temporaryPassword: string }> {
    const roles = this.shapeRoles(i.roles);
    const national = roles.every((r) => NATIONAL.includes(r.role));
    const establishmentId = national ? null : typeof i.establishmentId === 'string' ? i.establishmentId : null;
    // Autorisation d'abord : un refus ne révèle rien sur l'état de la base ni sur la validité des autres champs.
    await this.authorize(actor, 'account.create', { establishmentId, roles: roles.map((r) => r.role) });
    if (!national && (roles.some((r) => NATIONAL.includes(r.role)) || !establishmentId || !UUID.test(establishmentId))) bad(); // pas de mélange national / établissement
    if (national && (i.establishmentId !== undefined || roles.some((r) => r.serviceId))) bad();
    const isChief = roles.some((r) => r.role === 'chef_district');
    const district = isChief ? i.district?.trim() || null : null;
    if (isChief ? !district || district.length > 80 : i.district !== undefined) bad();
    if (!USERNAME.test(i.username ?? '') || !PHONE.test(i.phone ?? '') || (i.email !== undefined && !EMAIL.test(i.email))) bad();
    await this.checkServices(this.db, establishmentId, roles);
    if (establishmentId) {
      const e = await this.db.query("SELECT 1 FROM establishment WHERE id=$1 AND status='active'", [establishmentId]);
      if (!e.rows.length) throw new AuthError('not_found', 404);
    }

    const temporaryPassword = tempPassword();
    let sub: string;
    try {
      ({ sub } = await this.directory.createUser({ username: i.username, email: i.email, phone: i.phone, temporaryPassword }));
    } catch (err) {
      if (err instanceof DirectoryError && err.code === 'conflict') throw new AuthError('conflict', 409);
      throw new AuthError('directory_unavailable', 502);
    }
    const staffId = randomUUID();
    const nowIso = this.now().toISOString();
    try {
      await this.db.transaction(async (tx) => {
        await tx.query('INSERT INTO staff_member (id, sub, establishment_id, district, status, directory_sync, created_at, created_by) VALUES ($1,$2,$3,$4,\'active\',\'enable\',$5,$6)', [staffId, sub, establishmentId, district, nowIso, actor.sub]);
        for (const r of roles) {
          await tx.query('INSERT INTO staff_role (id, staff_id, role, service_id, granted_by, granted_at) VALUES ($1,$2,$3,$4,$5,$6)', [randomUUID(), staffId, r.role, r.serviceId, actor.sub, nowIso]);
        }
        await this.record(tx, actor, 'account.create', { establishmentId, targetSub: sub, details: { roles: roles.map((r) => r.role) } });
      });
    } catch (err) {
      // Aucune fiche : le compte distant (désactivé) n'a plus de raison d'être. Si la suppression échoue, il reste inutilisable.
      await this.directory.deleteUser(sub).catch(async (e) => { await this.events.record(this.db, 'staff_orphan_account', sub, { cause: describeFailure(e) }); });
      throw err;
    }
    await this.syncDirectory(sub); // active ; échec : 502 avec l'identifiant, reprise possible
    if ((await this.pendingSync(sub)) === 'enable') throw new AuthError('directory_unavailable', 502, { sub });
    return { sub, temporaryPassword };
  }

  private async pendingSync(sub: string): Promise<string | null> {
    return (await this.db.query<{ directory_sync: string | null }>('SELECT directory_sync FROM staff_member WHERE sub=$1', [sub])).rows[0]?.directory_sync ?? null;
  }

  /**
   * Aligne le fournisseur d'identité sur l'état local (source de vérité) : actif → activé, désactivé → désactivé + sessions
   * fermées. Le drapeau `directory_sync` n'est effacé que si l'état local n'a pas changé entre-temps (pas de course avec
   * une désactivation concurrente : on relit après l'appel distant et on rejoue si besoin).
   */
  private async syncDirectory(sub: string): Promise<boolean> {
    for (let round = 0; round < 3; round++) {
      const rec = await this.repo.bySub(sub);
      if (!rec) return true;
      const wantEnabled = rec.status === 'active';
      try {
        await this.directory.setEnabled(sub, wantEnabled);
        if (!wantEnabled) await this.directory.logout(sub);
      } catch (err) {
        await this.events.record(this.db, 'staff_directory_sync_failed', sub, { cause: describeFailure(err), souhaite: wantEnabled ? 'enable' : 'disable' });
        await this.db.query('UPDATE staff_member SET directory_sync=$2 WHERE sub=$1', [sub, wantEnabled ? 'enable' : 'disable']);
        return false;
      }
      const again = await this.repo.bySub(sub);
      if (again && again.status === rec.status) {
        await this.db.query('UPDATE staff_member SET directory_sync=NULL WHERE sub=$1', [sub]);
        return true;
      }
    }
    await this.db.query("UPDATE staff_member SET directory_sync = CASE WHEN status='active' THEN 'enable' ELSE 'disable' END WHERE sub=$1", [sub]);
    return false;
  }

  /** Rattrape les écarts avec le fournisseur d'identité sur demande de l'opérateur. */
  async reconcileDirectory(actor: StaffRecord): Promise<{ done: number; failed: number }> {
    await this.authorize(actor, 'establishment.manage');
    return this.reconcilePending();
  }

  /** Rattrape les écarts avec le fournisseur d'identité (tâche périodique de la passerelle). Retourne le nombre de comptes alignés. */
  async reconcilePending(): Promise<{ done: number; failed: number }> {
    const { rows } = await this.db.query<{ sub: string }>('SELECT sub FROM staff_member WHERE directory_sync IS NOT NULL ORDER BY created_at LIMIT 200');
    let done = 0, failed = 0;
    for (const r of rows) (await this.syncDirectory(r.sub)) ? done++ : failed++;
    return { done, failed };
  }

  /** Reprend l'activation chez le fournisseur d'identité d'un compte créé localement (idempotent). */
  async activate(actor: StaffRecord, sub: string): Promise<void> {
    const t = await this.repo.bySub(sub);
    if (!t) throw new AuthError('not_found', 404);
    await this.authorize(actor, 'account.create', { establishmentId: t.establishmentId, roles: t.roles.map((r) => r.role), staffSub: sub });
    if (t.status !== 'active') throw new AuthError('conflict', 409); // un compte désactivé ne se réactive pas par ici
    if (!(await this.syncDirectory(sub))) throw new AuthError('directory_unavailable', 502);
  }

  /** Nouveau mot de passe temporaire (perdu, ou compte dont l'activation avait échoué). Renvoyé une seule fois, jamais conservé. */
  async resetTemporaryPassword(actor: StaffRecord, sub: string): Promise<{ temporaryPassword: string }> {
    const t = await this.repo.bySub(sub);
    if (!t) throw new AuthError('not_found', 404);
    await this.authorize(actor, 'account.create', { establishmentId: t.establishmentId, roles: t.roles.map((r) => r.role), staffSub: sub });
    if (t.status !== 'active') throw new AuthError('conflict', 409);
    const temporaryPassword = tempPassword();
    try {
      await this.directory.setTemporaryPassword(sub, temporaryPassword);
    } catch {
      throw new AuthError('directory_unavailable', 502);
    }
    await this.db.transaction((tx) => this.record(tx, actor, 'account.password_reset', { establishmentId: t.establishmentId, targetSub: sub }));
    return { temporaryPassword };
  }

  async assignRole(actor: StaffRecord, sub: string, r: RoleInput): Promise<{ id: string }> {
    const [role] = this.shapeRoles([r]);
    const t = await this.repo.bySub(sub);
    if (!t || t.status !== 'active') throw new AuthError('not_found', 404);
    await this.authorize(actor, 'role.assign', { establishmentId: t.establishmentId, serviceId: role!.serviceId, staffSub: sub, roles: [role!.role] });
    // Comptes nationaux (sans établissement) : rôles nationaux seulement, et inversement (la base le garantit aussi).
    if (NATIONAL.includes(role!.role) !== (t.establishmentId === null) || (role!.role === 'chef_district' && !t.district)) bad();
    await this.checkServices(this.db, t.establishmentId, [role!]);
    const id = randomUUID();
    try {
      await this.db.transaction(async (tx) => {
        await tx.query('INSERT INTO staff_role (id, staff_id, role, service_id, granted_by, granted_at) VALUES ($1,$2,$3,$4,$5,$6)', [id, t.id, role!.role, role!.serviceId ?? null, actor.sub, this.now().toISOString()]);
        await this.record(tx, actor, 'role.assign', { establishmentId: t.establishmentId, targetSub: sub, details: { role: role!.role } });
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new AuthError('conflict', 409);
      throw e;
    }
    return { id };
  }

  async revokeRole(actor: StaffRecord, sub: string, roleId: string): Promise<void> {
    const t = await this.repo.bySub(sub);
    const g = UUID.test(roleId) ? t?.roles.find((r) => r.id === roleId) : undefined;
    if (!t || !g) throw new AuthError('not_found', 404);
    await this.authorize(actor, 'role.assign', { establishmentId: t.establishmentId, serviceId: g.serviceId, staffSub: sub, roles: [g.role] });
    await this.db.transaction(async (tx) => {
      await tx.query('UPDATE staff_role SET revoked_at=$2, revoked_by=$3 WHERE id=$1 AND revoked_at IS NULL', [roleId, this.now().toISOString(), actor.sub]);
      await this.record(tx, actor, 'role.revoke', { establishmentId: t.establishmentId, targetSub: sub, details: { role: g.role } });
    });
  }

  /**
   * Désactivation IMMÉDIATE : l'état local est contrôlé à chaque requête (aucun jeton ne survit), les sessions et les
   * appareils sont révoqués dans la même transaction. Le fournisseur d'identité est prévenu ensuite (compte désactivé,
   * sessions fermées) ; en cas d'échec le drapeau `directory_sync` le fait rattraper (`reconcileDirectory`), et l'effet local
   * reste complet.
   */
  async disableStaff(actor: StaffRecord, sub: string, reason: string): Promise<{ directory: 'ok' | 'pending' }> {
    const t = await this.repo.bySub(sub);
    if (!t) throw new AuthError('not_found', 404);
    await this.authorize(actor, 'account.disable', { establishmentId: t.establishmentId, staffSub: sub, roles: t.roles.map((r) => r.role) });
    if (!reason?.trim() || reason.length > 200) bad();
    const nowIso = this.now().toISOString();
    const changed = await this.db.transaction(async (tx) => {
      const r = await tx.query("UPDATE staff_member SET status='disabled', directory_sync='disable', disabled_at=$2, disabled_by=$3, disabled_reason=$4 WHERE id=$1 AND status='active' RETURNING id", [t.id, nowIso, actor.sub, reason.trim()]);
      if (!r.rows.length) return false;
      await this.sessions.revokeAll(tx, sub, 'account_disabled');
      await tx.query("UPDATE auth_professional_device SET status='revoked', revoked_at=$2 WHERE subject=$1 AND status IN ('active','pending')", [sub, nowIso]);
      await this.events.record(tx, 'staff_disabled', sub, { acteur: actor.sub });
      await this.record(tx, actor, 'account.disable', { establishmentId: t.establishmentId, targetSub: sub, details: { raison: reason.trim() } });
      return true;
    });
    if (!changed) throw new AuthError('conflict', 409);
    return { directory: (await this.syncDirectory(sub)) ? 'ok' : 'pending' };
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

  /**
   * Actions en attente de contrôle que cet acteur a le droit de contrôler, les plus RÉCENTES d'abord, par pages
   * (curseur `at|id`). Les lignes que l'acteur ne peut pas contrôler sont sautées, jusqu'à 5 000 lignes examinées par appel.
   */
  async pendingReviews(actor: StaffRecord, opts: { limit?: number; cursor?: string } = {}): Promise<ReviewPage> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const m = opts.cursor === undefined ? null : /^(\d{4}-[\d\-T:.]+Z)\|([0-9a-f-]{36})$/i.exec(opts.cursor);
    if (opts.cursor !== undefined && !m) bad();
    let after: { at: string; id: string } | null = m ? { at: m[1]!, id: m[2]! } : null;
    const cache = new Map<string, boolean>();
    const items: ReviewItem[] = [];
    let scanned = 0;
    let next: string | null = null;
    while (items.length < limit && scanned < 5000) {
      const { rows } = await this.db.query<{ id: string; at: Date; actor_sub: string; actor_roles: string[]; action: string; establishment_id: string | null; district: string | null; target_sub: string | null }>(
        `SELECT id, at, actor_sub, actor_roles, action, establishment_id, district, target_sub FROM admin_action
          WHERE review_required AND reviewed_by IS NULL ${after ? 'AND (at, id) < ($1::timestamptz, $2::uuid)' : ''}
          ORDER BY at DESC, id DESC LIMIT 200`, after ? [after.at, after.id] : []);
      if (!rows.length) break;
      for (const r of rows) {
        scanned++;
        const d = decideAdmin({ actor: toActor(actor), action: 'supervision.review', context: await this.reviewContext(this.db, r, actor, cache) });
        const at = new Date(r.at).toISOString();
        after = { at, id: r.id };
        if (d.allow) items.push({ id: r.id, at, actorSub: r.actor_sub, action: r.action, establishmentId: r.establishment_id, targetSub: r.target_sub });
        if (items.length === limit) { next = `${at}|${r.id}`; break; }
      }
      if (next || rows.length < 200) break;
    }
    if (!next && scanned >= 5000 && after) next = `${after.at}|${after.id}`; // examen interrompu : l'appelant continue
    return { items, next };
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
      if (refused) await this.denials.record({ actorSub: actor.sub, actorKind: 'staff', establishmentId: actor.establishmentId, action: 'admin', data: 'supervision.review', reason: refused });
      throw e;
    }
  }
}
