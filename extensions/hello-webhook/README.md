# `@kodera/ext-hello-webhook` — `< 15 min` Extension Starter Template

Status: Reference implementation (`Apache-2.0`)

Reference **Ring 2** Kodera slash-command & signed-webhook extension built on [`@kodera/extension-sdk`](../../packages/extension-sdk) with **zero runtime dependencies** and **zero server/database secrets**.

## Build Your Own Extension in 4 Steps (`< 15 minutes`)

1. **Copy this starter folder:**
   ```bash
   cp -R extensions/hello-webhook extensions/github-webhook
   ```
2. **Rename your workspace package in `extensions/github-webhook/package.json`:**
   Set `"name": "@kodera/ext-github-webhook"` while keeping `"@kodera/extension-sdk": "0.1.0"`. Because root `package.json` automatically discovers `"extensions/*"`, **you do not need to edit root `package.json`** (preventing merge conflicts across parallel contributors).
3. **Implement your command & signed handler in `src/index.mjs`:**
   - Declare least-privilege scopes (`ALLOWED_EXTENSION_SCOPES`, e.g. `['messages:write']`) via `defineSlashCommand(...)`.
   - Verify every inbound HTTP request via `verifyWebhookRequest(...)` using `SIGNATURE_HEADER`, `TIMESTAMP_HEADER`, and `getHeaderValue(...)` (handles both Node `IncomingHttpHeaders` and Web Fetch `Headers`, plus `string | Uint8Array` raw bodies).
   - Add tamper, replay, and invalid-JSON tests in `test/*.test.mjs`.
4. **Verify locally and open your PR:**
   ```bash
   npm run test:sdk
   python3 .github/scripts/check-vendor-attribution.py .
   ```
