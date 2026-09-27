/**
 * report_team_player_stats.js
 * ------------------------------------------------------------------
 * Выборка по команде: список её матчей, по каждому игроку — сыграл ли он
 * в матче ("2 из 5"), сколько розыгрышей всего, с разбивкой по матчам
 * и по сетам внутри матча. Источник — matches/{matchUuid}/stats, которые
 * уже пишет мост/слушатель при завершении каждого матча (единая схема,
 * см. ТЗ v2 — раньше это лежало в отдельной ветке match_stats).
 *
 * Работает в двух режимах:
 *
 * 1) На уже скачанном экспорте базы (для проверки без интернета):
 *      node report_team_player_stats.js --file=export.json "TV Baden"
 *    Файл может быть новым экспортом (с ключом "matches"), старым экспортом
 *    (с ключом "match_stats") либо просто объектом { matchUuid: {...}, ... }.
 *
 * 2) Напрямую из Firebase (данные всегда свежие):
 *      node report_team_player_stats.js "TV Baden"
 *    (сначала узнаёт список matchUuid, потом читает matches/{uuid}/stats
 *    по каждому — так не скачивается тяжёлый raw/history)
 *
 * Команда ищется по названию (без учёта регистра, по точному совпадению
 * с team1Name/team2Name из meta каждого матча). Если в будущем в meta
 * появится team1Id/team2Id — можно передать --id=UUID вместо названия,
 * это надёжнее (название иногда пишут по-разному).
 * ------------------------------------------------------------------
 */
'use strict';

const FIREBASE_BASE_URL = 'https://sams-score-3liga-default-rtdb.europe-west1.firebasedatabase.app';

function normalize(s) {
  return (s || '').trim().toLowerCase();
}

/**
 * matchStats: { matchUuid: { meta, complete, setNumbers, ralliesPerSet, players, warnings } }
 * teamQuery: { name } или { id }
 */
function buildTeamReport(matchStats, teamQuery) {
  const matches = [];
  for (const [matchUuid, m] of Object.entries(matchStats || {})) {
    const meta = m.meta || {};
    let side = null;
    if (teamQuery.id) {
      if (meta.team1Id === teamQuery.id) side = 'team1';
      else if (meta.team2Id === teamQuery.id) side = 'team2';
    } else {
      if (normalize(meta.team1Name) === normalize(teamQuery.name)) side = 'team1';
      else if (normalize(meta.team2Name) === normalize(teamQuery.name)) side = 'team2';
    }
    if (!side) continue;
    const opponentSide = side === 'team1' ? 'team2' : 'team1';
    matches.push({
      matchUuid,
      side,
      teamName: side === 'team1' ? meta.team1Name : meta.team2Name,
      opponent: opponentSide === 'team1' ? meta.team1Name : meta.team2Name,
      kickoff: meta.kickoff || null,
      league: meta.league || meta.leagueShort || null,
      setNumbers: m.setNumbers || [],
      players: m.players || {},
      warnings: m.warnings || [],
    });
  }
  // сортируем по дате, если она есть
  matches.sort((a, b) => (a.kickoff || 0) - (b.kickoff || 0));

  const totalMatches = matches.length;
  const playersAgg = {}; // uuid -> агрегат

  for (const match of matches) {
    for (const [uuid, p] of Object.entries(match.players)) {
      if (p.team !== match.side) continue; // берём только игроков нужной команды в этом матче
      if (!playersAgg[uuid]) {
        playersAgg[uuid] = {
          uuid,
          name: p.name,
          num: p.num,
          role: p.role,
          matchesInSquad: 0,
          matchesPlayed: 0,
          totalRallies: 0,
          byMatch: [],
        };
      }
      const agg = playersAgg[uuid];
      agg.name = p.name; // обновляем на случай опечаток/уточнений между матчами
      agg.num = p.num;   // номер берём из самого свежего матча
      agg.role = p.role || agg.role;

      agg.matchesInSquad += 1;
      const played = (p.total || 0) > 0;
      if (played) agg.matchesPlayed += 1;
      agg.totalRallies += p.total || 0;
      // p.sets в Firebase может прийти и объектом {1:.., 2:..}, и массивом
      // (Firebase сам превращает объект с ключами 0,1,2... в массив при экспорте) —
      // поэтому берём значения строго по номерам сетов матча, а не через Object.entries.
      const bySet = {};
      for (const s of match.setNumbers) {
        bySet[s] = (p.sets && p.sets[s]) || 0;
      }
      agg.byMatch.push({
        matchUuid: match.matchUuid,
        opponent: match.opponent,
        kickoff: match.kickoff,
        num: p.num,
        total: p.total || 0,
        bySet,
      });
    }
  }

  const players = Object.values(playersAgg)
    .sort((a, b) => Number(a.num || 999) - Number(b.num || 999))
    .map(p => ({
      ...p,
      participation: `${p.matchesPlayed} из ${totalMatches}`,
    }));

  return {
    team: teamQuery.name || teamQuery.id,
    totalMatches,
    matches: matches.map(m => ({
      matchUuid: m.matchUuid, opponent: m.opponent, kickoff: m.kickoff, league: m.league, warnings: m.warnings,
    })),
    players,
  };
}

