COMPOSE = docker compose --env-file .env -f infra/docker-compose.yml

.PHONY: up down test lint i18n verify-image
.env:
	cp .env.example .env

up: .env
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

lint: i18n
	node scripts/check-hardcoded-strings.mjs
	cd services/gateway && npm run lint

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
