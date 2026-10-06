import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Chiffrement applicatif des colonnes sensibles de la base identité (onglet 4.2, principe 7).
 * - AES-256-GCM, nonce aléatoire par valeur ; l'AAD lie le chiffré à sa colonne et à sa ligne
 *   (un chiffré copié ailleurs ne se déchiffre pas).
 * - Index aveugles HMAC-SHA256 pour les recherches d'égalité (identifiants, clés phonétiques, date de naissance).
 * - Deux clés dérivées (chiffrement, index) d'une clé maître fournie par l'environnement (Vault en production).
 */
const VERSION = 'v1';

export class FieldCrypto {
  private readonly encKey: Buffer;
  private readonly idxKey: Buffer;

  constructor(masterKeyBase64: string) {
    const master = Buffer.from(masterKeyBase64, 'base64');
    if (master.length !== 32) throw new Error('IDENTITY_MASTER_KEY doit contenir 32 octets encodés en base64');
    this.encKey = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `syfa/identity/enc/${VERSION}`, 32));
    this.idxKey = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `syfa/identity/idx/${VERSION}`, 32));
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): FieldCrypto {
    const key = env.IDENTITY_MASTER_KEY;
    if (!key) throw new Error("Variable d'environnement manquante : IDENTITY_MASTER_KEY");
    return new FieldCrypto(key);
  }

  encrypt(plain: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
  }

  decrypt(stored: string, aad: string): string {
    const [version, payload] = stored.split(':');
    if (version !== VERSION || !payload) throw new Error('format de chiffré inconnu');
    const raw = Buffer.from(payload, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }

  /** Empreinte déterministe pour recherche par égalité ; `label` sépare les usages. */
  blindIndex(label: string, value: string): string {
    return createHmac('sha256', this.idxKey).update(`${label}\0${value}`).digest('hex');
  }
}

export const generateMasterKey = (): string => randomBytes(32).toString('base64');
