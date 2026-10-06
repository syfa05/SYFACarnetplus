/**
 * Résumé non sensible d'une erreur externe : classe et code seulement, jamais le message (il peut citer des
 * données de santé ou d'identité). Les valeurs hors d'un format strict sont ignorées.
 */
export function describeFailure(e: unknown): string {
  const raw = e instanceof Error ? e.name : '';
  const name = /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(raw) ? raw : 'Error';
  const c = (e as { code?: unknown } | null)?.code;
  const code = typeof c === 'number' && Number.isInteger(c) && c >= 0 && c < 100_000 ? String(c)
    : typeof c === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(c) ? c : null;
  return code ? `${name}:${code}` : name;
}

/** Erreurs métier : `code` stable (jamais de texte affiché, principe 8 — la traduction est faite par le client). */
export class IdentityError extends Error {
  constructor(
    public readonly code: string,
    public readonly details: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    // La cause d'origine n'est jamais conservée : son message pourrait être affiché ou journalisé (principe 2).
    super(code, cause === undefined ? undefined : { cause: new Error(describeFailure(cause)) });
  }
}
