import { describe, expect, it } from 'vitest';
import { normalizeName } from '../../src/identity/normalize.js';
import type { PatientInput } from '../../src/identity/types.js';
import { afterAll } from 'vitest';
import { cleanup, makeService } from './helpers.js';

afterAll(cleanup);

// Noms fictifs d'inspiration camerounaise (français, anglais, langues locales) — aucune donnée réelle.
const NOMS = ['Mbarga','Ngono','Ndongo','Nkou','Fotso','Kamga','Njoya','Tchamba','Atangana','Essomba','Biya','Onana','Eto\'o','Mvondo','Abena','Owona','Ebanga','Manga','Tagne','Kouam','Talla','Tchoumi','Nana','Feudjio','Simo','Mbah','Fonyuy','Tabi','Ngu','Ayuk','Etta','Bessong','Nsame','Ekani','Ondoa','Zogo','Mebenga','Ateba','Nguema','Mballa','Ouedraogo','Dupont','Martin','Bello','Mohamadou','Hamadou','Abdoulaye','Yaya','Ngassa','Dongmo','Tsafack','Wafo','Kenfack','Pouemi','Nzeukou','Djomo','Youmbi','Sob','Njike','Ewane','Elonge','Lyonga','Ngoh','Mukete','Ngwa','Tanyi','Ako','Bekolo','Mintya','Assomo','Awono','Evina','Fouda','Etoundi','Messi','Ngatchou','Teguia'];
const PRENOMS = ['Jean','Pierre','Marie','Paul','Joseph','Esther','Grace','Alain','Christelle','Brice','Sandrine','Blaise','Nadine','Patrick','Carine','Hervé','Aline','Rodrigue','Florence','Serge','Léopold','Rose','Michel','Estelle','Fabrice','Prisca','Samuel','Ruth','David','Judith','Emmanuel','Mireille','Thierry','Danielle','Alexis','Odette','Valérie','Roger','Chantal','Victor','Yvette','Bertrand','Solange','Eric','Nicole','Francis','Josiane','Ferdinand','Berthe','Gilbert','Clarisse','Raymond','Edith','Moïse','Pauline','Cyrille','Lydie','Anicet','Flore','Désiré'];

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const r = rng(20261006);
const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]!;
const dob = () => {
  const y = 1940 + Math.floor(r() * 85), m = 1 + Math.floor(r() * 12), d = 1 + Math.floor(r() * 28);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};
const person = (): PatientInput => ({
  nom: pick(NOMS), prenoms: r() < 0.3 ? `${pick(PRENOMS)} ${pick(PRENOMS)}` : pick(PRENOMS),
  dateNaissance: dob(), sexe: r() < 0.5 ? 'F' : 'M', lieuNaissance: 'Douala', niveauIdentite: 3, langue: 'fr',
  nomMere: r() < 0.3 ? pick(NOMS) : undefined,
});
const identity = (p: PatientInput) => `${normalizeName(p.nom)}|${normalizeName(p.prenoms)}|${p.dateNaissance}|${p.sexe}`;

/** Perturbations réalistes d'une saisie : accents, casse, trait d'union, faute de frappe. */
const perturb = (p: PatientInput): PatientInput => {
  const out = { ...p };
  const kind = Math.floor(r() * 5);
  if (kind === 0) out.nom = p.nom.toUpperCase();
  if (kind === 1) out.prenoms = p.prenoms.replace(' ', '-').normalize('NFD').replace(/\p{M}/gu, '');
  if (kind === 2) { const i = 1 + Math.floor(r() * (p.nom.length - 1)); out.nom = p.nom.slice(0, i) + p.nom.slice(i + 1); }
  if (kind === 3) { const i = Math.floor(r() * p.prenoms.length); out.prenoms = p.prenoms.slice(0, i) + (p.prenoms[i] ?? '') + p.prenoms.slice(i); }
  if (kind === 4) { const [a, b] = [p.nom, p.prenoms.split(' ')[0]!]; if (!p.prenoms.includes(' ')) { out.nom = b; out.prenoms = a; } }
  return out;
};

describe('10 000 identités synthétiques (taux de faux positifs, L1)', () => {
  it('mesure faux positifs et rappel aux seuils par défaut', async () => {
    const { service, db } = await makeService();
    const seen = new Set<string>();
    const stored: PatientInput[] = [];
    while (stored.length < 10_000) {
      const p = person();
      if (seen.has(identity(p))) continue;
      seen.add(identity(p));
      stored.push(p);
    }
    await db.transaction(async (tx) => {
      for (const p of stored) {
        const row = service.patientRow(p, crypto.randomUUID());
        const cols = Object.keys(row);
        await tx.query(`INSERT INTO patient (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, cols.map((c) => row[c]));
      }
    });

    // Personnes distinctes (absentes de la base) : ne doivent pas être « probables ».
    let fresh = 0, falseProbable = 0, falsePossible = 0;
    while (fresh < 1000) {
      const p = person();
      if (seen.has(identity(p))) continue;
      fresh++;
      const m = await service.findMatches(p);
      if (m.probable.length) falseProbable++;
      else if (m.possible.length) falsePossible++;
    }
    // Vrais doublons saisis différemment : doivent être retrouvés.
    let dups = 0, foundProbable = 0, foundTop1 = 0;
    for (let i = 0; i < 1000; i++) {
      const orig = stored[Math.floor(r() * stored.length)]!;
      const m = await service.findMatches(perturb(orig));
      dups++;
      const all = [...m.probable, ...m.possible];
      if (m.probable.some((x) => x.patient.nom === orig.nom && x.patient.dateNaissance === orig.dateNaissance)) foundProbable++;
      if (all[0] && all[0].patient.dateNaissance === orig.dateNaissance && normalizeName(all[0].patient.nom) === normalizeName(orig.nom)) foundTop1++;
    }
    const fpRate = falseProbable / fresh;
    console.log(`[L1] faux positifs probables: ${(fpRate * 100).toFixed(2)} % ; possibles: ${(falsePossible / fresh * 100).toFixed(2)} % ; rappel probable: ${(foundProbable / dups * 100).toFixed(1)} % ; en tête: ${(foundTop1 / dups * 100).toFixed(1)} %`);
    expect(fpRate).toBeLessThan(0.01);
    expect(foundProbable / dups).toBeGreaterThan(0.85);
  }, 600_000);
});
