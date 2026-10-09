import type { LightMyRequestResponse } from 'fastify';
import { makeOrgEnv, type OrgEnv } from '../org/helpers.js';

export { cleanup } from '../org/helpers.js';

export interface CardEnv extends OrgEnv {
  est: string;
  director: string;
  agent: string;
  /** Crée un patient avec un téléphone propre. */
  patient(over?: Record<string, unknown>): Promise<string>;
  /** Secrets d'une carte (déchiffrés) : ce que le PDF imprime. */
  issue(patientId: string, type?: string, by?: string): Promise<{ id: string; number: string; status: string; type: string }>;
  activateCard(cardId: string, by?: string): Promise<LightMyRequestResponse>;
  status(cardId: string): Promise<string>;
  /** Fiche du personnel de l'agent d'émission. */
  agentRecord(): Promise<import('../../src/org/repository.js').StaffRecord>;
  /** Jeton d'un client système (serveur local). */
  signSystem(): Promise<string>;
}

export async function makeCardEnv(authEnv: NodeJS.ProcessEnv = {}): Promise<CardEnv> {
  const e = (await makeOrgEnv(authEnv)) as CardEnv;
  e.est = await e.establishment('A-1');
  e.director = await e.staff('op-1', 'dir.a', e.est, [{ role: 'directeur_medical' }]);
  e.agent = await e.staff(e.director, 'agent.a', e.est, [{ role: 'agent_emission' }]);
  let n = 0;
  e.patient = (over = {}) => {
    n++;
    return e.addPatient({ telephone: `23767700${String(1000 + n)}`, ...over });
  };
  e.issue = async (patientId, type = 'adulte', by = e.agent) => {
    const r = await e.call('POST', '/v1/cards', await e.tok(by), { patientId, type });
    if (r.statusCode !== 201) throw new Error(`issue ${r.statusCode} ${r.body}`);
    return r.json();
  };
  e.activateCard = async (cardId, by = e.agent) => {
    const { token } = await secretsOf(e, cardId);
    return e.call('POST', '/v1/cards/activate', await e.tok(by), { scan: token });
  };
  e.status = async (cardId) => (await e.db.query<{ status: string }>('SELECT status FROM card WHERE id=$1', [cardId])).rows[0]!.status;
  e.agentRecord = async () => (await e.rt.staff.bySub(e.agent))!;
  e.signSystem = () => e.signPro({ azp: 'syfa-system', sub: 'svc-local', sid: undefined, amr: undefined });
  return e;
}

/** Jeton et code de secours (en clair) d'une carte, déchiffrés comme le fait l'impression. */
export async function secretsOf(e: CardEnv, cardId: string): Promise<{ token: string; code: string }> {
  const r = (await e.db.query<{ token_enc: string; code_enc: string }>('SELECT token_enc, code_enc FROM card WHERE id=$1', [cardId])).rows[0]!;
  return { token: e.fieldCrypto.decrypt(r.token_enc, `card:${cardId}:token`), code: e.fieldCrypto.decrypt(r.code_enc, `card:${cardId}:code`) };
}
