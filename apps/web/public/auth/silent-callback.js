// The silent renewal's landing page (`silent_redirect_uri`, `src/auth/oidc.ts`). The identity
// provider answers a renewal attempted in a hidden frame here, and this page has one thing to do:
// hand the answer's address to the console that opened the frame, which owns the code exchange.
// It boots nothing else, so a renewal never loads the console a second time inside the frame.
//
// The message is the one `oidc-client-ts` listens for from its frame: `source` names the library,
// `url` carries the response, and the target origin is this page's own, so no other origin can
// read it. An external file, not an inline script, so `script-src 'self'` allows it as it stands.
;(() => {
  if (window.parent === window) return
  window.parent.postMessage(
    { source: 'oidc-client', url: window.location.href, keepOpen: false },
    window.location.origin
  )
})()
