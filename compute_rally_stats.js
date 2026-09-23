/**
 * compute_rally_stats.js
 * ------------------------------------------------------------------
 * Модуль 3 (статистика): считает, сколько розыгрышей сыграл каждый
 * игрок в каждом сете, по сырому matchStates[matchUuid] из фида DVV.
 * Порт reconstruct_stats.py, без привязки к конкретному матчу.
 *
 * Использование как модуль:
 *   const { computeRallyStats } = require('./compute_rally_stats');
 *   const stats = computeRallyStats(feed.matchStates[matchUuid]);
 *
 * Использование из консоли (проверка на сохранённом ответе фида):
 *   node compute_rally_stats.js Response.txt <matchUuid> [Team1Name] [Team2Name]
 *
 * Результат:
 *   {
 *     complete: bool,                 // матч завершён (finished)
 *     setNumbers: [1,2,...],
 *     ralliesPerSet: {1: 48, ...},
 *     players: {
 *       [uuid]: { name, num, role, team, sets: {1: n, ...}, total }
 *     },
 *     warnings: [ ... ]               // всё, что стоит проверить глазами
 *   }
 * ------------------------------------------------------------------
 */
'use strict';

const POSITION_MAP = {
  SETTER: 'Z',
  OPPOSITE: 'D',
  MIDDLE_BLOCKER: 'MB',
  WING_SPIKER: 'AA',
  LIBERO: 'L',
};

const TEAMS = ['team1', 'team2'];

function fullName(p) {
  return `${p.firstName || ''} ${p.lastName || ''}`.trim();
}

function rallyIndex(setScore) {
  return (setScore?.team1 || 0) + (setScore?.team2 || 0);
}

