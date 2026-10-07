import type { LightMyRequestResponse } from 'fastify';
import { bootstrapOperator } from '../../src/org/bootstrap.js';
import { makeEnv, PHONE, type Env } from '../auth/helpers.js';

export { cleanup, PHONE } from '../auth/helpers.js';

export interface OrgEnv extends Env {
  /** Jeton d'un professionnel (sub unique par session). */
  tok(sub: string, over?: Record<string, unknown>): Promise<string>;
  /** Appel authentifié JSON. */
  call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token: string, payload?: unknown, headers?: Record<string, string>): Promise<LightMyRequestResponse>;
  /** Crée un établissement (par l'opérateur `op-1`) et retourne son identifiant. */
  establishment(code: string, over?: Record<string, unknown>): Promise<string>;
  /** Crée un compte du personnel par l'API (directeur par l'opérateur, sinon par `by`) et retourne son `sub`. */
  staff(by: string, username: string, establishmentId: string, roles: Array<{ role: string; serviceId?: string }>): Promise<string>;
}

export async function makeOrgEnv(authEnv: NodeJS.ProcessEnv = {}): Promise<OrgEnv> {
  const env = await makeEnv(authEnv);
  await bootstrapOperator(env.db, 'op-1', {}, () => env.clock.now);
  const o = env as OrgEnv;
  o.tok = (sub, over = {}) => env.signPro({ sub, sid: `sid-${sub}`, ...over });
  o.call = async (method, url, token, payload, headers = {}) =>
    env.app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${token}`, ...headers } });
  o.establishment = async (code, over = {}) => {
    const r = await o.call('POST', '/v1/admin/establishments', await o.tok('op-1'), { code, name: `Hôpital ${code}`, ...over });
    if (r.statusCode !== 201) throw new Error(`establishment ${r.statusCode} ${r.body}`);
    return (r.json() as { id: string }).id;
  };
  let n = 0;
  o.staff = async (by, username, establishmentId, roles) => {
    n++;
    const r = await o.call('POST', '/v1/admin/staff', await o.tok(by), { username, phone: `23769000${String(1000 + n)}`, establishmentId, roles });
    if (r.statusCode !== 201) throw new Error(`staff ${r.statusCode} ${r.body}`);
    return (r.json() as { sub: string }).sub;
  };
  return o;
}
export const unused = PHONE;
