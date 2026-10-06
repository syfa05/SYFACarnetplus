COMPOSE = docker compose --env-file .env -f infra/docker-compose.yml

.PHONY: up down test lint i18n
.env:
	cp .env.example .env

up: .env
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

lint: i18n
	cd services/gateway && npm run lint

test:
	cd services/gateway && npm test

i18n:
	node scripts/check-i18n.mjs
