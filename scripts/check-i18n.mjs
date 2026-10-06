// Principe 8 : fr/en doivent avoir exactement les mêmes clés, sans valeur vide.
import { readFileSync } from 'node:fs';

const load = (l) => JSON.parse(readFileSync(new URL(`../i18n/${l}.json`, import.meta.url), 'utf8'));
const fr = load('fr');
const en = load('en');
const problems = [];
for (const k of Object.keys(fr)) if (!(k in en)) problems.push(`clé absente en en.json : ${k}`);
for (const k of Object.keys(en)) if (!(k in fr)) problems.push(`clé absente en fr.json : ${k}`);
for (const [l, d] of [['fr', fr], ['en', en]])
  for (const [k, v] of Object.entries(d)) if (!String(v).trim()) problems.push(`${l}.json : valeur vide pour ${k}`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`i18n OK (${Object.keys(fr).length} clés)`);
