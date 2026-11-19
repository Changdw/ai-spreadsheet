import { api, token } from './api';
import { detectLanguage, isLanguage, type Language } from '../language';

/** Keep a fast per-origin cache and a preference that survives local server port changes. */
export function installLanguageSetting(
  display: (locale: Language) => void,
  failed: (error: unknown) => void,
) {
  const select = document.getElementById('language') as HTMLSelectElement;
  const dialog = document.getElementById('dialog') as HTMLDialogElement;
  const key = 'aib-language';
  let generation = 0;
  let writes = Promise.resolve();
  let deferred: Language | undefined;

  function apply(value: unknown) {
    const locale = isLanguage(value) ? value : detectLanguage(navigator.languages);
    // Let a dialog keep its fields and validation language until the user finishes it.
    if (dialog.open) {
      deferred = locale;
      return;
    }
    select.value = locale;
    display(locale);
  }
  dialog.addEventListener('close', () => {
    if (deferred) {
      const next = deferred;
      deferred = undefined;
      apply(next);
    }
  });
  apply(localStorage.getItem(key));
  window.addEventListener('storage', (event) => {
    if (event.key !== key) return;
    generation++;
    apply(event.newValue);
  });
  select.onchange = () => {
    const locale = select.value;
    if (!isLanguage(locale)) return;
    generation++;
    apply(locale);
    localStorage.setItem(key, locale);
    if (token) writes = writes.then(() => api('/api/language', { language: locale })).catch(failed);
  };
  if (token)
    void api('/api/language')
      .then((saved) => {
        if (generation || !isLanguage(saved)) return;
        localStorage.setItem(key, saved);
        apply(saved);
      })
      .catch(() => {
        /* Use the cached preference while the service is unavailable. */
      });
}
