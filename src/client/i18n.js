/** Web client i18n: EN defaults in app.js; RU from /locales/ru.json when server locale=ru. */

(function () {

  'use strict';



  let locale = 'en';

  /** @type {Record<string, string> | null} */

  let ru = null;



  async function init() {

    try {

      const res = await fetch('/health', { credentials: 'same-origin' });

      if (res.ok) {

        const data = await res.json();

        locale = data.locale === 'ru' ? 'ru' : 'en';

      }

    } catch {

      locale = 'en';

    }



    if (locale !== 'ru') return;



    try {

      const res = await fetch('/locales/ru.json', { credentials: 'same-origin' });

      if (res.ok) ru = await res.json();

    } catch {

      ru = null;

    }

  }



  /** @param {string} key @param {string} enDefault */

  function t(key, enDefault) {

    if (locale !== 'ru' || !ru) return enDefault;

    const v = ru[key];

    return typeof v === 'string' && v.length > 0 ? v : enDefault;

  }



  /** @param {string} key @param {string} enDefault @param {Record<string, string|number>} [params] */
  function tp(key, enDefault, params) {
    let text = t(key, enDefault);
    if (params && typeof params === 'object') {
      for (const [k, v] of Object.entries(params)) {
        text = text.replaceAll(`{${k}}`, String(v));
      }
    }
    return text;
  }



  /** Apply data-i18n* on static HTML. */

  function applyDom() {

    document.querySelectorAll('[data-i18n]').forEach((el) => {

      const key = el.getAttribute('data-i18n');

      const fb = el.getAttribute('data-i18n-fb') || el.textContent || '';

      if (key) el.textContent = t(key, fb);

    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {

      const key = el.getAttribute('data-i18n-placeholder');

      const fb = el.getAttribute('placeholder') || '';

      if (key && 'placeholder' in el) el.placeholder = t(key, fb);

    });

    document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {

      const key = el.getAttribute('data-i18n-aria-label');

      const fb = el.getAttribute('aria-label') || '';

      if (key) el.setAttribute('aria-label', t(key, fb));

    });

    document.documentElement.lang = locale;

  }



  window.HandoffI18n = { init, t, tp, applyDom, getLocale: () => locale };

})();

