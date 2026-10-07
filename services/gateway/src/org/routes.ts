import type { FastifyInstance, FastifyRequest } from 'fastify';
import { body, str } from '../auth/routes.js';
import { AuthError } from '../auth/errors.js';
import type { AuthRuntime } from '../auth/runtime.js';
import type { StaffRecord } from './repository.js';

const arr = (items: unknown, max: number) => ({ type: 'array', items, maxItems: max });
const roleSchema = { type: 'object', properties: { role: str(40), serviceId: { anyOf: [str(36, 36), { type: 'null' }] } }, required: ['role'], additionalProperties: false };

/**
 * Administration (onglet 2.3). Réservée au personnel : le droit est décidé par le moteur pour chaque action, jamais par
 * le rôle du jeton. Les erreurs ont des codes stables (403 `forbidden`, jamais le motif du refus).
 */
export function orgRoutes(app: FastifyInstance, rt: AuthRuntime): void {
  const me = (req: FastifyRequest): StaffRecord => {
    if (req.principal?.kind !== 'professional' || !req.staff) throw new AuthError('forbidden', 403);
    return req.staff;
  };
  const opts = (properties: Record<string, unknown>, required: string[]) => ({ ...body(properties, required), bodyLimit: 16_384 });

  app.post('/v1/admin/establishments',
    opts({ code: str(32), name: str(120), district: str(80), allowedNetworks: arr(str(64), 50) }, ['code', 'name']),
    async (req, reply) => reply.code(201).send(await rt.org.createEstablishment(me(req), req.body as never)));

  app.get('/v1/admin/establishments', async (req) => rt.org.listEstablishments(me(req)));

  app.put('/v1/admin/establishments/:id/networks', opts({ allowedNetworks: arr(str(64), 50) }, ['allowedNetworks']), async (req, reply) => {
    await rt.org.setNetworks(me(req), (req.params as { id: string }).id, (req.body as { allowedNetworks: string[] }).allowedNetworks);
    return reply.code(204).send();
  });

  app.post('/v1/admin/establishments/:id/services', opts({ name: str(80) }, ['name']), async (req, reply) =>
    reply.code(201).send(await rt.org.createService(me(req), (req.params as { id: string }).id, (req.body as { name: string }).name)));

  app.post('/v1/admin/staff',
    opts({ username: str(64), email: str(254), phone: str(20), establishmentId: str(36, 36), district: str(80), roles: { ...arr(roleSchema, 6), minItems: 1 } },
      ['username', 'phone', 'roles']),
    async (req, reply) => {
      const r = await rt.org.createStaff(me(req), req.body as never);
      return reply.header('cache-control', 'no-store').code(201).send(r); // mot de passe temporaire : jamais mis en cache
    });

  app.post('/v1/admin/staff/:sub/temporary-password', async (req, reply) =>
    reply.header('cache-control', 'no-store').send(await rt.org.resetTemporaryPassword(me(req), (req.params as { sub: string }).sub)));

  app.post('/v1/admin/directory/reconcile', async (req) => rt.org.reconcileDirectory(me(req)));

  app.post('/v1/admin/staff/:sub/activate', async (req, reply) => {
    await rt.org.activate(me(req), (req.params as { sub: string }).sub);
    return reply.code(204).send();
  });

  app.post('/v1/admin/staff/:sub/roles', opts(roleSchema.properties, ['role']), async (req, reply) =>
    reply.code(201).send(await rt.org.assignRole(me(req), (req.params as { sub: string }).sub, req.body as never)));

  app.delete('/v1/admin/staff/:sub/roles/:roleId', async (req, reply) => {
    const p = req.params as { sub: string; roleId: string };
    await rt.org.revokeRole(me(req), p.sub, p.roleId);
    return reply.code(204).send();
  });

  app.post('/v1/admin/staff/:sub/disable', opts({ reason: str(200) }, ['reason']), async (req) =>
    rt.org.disableStaff(me(req), (req.params as { sub: string }).sub, (req.body as { reason: string }).reason));

  app.get('/v1/admin/reviews', { schema: { querystring: { type: 'object', properties: { limit: { type: 'string', pattern: '^[0-9]{1,3}$' }, cursor: str(80) }, additionalProperties: false } } },
    async (req) => {
      const q = req.query as { limit?: string; cursor?: string };
      const limit = q.limit === undefined ? undefined : Number(q.limit);
      if (limit !== undefined && (limit < 1 || limit > 100)) throw new AuthError('validation', 400);
      return rt.org.pendingReviews(me(req), { limit, cursor: q.cursor });
    });

  app.post('/v1/admin/reviews/:id', opts({ outcome: { type: 'string', enum: ['approved', 'contested'] }, comment: str(500) }, ['outcome']), async (req, reply) => {
    const b = req.body as { outcome: 'approved' | 'contested'; comment?: string };
    await rt.org.review(me(req), (req.params as { id: string }).id, b.outcome, b.comment);
    return reply.code(204).send();
  });
}
