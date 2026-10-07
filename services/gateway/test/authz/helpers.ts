import type { AccessRequest, Actor, Action, DataType, Item, RoleGrant, StaffRole } from '../../src/authz/types.js';

export const NOW = new Date('2026-10-06T10:00:00Z');
export const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
export const PATIENT = 'patient-1';
export const EST = 'est-1';

export const staff = (role: StaffRole, over: Partial<Extract<Actor, { kind: 'staff' }>> = {}, serviceId: string | null = null): Actor => ({
  kind: 'staff', sub: 'u1', active: true, establishmentId: EST, roles: [{ role, serviceId } satisfies RoleGrant], ...over,
});

/** Élément qui satisfait toutes les conditions d'un accès normal. */
export const goodItem = (over: Partial<Item> = {}): Item => ({
  masked: false, confidential: false, authorSub: 'someone-else', status: 'valide', validatedAt: hoursAgo(100),
  active: true, currentCare: true, examKind: 'prescrit', ...over,
});

export const openEpisode = (over = {}) => ({
  establishmentId: EST, serviceId: null, serviceScoped: false, expiresAt: new Date(NOW.getTime() + 24 * 3_600_000), closedAt: null, ...over,
});

export function req(actor: Actor, data: DataType, action: Action, ctx: Partial<AccessRequest['context']> = {}): AccessRequest {
  return {
    actor, patientId: PATIENT, action, data,
    context: { now: NOW, episode: openEpisode(), item: goodItem(), ...(action === 'E' ? { export: { format: 'pdf' as const } } : {}), ...ctx },
  };
}
