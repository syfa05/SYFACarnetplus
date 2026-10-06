// Principe 8 : aucun texte en dur dans les interfaces. Les textes visibles passent par i18n/*.json.
// Contrôle : JSX/TSX (texte entre balises, attributs visibles), Kotlin (Text("…"), setText…), XML Android.
// Exception ponctuelle : commentaire `i18n-ignore` sur la même ligne ou la ligne précédente.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP = new Set(['node_modules', 'dist', 'build', '.git', 'fixtures']);
const LETTER = /\p{L}/u;
const VISIBLE_ATTR = '(?:title|placeholder|alt|label|aria-label|aria-description|helperText|tooltip)';

const RULES = {
  '.tsx': [
    { re: />\s*([^<>{}\n]*\p{L}[^<>{}\n]*?)\s*</gu, msg: 'texte JSX en dur' },
    { re: new RegExp(`\\b${VISIBLE_ATTR}\\s*=\\s*"([^"]*\\p{L}[^"]*)"`, 'gu'), msg: 'attribut visible en dur' },
  ],
  '.kt': [
    { re: /\b(?:Text|setText|setTitle|setMessage|Toast\.makeText)\s*\(\s*(?:[\w.]+\s*,\s*)?"([^"$]*\p{L}[^"]*)"/gu, msg: 'texte Kotlin en dur' },
    { re: /\b(?:text|title|label|contentDescription|placeholder)\s*=\s*"([^"$]*\p{L}[^"]*)"/gu, msg: 'texte Kotlin en dur' },
  ],
  '.xml': [
    { re: /android:(?:text|hint|contentDescription|title)\s*=\s*"(?!@string\/|@\{)([^"]*\p{L}[^"]*)"/gu, msg: 'texte XML en dur (utiliser @string/…)' },
  ],
};

export function scanSource(path, source) {
  const rules = RULES[extname(path)];
  if (!rules) return [];
  // XML : les ressources de chaînes sont l'endroit légitime des textes.
  if (path.endsWith('strings.xml')) return [];
  const lines = source.split('\n');
  const found = [];
  for (const { re, msg } of rules) {
    for (const m of source.matchAll(re)) {
      const line = source.slice(0, m.index).split('\n').length;
      const here = lines[line - 1] ?? '';
      const prev = lines[line - 2] ?? '';
      if (here.includes('i18n-ignore') || prev.includes('i18n-ignore')) continue;
      if (!LETTER.test(m[1] ?? '')) continue;
      found.push({ path, line, msg, text: (m[1] ?? '').trim() });
    }
  }
  return found;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = [];
  for (const top of ['apps', 'services']) {
    let dir;
    try { dir = join(ROOT, top); statSync(dir); } catch { continue; }
    for (const f of walk(dir)) problems.push(...scanSource(f, readFileSync(f, 'utf8')));
  }
  if (problems.length) {
    for (const p of problems) console.error(`${relative(ROOT, p.path)}:${p.line}  ${p.msg} : « ${p.text} »`);
    console.error(`\n${problems.length} texte(s) en dur. Utiliser les clés de i18n/*.json (ou i18n-ignore, avec justification).`);
    process.exit(1);
  }
  console.log('Aucun texte en dur détecté.');
}
