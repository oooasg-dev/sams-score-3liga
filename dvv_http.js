/**
 * dvv_http.js
 * Общие заголовки и необязательный прокси для запросов к backend.sams-ticker.de
 * (REST и WebSocket). Firebase через прокси НЕ ходит.
 *
 * Прокси включается переменной окружения DVV_PROXY, например:
 *   DVV_PROXY=http://user:pass@host:port
 * Если переменная пуста — всё работает как раньше, напрямую.
 */
'use strict';

const axios = require('axios');

const LEAGUE_DEFAULT = process.env.DVV_LEAGUE || 'dvv';

let agent = null;
if (process.env.DVV_PROXY) {
  const { HttpsProxyAgent } = require('https-proxy-agent');
  agent = new HttpsProxyAgent(process.env.DVV_PROXY);
  console.log('[dvv_http] запросы к sams-ticker идут через прокси');
}

function tickerHeaders(league = LEAGUE_DEFAULT) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
    'Origin': `https://${league}.sams-ticker.de`,
    'Referer': `https://${league}.sams-ticker.de/`,
  };
}

// GET к sams-ticker с нужными заголовками и (если задан) прокси
function tickerGet(url, league = LEAGUE_DEFAULT, extra = {}) {
  return axios.get(url, {
    headers: tickerHeaders(league),
    timeout: 30000,
    ...(agent ? { httpsAgent: agent, proxy: false } : {}),
    ...extra,
  });
}

// Опции для new WebSocket(url, opts)
function wsOptions(league = LEAGUE_DEFAULT) {
  const h = tickerHeaders(league);
  return {
    origin: h.Origin,
    headers: { 'User-Agent': h['User-Agent'], 'Accept-Language': h['Accept-Language'] },
    ...(agent ? { agent } : {}),
  };
}

module.exports = { tickerHeaders, tickerGet, wsOptions, hasProxy: !!agent };
