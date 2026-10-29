/**
 * dvv_diagnose.js — быстрая проверка, откуда и почему приходит 403.
 * Запуск: node dvv_diagnose.js
 * Печатает IP/страну машины, затем пробует REST и WebSocket (напрямую и, если задан DVV_PROXY, через прокси).
 */
'use strict';
const axios = require('axios');
const WebSocket = require('ws');

const LEAGUE = process.env.DVV_LEAGUE || 'dvv';
const REST = `https://backend.sams-ticker.de/live/indoor/tickers/${LEAGUE}`;
const WS = `wss://backend.sams-ticker.de/indoor/${LEAGUE}`;

async function tryRest(label, opts) {
  try {
    const r = await axios.get(REST, { timeout: 30000, validateStatus: () => true, ...opts });
    console.log(`REST [${label}]: ${r.status}  pop=${r.headers['x-amz-cf-pop'] || '-'}`);
  } catch (e) {
    console.log(`REST [${label}]: ошибка ${e.message}`);
  }
}

function tryWs(label, opts) {
  return new Promise(resolve => {
    const ws = new WebSocket(WS, opts);
    const t = setTimeout(() => { console.log(`WS   [${label}]: таймаут`); ws.terminate(); resolve(); }, 15000);
    ws.on('open', () => { console.log(`WS   [${label}]: подключено (OK)`); clearTimeout(t); ws.close(); resolve(); });
    ws.on('error', e => { console.log(`WS   [${label}]: ${e.message}`); clearTimeout(t); resolve(); });
  });
}

(async () => {
  try {
    const ip = await axios.get('https://ipinfo.io/json', { timeout: 10000 });
    console.log(`Эта машина: ${ip.data.ip}  ${ip.data.country}  ${ip.data.city}  ${ip.data.org}`);
  } catch (e) {
    console.log('ipinfo недоступен:', e.message);
  }

  // 1) напрямую, заголовки как у сайта
  const http = require('./dvv_http.js');
  const h = http.tickerHeaders(LEAGUE);
  await tryRest('напрямую', { headers: h });
  await tryWs('напрямую', { origin: h.Origin, headers: { 'User-Agent': h['User-Agent'] } });

  // 2) через прокси, если задан
  if (process.env.DVV_PROXY) {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    const agent = new HttpsProxyAgent(process.env.DVV_PROXY);
    await tryRest('прокси', { headers: h, httpsAgent: agent, proxy: false });
    await tryWs('прокси', { origin: h.Origin, headers: { 'User-Agent': h['User-Agent'] }, agent });
  } else {
    console.log('DVV_PROXY не задан — проверка через прокси пропущена');
  }
})();
