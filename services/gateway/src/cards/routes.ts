import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AuthError } from '../auth/errors.js';
import type { AuthRuntime } from '../auth/runtime.js';
import { body, str } from '../auth/routes.js';
import type { StaffRecord } from '../org/repository.js';

const TYPES = ['adulte', 'enfant', 'temporaire'];

/**
 * Routes des cartes (lot L4). Le personnel agit selon la matrice des actions d'administration (agent d'émission, directeur
 * médical ; opérateur : blocage seul) ; le patient ne voit et ne bloque que SES cartes. Jamais de jeton ni de code de secours dans
 * une réponse JSON, sauf la carte numérique de son titulaire.
 */
export function cardRoutes(app: FastifyInstance, rt: AuthRuntime): void {
  const staff = (req: FastifyRequest): StaffRecord => {
    if (req.principal?.kind !== 'professional' || !req.staff) throw new AuthError('forbidden', 403);
    return req.staff;
  };
  const patientId = (req: FastifyRequest): string => {
    if (req.principal?.kind !== 'patient') throw new AuthError('forbidden', 403);
    return req.principal.sub;
  };
  const deviceOf = (req: FastifyRequest): string | null => (req.principal?.kind === 'professional' ? req.principal.deviceId : null);

  app.post('/v1/cards', body({ patientId: str(36, 36), type: { type: 'string', enum: TYPES } }, ['patientId', 'type']),
    async (req, reply) => reply.code(201).send(await rt.cards.issue(staff(req), req.body as never)));

  app.get('/v1/cards/:id/print', async (req, reply) => {
    const pdf = await rt.cards.print(staff(req), (req.params as { id: string }).id);
    return reply.type('application/pdf').header('cache-control', 'no-store').header('content-disposition', 'inline; filename="carte.pdf"').send(pdf);
  });

  app.post('/v1/cards/activate', body({ scan: str(64) }, ['scan']),
    async (req) => rt.cards.activate(staff(req), (req.body as { scan: string }).scan));

  app.post('/v1/cards/:id/block', body({ reason: str(200) }, ['reason']),
    async (req) => rt.cards.block(staff(req), (req.params as { id: string }).id, (req.body as { reason: string }).reason));

  app.get('/v1/patients/:id/cards', async (req) => rt.cards.listForPatient(staff(req), (req.params as { id: string }).id));

  // Titulaire : carte numérique et blocage depuis l'application.
  app.get('/v1/cards/mine', async (req, reply) => reply.header('cache-control', 'no-store').send(await rt.cards.digitalCard(patientId(req))));
  app.post('/v1/cards/mine/block', async (req) => rt.cards.blockOwn(patientId(req)));

  // Émission hors ligne : réserve de codes par appareil, rattachement à la synchronisation.
  app.post('/v1/cards/reserve', body({ type: { type: 'string', enum: TYPES }, count: { type: 'integer', minimum: 1, maximum: 1000 } }, ['type', 'count']),
    async (req, reply) => {
      const b = req.body as { type: 'adulte' | 'enfant' | 'temporaire'; count: number };
      return reply.header('cache-control', 'no-store').code(201).send(await rt.cards.reserve(staff(req), deviceOf(req), b.type, b.count));
    });
  app.post('/v1/cards/reserve/bind', body({ cardId: str(36, 36), patientId: str(36, 36), issuedAt: str(40), controlScanAt: str(40) }, ['cardId', 'patientId', 'issuedAt']),
    async (req) => rt.cards.bindReserved(staff(req), deviceOf(req), req.body as never));

  // Liste des cartes révoquées : serveurs locaux (client système) et appareils d'émission ou de scan enregistrés.
  app.get('/v1/cards/revocations', { schema: { querystring: { type: 'object', properties: { since: { type: 'string', pattern: '^[0-9]{1,15}$' }, limit: { type: 'string', pattern: '^[0-9]{1,5}$' } }, additionalProperties: false } } },
    async (req) => {
      const p = req.principal;
      if (!(p?.kind === 'system' || (p?.kind === 'professional' && p.deviceId))) throw new AuthError('forbidden', 403);
      const q = req.query as { since?: string; limit?: string };
      return rt.cards.revocations(Number(q.since ?? 0), q.limit === undefined ? undefined : Number(q.limit));
    });
}
