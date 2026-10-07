import { randomUUID } from 'node:crypto';
import type { Db } from '../db/db.js';

/**
 * Premier compte de la plateforme : l'opérateur. Aucune route de l'API ne crée d'opérateur ni d'administrateur
 * habilité ; ils sont posés par l'exploitation (`npm run bootstrap-operator -- <sub>`). Idempotent.
 */
export async function bootstrapOperator(db: Db, sub: string, opts: { habilite?: boolean; reactivate?: boolean } = {}, now: () => Date = () => new Date()): Promise<void> {
  if (!sub?.trim()) throw new Error('identifiant (sub) du compte requis');
  const nowIso = now().toISOString();
  await db.transaction(async (tx) => {
    const ex = (await tx.query<{ id: string }>('SELECT id FROM staff_member WHERE sub=$1', [sub])).rows[0];
    const id = ex?.id ?? randomUUID();
    if (ex) {
      const st = (await tx.query<{ status: string }>('SELECT status FROM staff_member WHERE id=$1', [id])).rows[0]!.status;
      if (st === 'disabled') {
        // Un compte désactivé ne redevient pas opérateur par mégarde : réactivation explicite (--reactivate).
        if (!opts.reactivate) throw new Error('compte désactivé : relancer avec --reactivate pour le réactiver');
        await tx.query("UPDATE staff_member SET status='active', directory_sync='enable', disabled_at=NULL, disabled_by=NULL, disabled_reason=NULL WHERE id=$1", [id]);
      }
    }
    if (!ex) await tx.query("INSERT INTO staff_member (id, sub, status, created_at, created_by) VALUES ($1,$2,'active',$3,'bootstrap')", [id, sub, nowIso]);
    for (const role of opts.habilite ? ['operateur', 'administrateur_habilite'] : ['operateur']) {
      await tx.query(
        `INSERT INTO staff_role (id, staff_id, role, granted_by, granted_at)
         SELECT $1,$2,$3,'bootstrap',$4 WHERE NOT EXISTS (SELECT 1 FROM staff_role WHERE staff_id=$2 AND role=$3 AND revoked_at IS NULL)`,
        [randomUUID(), id, role, nowIso]);
    }
  });
}
