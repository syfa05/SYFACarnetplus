# Lot L3 — guide de revue

Périmètre : moteur d'autorisation (onglet 2), établissements, personnel, rôles, désactivation immédiate, contrôle de niveau supérieur, listes de réseaux par établissement. Décisions et **points à arbitrer** : `docs/DECISIONS.md`, section « Lot L3 ».

## 1. Lire dans cet ordre
1. `src/authz/types.ts`, `matrix.ts` (la matrice 2.2 en données), `engine.ts` (C1 à C9, refus par défaut), `admin.ts` (matrice 2.3, portée, niveau supérieur).
2. `migrations/003_org.sql` (contraintes : pas d'auto-contrôle, ajout seul).
3. `src/org/service.ts`, `repository.ts`, `directory.ts`, `routes.ts`, `bootstrap.ts`.
4. `src/auth/hook.ts` (fiche du personnel, compte désactivé), `network-guard.ts` (réseaux par établissement), `src/authz/guard.ts`.

## 2. Lancer
```
cd services/gateway && npm test                               # PGlite
TEST_DATABASE_URL=postgres://… npm test                       # PostgreSQL réel (CI)
npx vitest run test/authz test/org                            # le lot seul
```

## 3. Ce que les tests prouvent (et ne prouvent pas)
- `authz/matrix.test.ts` compare le moteur à une **copie du tableau du document** (texte « C, Cr, M* »), pas à `matrix.ts`. Modifier une cellule de `matrix.ts` fait échouer le test (vérifié par mutation).
- `org/*` : mutations vérifiées — retirer le contrôle « compte désactivé » du jeton, l'indicateur de contrôle, la liste de réseaux de l'établissement, ou la journalisation des refus fait échouer des tests.
- **Ne prouvent pas** : le comportement d'un vrai Keycloak (adaptateur testé contre un serveur simulé) ; l'usage par de vrais services de données (inexistants).

## 4. Prompt de revue (§10.4) — points d'attention propres au lot
- Un chemin permet-il d'obtenir un droit **sans** passer par la base (jeton, en-tête, corps de requête) ?
- Un champ **absent** de la requête au moteur peut-il ouvrir un droit ? (masquage, confidentialité, validation)
- Une désactivation laisse-t-elle un chemin valide (jeton, session, appareil, cache) ?
- L'ordre création distante / locale laisse-t-il un compte utilisable sans fiche, ou une fiche sans contrôle ?
- Peut-on se contrôler soi-même ou contrôler son pair (cumul de rôles, district, opérateur et chef de district) ?
- Les 11 interprétations du tableau (DECISIONS) sont-elles acceptables ?

## 5. Boucle de validation
Le lot est validé quand : (a) aucun problème bloquant ou majeur ; (b) les interprétations de DECISIONS sont arbitrées ; (c) la CI est verte ; (d) l'adaptateur d'annuaire a été essayé contre un Keycloak réel (création d'un compte, activation, désactivation, `phone_number` conservé) ; (e) la vérification du step-up du lot L2 est faite (`infra/keycloak/README.md` §4) — le lot L3 repose sur le même réalm.
