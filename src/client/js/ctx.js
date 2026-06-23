export const ctx = {};

export function t(key, enDefault) {
  if (typeof globalThis.HandoffI18n?.t === 'function') {
    return globalThis.HandoffI18n.t(key, enDefault);
  }
  return enDefault;
}

export function tp(key, enDefault, params) {
  if (typeof globalThis.HandoffI18n?.tp === 'function') {
    return globalThis.HandoffI18n.tp(key, enDefault, params);
  }
  let text = enDefault;
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}
