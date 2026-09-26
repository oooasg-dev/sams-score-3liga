/**
 * dvv_find_match.js
 * ------------------------------------------------------------------
 * Помогает найти matchUuid нужного матча среди ~200+ матчей по всей
 * Германии, не открывая сайт руками.
 *
 * Запуск:
 *   node dvv_find_match.js "TV Baden"
 *   node dvv_find_match.js "TV Baden" "Essen"     (сузить по обеим командам)
 *
 * Выводит список кандидатов: дату/время, обе команды, лигу, matchUuid.
 * ------------------------------------------------------------------
 */

const axios = require('axios');

const LEAGUE = process.env.DVV_LEAGUE || 'dvv';
const TICKER_URL = `https://backend.sams-ticker.de/live/indoor/tickers/${LEAGUE}`;

function norm(s) {
  return (s || '').toLowerCase();
}

async function main() {
  const args = process.argv.slice(2).map(norm);
  if (args.length === 0) {
    console.error('Использование: node dvv_find_match.js "название команды" ["вторая команда"]');
    process.exit(1);
  }

  const { data } = await axios.get(TICKER_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    timeout: 30000,
  });

  const results = [];
  for (const day of data.matchDays || []) {
    for (const m of day.matches || []) {
      const t1 = norm(m.teamDescription1);
      const t2 = norm(m.teamDescription2);
      const matchesAll = args.every(a => t1.includes(a) || t2.includes(a));
      if (matchesAll) {
        const league = (data.matchSeries && data.matchSeries[m.matchSeries]) || {};
        results.push({
          id: m.id,
          date: new Date(m.date).toLocaleString('de-DE'),
          team1: m.teamDescription1,
          team2: m.teamDescription2,
          league: league.name || m.matchSeries,
        });
      }
    }
  }

  if (results.length === 0) {
    console.log('Ничего не найдено. Проверьте написание названия команды (как оно записано на сайте DVV).');
    return;
  }

  console.log(`Найдено совпадений: ${results.length}\n`);
  results
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .forEach(r => {
      console.log(`${r.date}  |  ${r.team1}  vs  ${r.team2}  |  ${r.league}`);
      console.log(`  matchUuid: ${r.id}\n`);
    });
}

main().catch(err => {
  console.error('Ошибка:', err.message);
  process.exit(1);
});
