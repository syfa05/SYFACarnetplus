# Décisions techniques (onglet 4.8)

| Choix | Décision | Date |
|---|---|---|
| Passerelle API | Node.js / TypeScript (Fastify) | 2026-10-06 |
| Orchestration pilote | Docker Compose | 2026-10-06 |
| Application patient | Multiplateforme (framework à fixer au lot L14) | 2026-10-06 |
| Gestion de flotte | À confirmer | — |
| Algorithme phonétique | À confirmer (lot L1) | — |

## Garde-fous L0
- Textes en dur : `scripts/check-hardcoded-strings.mjs` (JSX/TSX, Kotlin, XML Android), exception `i18n-ignore` justifiée.
- Images : construites et poussées sur GHCR par la CI sur `push`, signées par cosign keyless (identité du workflow), avec provenance et SBOM. Vérification : `make verify-image`.