function computeRallyStats(state) {
  const warnings = [];
  const events = [...(state.eventHistory || [])].sort((a, b) => a.timestamp - b.timestamp);

  // ---------- составы и роли ----------
  const roster = {};
  const liberoUuids = { team1: new Set(), team2: new Set() };

  for (const teamCode of TEAMS) {
    const sq = events.filter(e => e.type === 'CONFIRM_TEAMSQUAD' && e.teamCode === teamCode);
    if (sq.length === 0) {
      warnings.push(`${teamCode}: нет события CONFIRM_TEAMSQUAD, состав неизвестен`);
      continue;
    }
    const squad = sq[sq.length - 1].teamSquad || {};
    for (const p of squad.players || []) {
      roster[p.uuid] = {
        name: fullName(p),
        num: p.jerseyNumber || '',
        role: POSITION_MAP[p.position] || p.position || '',
        team: teamCode,
      };
      // в заявке либеро может дублироваться и в players, и в liberos
      if (p.position === 'LIBERO') liberoUuids[teamCode].add(p.uuid);
    }
    for (const p of squad.liberos || []) {
      roster[p.uuid] = { name: fullName(p), num: p.jerseyNumber || '', role: 'L', team: teamCode };
      liberoUuids[teamCode].add(p.uuid);
    }
  }

  // ---------- границы сетов ----------
  const startMatch = events.find(e => e.type === 'START_MATCH');
  if (!startMatch) {
    return { complete: false, setNumbers: [], ralliesPerSet: {}, players: {}, warnings: ['нет START_MATCH'] };
  }
  const setStarts = [{ setNumber: 1, ts: startMatch.timestamp, lineups: startMatch.lineups }];
  for (const e of events) {
    if (e.type === 'START_SET') setStarts.push({ setNumber: e.setNumber, ts: e.timestamp, lineups: e.lineups });
  }
  setStarts.sort((a, b) => a.ts - b.ts);

  const bounds = setStarts.map((s, i) => ({
    ...s,
    endTs: i + 1 < setStarts.length ? setStarts[i + 1].ts : Infinity,
  }));

  const finalSets = {};
  for (const s of state.matchSets || []) finalSets[s.setNumber] = s.setScore;

  const counts = {}; // uuid -> {setNumber: rallies}
  const ensure = u => {
    if (!counts[u]) counts[u] = {};
    return counts[u];
  };
  Object.keys(roster).forEach(ensure);

  const liberoSeen = { team1: {}, team2: {} }; // setNumber -> uuid
  const rallies = {};

  // ---------- по сетам ----------
  for (const b of bounds) {
    const score = finalSets[b.setNumber];
    if (!score) {
      warnings.push(`сет ${b.setNumber}: нет итогового счёта в matchSets, пропущен`);
      continue;
    }
    const totalRallies = score.team1 + score.team2;
    rallies[b.setNumber] = totalRallies;

    const subsInSet = events.filter(e => e.type === 'SUBSTITUTION' && e.timestamp >= b.ts && e.timestamp < b.endTs);

    for (const teamCode of TEAMS) {
      const startLineup = b.lineups?.[teamCode]?.playerUuids;
      if (!startLineup) {
        warnings.push(`сет ${b.setNumber} ${teamCode}: нет стартовой расстановки`);
        continue;
      }
      const currentSix = [...startLineup];
      let cursor = 0;

      const teamSubs = subsInSet
        .filter(e => e.teamCode === teamCode)
        .sort((a, b2) => rallyIndex(a.setScore) - rallyIndex(b2.setScore) || a.timestamp - b2.timestamp);

      // где по снимкам расстановки виден либеро
      const snapshots = [startLineup, ...teamSubs.map(e => e.lineup?.playerUuids || [])];
      for (const snap of snapshots) {
        for (const u of snap) {
          if (liberoUuids[teamCode].has(u)) liberoSeen[teamCode][b.setNumber] ??= u;
        }
      }
      // запасной вариант: defaultLiberoUuid, если поле есть (формат не проверен на живых данных)
      const defLib = b.lineups?.[teamCode]?.defaultLiberoUuid;
      if (defLib && liberoUuids[teamCode].has(defLib)) liberoSeen[teamCode][b.setNumber] ??= defLib;

      for (const sub of teamSubs) {
        const idx = rallyIndex(sub.setScore);
        const seg = idx - cursor;
        for (const u of currentSix) ensure(u)[b.setNumber] = (ensure(u)[b.setNumber] || 0) + seg;

        const outPos = currentSix.indexOf(sub.playerOutUuid);
        if (outPos >= 0) {
          currentSix.splice(outPos, 1);
        } else {
          warnings.push(
            `сет ${b.setNumber} ${teamCode}: при замене на ${idx}-м розыгрыше уходящий игрок не найден в шестёрке ` +
            `(вероятно, его заменял либеро) — проверить`
          );
        }
        currentSix.push(sub.playerInUuid);
        cursor = idx;
      }

      const seg = totalRallies - cursor;
      for (const u of currentSix) ensure(u)[b.setNumber] = (ensure(u)[b.setNumber] || 0) + seg;
    }

    // либеро: 100% сета, если он в этом сете использовался
    for (const teamCode of TEAMS) {
      const lib = liberoSeen[teamCode][b.setNumber];
      if (lib) ensure(lib)[b.setNumber] = totalRallies;
    }
  }

  const setNumbers = Object.keys(rallies).map(Number).sort((a, b) => a - b);

  // правило единственного либеро: 100% всех сыгранных сетов
  for (const teamCode of TEAMS) {
    if (liberoUuids[teamCode].size === 1) {
      const lib = [...liberoUuids[teamCode]][0];
      for (const s of setNumbers) ensure(lib)[s] = rallies[s];
    } else if (liberoUuids[teamCode].size > 1) {
      warnings.push(
        `${teamCode}: в заявке ${liberoUuids[teamCode].size} либеро — сеты без снимков расстановки ` +
        `определить нельзя, цифры по либеро могут быть неполными`
      );
    }
  }

  // ---------- итог ----------
  const players = {};
  for (const [uuid, perSet] of Object.entries(counts)) {
    const info = roster[uuid] || { name: uuid, num: '', role: '', team: null };
    const sets = {};
    let total = 0;
    for (const s of setNumbers) {
      sets[s] = perSet[s] || 0;
      total += sets[s];
    }
    players[uuid] = { ...info, sets, total };
  }

  return { complete: !!state.finished, setNumbers, ralliesPerSet: rallies, players, warnings };
}

// ---------- консольный режим ----------
function printTable(stats, teamNames) {
  for (const teamCode of TEAMS) {
    console.log(`\n=== ${teamNames[teamCode] || teamCode} ===`);
    console.log(['Ном', 'Игрок'.padEnd(24), 'Ампл', ...stats.setNumbers.map(s => `Сет${s}`), 'Всего'].join('\t'));
    Object.values(stats.players)
      .filter(p => p.team === teamCode)
      .sort((a, b) => Number(a.num || 999) - Number(b.num || 999))
      .forEach(p => {
        console.log([p.num, p.name.padEnd(24), p.role, ...stats.setNumbers.map(s => p.sets[s]), p.total].join('\t'));
      });
  }
  if (stats.warnings.length) {
    console.log('\nПРЕДУПРЕЖДЕНИЯ:');
    stats.warnings.forEach(w => console.log(' - ' + w));
  }
}

if (require.main === module) {
  const fs = require('fs');
  const [file, matchUuid, n1, n2] = process.argv.slice(2);
  if (!file || !matchUuid) {
    console.error('Использование: node compute_rally_stats.js <файл_фида.json> <matchUuid> [Команда1] [Команда2]');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  // поддерживаем и полный фид, и сохранённый в archive/ один state
  const state = data.matchStates ? data.matchStates[matchUuid] : data;
  if (!state) {
    console.error('matchUuid не найден в файле');
    process.exit(1);
  }
  printTable(computeRallyStats(state), { team1: n1, team2: n2 });
}

module.exports = { computeRallyStats };
