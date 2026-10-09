import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeFailure } from '../identity/errors.js';

/** Envoi de SMS (passerelle complète avec bascule entre prestataires : lot L11). */
export interface SmsSender {
  send(to: string, text: string): Promise<void>;
}

/** Prestataire HTTP (le faux prestataire de développement, puis la passerelle SMS du lot L11). */
export class HttpSmsSender implements SmsSender {
  constructor(private readonly url: string, private readonly timeoutMs = 5000) {}
  async send(to: string, text: string): Promise<void> {
    const res = await fetch(`${this.url}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to, text }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw Object.assign(new Error('sms'), { code: `HTTP_${res.status}` });
  }
}

/** Textes (fr/en) lus dans i18n/*.json : aucun texte en dur (principe 8). */
export class Translator {
  private readonly dicts: Record<string, Record<string, string>> = {};
  constructor(dir: string) {
    for (const lang of ['fr', 'en']) this.dicts[lang] = JSON.parse(readFileSync(join(dir, `${lang}.json`), 'utf8'));
  }
  /** Dictionnaire complet d'une langue (gabarits bilingues des cartes). */
  dict(lang: 'fr' | 'en'): Record<string, string> {
    return this.dicts[lang]!;
  }
  t(lang: string, key: string, vars: Record<string, string | number> = {}): string {
    const raw = this.dicts[lang]?.[key] ?? this.dicts.fr?.[key];
    if (raw === undefined) throw new Error(`clé i18n absente : ${key}`);
    return raw.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
  }
}

export { describeFailure };
