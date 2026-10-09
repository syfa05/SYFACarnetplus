import { decideAdmin, type AdminAction, type AdminContext, type AdminTarget } from '../authz/admin.js';
import type { DenialLog } from '../authz/denial.js';
import { AuthError } from '../auth/errors.js';
import { toActor, type StaffRecord } from './repository.js';

/** Autorise une action d'administration par le moteur ; un refus est journalisé (limité en débit) et renvoie 403. */
export function adminGate(denials: DenialLog) {
  return async (actor: StaffRecord, action: AdminAction, target?: AdminTarget, context?: AdminContext): Promise<void> => {
    const d = decideAdmin({ actor: toActor(actor), action, target, context });
    if (d.allow) return;
    await denials.record({ actorSub: actor.sub, actorKind: 'staff', establishmentId: actor.establishmentId, action: 'admin', data: action, reason: d.reason, condition: d.condition });
    throw new AuthError('forbidden', 403);
  };
}
