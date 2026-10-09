# Lot L4 — guide de revue

Périmètre : cycle de vie des cartes santé (onglet 3.2, parcours P6 et P9, chapitres 7 et 11.5, onglet 5 pour les réserves et la liste des révoquées). Décisions et points à arbitrer : `docs/DECISIONS.md`, section « Lot L4 ».

## 1. Lire dans cet ordre
1. `migrations/004_cards.sql` (déclencheurs : transitions, immuabilité, liste des révoquées, réserve d'un appareil perdu ; index unique « une carte active »).
2. `src/cards/codes.ts` (formats, contrôle, empreintes), `service.ts` (cycle de vie), `pdf.ts` (gabarits), `routes.ts`, `config.ts`.
3. Tests : `codes.test.ts`, `lifecycle.test.ts` (F-CARTE-01/02), `print.test.ts`, `reserve.test.ts`, `access.test.ts`.

## 2. Lancer
```
cd services/gateway && npm test                         # PGlite ; le test des 10 millions de tirages prend ~1 min
TEST_DATABASE_URL=postgres://… npm test                  # PostgreSQL réel (CI)
npx vitest run test/cards
```
Voir une carte : le script de rendu de la revue (`scratchpad`) ou `print` via l'API ; les gabarits sont comparables aux trois maquettes du cahier des charges.

## 3. Points d'attention
- Un chemin permet-il à une carte non activée, bloquée ou révoquée d'identifier un patient (`resolve`, activation, réserve, rattachement hors ligne) ?
- Peut-on obtenir un jeton ou un code de secours autrement que par l'impression, la carte numérique de son titulaire ou la remise de réserve à l'appareil ?
- Une transition illégale ou deux cartes actives sont-elles possibles par SQL direct ou par concurrence ?
- La liste des révoquées peut-elle oublier une carte (SQL direct, balayage, appareil perdu, remplacement) ?
- La réserve d'un appareil révoqué reste-t-elle utilisable ? un autre appareil peut-il rattacher ses cartes ?
- Le contenu imprimé dépasse-t-il le cahier des charges (champs, niveau d'identité, coordonnées du représentant) ?
- SMS : lien, nom d'établissement, donnée médicale ?
- Les 8 points « À arbitrer » de DECISIONS sont-ils acceptables ?

## 4. Boucle de validation
Validé quand : (a) aucun problème bloquant ni majeur ; (b) les points à arbitrer sont tranchés ; (c) la CI est verte ; (d) **rendu physique** : une carte imprimée (PVC ou papier plastifié) est lue avec un smartphone d'entrée de gamme et une douchette (tests T-NET/onglet 7 de terrain, par un humain) ; (e) le numéro d'assistance est défini.
