# The console, built from the monorepo root for one environment and served by server/static.mjs.
FROM node:22-bookworm@sha256:63538dfe497cc29dfafdda25ada09b46db68a3f4cc205abf1f5d6bf0913f3384 AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/design-tokens/package.json ./packages/design-tokens/package.json
COPY packages/api-contract/package.json ./packages/api-contract/package.json
COPY packages/extension-sdk/package.json ./packages/extension-sdk/package.json
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY extensions/hello-webhook/package.json ./extensions/hello-webhook/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY packages/design-tokens ./packages/design-tokens
COPY packages/api-contract ./packages/api-contract
COPY packages/extension-sdk ./packages/extension-sdk
COPY apps/web ./apps/web
ARG VITE_CORE_API_URL
ARG VITE_KEYCLOAK_URL
ARG VITE_OIDC_CLIENT_ID=console
ARG VITE_MATRIX_DOMAIN
ARG VITE_TENANT_DOMAIN
ARG VITE_FIRST_OWNER_JOURNEY=0
ENV VITE_AUTH_MODE=oidc     VITE_ENABLE_MSW=0     VITE_CORE_API_URL=${VITE_CORE_API_URL}     VITE_KEYCLOAK_URL=${VITE_KEYCLOAK_URL}     VITE_OIDC_CLIENT_ID=${VITE_OIDC_CLIENT_ID}     VITE_MATRIX_DOMAIN=${VITE_MATRIX_DOMAIN}     VITE_TENANT_DOMAIN=${VITE_TENANT_DOMAIN}     VITE_FIRST_OWNER_JOURNEY=${VITE_FIRST_OWNER_JOURNEY}
RUN test -n "$VITE_CORE_API_URL" && test -n "$VITE_KEYCLOAK_URL" && test -n "$VITE_MATRIX_DOMAIN"  && npm run build  && profile=production && if [ "$VITE_FIRST_OWNER_JOURNEY" = 1 ]; then profile=staging; fi  && (cd apps/web && bash scripts/check-production-bundle.sh --profile "$profile" --scan-only dist)

FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
ARG REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/kodera-hq/kodera"       org.opencontainers.image.revision="${REVISION}"
COPY --from=build /src/apps/web/dist /srv/console
COPY apps/web/server/static.mjs /app/static.mjs
USER node
EXPOSE 8080
ENTRYPOINT ["node", "/app/static.mjs", "--root", "/srv/console", "--host", "0.0.0.0"]
