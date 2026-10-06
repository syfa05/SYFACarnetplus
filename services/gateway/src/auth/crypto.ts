import { createHash, createHmac, hkdfSync, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Secrets d'authentification. Clé maître `AUTH_SECRET_KEY` (32 octets, base64 ; Vault en production),
 * distincte de la clé d'identité. Une sous-clé par usage : un secret volé ne sert qu'à son usage.
 */
export class AuthCrypto {
  private readonly keys = new Map<string, Buffer>();
  constructor(private readonly masterBase64: string) {
    if (Buffer.from(masterBase64, 'base64').length !== 32) throw new Error('AUTH_SECRET_KEY doit contenir 32 octets encodés en base64');
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): AuthCrypto {
    if (!env.AUTH_SECRET_KEY) throw new Error("Variable d'environnement manquante : AUTH_SECRET_KEY");
    return new AuthCrypto(env.AUTH_SECRET_KEY);
  }

  private key(usage: string): Buffer {
    let k = this.keys.get(usage);
    if (!k) {
      k = Buffer.from(hkdfSync('sha256', Buffer.from(this.masterBase64, 'base64'), Buffer.alloc(0), `syfa/auth/${usage}/v1`, 32));
      this.keys.set(usage, k);
    }
    return k;
  }

  hmac(usage: string, value: string): string {
    return createHmac('sha256', this.key(usage)).update(value).digest('hex');
  }

  /** Comparaison en temps constant de deux chaînes hexadécimales/base64 de même nature. */
  static equal(a: string, b: string): boolean {
    const ha = createHash('sha256').update(a).digest();
    const hb = createHash('sha256').update(b).digest();
    return timingSafeEqual(ha, hb);
  }

  /** Code numérique uniformément tiré (pas de biais modulo). */
  numericCode(length: number): string {
    return Array.from({ length }, () => String(randomInt(0, 10))).join('');
  }

  /** Secret de 256 bits (appareil, jeton de rafraîchissement) et son empreinte. */
  newSecret(): { secret: string; hash: string } {
    const secret = randomBytes(32).toString('base64url');
    return { secret, hash: this.secretHash(secret) };
  }
  secretHash(secret: string): string {
    return createHash('sha256').update(secret).digest('hex'); // entropie 256 bits : un hachage rapide suffit
  }

  /** PIN : scrypt sur HMAC(poivre, appareil|PIN) — une fuite de la base seule ne permet pas d'énumérer les 10 000 PIN. */
  async hashPin(deviceId: string, pin: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await this.scrypt(this.pinInput(deviceId, pin), salt);
    return `s1:${salt.toString('base64')}:${derived.toString('base64')}`;
  }
  async verifyPin(deviceId: string, pin: string, stored: string): Promise<boolean> {
    const [v, salt, hash] = stored.split(':');
    if (v !== 's1' || !salt || !hash) return false;
    const derived = await this.scrypt(this.pinInput(deviceId, pin), Buffer.from(salt, 'base64'));
    const expected = Buffer.from(hash, 'base64');
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  }
  private pinInput(deviceId: string, pin: string): string {
    return createHmac('sha256', this.key('pin')).update(`${deviceId}\0${pin}`).digest('base64');
  }
  private scrypt(input: string, salt: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) =>
      scrypt(input, salt, 32, { N: 2 ** 14, r: 8, p: 1 }, (e, k) => (e ? reject(e) : resolve(k))),
    );
  }
}

export const generateAuthKey = (): string => randomBytes(32).toString('base64');
