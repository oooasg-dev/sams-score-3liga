/**
 * recompute_stats_from_history.js
 * ------------------------------------------------------------------
 * Точная статистика розыгрышей по снимкам площадки (matches/{uuid}/history).
 *
 * ЗАЧЕМ. compute_rally_stats.js считает по событиям матча (стартовая шестёрка +
 * замены со счётом). Он не видит, когда либеро заходит вместо центрального
 * блокирующего, поэтому центральные получались завышенными (почти 100%),
 * а второй либеро — нулевым. Слушатель же пишет в history снимок почти на каждый
 * розыгрыш, и в нём teamLineups уже содержит либеро на площадке — по нему
 * считается точно.
 *
 * КАК. Для каждого сета и каждого розыгрыша k берём снимок, сделанный при
 * счёте k-1 (то есть шестёрку, которая этот розыгрыш играла). Если снимка на
 * этот счёт нет — берём ближайший предыдущий. Сет считается «точным», если
 * снимки есть минимум на MIN_SET_COVERAGE розыгрышей. Остальные сеты считаются
 * по событиям (как раньше) и помечаются как приблизительные.
 *
 * Запуск (по умолчанию ТОЛЬКО показывает результат, в базу ничего не пишет):
 *   node recompute_stats_from_history.js --file=export.json         по выгрузке базы
 *   node recompute_stats_from_history.js --file=export.json --match=2f5a6dd3
 *   node recompute_stats_from_history.js                            из Firebase
 *   node recompute_stats_from_history.js --write                    записать в Firebase
 *
 * С --write старая статистика каждого перезаписываемого матча сначала
 * сохраняется в локальный файл stats_backup_<время>.json.
 *
 * Как модуль:
 *   const { buildStats } = require('./recompute_stats_from_history');
 *   const stats = buildStats({ state, history, liveRoster, liveFinishedSets });
 * ------------------------------------------------------------------
 */
'use strict';

const { computeRallyStats } = require('./compute_rally_stats');

const FIREBASE_BASE_URL = process.env.DVV_FIREBASE_URL || 'https://sams-score-3liga-default-rtdb.europe-west1.firebasedatabase.app';
const MIN_SET_COVERAGE = 0.85;

const ROLE_CODE = {
  Zuspieler: 'Z',
  Diagonal: 'D',
  Mittelblock: 'MB',
  Aussenangriff: 'AA',
  Libero: 'L',
};

// Firebase отдаёт массивы то массивом, то объектом с ключами-номерами и теряет пустые.
function asList(v) {
  if (Array.isArray(v)) return v.filter(x => x != null);
  return v ? Object.values(v) : [];
}

function roleCode(r) {
  return ROLE_CODE[r] || r || '';
}

/** Состав из live.roster (формат dvv_bridge.js: players/liberos с uuid, num, name, role). */
function rosterFromLive(liveRoster) {
  const out = {};
  for (const team of ['team1', 'team2']) {
    const r = liveRoster && liveRoster[team];
    if (!r) continue;
    for (const p of [...asList(r.players), ...asList(r.liberos)]) {
      if (!p || !p.uuid) continue;
      out[p.uuid] = { name: p.name || p.uuid, num: p.num || '', role: roleCode(p.role), team };
    }
    // либеро из заявки важнее: в players тот же человек может числиться с другой ролью
    for (const p of asList(r.liberos)) {
      if (p && p.uuid) out[p.uuid].role = 'L';
    }
  }
  return out;
}

/**
 * Считает розыгрыши по снимкам, один сет.
 * snapshots — снимки только этого сета, по времени.
 * Возвращает { counts: {uuid: n}, teams: {uuid: 'team1'|'team2'}, coverage }.
 */
function countSetFromSnapshots(snapshots, totalRallies) {
  const byScoreSum = new Map(); // сумма очков -> последний по времени снимок
  for (const s of snapshots) {
    const sum = (s.score?.team1 || 0) + (s.score?.team2 || 0);
    byScoreSum.set(sum, s);
  }
  const counts = {};
  const teams = {};
  let exact = 0;
  let last = null;
  for (let k = 1; k <= totalRallies; k++) {
    const exactSnap = byScoreSum.get(k - 1);
    if (exactSnap) exact++;
    const snap = exactSnap || last;
    if (!snap) continue;
    last = snap;
    for (const team of ['team1', 'team2']) {
      for (const u of asList(snap.onCourt?.[team])) {
        counts[u] = (counts[u] || 0) + 1;
        teams[u] = team;
      }
    }
  }
  return { counts, teams, coverage: totalRallies ? exact / totalRallies : 0 };
}

