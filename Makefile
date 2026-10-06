COMPOSE = docker compose --env-file .env -f infra/docker-compose.yml

.PHONY: up down reset-db test lint i18n verify-image
.env:
	cp .env.example .env

up: .env
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

lint: i18n
	node scripts/check-hardcoded-strings.mjs
	cd services/gateway && npm run lint

# Supprime les volumes de développement (bases identité, FHIR, Keycloak, MinIO) : à faire après toute
# modification d'une migration déjà appliquée en local. Données fictives uniquement.
reset-db: .env
	$(COMPOSE) down -v

test:
	node --test scripts/test/*.test.mjs
	cd services/gateway && npm test

i18n:
	node scripts/check-i18n.mjs

# Vérifie la signature d'une image : make verify-image IMAGE=ghcr.io/<org>/syfa-gateway@sha256:<digest> REPO=<org>/<repo>
verify-image:
	cosign verify $(IMAGE) \
	  --certificate-identity-regexp "^https://github.com/$(REPO)/\.github/workflows/ci\.yml@.*" \
	  --certificate-oidc-issuer https://token.actions.githubusercontent.com
