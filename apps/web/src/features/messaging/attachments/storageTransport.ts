// The one request the console sends outside Core and the homeserver: an attachment's bytes, to the
// presigned object-storage address Core's upload ticket names (Core API 0.43.0,
// `createAttachmentUpload`). It carries no Kodera credential, the ticket's signature being the
// grant, and the console's policy allows it only under the deployment's `--attachment-base`
// (`server/static.mjs`). ESLint allows `fetch` in this file alone (eslint.config.js).

export const putToStorage: typeof fetch = (input, init) => fetch(input, init)
