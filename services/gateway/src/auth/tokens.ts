import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import type { AuthConfig } from './config.js';

export interface PatientTokenClaims {
  sub: string; // identifiant technique du dossier patient
  sid: string;
}

/** Jetons d'accès des patients, émis par la passerelle (ES256). Clé privée : Vault en production. */
export class PatientTokens {
  constructor(
    private readonly config: AuthConfig,
    private readonly privateKey: KeyObject,
    private readonly publicKey: KeyObject,
    private readonly now: () => Date,
  ) {}

  static fromPem(config: AuthConfig, pkcs8Pem: string, now: () => Date): PatientTokens {
    const priv = createPrivateKey(pkcs8Pem);
    if (priv.asymmetricKeyType !== 'ec') throw new Error('PATIENT_JWT_PRIVATE_KEY doit être une clé EC P-256 (ES256)');
    return new PatientTokens(config, priv, createPublicKey(priv), now);
  }

  async issue(c: PatientTokenClaims): Promise<{ token: string; expiresIn: number }> {
    const iat = Math.floor(this.now().getTime() / 1000);
    const token = await new SignJWT({ sid: c.sid, roles: ['patient'] })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(c.sub)
      .setIssuer(this.config.patientIssuer)
      .setAudience(this.config.patientAudience)
      .setIssuedAt(iat)
      .setExpirationTime(iat + this.config.accessTokenSeconds)
      .sign(this.privateKey);
    return { token, expiresIn: this.config.accessTokenSeconds };
  }

  async verify(token: string) {
    const { payload } = await jwtVerify(token, this.publicKey, {
      issuer: this.config.patientIssuer,
      audience: this.config.patientAudience,
      algorithms: ['ES256'],
      currentDate: this.now(),
    });
    return payload;
  }
}
