import type { Queryable } from '../db/db.js';
import type { Actor, RoleGrant, StaffRole } from '../authz/types.js';

export interface StaffRecord {
  id: string;
  sub: string;
  establishmentId: string | null;
  district: string | null;
  status: 'active' | 'disabled';
  roles: Array<RoleGrant & { id: string }>;
  /** Réseaux autorisés de l'établissement (vide : liste globale). */
  allowedNetworks: string[];
}

/** Lecture du personnel et de ses rôles (source de vérité des droits : la base de la passerelle, jamais le jeton). */
export class StaffRepository {
  constructor(private readonly db: Queryable) {}

  async bySub(sub: string, q: Queryable = this.db): Promise<StaffRecord | null> {
    const m = (await q.query<{ id: string; sub: string; establishment_id: string | null; district: string | null; status: 'active' | 'disabled'; networks: string[] | null }>(
      `SELECT s.id, s.sub, s.establishment_id, s.district, s.status, e.allowed_networks AS networks
         FROM staff_member s LEFT JOIN establishment e ON e.id = s.establishment_id WHERE s.sub = $1`, [sub])).rows[0];
    if (!m) return null;
    const roles = (await q.query<{ id: string; role: StaffRole; service_id: string | null }>(
      'SELECT id, role, service_id FROM staff_role WHERE staff_id = $1 AND revoked_at IS NULL ORDER BY granted_at, id', [m.id])).rows;
    return {
      id: m.id, sub: m.sub, establishmentId: m.establishment_id, district: m.district, status: m.status,
      roles: roles.map((r) => ({ id: r.id, role: r.role, serviceId: r.service_id })),
      allowedNetworks: m.networks ?? [],
    };
  }

  async districtChiefAvailable(district: string | null, q: Queryable = this.db): Promise<boolean> {
    if (!district) return false;
    const { rows } = await q.query(
      `SELECT 1 FROM staff_member s JOIN staff_role r ON r.staff_id = s.id AND r.revoked_at IS NULL AND r.role = 'chef_district'
        WHERE s.status = 'active' AND s.district = $1 LIMIT 1`, [district]);
    return rows.length > 0;
  }
}

export const toActor = (r: StaffRecord): Actor => ({
  kind: 'staff', sub: r.sub, active: r.status === 'active', establishmentId: r.establishmentId,
  roles: r.roles.map(({ role, serviceId }) => ({ role, serviceId })),
});
