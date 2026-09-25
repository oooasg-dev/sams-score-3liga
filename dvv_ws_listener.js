/**
 * dvv_ws_listener.js
 * ------------------------------------------------------------------
 * Слушатель WebSocket-канала SAMS-тикера. В отличие от dvv_bridge.js
 * (который раз в 15 сек скачивает REST-фид целиком), этот скрипт держит
 * одно соединение и получает обновления сразу, как только что-то
 * происходит на площадке — на практике почти на каждый розыгрыш.
 *
 * ПОДТВЕРЖДЕНО НА ЖИВЫХ ДАННЫХ (25.09.2026):
 *  - Канал wss://backend.sams-ticker.de/indoor/{dvv|nwvv} транслирует
 *    события ВСЕХ матчей, идущих сейчас по всей стране в этой лиге,
 *    без подписки на конкретный матч. Скрипт сам отбирает нужные uuid.
 *  - Формат сообщения: {"type":"MATCH_UPDATE","payload": {...}}, где
 *    payload — это ровно то же самое, что matchStates[uuid] в REST.
 *  - Счёт в payload.matchSets обновляется на каждый розыгрыш (не на
 *    серии по 3, как событие SCORE в eventHistory).
 *  - Порядок playerUuids в teamLineups — это позиции 1–6 по ротации,
 *    подтверждено визуально (сдвигается по кругу при смене подачи).
 *
 * НЕ ПОДТВЕРЖДЕНО:
 *  - Какой именно индекс массива playerUuids соответствует зоне подачи
 *    (мы предполагаем playerUuids[0] — см. servingPlayer в dvv_bridge.js,
 *    computeMatchPayload). Проверить на первом же реальном матче: у кого
 *    из шестёрки табло показывает подачу, и совпадает ли это с [0].
 *
 * Что пишется в Firebase (то же дерево, что у dvv_bridge.js):
 *   dvv_live/{matchUuid}        — как и раньше, читают титры, без изменений
 *   match_index/{matchUuid}     — человекочитаемое название матча
 *   match_history/{matchUuid}/* — НОВОЕ: слепок на каждое сообщение,
 *                                  append-only (счёт, сет, подача,
 *                                  шестёрки на площадке, тип события)
 *   archive/{matchUuid}         — сырой state при finished:true (1 раз)
 *   match_stats/{matchUuid}     — статистика розыгрышей при finished:true
 *
 * Список матчей — тот же dvv_watchlist.json, что у dvv_bridge.js, либо
 * аргумент командной строки (uuid через запятую).
 *
 * Переменные окружения:
 *   DVV_LEAGUE            'dvv' (по умолчанию) или 'nwvv'
 *   DVV_MAX_RUNTIME_MIN   страховка по времени (по умолчанию 340, максимум ~355)
 * ------------------------------------------------------------------
 */
'use strict';

const axios = require('axios');
const WebSocket = require('ws');
const bridge = require('./dvv_bridge.js');

const LEAGUE = process.env.DVV_LEAGUE || 'dvv';
const WS_URL = `wss://backend.sams-ticker.de/indoor/${LEAGUE}`;
const TICKER_URL = `https://backend.sams-ticker.de/live/indoor/tickers/${LEAGUE}`;
const FIREBASE_BASE_URL = bridge.FIREBASE_BASE_URL;
const MAX_RUNTIME_MIN = Number(process.env.DVV_MAX_RUNTIME_MIN || 340);

// ---------- список отслеживаемых матчей ----------
function loadWatchlist() {
  try {
    return bridge.loadWatchlist();
  } catch (e) {
    console.error('Не удалось загрузить watchlist:', e.message);
    process.exit(1);
  }
}

