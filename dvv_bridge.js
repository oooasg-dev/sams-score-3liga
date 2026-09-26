/**
 * dvv_bridge.js
 * ------------------------------------------------------------------
 * Отдельный, независимый от ваших ручных Score/Aufstellung приложений
 * "мост": следит за N матчами Третьей лиги одновременно (одним общим
 * опросом фида DVV) и для каждого пишет живое состояние в свою ветку:
 *
 *   dvv_live/{matchUuid}/meta      — команды, лига, время начала
 *   dvv_live/{matchUuid}/roster    — заявка + фото + позиции (обе команды)
 *   dvv_live/{matchUuid}/live      — счёт, партии, подающая команда,
 *                                    текущая расстановка на площадке,
 *                                    лавка, тайм-ауты
 *   dvv_live/{matchUuid}/substitutions — история замен в текущем сете
 *
 * Ваша текущая ручная система (full_state, vmix/0, match и т.д.)
 * НИКАК не затрагивается — это полностью параллельная ветка данных.
 *
 * ВАЖНОЕ ДОПУЩЕНИЕ, ТРЕБУЮЩЕЕ ПРОВЕРКИ НА ЖИВОМ МАТЧЕ:
 *   Порядок игроков в teamLineups.playerUuids предполагается равным
 *   текущей ротации (позиция 1..6). Это стандартное поведение для
 *   систем официального протоколирования, но на живых данных фид
 *   ещё не проверялся (проверяли только на завершённом матче).
 *   Проверить: во время следующего живого матча взять два снепшота
 *   через 5-10 минут (после смены подачи) и убедиться, что порядок
 *   массива меняется по правилам волейбольной ротации.
 *
 * Настройка списка отслеживаемых матчей — файл dvv_watchlist.json
 * рядом со скриптом:
 *   [
 *     { "matchUuid": "2e724b7f-...", "label": "TV Baden - Essen" },
 *     { "matchUuid": "...", "label": "Матч 2" }
 *   ]
 * Либо через аргументы командной строки (через запятую):
 *   node dvv_bridge.js 2e724b7f-...,ab12cd34-...
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { computeRallyStats } = require('./compute_rally_stats');

const TICKER_URL = 'https://backend.sams-ticker.de/live/indoor/tickers/dvv';
const FIREBASE_BASE_URL = 'https://sams-score-3liga-default-rtdb.europe-west1.firebasedatabase.app';
const POLL_INTERVAL_MS = Number(
  process.env.DVV_POLL_INTERVAL_MS ||
  (process.env.DVV_POLL_INTERVAL_SEC ? Number(process.env.DVV_POLL_INTERVAL_SEC) * 1000 : 15000)
);
const archivedThisRun = new Set(); // matchUuid, уже заархивированные в этом запуске
const MAX_TIMEOUTS_PER_SET = 2;

const POSITION_MAP = {
  SETTER: 'Zuspieler',
  OPPOSITE: 'Diagonal',
  MIDDLE_BLOCKER: 'Mittelblock',
  WING_SPIKER: 'Aussenangriff',
  LIBERO: 'Libero',
};
function mapPosition(pos) {
  return POSITION_MAP[pos] || pos || '';
}

// ---------- загрузка списка матчей для слежения ----------
function loadWatchlist() {
  const cfgPath = path.join(__dirname, 'dvv_watchlist.json');
  if (fs.existsSync(cfgPath)) {
    const list = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return list.map(x => (typeof x === 'string' ? { matchUuid: x, label: x } : { ...x, label: x.label || x.matchUuid }));
  }
  const arg = process.argv[2];
  if (arg) {
    return arg.split(',').map(u => ({ matchUuid: u.trim(), label: u.trim() }));
  }
  console.error('Не найден dvv_watchlist.json и не передан matchUuid аргументом. Нечего отслеживать.');
  process.exit(1);
}

function formatPlayer(p) {
  if (!p) return null;
  return {
    uuid: p.uuid,
    num: p.jerseyNumber || '',
    name: `${p.firstName || ''} ${p.lastName || ''}`.trim(),
    role: mapPosition(p.position),
    photo: p.portraitPhoto || '',
  };
}

function findLatestTeamSquadEvent(eventHistory, teamCode) {
  // Берём САМУЮ ПОЗДНЮЮ по времени заявку (на случай, если секретарь
  // что-то поправил в составе по ходу матча) — но не раньше начала матча.
  const events = (eventHistory || [])
    .filter(e => e.type === 'CONFIRM_TEAMSQUAD' && e.teamCode === teamCode)
    .sort((a, b) => b.timestamp - a.timestamp);
  return events[0] || null;
}

function buildRoster(teamSquadEvent) {
  if (!teamSquadEvent || !teamSquadEvent.teamSquad) return null;
  const squad = teamSquadEvent.teamSquad;
  return {
    players: (squad.players || []).map(formatPlayer).filter(Boolean),
    liberos: (squad.liberos || []).map(formatPlayer).filter(Boolean),
    captain: formatPlayer(squad.captain),
    officials: (squad.officials || []).map(o => ({
      name: `${o.firstName || ''} ${o.lastName || ''}`.trim(),
      function: o.function || '',
      photo: o.portraitPhoto || '',
    })),
  };
}

function findTeamInfo(league, teamId) {
  // Логотипы лежат в matchSeries[лига].teams[] (поле logoImage200);
  // запасной вариант — таблица рейтинга той же лиги.
  if (!league || !teamId) return {};
  const fromTeams = (league.teams || []).find(t => t.id === teamId);
  if (fromTeams) return fromTeams;
  const ranks = (league.rankings && league.rankings.fullRankings) || [];
  const fromRank = ranks.find(r => r.team && r.team.id === teamId);
  return fromRank ? fromRank.team : {};
}

function personName(p) {
  return p ? `${p.firstName || ''} ${p.lastName || ''}`.trim() : '';
}

function buildReferees(eventHistory) {
  // Судьи и секретари — из события CONFIRM_ARBITRATION (берём последнее).
  const ev = (eventHistory || [])
    .filter(e => e.type === 'CONFIRM_ARBITRATION' && e.arbitration)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  const a = (ev && ev.arbitration) || {};
  return {
    referee1: personName(a.firstReferee),
    referee2: personName(a.secondReferee),
    scorer: personName(a.scorer),
    scorerAssistant: personName(a.scorerAssistant),
  };
}

function buildPlayerIndex(roster1, roster2) {
  const idx = {};
  [roster1, roster2].forEach(r => {
    if (!r) return;
    [...r.players, ...r.liberos].forEach(p => { idx[p.uuid] = p; });
  });
  return idx;
}

function lastStartSetTimestamp(eventHistory, setNumber) {
  const starts = (eventHistory || [])
    .filter(e => e.type === 'START_SET' && e.setNumber === setNumber)
    .sort((a, b) => b.timestamp - a.timestamp);
  return starts[0] ? starts[0].timestamp : 0;
}

function computeTimeouts(eventHistory, currentSetNumber) {
  const since = lastStartSetTimestamp(eventHistory, currentSetNumber);
  const used = { team1: 0, team2: 0 };
  const relevant = (eventHistory || [])
    .filter(e => (e.type === 'START_TIMEOUT') && e.timestamp >= since)
    .sort((a, b) => a.timestamp - b.timestamp);
  relevant.forEach(e => {
    if (e.teamCode === 'team1') used.team1++;
    if (e.teamCode === 'team2') used.team2++;
  });

  const allSorted = [...(eventHistory || [])].sort((a, b) => b.timestamp - a.timestamp);
  const lastEvent = allSorted[0];
  const active = !!(lastEvent && lastEvent.type === 'START_TIMEOUT');

  return {
    team1Left: Math.max(0, MAX_TIMEOUTS_PER_SET - used.team1),
    team2Left: Math.max(0, MAX_TIMEOUTS_PER_SET - used.team2),
    team1Used: used.team1,
    team2Used: used.team2,
    activeTeam: active ? lastEvent.teamCode : null,
    // Номер тайм-аута активной команды в этом сете (1 или 2) — для титра "1-й тайм-аут" / "2-й тайм-аут"
    activeTeamTimeoutNumber: active ? used[lastEvent.teamCode] : null,
  };
}

function computeSubstitutions(eventHistory, currentSetNumber, playerIndex) {
  const since = lastStartSetTimestamp(eventHistory, currentSetNumber);
  return (eventHistory || [])
    .filter(e => e.type === 'SUBSTITUTION' && e.timestamp >= since)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(e => ({
      teamCode: e.teamCode,
      timestamp: e.timestamp,
      setScore: e.setScore || { team1: 0, team2: 0 },
      playerInUuid: e.playerInUuid || (e.substitution && e.substitution.playerInUuid) || null,
      playerOutUuid: e.playerOutUuid || (e.substitution && e.substitution.playerOutUuid) || null,
      playerIn: playerIndex[e.playerInUuid] || null,
      playerOut: playerIndex[e.playerOutUuid] || null,
    }));
  // ПРИМЕЧАНИЕ: точные имена полей playerInUuid/playerOutUuid внутри
  // события SUBSTITUTION нужно свериться на реальном событии живого
  // матча — раньше нам попадались только SUBSTITUTION без разбора
  // структуры целиком. Если имена полей другие — поправить здесь.
}

function scoreKey(s) {
  return `${s.team1}:${s.team2}`;
}

function groupSubstitutionMoments(substitutions) {
  // Группирует замены, случившиеся при одном и том же счёте, в один "момент":
  // это покрывает и двойную замену одной команды, и одновременные замены
  // у обеих команд. Для титров: показываем последний момент целиком.
  const byKey = new Map();
  for (const sub of substitutions) {
    const key = scoreKey(sub.setScore || { team1: 0, team2: 0 });
    if (!byKey.has(key)) {
      byKey.set(key, { setScore: sub.setScore, timestamp: sub.timestamp, byTeam: { team1: [], team2: [] } });
    }
    const moment = byKey.get(key);
    moment.timestamp = Math.max(moment.timestamp, sub.timestamp);
    moment.byTeam[sub.teamCode].push({
      playerInUuid: sub.playerInUuid,
      playerOutUuid: sub.playerOutUuid,
      playerIn: sub.playerIn,
      playerOut: sub.playerOut,
    });
  }
  return [...byKey.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function computeMatchPayload(feedData, watch) {
  const { matchUuid } = watch;
  const state = feedData.matchStates && feedData.matchStates[matchUuid];
  if (!state) return null;

  // --- meta (команды/лига) — ищем в matchDays ---
  let meta = { team1Name: null, team2Name: null, league: null };
  outer:
  for (const day of feedData.matchDays || []) {
    for (const m of day.matches || []) {
      if (m.id === matchUuid) {
        const league = feedData.matchSeries && feedData.matchSeries[m.matchSeries];
        const info1 = findTeamInfo(league, m.team1);
        const info2 = findTeamInfo(league, m.team2);
        meta = {
          team1Name: m.teamDescription1,
          team2Name: m.teamDescription2,
          team1Id: m.team1 || '',
          team2Id: m.team2 || '',
          team1Logo: info1.logoImage200 || '',
          team2Logo: info2.logoImage200 || '',
          team1Short: info1.shortName || '',
          team2Short: info2.shortName || '',
          league: league ? league.name : m.matchSeries,
          leagueShort: league ? league.shortName || '' : '',
          kickoff: m.date,
        };
        break outer;
      }
    }
  }

  const roster1 = buildRoster(findLatestTeamSquadEvent(state.eventHistory, 'team1'));
  const roster2 = buildRoster(findLatestTeamSquadEvent(state.eventHistory, 'team2'));
  const playerIndex = buildPlayerIndex(roster1, roster2);

  const sets = state.matchSets || [];
  const currentSetEntry = sets[sets.length - 1] || { setNumber: 1, setScore: { team1: 0, team2: 0 } };
  const finishedSets = state.finished ? sets : sets.slice(0, -1);

  const lineup1 = (state.teamLineups?.team1?.playerUuids || []).map(u => playerIndex[u] || { uuid: u });
  const lineup2 = (state.teamLineups?.team2?.playerUuids || []).map(u => playerIndex[u] || { uuid: u });

  const onCourtUuids = new Set([...(state.teamLineups?.team1?.playerUuids || []), ...(state.teamLineups?.team2?.playerUuids || [])]);
  const bench1 = (roster1?.players || []).filter(p => !onCourtUuids.has(p.uuid));
  const bench2 = (roster2?.players || []).filter(p => !onCourtUuids.has(p.uuid));

  const timeouts = computeTimeouts(state.eventHistory, currentSetEntry.setNumber);
  const substitutions = computeSubstitutions(state.eventHistory, currentSetEntry.setNumber, playerIndex);
  const substitutionMoments = groupSubstitutionMoments(substitutions);

  // Либеро на площадке прямо сейчас: пересечение заявленных либеро (roster.liberos)
  // с текущей шестёркой (teamLineups). Если в заявке два либеро — берём того,
  // кто сейчас реально на площадке (может быть и null, если оба на лавке).
  const liberoOnCourt = (roster, lineupUuids) => {
    const uuids = new Set(lineupUuids || []);
    return (roster?.liberos || []).find(l => uuids.has(l.uuid)) || null;
  };
  const libero1 = liberoOnCourt(roster1, state.teamLineups?.team1?.playerUuids);
  const libero2 = liberoOnCourt(roster2, state.teamLineups?.team2?.playerUuids);

  // ВНИМАНИЕ, НЕ ПОДТВЕРЖДЕНО: предполагаем, что playerUuids[0] — подающий
  // (позиция 1 / зона подачи). Ротация массива подтверждена на живых данных,
  // но какой именно индекс соответствует зоне подачи — нет. Проверить на
  // ближайшем живом матче и поправить при необходимости (см. README ниже).
  const servingLineup = state.serving === 'team2' ? lineup2 : lineup1;
  const servingPlayer = servingLineup[0] || null;

  // Самое свежее событие целиком, как пришло от SAMS, без обработки.
  // Нужно для типов событий, которые мост пока не разбирает отдельно
  // (SET_BALL, MATCH_BALL, CANCEL_TIMEOUT, SELECT_MVP и т.д.) — титры
  // могут заглянуть сюда, даже если для события ещё нет своего поля.
  const lastEvent = (state.eventHistory || [])[0] || null;

  const payload = {
    meta: { ...meta, syncedAt: new Date().toISOString() },
    roster: { team1: roster1, team2: roster2 },
    referees: buildReferees(state.eventHistory),
    live: {
      started: !!state.started,
      finished: !!state.finished,
      setNumber: currentSetEntry.setNumber,
      currentSetScore: currentSetEntry.setScore,
      setsWon: state.setPoints || { team1: 0, team2: 0 },
      finishedSets: finishedSets.map(s => ({ setNumber: s.setNumber, ...s.setScore })),
      servingTeam: state.serving || null,
      lineup: { team1: lineup1, team2: lineup2 },
      libero: { team1: libero1, team2: libero2 },
      servingPlayer, // best-effort, см. комментарий выше — не подтверждено
      bench: { team1: bench1, team2: bench2 },
      timeouts,
      lastEvent, // сырое событие целиком: type, teamCode, timestamp, setScore и т.д.
    },
    substitutions,
    substitutionMoments,
  };

  return payload;
}

function matchTitle(meta) {
  // Человекочитаемое название: "2026-09-19 18:00 | DLW M | TV Baden – VV Humann Essen II"
  const when = meta.kickoff
    ? new Date(meta.kickoff).toLocaleString('sv-SE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' })
    : '';
  return [when, meta.leagueShort || meta.league || '', `${meta.team1Name || '?'} – ${meta.team2Name || '?'}`]
    .filter(Boolean)
    .join(' | ');
}

const indexedThisRun = new Set();
async function writeMatchIndex(matchUuid, meta) {
  if (indexedThisRun.has(matchUuid) || !meta || !meta.team1Name) return;
  // match_index/{uuid} = "дата | лига | команда1 – команда2" — чтобы в консоли Firebase было видно, что за матч
  await axios.put(`${FIREBASE_BASE_URL}/match_index/${matchUuid}.json`, JSON.stringify(matchTitle(meta)), {
    headers: { 'Content-Type': 'application/json' },
  });
  indexedThisRun.add(matchUuid);
}

async function archiveFinishedMatch(state, matchUuid, meta, label) {
  // 1) сырой state целиком (включая eventHistory) — из него можно пересчитать что угодно позже
  await axios.put(`${FIREBASE_BASE_URL}/archive/${matchUuid}.json`, {
    archivedAt: new Date().toISOString(),
    meta,
    state,
  });

  // 2) статистика розыгрышей
  const stats = computeRallyStats(state);
  await axios.put(`${FIREBASE_BASE_URL}/match_stats/${matchUuid}.json`, {
    computedAt: new Date().toISOString(),
    meta,
    ...stats,
  });

  console.log(`[${label}] АРХИВ сохранён: archive/${matchUuid}, match_stats/${matchUuid}`);
  if (stats.warnings.length) {
    stats.warnings.forEach(w => console.warn(`[${label}] предупреждение статистики: ${w}`));
  }
}

async function syncOneMatch(feedData, watch) {
  const { matchUuid } = watch;
  let label = watch.label || matchUuid;
  const payload = computeMatchPayload(feedData, watch);
  if (!payload) {
    console.log(`[${label}] матч не найден в фиде (ещё не начался или уже выпал из окна)`);
    return null;
  }

  if (label === matchUuid && payload.meta.team1Name) label = `${payload.meta.team1Name} - ${payload.meta.team2Name}`;
  await axios.put(`${FIREBASE_BASE_URL}/dvv_live/${matchUuid}.json`, payload);
  await writeMatchIndex(matchUuid, payload.meta).catch(e => console.warn(`[${label}] не удалось записать match_index: ${e.message}`));

  // Матч завершён -> один раз сохраняем сырой state и считаем статистику,
  // пока матч не выпал из ~8-дневного окна фида DVV.
  if (payload.live.finished && !archivedThisRun.has(matchUuid)) {
    try {
      await archiveFinishedMatch(feedData.matchStates[matchUuid], matchUuid, payload.meta, label);
      archivedThisRun.add(matchUuid);
    } catch (e) {
      console.error(`[${label}] не удалось заархивировать матч (повторю на следующем опросе):`, e.message);
    }
  }
  const live = payload.live;
  console.log(`[${label}] OK  сет ${live.setNumber}  счёт ${live.currentSetScore.team1}:${live.currentSetScore.team2}  подача: ${live.servingTeam}  ${live.finished ? '(матч завершён)' : ''}`);
  return payload;
}

async function tick(watchlist) {
  let feedData;
  try {
    const res = await axios.get(TICKER_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 30000,
    });
    feedData = res.data;
  } catch (e) {
    console.error('Не удалось получить фид DVV:', e.message);
    return [];
  }

  const results = [];
  for (const watch of watchlist) {
    try {
      const payload = await syncOneMatch(feedData, watch);
      results.push({ matchUuid: watch.matchUuid, finished: !!(payload && payload.live && payload.live.finished) });
    } catch (e) {
      console.error(`[${watch.label}] ошибка обработки:`, e.message);
      results.push({ matchUuid: watch.matchUuid, finished: false });
    }
  }
  return results;
}

async function main() {
  const watchlist = loadWatchlist();
  const maxRuntimeMin = Number(process.env.DVV_MAX_RUNTIME_MIN || 240); // страховка для GitHub Actions
  const startedAt = Date.now();
  console.log(`=== DVV bridge запущен, слежу за ${watchlist.length} матч(ами), опрос раз в ${POLL_INTERVAL_MS / 1000} сек, макс. время работы ${maxRuntimeMin} мин ===`);
  watchlist.forEach(w => console.log(`  - ${w.label} (${w.matchUuid})`));

  let finishedStreak = 0;

  while (true) {
    const results = await tick(watchlist);

    // Если ВСЕ отслеживаемые матчи завершены 3 опроса подряд — выходим сами,
    // не дожидаясь принудительной остановки job'ы по таймауту (экономим минуты Actions).
    const allFinished = results.length > 0 && results.every(r => r.finished);
    finishedStreak = allFinished ? finishedStreak + 1 : 0;
    if (finishedStreak >= 3) {
      console.log('=== Все отслеживаемые матчи завершены — останавливаюсь ===');
      break;
    }

    if (Date.now() - startedAt > maxRuntimeMin * 60 * 1000) {
      console.log('=== Достигнут лимит времени работы — останавливаюсь ===');
      break;
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  syncOneMatch, computeMatchPayload, computeTimeouts, computeSubstitutions,
  buildRoster, findLatestTeamSquadEvent, findTeamInfo, buildReferees,
  buildPlayerIndex, archiveFinishedMatch, matchTitle, writeMatchIndex, groupSubstitutionMoments,
  TICKER_URL, FIREBASE_BASE_URL, loadWatchlist,
};
