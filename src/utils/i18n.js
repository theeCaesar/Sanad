const { LOCALES, DEFAULT_LOCALE } = require('../constants');

const en = require('../../locales/en.json');
const ar = require('../../locales/ar.json');
const ku = require('../../locales/ku.json');

const DICT = { en, ar, ku };

function getLocale(req) {
  const h = (req.headers['accept-language'] || '').split(',')[0].split('-')[0].toLowerCase();
  if (LOCALES.includes(h)) return h;
  if (req.user?.locale && LOCALES.includes(req.user.locale)) return req.user.locale;
  return DEFAULT_LOCALE;
}

function t(key, locale = DEFAULT_LOCALE, params = {}) {
  const table = DICT[locale] || DICT[DEFAULT_LOCALE];
  let s = table[key] ?? DICT[DEFAULT_LOCALE][key] ?? key;
  for (const [k, v] of Object.entries(params)) {
    s = s.replace(new RegExp(`{{\\s*${k}\\s*}}`, 'g'), String(v));
  }
  return s;
}

module.exports = { t, getLocale, LOCALES, DEFAULT_LOCALE };
