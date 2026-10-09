import { createHash, randomBytes, randomInt } from 'node:crypto';

/**
 * Identifiants de la carte santé (onglet 3.2 et cahier des charges 7.3-7.4).
 *  - QR code : « CS1: » (version du format) + 128 bits aléatoires et opaques, codés en base 32 (26 caractères) ; aucune donnée
 *    personnelle ni médicale. NB : l'exemple du cahier des charges (14 caractères) n'offre que 70 bits ; l'exigence du lot L4
 *    (128 bits) est retenue.
 *  - Code de secours : 9 caractères (affichés XXX-XXX-XXX), alphabet de 31 caractères sans ambiguïté (ni 0/O, ni 1/I/L), le
 *    dernier est un caractère de contrôle qui détecte toute faute de frappe sur un caractère et toute inversion de deux
 *    caractères voisins.
 */
export const TOKEN_PREFIX = 'CS1:';
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOKEN_BODY = /^[A-Z2-7]{26}$/;
export const TOKEN_ENTROPY_BITS = 128;

/** 31 caractères : chiffres 2-9 et lettres sans I, L, O. */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const BASE = CODE_ALPHABET.length; // 31, premier : le contrôle pondéré détecte substitutions et inversions voisines
export const CODE_LENGTH = 9;
export const CODE_RANDOM_LENGTH = CODE_LENGTH - 1;

/** 16 octets aléatoires → 26 caractères base 32 (130 bits codés, dont 128 aléatoires). */
function base32(bytes: Buffer): string {
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

export function generateToken(): string {
  return TOKEN_PREFIX + base32(randomBytes(16));
}

/** Écriture canonique d'un QR code lu (majuscules, espaces retirés) ; `null` si le format n'est pas celui d'un jeton CS1. */
export function parseToken(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const v = raw.trim().toUpperCase();
  return v.startsWith(TOKEN_PREFIX) && TOKEN_BODY.test(v.slice(TOKEN_PREFIX.length)) ? v : null;
}

/** Caractère de contrôle des 8 premiers : Σ (position × valeur) sur les 9 caractères ≡ 0 (mod 31). */
export function checkChar(first8: string): string {
  let sum = 0;
  for (let i = 0; i < first8.length; i++) sum += (i + 1) * CODE_ALPHABET.indexOf(first8[i]!);
  // poids du caractère de contrôle = 9 ; inverse de 9 modulo 31 = 7 (9 × 7 = 63 = 2 × 31 + 1)
  const v = ((BASE - (sum % BASE)) % BASE) * 7 % BASE;
  return CODE_ALPHABET[v]!;
}

export function generateCode(): string {
  const first = Array.from({ length: CODE_RANDOM_LENGTH }, () => CODE_ALPHABET[randomInt(BASE)]).join('');
  return first + checkChar(first);
}

/** Forme imprimée : K7X-4M2-9PQ. */
export const formatCode = (code: string): string => `${code.slice(0, 3)}-${code.slice(3, 6)}-${code.slice(6, 9)}`;

/**
 * Écriture canonique d'un code de secours saisi (tirets et espaces tolérés, minuscules acceptées) ; `null` si la longueur,
 * l'alphabet ou le caractère de contrôle sont faux (faute de frappe détectée AVANT toute recherche).
 */
export function parseCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 32) return null;
  const v = raw.replace(/[\s-]/g, '').toUpperCase();
  if (v.length !== CODE_LENGTH || [...v].some((c) => !CODE_ALPHABET.includes(c))) return null;
  return checkChar(v.slice(0, CODE_RANDOM_LENGTH)) === v[CODE_LENGTH - 1] ? v : null;
}

/** Ce qui a été scanné ou saisi : jeton QR ou code de secours. */
export type Scan = { kind: 'token'; value: string } | { kind: 'code'; value: string };
export function parseScan(raw: unknown): Scan | null {
  const t = parseToken(raw);
  if (t) return { kind: 'token', value: t };
  const c = parseCode(raw);
  return c ? { kind: 'code', value: c } : null;
}

/**
 * Empreintes de la liste des cartes révoquées. Sans clé, pour que les appareils (qui scannent) puissent les recalculer hors
 * ligne ; aucun risque : une carte révoquée est sans valeur. À reproduire à l'identique côté Android.
 */
export const tokenSha = (token: string): string => createHash('sha256').update(`cs-token\0${token}`).digest('hex');
export const codeSha = (code: string): string => createHash('sha256').update(`cs-code\0${code}`).digest('hex');
export const scanSha = (s: Scan): string => (s.kind === 'token' ? tokenSha(s.value) : codeSha(s.value));

/**
 * Contrôle côté appareil ou serveur local (hors ligne) : la carte scannée figure-t-elle dans la liste locale des cartes révoquées ?
 * `revoked` = ensemble des empreintes (jeton ou code) reçues avec la liste ; une saisie illisible est refusée.
 */
export function isScanRevoked(revoked: ReadonlySet<string>, raw: unknown): boolean {
  const s = parseScan(raw);
  return s === null || revoked.has(scanSha(s));
}
