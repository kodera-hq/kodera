FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
WORKDIR /app
COPY package.json package-lock.json licenses.mjs ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && node licenses.mjs && npm cache clean --force
COPY *.mjs ./
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=128
USER node
EXPOSE 8098
CMD ["node", "server.mjs"]
