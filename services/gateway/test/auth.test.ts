import { generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig({
  OIDC_ISSUER: 'http://kc.test/realms/syfa',
  OIDC_AUDIENCE: 'syfa-gateway',
});

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const sign = (over: { iss?: string; aud?: string } = {}) =>
    new SignJWT({ realm_access: { roles: ['medecin'] } })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('user-1')
      .setIssuer(over.iss ?? config.oidcIssuer)
      .setAudience(over.aud ?? config.oidcAudience)
      .setExpirationTime('5m')
      .sign(privateKey);
  return { app: buildApp(config, publicKey), sign };
}

describe('L0 socle — passerelle (principe 1)', () => {
  it('refuse une requête sans jeton', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
  });

  it('refuse un jeton invalide ou mal destiné', async () => {
    const { app, sign } = await setup();
    const bad = await sign({ aud: 'autre' });
    for (const token of ['garbage', bad]) {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it('accepte un jeton valide', async () => {
    const { app, sign } = await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${await sign()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ subject: 'user-1', roles: ['medecin'] });
  });

  it('expose /health sans jeton', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });
});

describe('configuration', () => {
  it('refuse un mode inconnu', () => {
    expect(() => loadConfig({ SYFA_MODE: 'x', OIDC_ISSUER: 'a', OIDC_AUDIENCE: 'b' })).toThrow();
  });
});
