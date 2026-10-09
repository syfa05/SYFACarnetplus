import { describe, expect, it } from 'vitest';
import {
  CODE_ALPHABET, checkChar, codeSha, formatCode, generateCode, generateToken, isScanRevoked, parseCode, parseScan, parseToken, scanSha, tokenSha,
} from '../../src/cards/codes.js';

describe('QR code « CS1: » (onglet 3.2 ; cahier des charges 7.3)', () => {
  it('préfixe de version, 26 caractères base 32 (128 bits aléatoires), aucune donnée personnelle', () => {
    for (let i = 0; i < 200; i++) {
      const t = generateToken();
      expect(t).toMatch(/^CS1:[A-Z2-7]{26}$/);
      expect(parseToken(t)).toBe(t);
    }
  });
  it('128 bits : le 26e caractère ne porte que 3 bits aléatoires (les 2 bits de bourrage sont nuls) et les autres sont uniformes', () => {
    const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const last = new Set<number>();
    const first = new Array(32).fill(0);
    for (let i = 0; i < 6400; i++) {
      const t = generateToken();
      last.add(B32.indexOf(t.at(-1)!) & 3); // 2 bits de poids faible : toujours 0
      first[B32.indexOf(t[4]!)]++;
    }
    expect([...last]).toEqual([0]);
    for (const n of first) expect(n).toBeGreaterThan(100); // 200 attendus par caractère
  });
  it('saisie tolérante (minuscules, espaces) ; formats faux refusés', () => {
    const t = generateToken();
    expect(parseToken(` ${t.toLowerCase()} `)).toBe(t);
    for (const bad of ['', 'CS2:' + t.slice(4), t.slice(4), t + 'A', t.slice(0, -1), 'CS1:' + '1'.repeat(26), 'CS1:' + '0'.repeat(26), 42, null, undefined, {}, 'x'.repeat(100)]) {
      expect(parseToken(bad as never), String(bad)).toBeNull();
    }
  });
  it('10 millions de tirages simulés : aucune collision (comparaison sur 64 bits puis vérification complète)', () => {
    const N = 10_000_000;
    const prefix = new BigUint64Array(N);
    const full = new Map<bigint, string>();
    const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const big = (t: string) => { let v = 0n; for (const ch of t.slice(4, 17)) v = (v << 5n) | BigInt(B32.indexOf(ch)); return v; }; // 13 caractères = 65 bits
    for (let i = 0; i < N; i++) {
      const t = generateToken();
      prefix[i] = BigInt.asUintN(64, big(t));
      if (i % 5000 === 0) full.set(prefix[i]!, t);
    }
    prefix.sort();
    let dup = 0;
    for (let i = 1; i < N; i++) if (prefix[i] === prefix[i - 1]) dup++;
    expect(dup).toBe(0); // espérance d'une collision sur 64 bits : ~ 3 × 10⁻⁶
    expect(full.size).toBeGreaterThan(1000);
  }, 180_000);
});

describe('code de secours (cahier des charges 7.4)', () => {
  it('alphabet de 31 caractères sans ambiguïté : ni 0, O, 1, I, L', () => {
    expect(CODE_ALPHABET).toHaveLength(31);
    expect(new Set(CODE_ALPHABET).size).toBe(31);
    for (const c of '01OIL') expect(CODE_ALPHABET).not.toContain(c);
  });
  it('9 caractères, imprimés XXX-XXX-XXX, dernier caractère de contrôle valide', () => {
    for (let i = 0; i < 2000; i++) {
      const c = generateCode();
      expect(c).toHaveLength(9);
      expect([...c].every((x) => CODE_ALPHABET.includes(x))).toBe(true);
      expect(checkChar(c.slice(0, 8))).toBe(c[8]);
      expect(formatCode(c)).toMatch(/^[2-9A-HJKMNP-Z]{3}-[2-9A-HJKMNP-Z]{3}-[2-9A-HJKMNP-Z]{3}$/);
      expect(parseCode(formatCode(c.toLowerCase()))).toBe(c);
    }
  });
  it('toute faute sur UN caractère et toute inversion de deux caractères voisins sont détectées', () => {
    let total = 0;
    for (let i = 0; i < 300; i++) {
      const c = generateCode();
      for (let p = 0; p < 9; p++) for (const a of CODE_ALPHABET) if (a !== c[p]) { total++; expect(parseCode(c.slice(0, p) + a + c.slice(p + 1)), `${c} @${p}`).toBeNull(); }
      for (let p = 0; p < 8; p++) if (c[p] !== c[p + 1]) { total++; expect(parseCode(c.slice(0, p) + c[p + 1] + c[p] + c.slice(p + 2)), `${c} ↔${p}`).toBeNull(); }
    }
    expect(total).toBeGreaterThan(80_000);
  });
  it('caractères ambigus, longueur, types : refusés avant toute recherche', () => {
    const c = generateCode();
    for (const bad of [c.replace(c[0]!, 'O'), c.replace(c[0]!, '0'), c.replace(c[0]!, 'I'), c.slice(0, 8), c + 'A', '', 5, null, {}, 'x'.repeat(40)]) {
      expect(parseCode(bad as never), String(bad)).toBeNull();
    }
  });
  it('au plus quelques collisions de codes à très grande échelle : espace 31^8 — l\'unicité est assurée par la base (voir cycle de vie)', () => {
    const seen = new Set<string>();
    let collisions = 0;
    for (let i = 0; i < 200_000; i++) { const c = generateCode().slice(0, 8); if (seen.has(c)) collisions++; seen.add(c); }
    expect(collisions).toBeLessThan(5); // espérance : n²/2N = 2·10¹⁰ / 1,7·10¹² ≈ 0,02
  });
});

describe('scan et liste locale des cartes révoquées', () => {
  it('parseScan distingue jeton et code ; empreintes sans clé, séparées par usage', () => {
    const t = generateToken(), c = generateCode();
    expect(parseScan(t)).toEqual({ kind: 'token', value: t });
    expect(parseScan(formatCode(c))).toEqual({ kind: 'code', value: c });
    expect(parseScan('n\'importe quoi')).toBeNull();
    expect(tokenSha(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenSha(t)).not.toBe(codeSha(t));
    expect(scanSha({ kind: 'token', value: t })).toBe(tokenSha(t));
  });
  it('contrôle hors ligne : révoquée ou illisible → refusée ; absente de la liste → acceptée', () => {
    const t = generateToken(), c = generateCode();
    const list = new Set([tokenSha(t), codeSha(c)]);
    expect(isScanRevoked(list, t)).toBe(true);
    expect(isScanRevoked(list, formatCode(c))).toBe(true);
    expect(isScanRevoked(list, generateToken())).toBe(false);
    expect(isScanRevoked(list, 'illisible')).toBe(true);
  });
});
