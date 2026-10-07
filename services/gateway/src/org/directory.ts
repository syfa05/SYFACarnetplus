import { describeFailure } from '../identity/errors.js';

/** Fournisseur d'identité (Keycloak) : création et activation des comptes. Le nom du personnel n'est jamais copié dans la passerelle. */
export interface DirectoryPort {
  /** Crée le compte DÉSACTIVÉ avec un mot de passe temporaire (à changer, TOTP à configurer) ; retourne son identifiant (`sub`). */
  createUser(u: { username: string; email?: string; phone: string; temporaryPassword: string }): Promise<{ sub: string }>;
  setEnabled(sub: string, enabled: boolean): Promise<void>;
  /** Supprime un compte créé par erreur (compensation d'une création locale échouée). */
  deleteUser(sub: string): Promise<void>;
  /** Met fin aux sessions ouvertes du compte chez le fournisseur d'identité (désactivation). */
  logout(sub: string): Promise<void>;
  /** Nouveau mot de passe temporaire (à changer à la première connexion). */
  setTemporaryPassword(sub: string, password: string): Promise<void>;
}

export class DirectoryError extends Error {
  constructor(public readonly code: 'conflict' | 'unavailable', cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause: new Error(describeFailure(cause)) });
  }
}

/**
 * Adaptateur Keycloak (API d'administration). NON VÉRIFIÉ contre un vrai Keycloak : testé seulement contre un
 * serveur HTTP simulé (voir infra/keycloak/README.md). Exige un client « compte de service » avec le rôle
 * `manage-users` du client `realm-management` — à créer dans la console ; il n'est pas dans le realm importé.
 */
export class KeycloakDirectory implements DirectoryPort {
  private token?: { value: string; expiresAt: number };
  private pending?: Promise<string>;
  constructor(
    private readonly baseUrl: string, private readonly realm: string,
    private readonly clientId: string, private readonly clientSecret: string,
    private readonly timeoutMs = 5000, private readonly now: () => number = Date.now,
  ) {}

  /** Un seul rafraîchissement du jeton à la fois, même sous requêtes concurrentes. */
  private accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now() + 10_000) return Promise.resolve(this.token.value);
    this.pending ??= this.fetchToken().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async fetchToken(): Promise<string> {
    const res = await this.call(`${this.baseUrl}/realms/${this.realm}/protocol/openid-connect/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.clientId, client_secret: this.clientSecret }),
    });
    const j = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
    if (!res.ok || typeof j?.access_token !== 'string') throw new DirectoryError('unavailable', Object.assign(new Error('token'), { code: `HTTP_${res.status}` }));
    this.token = { value: j.access_token, expiresAt: this.now() + (typeof j.expires_in === 'number' ? j.expires_in : 60) * 1000 };
    return j.access_token;
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    try {
      // Pas de redirection suivie : le serveur d'identité est une adresse fixe de la configuration.
      return await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new DirectoryError('unavailable', e);
    }
  }

  /** Appel d'administration ; un 401 invalide le jeton en cache et rejoue UNE fois avec un jeton neuf. */
  private async admin(path: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      const res = await this.call(`${this.baseUrl}/admin/realms/${this.realm}${path}`, {
        ...init, headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      });
      if (res.status !== 401 || attempt > 0) return res;
      this.token = undefined;
    }
  }

  async createUser(u: { username: string; email?: string; phone: string; temporaryPassword: string }): Promise<{ sub: string }> {
    const res = await this.admin('/users', {
      method: 'POST',
      body: JSON.stringify({
        username: u.username, ...(u.email && { email: u.email }), enabled: false,
        attributes: { phone_number: [u.phone] }, requiredActions: ['CONFIGURE_TOTP'],
        credentials: [{ type: 'password', value: u.temporaryPassword, temporary: true }],
      }),
    });
    if (res.status === 409) throw new DirectoryError('conflict');
    const location = res.headers.get('location');
    const sub = location?.split('/').pop();
    if (res.status !== 201 || !sub || !/^[\w-]{8,64}$/.test(sub)) throw new DirectoryError('unavailable', Object.assign(new Error('create'), { code: `HTTP_${res.status}` }));
    return { sub };
  }

  private userPath(sub: string): string {
    if (!/^[\w-]{8,64}$/.test(sub)) throw new DirectoryError('unavailable'); // identifiant inattendu : jamais dans un chemin
    return `/users/${encodeURIComponent(sub)}`;
  }

  private async expect(res: Response, ok: number[], what: string): Promise<void> {
    if (!ok.includes(res.status)) throw new DirectoryError('unavailable', Object.assign(new Error(what), { code: `HTTP_${res.status}` }));
  }

  /**
   * Lit puis réécrit la représentation complète : une mise à jour partielle pourrait effacer des attributs du profil
   * (dont `phone_number`, qui reçoit l'alerte « nouvel appareil »). Comportement du serveur à confirmer.
   */
  async setEnabled(sub: string, enabled: boolean): Promise<void> {
    const path = this.userPath(sub);
    const got = await this.admin(path, { method: 'GET' });
    const rep = (await got.json().catch(() => null)) as Record<string, unknown> | null;
    if (got.status !== 200 || !rep || typeof rep !== 'object') throw new DirectoryError('unavailable', Object.assign(new Error('read'), { code: `HTTP_${got.status}` }));
    await this.expect(await this.admin(path, { method: 'PUT', body: JSON.stringify({ ...rep, enabled }) }), [204], 'update');
  }

  async deleteUser(sub: string): Promise<void> {
    await this.expect(await this.admin(this.userPath(sub), { method: 'DELETE' }), [204, 404], 'delete');
  }

  async logout(sub: string): Promise<void> {
    await this.expect(await this.admin(`${this.userPath(sub)}/logout`, { method: 'POST' }), [204], 'logout');
  }

  async setTemporaryPassword(sub: string, password: string): Promise<void> {
    await this.expect(await this.admin(`${this.userPath(sub)}/reset-password`, { method: 'PUT', body: JSON.stringify({ type: 'password', value: password, temporary: true }) }), [204], 'reset');
  }
}
