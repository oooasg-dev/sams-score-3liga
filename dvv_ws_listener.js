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
 * Что пишется в Firebase (единая схема matches/, как после migrate_to_matches_schema):
 *   matches/{matchUuid}/live    — текущее состояние матча (бывший dvv_live)
 *   matches/{matchUuid}/history — слепок на каждое сообщение, append-only
 *   matches/{matchUuid}/raw     — сырой state при finished:true (бывший archive)
 *   matches/{matchUuid}/stats   — статистика розыгрышей при finished:true
 *   program/live                — ДУБЛЬ live матча "в эфире" для титров vMix
 *   program/matchUuid           — указатель, какой матч сейчас в эфире
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

  // Матч "в эфире": uuid лежит в Firebase по адресу program/matchUuid (его ставит
  // страница выбора матча). Его live дублируется в постоянную ветку program/live,
  // откуда читают титры vMix — адрес для титров не меняется никогда.
  const archived = new Set(); // объявлено выше стартового снимка, чтобы handleUpdate мог им пользоваться сразу
  let programUuid = null;
  const lastOut = {}; // matchUuid -> последний собранный payload (для мгновенной записи при смене эфира)
  async function refreshProgramUuid() {
    try {
      const res = await axios.get(`${FIREBASE_BASE_URL}/program/matchUuid.json`, { timeout: 10000 });
      const next = res.data || null;
      if (next !== programUuid) {
        programUuid = next;
        console.log(`>>> В ЭФИРЕ теперь: ${programUuid || '(ничего)'}`);
        if (programUuid && !watchByUuid.has(programUuid)) {
          console.warn('    ВНИМАНИЕ: этот матч не в списке слушателя — program/live обновляться не будет');
        } else if (programUuid && lastOut[programUuid]) {
          // сразу отдаём титрам актуальные данные, не дожидаясь следующего розыгрыша
          await axios.put(`${FIREBASE_BASE_URL}/program/live.json`, lastOut[programUuid]);
        }
      }
    } catch (e) {
      // сеть моргнула — оставляем прежнее значение
    }
  }
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

  // Предупреждение, если матча нет в ленте: неверный uuid, не та лига (dvv / nwvv) или матч ещё не создан.
  for (const [uuid, w] of watchByUuid) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) {
      console.warn(`!!! [${w.label}] это не похоже на uuid матча — проверь, что в поле нет лишнего текста`);
    } else if (!bootstrapFeed.matchStates?.[uuid]) {
      console.warn(`!!! [${w.label}] в ленте ${LEAGUE} нет состояния этого матча (неверный uuid, не та лига или матч ещё не начался)`);
    }
  }

  // Живое состояние каждого матча (payload из последнего WS-сообщения).
  // Изначально — то, что уже есть в REST (может быть, матч ещё не начался).
  const latestState = {};
  for (const uuid of watchByUuid.keys()) {
    latestState[uuid] = bootstrapFeed.matchStates?.[uuid] || null;
  }

  // ---------- начальная запись из REST, чтобы не ждать первого WS-события ----------
  // WebSocket пересылает только НОВЫЕ события, случившиеся после подключения.
  // Если заявка/судьи уже подтверждены секретарём до старта листенера, WS о них
  // не расскажет, пока не случится что-то ещё. Поэтому сразу пишем то, что уже
  // есть в REST — а дальше событиями из WS данные будут только дополняться.
  for (const [uuid, state] of Object.entries(latestState)) {
    if (!state) continue;
    try {
      await handleUpdate(uuid, state);
      console.log(`[${watchByUuid.get(uuid).label}] стартовый снимок из REST записан`);
    } catch (e) {
      console.error(`[${watchByUuid.get(uuid).label}] не удалось записать стартовый снимок:`, e.message);
    }
  }

  // Предыдущая шестёрка на площадке — для слепков и отладки замен.
  const prevOnCourt = {}; // matchUuid -> {team1: Set, team2: Set}
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
    lastOut[matchUuid] = out;

    try {
      await axios.put(`${FIREBASE_BASE_URL}/matches/${matchUuid}/live.json`, out);
    } catch (e) {
      console.error(`[${watch.label}] не удалось записать matches/live:`, e.message);
    }

    // дублируем в постоянную ветку для титров, если это матч "в эфире"
    if (matchUuid === programUuid) {
      try {
        await axios.put(`${FIREBASE_BASE_URL}/program/live.json`, out);
      } catch (e) {
        console.error(`[${watch.label}] не удалось записать program/live:`, e.message);
      }
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
      await axios.post(`${FIREBASE_BASE_URL}/matches/${matchUuid}/history.json`, snapshot);
    } catch (e) {
      console.error(`[${watch.label}] не удалось записать слепок в matches/history:`, e.message);
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

  // Если при запуске указан матч "в эфир" — ставим его указателем.
  // из введённого текста берём только сам uuid (на случай, если вставили вместе с подписью "matchUuid: ")
  const initialProgram = ((process.env.DVV_PROGRAM_UUID || '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [''])[0].toLowerCase();
  if (initialProgram) {
    try {
      await axios.put(`${FIREBASE_BASE_URL}/program/matchUuid.json`, JSON.stringify(initialProgram));
    } catch (e) {
      console.error('Не удалось записать program/matchUuid:', e.message);
    }
  }

  // Раз в 5 сек проверяем, какой матч выбран "в эфир".
  await refreshProgramUuid();
  const programTimer = setInterval(refreshProgramUuid, 5000);

  // Периодически проверяем, не пора ли остановиться.
  const checkInterval = setInterval(() => {
    if (allDone()) {
      console.log('=== Все отслеживаемые матчи завершены — останавливаюсь ===');
      stopped = true;
      clearInterval(checkInterval); clearInterval(programTimer);
      if (ws) ws.close();
      process.exit(0);
    }
    if (Date.now() - startedAt > MAX_RUNTIME_MIN * 60 * 1000) {
      console.log('=== Достигнут лимит времени работы — останавливаюсь ===');
      stopped = true;
      clearInterval(checkInterval); clearInterval(programTimer);
      if (ws) ws.close();
      process.exit(0);
    }
  }, 15000);
}

main();
