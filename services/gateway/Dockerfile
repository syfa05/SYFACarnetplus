# Contexte de construction : la racine du dépôt (le service lit aussi i18n/).
FROM node:22-alpine AS build
WORKDIR /app
COPY services/gateway/package*.json ./
RUN npm ci
COPY services/gateway/ .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production MIGRATIONS_DIR=/app/migrations I18N_DIR=/app/i18n
COPY services/gateway/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY services/gateway/migrations ./migrations
COPY i18n ./i18n
USER node
CMD ["node", "dist/src/main.js"]
