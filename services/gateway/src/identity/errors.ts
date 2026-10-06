/** Erreurs métier : `code` stable (jamais de texte affiché, principe 8 — la traduction est faite par le client). */
export class IdentityError extends Error {
  constructor(
    public readonly code: string,
    public readonly details: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(code, cause === undefined ? undefined : { cause });
  }
}
