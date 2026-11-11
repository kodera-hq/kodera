/** Node HTTP adapter. Mount on one provider-specific route behind TLS. */
export function createNodeHandler(tracker) {
  return async (request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    if (request.method !== 'POST') return reply(405, { error: 'method-not-allowed' });
    if (request.headers['content-encoding'] || !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
      return reply(415, { error: 'unsupported-content' });
    }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 1_048_576) return reply(413, { error: 'body-too-large' });
        chunks.push(bytes);
      }
      const result = await tracker.receive({ headers: request.headers, rawBody: Buffer.concat(chunks) });
      reply(result.status === 'duplicate' ? 200 : 202, result);
    } catch (error) {
      const invalid = ['INVALID_BODY', 'INVALID_EVENT', 'INVALID_DELIVERY', 'REPOSITORY_NOT_ALLOWED'];
      const status = error?.code === 'INVALID_SIGNATURE' ? 401 : invalid.includes(error?.code) ? 400 : 503;
      // Never reflect provider data, storage diagnostics, raw body or credential details.
      reply(status, { error: status === 503 ? 'temporarily-unavailable' : 'request-rejected' });
    }
  };
}