/**
 * state            — сырой state матча (matches/{uuid}/raw/state) или null
 * history          — matches/{uuid}/history (объект слепков) или null
 * liveRoster       — matches/{uuid}/live/roster (запасной источник состава)
 * liveFinishedSets — matches/{uuid}/live/live/finishedSets (счёт сетов, если нет state)
 */
function buildStats({ state, history, liveRoster, liveFinishedSets }) {
  const warnings = [];
  const events = state ? computeRallyStats(state) : null;

  // ---------- сколько розыгрышей было в каждом сете ----------
  const totals = {};
  if (events) {
    for (const s of events.setNumbers) totals[s] = events.ralliesPerSet[s];
  } else {
    for (const s of asList(liveFinishedSets)) totals[s.setNumber] = (s.team1 || 0) + (s.team2 || 0);
  }
  const setNumbers = Object.keys(totals).map(Number).sort((a, b) => a - b);

  // ---------- снимки по сетам ----------
  const snaps = asList(history)
    .filter(s => asList(s.onCourt?.team1).length === 6 && asList(s.onCourt?.team2).length === 6)
    .sort((a, b) => a.timestamp - b.timestamp);
  const snapsBySet = {};
  for (const s of snaps) (snapsBySet[s.setNumber] ||= []).push(s);

  // ---------- кто есть кто ----------
  const info = {};
  Object.assign(info, rosterFromLive(liveRoster));
  if (events) {
    for (const [uuid, p] of Object.entries(events.players)) {
      info[uuid] = { name: p.name, num: p.num, role: p.role, team: p.team };
    }
  }

  // ---------- по сетам выбираем способ ----------
  const perSet = {}; // set -> { uuid: n }
  const setMethods = {};
  const setCoverage = {};
  for (const sn of setNumbers) {
    const h = countSetFromSnapshots(snapsBySet[sn] || [], totals[sn]);
    setCoverage[sn] = Math.round(h.coverage * 100) / 100;
    if (h.coverage >= MIN_SET_COVERAGE) {
      setMethods[sn] = 'history';
      perSet[sn] = h.counts;
      for (const [u, t] of Object.entries(h.teams)) {
        if (!info[u]) {
          info[u] = { name: u, num: '', role: '', team: t };
          warnings.push(`сет ${sn}: игрок ${u} не найден в составе`);
        } else if (!info[u].team) {
          info[u].team = t;
        }
      }
    } else if (events) {
      setMethods[sn] = 'events';
      perSet[sn] = {};
      for (const [u, p] of Object.entries(events.players)) perSet[sn][u] = p.sets[sn] || 0;
    } else {
      // ни точных снимков, ни событий — считаем что есть и помечаем
      setMethods[sn] = 'history-partial';
      perSet[sn] = h.counts;
      warnings.push(`сет ${sn}: снимков только на ${Math.round(h.coverage * 100)}% розыгрышей и нет событий для запасного расчёта`);
    }
  }

  // ---------- итог ----------
  const players = {};
  for (const [uuid, p] of Object.entries(info)) {
    const sets = {};
    let total = 0;
    for (const sn of setNumbers) {
      sets[sn] = perSet[sn]?.[uuid] || 0;
      total += sets[sn];
    }
    players[uuid] = { name: p.name, num: p.num, role: p.role, team: p.team, sets, total };
  }

  const methodValues = new Set(Object.values(setMethods));
  let method = 'events';
  if (methodValues.size === 1 && methodValues.has('history')) method = 'history';
  else if (methodValues.has('history') || methodValues.has('history-partial')) method = 'mixed';
  const approxSets = setNumbers.filter(s => setMethods[s] !== 'history');
  // предупреждения расчёта по событиям (про либеро и т.п.) нужны, только если он где-то использован
  if (events && approxSets.length) warnings.push(...events.warnings);
  if (approxSets.length) {
    warnings.push(
      `сеты ${approxSets.join(', ')} посчитаны по событиям (нет снимков площадки): ` +
      `центральные и либеро в них завышены`
    );
  }

  return {
    complete: events ? events.complete : true,
    setNumbers,
    ralliesPerSet: totals,
    players,
    warnings,
    method,
    setMethods,
    setCoverage,
    approximate: approxSets.length > 0,
  };
}

