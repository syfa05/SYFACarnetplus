import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthError } from '../auth/errors.js';
import type { Principal } from '../auth/principal.js';
import type { Db } from '../db/db.js';
import { toActor, type StaffRecord } from '../org/repository.js';
import { decide, DEFAULT_ENGINE_CONFIG } from './engine.js';
import { deny, type AccessContext, type AccessRequest, type Action, type Actor, type DataType, type Decision, type EngineConfig } from './types.js';

export interface AccessInput { patientId: string; action: Action; data: DataType; context: Omit<AccessContext, 'now'> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Point d'entrée UNIQUE des services pour une décision d'accès aux données : construit l'acteur à partir du principal
 * authentifié (jamais d'après le corps de la requête), appelle le moteur, journalise les refus (T-ACC-01/02).
 * Les services lisent ensuite `Decision.fields` pour ne renvoyer que les champs autorisés.
 */
export class AccessGuard {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date,
    private readonly cfg: EngineConfig = DEFAULT_ENGINE_CONFIG,
    private readonly homologatedClients: string[] = [],
  ) {}

  private actorOf(p: Principal, staff: StaffRecord | null | undefined): Actor | null {
    switch (p.kind) {
      case 'patient': return { kind: 'patient', patientId: p.sub };
      case 'system': return { kind: 'system', client: p.client, homologated: this.homologatedClients.includes(p.client) };
      case 'professional': return staff ? toActor(staff) : null; // sans fiche du personnel : aucun droit
    }
  }

  async check(p: Principal, staff: StaffRecord | null | undefined, r: AccessInput): Promise<Decision> {
    const actor = this.actorOf(p, staff);
    const req: AccessRequest | null = actor && { actor, patientId: r.patientId, action: r.action, data: r.data, context: { ...r.context, now: this.now() } };
    const d = req ? decide(req, this.cfg) : deny('no_staff_record');
    if (!d.allow) await this.logDenial(p, staff, r, d).catch(() => {}); // un échec de journalisation ne rend jamais l'accès
    return d;
  }

  private async logDenial(p: Principal, staff: StaffRecord | null | undefined, r: AccessInput, d: Extract<Decision, { allow: false }>): Promise<void> {
    await this.db.query(
      'INSERT INTO access_denial (at, actor_sub, actor_kind, establishment_id, patient_id, action, data, reason, condition) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [this.now().toISOString(), p.sub, p.kind, staff?.establishmentId ?? null, UUID.test(r.patientId) ? r.patientId : null, r.action, r.data, d.reason, d.condition ?? null]);
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Fiche du personnel (professionnels), chargée par le contrôle du jeton. */
    staff?: StaffRecord | null;
    /** Décision d'accès de la route (champs autorisés). */
    access?: Decision;
  }
}

/** `preHandler` de route : refuse (403, `forbidden`) sauf décision favorable du moteur. */
export function requireAccess(guard: AccessGuard, build: (req: FastifyRequest) => AccessInput) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.principal) throw new AuthError('unauthorized', 401);
    const d = await guard.check(req.principal, req.staff, build(req));
    if (!d.allow) throw new AuthError('forbidden', 403);
    req.access = d;
  };
}