async function main() {
  const watchlist = loadWatchlist();
  const watchByUuid = new Map(watchlist.map(w => [w.matchUuid, w]));
  console.log(`=== WS-слушатель (${LEAGUE}) запущен, слежу за ${watchlist.length} матч(ами) ===`);
  watchlist.forEach(w => console.log(`  - ${w.label} (${w.matchUuid})`));

  // 1) Один раз забираем REST-фид целиком — оттуда берём то, чего нет в
  //    WS-сообщениях: названия команд, логотипы, время начала матча.
  console.log('Загружаю REST-фид один раз для названий команд и логотипов...');
  let bootstrapFeed;
  try {
    const res = await axios.get(TICKER_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 30000,
    });
    bootstrapFeed = res.data;
  } catch (e) {
    console.error('Не удалось загрузить REST-фид, продолжаю без названий команд:', e.message);
    bootstrapFeed = { matchDays: [], matchSeries: {}, matchStates: {} };
  }

  // Живое состояние каждого матча (payload из последнего WS-сообщения).
  // Изначально — то, что уже есть в REST (может быть, матч ещё не начался).
  const latestState = {};
  for (const uuid of watchByUuid.keys()) {
    latestState[uuid] = bootstrapFeed.matchStates?.[uuid] || null;
  }

  // Предыдущая шестёрка на площадке — для слепков и отладки замен.
  const prevOnCourt = {}; // matchUuid -> {team1: Set, team2: Set}
  const archived = new Set();
  const startedAt = Date.now();
  let ws;
  let stopped = false;

  async function handleUpdate(matchUuid, payload) {
    latestState[matchUuid] = payload;
    const watch = watchByUuid.get(matchUuid);

    // Собираем тот же payload, что раньше собирал REST-мост — титры не
    // придётся переделывать, dvv_live выглядит так же, только обновляется
    // не раз в 15 сек, а почти мгновенно.
    const syntheticFeed = {
      matchDays: bootstrapFeed.matchDays,
      matchSeries: bootstrapFeed.matchSeries,
      matchStates: { [matchUuid]: payload },
    };
    let out;
    try {
      out = bridge.computeMatchPayload(syntheticFeed, watch);
    } catch (e) {
      console.error(`[${watch.label}] ошибка сборки payload:`, e.message);
      return;
    }
    if (!out) return;

    try {
      await axios.put(`${FIREBASE_BASE_URL}/dvv_live/${matchUuid}.json`, out);
      await bridge.writeMatchIndex(matchUuid, out.meta).catch(() => {});
    } catch (e) {
      console.error(`[${watch.label}] не удалось записать dvv_live:`, e.message);
    }

    // ---------- слепок в match_history (append, не перезаписывается) ----------
    try {
      const lastEvent = (payload.eventHistory || [])[0] || null;
      const snapshot = {
        timestamp: Date.now(),
        setNumber: out.live.setNumber,
        score: out.live.currentSetScore,
        servingTeam: out.live.servingTeam,
        onCourt: {
          team1: payload.teamLineups?.team1?.playerUuids || [],
          team2: payload.teamLineups?.team2?.playerUuids || [],
        },
        eventType: lastEvent ? lastEvent.type : null,
      };
      await axios.post(`${FIREBASE_BASE_URL}/match_history/${matchUuid}.json`, snapshot);
    } catch (e) {
      console.error(`[${watch.label}] не удалось записать слепок в match_history:`, e.message);
    }

    const live = out.live;
    console.log(
      `[${watch.label}] сет ${live.setNumber}  ${live.currentSetScore.team1}:${live.currentSetScore.team2}` +
      `  подача: ${live.servingTeam}${live.finished ? '  (матч завершён)' : ''}`
    );

    // ---------- архивация при завершении матча ----------
    if (payload.finished && !archived.has(matchUuid)) {
      try {
        await bridge.archiveFinishedMatch(payload, matchUuid, out.meta, watch.label);
        archived.add(matchUuid);
      } catch (e) {
        console.error(`[${watch.label}] не удалось заархивировать матч:`, e.message);
      }
    }
  }

  function allDone() {
    if (watchByUuid.size === 0) return false;
    return [...watchByUuid.keys()].every(u => archived.has(u) || latestState[u]?.finished);
  }

  function connect() {
    if (stopped) return;
    console.log(`Подключаюсь к ${WS_URL} ...`);
    ws = new WebSocket(WS_URL, { origin: `https://${LEAGUE}.sams-ticker.de` });

    ws.on('open', () => console.log('WebSocket подключен.'));

    ws.on('message', raw => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e) {
        return; // не JSON — игнорируем
      }
      if (msg.type !== 'MATCH_UPDATE' || !msg.payload) return;
      const matchUuid = msg.payload.matchUuid;
      if (!watchByUuid.has(matchUuid)) return; // не наш матч — игнорируем (их идёт много по всей стране)
      handleUpdate(matchUuid, msg.payload).catch(e => console.error('Ошибка обработки обновления:', e.message));
    });

    ws.on('close', (code) => {
      if (stopped) return;
      console.warn(`Соединение закрыто (code ${code}), переподключаюсь через 3 сек...`);
      setTimeout(connect, 3000);
    });

    ws.on('error', (err) => {
      console.error('Ошибка WebSocket:', err.message);
      // 'close' сработает следом и переподключит
    });
  }

  connect();

  // Периодически проверяем, не пора ли остановиться.
  const checkInterval = setInterval(() => {
    if (allDone()) {
      console.log('=== Все отслеживаемые матчи завершены — останавливаюсь ===');
      stopped = true;
      clearInterval(checkInterval);
      if (ws) ws.close();
      process.exit(0);
    }
    if (Date.now() - startedAt > MAX_RUNTIME_MIN * 60 * 1000) {
      console.log('=== Достигнут лимит времени работы — останавливаюсь ===');
      stopped = true;
      clearInterval(checkInterval);
      if (ws) ws.close();
      process.exit(0);
    }
  }, 15000);
}

main();
