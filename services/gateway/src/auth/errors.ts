/** Erreur d'authentification : code stable (jamais de texte affiché) et statut HTTP. */
export class AuthError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}
