# Décisions techniques (onglet 4.8)

| Choix | Décision | Date |
|---|---|---|
| Passerelle API | Node.js / TypeScript (Fastify) | 2026-10-06 |
| Orchestration pilote | Docker Compose | 2026-10-06 |
| Application patient | Multiplateforme (framework à fixer au lot L14) | 2026-10-06 |
| Gestion de flotte | À confirmer | — |
| Algorithme phonétique | Clé maison (consonnes, adaptée français/anglais/préfixes nasaux MB/ND/NK) pour retrouver les candidats ; score final = Jaro-Winkler + date + sexe + nom de la mère. **Proposition L1, à valider et calibrer au pilote** | 2026-10-06 |

## Garde-fous L0
- Textes en dur : `scripts/check-hardcoded-strings.mjs` (JSX/TSX, Kotlin, XML Android), exception `i18n-ignore` justifiée.
- Images : construites et poussées sur GHCR par la CI sur `push`, signées par cosign keyless (identité du workflow), avec provenance et SBOM. Vérification : `make verify-image`.

## Lot L1 — identité et doublons
- Livré comme couche domaine (`services/gateway/src/identity`) + migration SQL (`migrations/001_identity.sql`). **Aucune route HTTP** n'est exposée : l'autorisation par la matrice (onglet 2) est le lot L3, et publier des routes d'identité avant elle contournerait le principe 1.
- Chiffrement des colonnes sensibles (onglet 4.2) : AES-256-GCM applicatif (`crypto.ts`), AAD = table/ligne/colonne, index aveugles HMAC pour les recherches (clés phonétiques, date de naissance, identifiants, téléphone). Clé maître `IDENTITY_MASTER_KEY` (Vault en production). La rotation des clés (préfixe de version `v1`) reste à outiller.
- Journal : table `identity_event` en ajout seul (source du journal chaîné du lot L11).
- Réaffectation FHIR lors d'une fusion : port `FhirReferenceReassigner` (implémentation au lot L6).
- Mesure sur 10 000 identités synthétiques (seuils 0,90 / 0,75) : faux positifs « probables » 0,10 %, « possibles » 1,4 % ; rappel des doublons mal saisis 99,9 %. Jeu synthétique : à refaire sur données pilote.
- Hors périmètre L1 : montée automatique du niveau d'identité à l'ajout d'un CSU/CNI (la vérification CSU relève de L15) ; décès et suppression après conservation.

### Corrections de la revue L1
`001_identity.sql` a été modifiée en place (aucune donnée existante : le pilote n'a pas démarré). Règles tranchées, à valider :
- **Fusion et décès** : les deux dossiers sont décédés, ou aucun ; sinon refus (`fusion_decede_incompatible`). Le report d'un décès sur un dossier vivant relève de la procédure de déclaration (médecin habilité).
- **Lien parent-enfant entre les deux dossiers** : fusion refusée (`fusion_lien_representation_entre_dossiers`).
- **FHIR** : fusion en deux temps ; échec → base restaurée, ou état `a_reconcilier` persistant + `reconcileFhir` / `pendingFhirSyncs`. Contrat du port : `reassign` atomique et idempotent, `restore` idempotent.
- Réglages du score (coefficients, paliers de date) : variables `ID_*` ; clé phonétique de moins de 2 caractères non discriminante.
- Tests exécutables sur PGlite (défaut) ou PostgreSQL réel (`TEST_DATABASE_URL`, utilisé par la CI) ; les cas de concurrence ne tournent que sur PostgreSQL réel.
- Reportés : 2.1 et 2.2 au lot L3 (moteur d'autorisation) / L5 (champs renvoyés, limitation de débit) ; 1.3 (rapprochement manuel des enregistrements en attente) au lot L10.