// ======================= консольный режим =======================
function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function describeMatch(uuid, live, stats) {
  const meta = (live && live.meta) || {};
  const sets = stats.setNumbers.map(s => `с${s}:${stats.setMethods[s] === 'history' ? 'точно' : '≈'}`).join(' ');
  return `${pad(uuid.slice(0, 8), 9)}${pad(`${meta.team1Name || '?'} – ${meta.team2Name || '?'}`, 46)}${pad(stats.method, 8)}${sets}`;
}

async function loadFromFirebase(matchFilter) {
  const axios = require('axios');
  const get = async (p, query = '') => {
    try {
      // ".json" должен стоять сразу после пути, а параметры (?shallow=true) — после него
      return (await axios.get(`${FIREBASE_BASE_URL}/${p}.json${query}`, { timeout: 60000 })).data;
    } catch (e) {
      console.error(`  не удалось прочитать ${p}: ${e.message}`);
      return null;
    }
  };
  const shallow = await get('matches', '?shallow=true');
  if (!shallow || typeof shallow !== 'object' || Array.isArray(shallow)) {
    throw new Error('не удалось получить список матчей из Firebase (ответ не похож на список uuid)');
  }
  console.log(`Матчей в базе: ${Object.keys(shallow).length}`);
  const out = {};
  for (const uuid of Object.keys(shallow)) {
    if (matchFilter && !uuid.startsWith(matchFilter)) continue;
    const [live, history, rawState, stats] = await Promise.all([
      get(`matches/${uuid}/live`), get(`matches/${uuid}/history`), get(`matches/${uuid}/raw/state`), get(`matches/${uuid}/stats`),
    ]);
    out[uuid] = { live, history, raw: rawState ? { state: rawState } : null, stats };
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = {};
  for (const a of args) {
    if (a === '--write') opt.write = true;
    else if (a.startsWith('--file=')) opt.file = a.slice(7);
    else if (a.startsWith('--match=')) opt.match = a.slice(8);
  }
  if (opt.write && opt.file) {
    console.error('--write нельзя сочетать с --file: файл — это только выгрузка для проверки.');
    process.exit(1);
  }

  let matches;
  if (opt.file) {
    const data = JSON.parse(require('fs').readFileSync(opt.file, 'utf8'));
    matches = data.matches || data;
    if (opt.match) matches = Object.fromEntries(Object.entries(matches).filter(([u]) => u.startsWith(opt.match)));
  } else {
    console.log('Читаю Firebase (это может занять минуту)...');
    matches = await loadFromFirebase(opt.match);
  }

  const results = [];
  for (const [uuid, m] of Object.entries(matches)) {
    if (!m.history || !m.live) continue; // без снимков пересчитывать нечем — остаётся старая статистика
    const live = m.live;
    const stats = buildStats({
      state: m.raw && m.raw.state,
      history: m.history,
      liveRoster: live.roster,
      liveFinishedSets: live.live && live.live.finishedSets,
    });
    results.push({ uuid, live, old: m.stats || null, stats });
  }

  console.log(`\nМатчей со снимками: ${results.length} из ${Object.keys(matches).length}\n`);
  console.log(pad('матч', 9) + pad('команды', 46) + pad('способ', 8) + 'сеты');
  for (const r of results) console.log(describeMatch(r.uuid, r.live, r.stats) + (r.old ? '' : '   ← статистики не было'));

  const count = k => results.filter(r => r.stats.method === k).length;
  console.log(`\nТочно по всем сетам: ${count('history')},  частично: ${count('mixed')},  только по событиям: ${count('events')}`);

  if (!opt.write) {
    console.log('\nВ базу ничего не записано (запустите с --write, когда результат устроит).');
    return;
  }

  const axios = require('axios');
  const fs = require('fs');
  const backup = {};
  for (const r of results) if (r.old) backup[r.uuid] = r.old;
  const backupPath = `stats_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(backupPath, JSON.stringify(backup));
  console.log(`\nСтарая статистика сохранена в ${backupPath}`);

  let ok = 0;
  for (const r of results) {
    try {
      await axios.put(`${FIREBASE_BASE_URL}/matches/${r.uuid}/stats.json`, {
        computedAt: new Date().toISOString(),
        meta: (r.old && r.old.meta) || r.live.meta,
        ...r.stats,
      }, { timeout: 60000 });
      ok++;
    } catch (e) {
      console.error(`  ОШИБКА записи ${r.uuid}: ${e.message}`);
    }
  }
  console.log(`Записано: ${ok} из ${results.length}`);
}

if (require.main === module) {
  main().catch(e => { console.error('Ошибка:', e.message); process.exit(1); });
}

module.exports = { buildStats, rosterFromLive, MIN_SET_COVERAGE };
