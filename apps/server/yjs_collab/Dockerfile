FROM node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
WORKDIR /app
COPY package.json package-lock.json licenses.mjs ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && node licenses.mjs && npm cache clean --force
COPY *.mjs ./
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=128
USER node
EXPOSE 8098
CMD ["node", "server.mjs"]
