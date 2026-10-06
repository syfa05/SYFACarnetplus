/** Normalisation pour la recherche (onglet 3.2) : majuscules, sans accents ; forme d'origine conservée ailleurs. */
export function normalizeName(input: string): string {
  return input
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/['’`]/g, '') // N'GUEMA -> NGUEMA
    .replace(/[^A-Z]+/g, ' ')
    .trim();
}

/** Forme comparable : jetons triés (tolère l'inversion d'ordre des prénoms), sans espaces. */
export function comparableKey(normalized: string): string {
  return normalized.split(' ').filter(Boolean).sort().join('');
}

const VOWELS = /[AEIOUY]/;

/**
 * Clé phonétique d'un jeton, pensée pour des noms camerounais d'origine française, anglaise et locale.
 * Proposition à calibrer pendant le pilote (onglet 3.3) : elle sert à retrouver des candidats ; le score
 * final repose sur la similarité des chaînes, pas sur cette seule clé.
 */
export function phoneticToken(token: string): string {
  let s = token;
  const rules: Array<[RegExp, string]> = [
    [/^(?:KN|GN)(?=[A-Z])/, 'N'],
    [/TCH|TSCH|CH|SH/g, 'S'],
    [/PH/g, 'F'],
    [/TH/g, 'T'],
    [/CK|CQ|Q/g, 'K'],
    [/C(?=[EIY])/g, 'S'],
    [/C/g, 'K'],
    [/G(?=[EIY])/g, 'J'],
    [/GU/g, 'G'],
    [/GN/g, 'N'],
    [/X/g, 'KS'],
    [/W/g, 'V'],
    [/EAU|AU/g, 'O'],
    [/OU/g, 'U'],
    [/OI/g, 'UA'],
    [/(?:AI|EI|AY|EY)/g, 'E'],
    [/H/g, ''],
  ];
  for (const [re, to] of rules) s = s.replace(re, to);
  // préfixe nasal devant consonne occlusive : MBARGA ~ BARGA, NDONGO ~ DONGO, NKOU ~ KOU
  s = s.replace(/^[MN](?=[BDGKPTJ])/, '');
  // fin muette (français) sur les jetons assez longs
  if (s.length > 3) s = s.replace(/[STDX]$/, '');
  // squelette consonantique + voyelle initiale, lettres doublées réduites
  const head = s[0] ?? '';
  const rest = s.slice(1).replace(/[AEIOUY]/g, '');
  s = (VOWELS.test(head) ? 'A' : head) + rest;
  return s.replace(/(.)\1+/g, '$1');
}

export function phoneticKey(normalized: string): string {
  return normalized
    .split(' ')
    .filter(Boolean)
    .map(phoneticToken)
    .sort()
    .join('');
}
