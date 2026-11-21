  'use strict';
  if (!window.koderaDesktop || !((location.protocol === 'kodera-asset:' && location.hostname === 'localhost') ||
      (location.protocol === 'https:' && location.hostname === 'kodera-asset.localhost'))) return;
  let host, button, busy = false;
  const french = () => document.documentElement.lang.toLowerCase().startsWith('fr');
  function copy() { return messages[french() ? 'fr' : 'en']; }
  async function check() {
    if (busy) return;
    try {
      const update = await window.koderaDesktop.invoke('check_app_updates', {});
      // Only the native verified-and-staged state authorizes a restart affordance.
      if (update?.supported !== true || update?.updateReady !== true || update?.verified !== true) {
        if (host) { host.remove(); host = null; }
        return;
      }
      if (host) return;
      host = document.createElement('aside');
      host.setAttribute('aria-label', copy().region);
      const shadow = host.attachShadow({ mode: 'closed' });
      const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/__desktop-update.css';
      button = document.createElement('button'); button.type = 'button'; button.textContent = copy().ready;
      button.addEventListener('click', async () => {
        if (busy) return;
        busy = true; button.disabled = true;
        button.textContent = copy().restarting;
        try { await window.koderaDesktop.invoke('restart_to_update', {}); }
        catch (_) {
          busy = false; button.disabled = false;
          button.textContent = copy().unavailable;
          button.setAttribute('aria-live', 'polite');
          setTimeout(() => { if (host) { host.remove(); host = null; } }, 5000);
        }
      });
      shadow.append(css, button); document.body.append(host);
    } catch (_) { /* A refused update never interrupts the workspace. */ }
  }
  function start() { void check(); setInterval(check, 10000); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
