# The console, built from the monorepo root for one environment and served by server/static.mjs.
FROM node:22.23.5-bookworm@sha256:e13726ca604184d7a91fcacab1fc09eefd642dc28e79ac34e85540dd93b78cfb AS build
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
ARG VITE_POSTHOG_KEY=
ARG VITE_POSTHOG_HOST=https://eu.i.posthog.com
ENV VITE_POSTHOG_KEY=${VITE_POSTHOG_KEY} VITE_POSTHOG_HOST=${VITE_POSTHOG_HOST}
ENV VITE_AUTH_MODE=oidc     VITE_ENABLE_MSW=0     VITE_CORE_API_URL=${VITE_CORE_API_URL}     VITE_KEYCLOAK_URL=${VITE_KEYCLOAK_URL}     VITE_OIDC_CLIENT_ID=${VITE_OIDC_CLIENT_ID}     VITE_MATRIX_DOMAIN=${VITE_MATRIX_DOMAIN}     VITE_TENANT_DOMAIN=${VITE_TENANT_DOMAIN}     VITE_FIRST_OWNER_JOURNEY=${VITE_FIRST_OWNER_JOURNEY}
RUN test -n "$VITE_CORE_API_URL" && test -n "$VITE_KEYCLOAK_URL" && test -n "$VITE_MATRIX_DOMAIN"  && npm run build  && profile=production && if [ "$VITE_FIRST_OWNER_JOURNEY" = 1 ]; then profile=staging; fi  && telemetry=0 && if [ -n "$VITE_POSTHOG_KEY" ]; then telemetry=1; fi && (cd apps/web && bash scripts/check-production-bundle.sh --profile "$profile" --telemetry "$telemetry" --scan-only dist)

FROM node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
ARG REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/kodera-hq/kodera"       org.opencontainers.image.revision="${REVISION}"
COPY --from=build /src/apps/web/dist /srv/console
COPY apps/web/server/static.mjs /app/static.mjs
USER node
EXPOSE 8080
ENTRYPOINT ["node", "/app/static.mjs", "--root", "/srv/console", "--host", "0.0.0.0"]
