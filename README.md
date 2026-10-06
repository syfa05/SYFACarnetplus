# SYFACarnetplus

Le projet vise à créer une plateforme nationale qui conserve l'historique médical de chaque patient et le rend accessible, de façon sécurisée, dans tout établissement de santé du Cameroun.

## Organisation

- `docs/` — dossier de spécification (archives Word) et `DECISIONS.md`
- `services/gateway` — passerelle API (Node.js/TypeScript, Fastify) ; `sync`, `sms`, `audit` réservés
- `apps/` — `android-pro`, `patient`, `web` (réservés)
- `infra/` — Docker Compose de développement (PostgreSQL ×3, HAPI FHIR, MinIO, Keycloak, Vault, faux SMS)
- `i18n/` — traductions fr/en (aucun texte en dur)

## Démarrage

```
make up      # démarre l'environnement local (copie .env.example vers .env)
make lint    # contrôle i18n + typage
make test    # tests automatisés
```

Mode `central` / `local` : variable `SYFA_MODE`. Données fictives uniquement.

## Avancement des lots

- **L0 — Socle** : fait (textes en dur interdits par `make lint` ; images signées avec cosign en CI, vérifiables par `make verify-image`). 
- **L1 — Identité et doublons** : fait (domaine + SQL + tests ; routes exposées au lot L3). Prochain : L2 (authentification).