function printReport(report) {
  console.log(`\n=== ${report.team} — матчей в базе: ${report.totalMatches} ===`);
  report.matches.forEach((m, i) => {
    const when = m.kickoff ? new Date(m.kickoff).toLocaleString('ru-RU') : '';
    console.log(`  ${i + 1}. vs ${m.opponent}  ${when}  ${m.league || ''}`.trimEnd());
    if (m.warnings.length) m.warnings.forEach(w => console.log(`     ⚠ ${w}`));
  });

  console.log('\nНом\tИгрок'.padEnd(30) + '\tУчастие\tВсего розыгрышей\tПо матчам (сеты)');
  for (const p of report.players) {
    const byMatchStr = p.byMatch
      .map(bm => {
        const sets = Object.entries(bm.bySet).map(([s, n]) => `с${s}:${n}`).join(' ');
        return `[vs ${bm.opponent}: ${bm.total} (${sets})]`;
      })
      .join('  ');
    console.log(`${p.num}\t${p.name.padEnd(22)}\t${p.participation}\t${p.totalRallies}\t${byMatchStr}`);
  }
}

// ---------- запуск из консоли ----------
async function loadMatchStats(opts) {
  if (opts.file) {
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync(opts.file, 'utf8'));
    // Поддерживаем три формата на входе:
    //  1) новый экспорт целиком: { matches: { uuid: { stats: {...}, ... } } }
    //  2) старый экспорт целиком: { match_stats: { uuid: {...} } }
    //  3) уже готовый объект { uuid: {...} } (например, скачанный matches.json)
    if (data.matches) {
      const out = {};
      for (const [uuid, m] of Object.entries(data.matches)) {
        if (m && m.stats) out[uuid] = m.stats;
      }
      return out;
    }
    return data.match_stats || data;
  }
  const axios = require('axios');
  // Сначала узнаём, какие матчи вообще есть (shallow — не скачивая их целиком,
  // там могут быть тяжёлые raw/history), потом по каждому берём только stats.
  const shallowRes = await axios.get(`${FIREBASE_BASE_URL}/matches.json?shallow=true`, { timeout: 30000 });
  const uuids = Object.keys(shallowRes.data || {});
  const out = {};
  for (const uuid of uuids) {
    try {
      const res = await axios.get(`${FIREBASE_BASE_URL}/matches/${uuid}/stats.json`, { timeout: 30000 });
      if (res.data) out[uuid] = res.data;
    } catch (e) {
      // у матча может не быть stats, если он ещё не завершён — пропускаем
    }
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const opts = {};
  const rest = [];
  for (const a of args) {
    if (a.startsWith('--file=')) opts.file = a.slice('--file='.length);
    else if (a.startsWith('--id=')) opts.id = a.slice('--id='.length);
    else rest.push(a);
  }
  const teamName = rest.join(' ');
  if (!teamName && !opts.id) {
    console.error('Использование: node report_team_player_stats.js [--file=export.json] "Название команды"');
    console.error('           или: node report_team_player_stats.js --id=UUID-команды');
    process.exit(1);
  }
  const matchStats = await loadMatchStats(opts);
  const report = buildTeamReport(matchStats, opts.id ? { id: opts.id } : { name: teamName });
  printReport(report);

  // Плюс сохраняем report в JSON рядом — пригодится, если понадобится
  // построить из него что-то ещё (график, HTML-таблицу и т.д.).
  const fs = require('fs');
  const outPath = `team_report_${(opts.id || teamName).replace(/[^\w-]+/g, '_')}.json`;
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nПолный отчёт сохранён в ${outPath}`);
}

if (require.main === module) {
  main().catch(e => { console.error('Ошибка:', e.message); process.exit(1); });
}

module.exports = { buildTeamReport };
