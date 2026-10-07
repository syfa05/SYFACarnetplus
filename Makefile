COMPOSE = docker compose --env-file .env -f infra/docker-compose.yml

.PHONY: up up-full down reset-db test lint i18n verify-image
.env:
	cp .env.example .env
	@# Secrets de DÉVELOPPEMENT uniquement, générés localement (jamais commités).
	sed -i "s|^IDENTITY_MASTER_KEY=.*|IDENTITY_MASTER_KEY=$$(openssl rand -base64 32)|" .env
	sed -i "s|^AUTH_SECRET_KEY=.*|AUTH_SECRET_KEY=$$(openssl rand -base64 32)|" .env
	sed -i "s|^PATIENT_JWT_PRIVATE_KEY_B64=.*|PATIENT_JWT_PRIVATE_KEY_B64=$$(openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 | base64 | tr -d '\n')|" .env

up: .env
	$(COMPOSE) up -d --build

# + serveur FHIR, stockage objet, coffre de clés (non nécessaires à l'authentification)
up-full: .env
	$(COMPOSE) --profile full up -d --build

down:
	$(COMPOSE) --profile full down

lint: i18n
	node scripts/check-hardcoded-strings.mjs
	cd services/gateway && npm run lint

# Supprime les volumes de développement (bases identité, FHIR, Keycloak, MinIO) : à faire après toute
# modification d'une migration déjà appliquée en local. Données fictives uniquement.
reset-db: .env
	$(COMPOSE) --profile full down -v

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
