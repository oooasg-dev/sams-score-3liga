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

  console.log('URL:', TICKER_URL);
  console.log('Ищем:', args.join(' + '));

  const { data, status, headers } = await axios.get(TICKER_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    timeout: 30000,
  });

  // --- Диагностика ---
  const days = (data && data.matchDays) || [];
  const totalMatches = days.reduce((n, d) => n + ((d.matches || []).length), 0);
  console.log('HTTP status:', status);
  console.log('Content-Type:', headers && headers['content-type']);
  console.log('Ключи ответа:', Object.keys(data || {}));
  console.log('Игровых дней:', days.length);
  console.log('Всего матчей:', totalMatches);
  if (days.length > 0) {
    const firstDate = days[0].matches && days[0].matches[0] && days[0].matches[0].date;
    const lastDay = days[days.length - 1];
    const lastDate = lastDay.matches && lastDay.matches[0] && lastDay.matches[0].date;
    console.log('Первый день в тикере:', firstDate ? new Date(firstDate).toLocaleString('de-DE') : '?');
    console.log('Последний день в тикере:', lastDate ? new Date(lastDate).toLocaleString('de-DE') : '?');
  }
  if (totalMatches === 0) {
    console.log('Начало ответа:', JSON.stringify(data).slice(0, 500));
  }
  console.log('');
  // --- Конец диагностики ---

  const results = [];
  for (const day of days) {
    for (const m of day.matches || []) {
      const t1 = norm(m.teamDescription1);
      const t2 = norm(m.teamDescription2);
      const matchesAll = args.every(a => t1.includes(a) || t2.includes(a));
      if (matchesAll) {
        const league = (data.matchSeries && data.matchSeries[m.matchSeries]) || {};
        results.push({
          id: m.id,
          ts: new Date(m.date).getTime(),
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
    .sort((a, b) => a.ts - b.ts)
    .forEach(r => {
      console.log(`${r.date}  |  ${r.team1}  vs  ${r.team2}  |  ${r.league}`);
      console.log(`  matchUuid: ${r.id}\n`);
    });
}

main().catch(err => {
  console.error('Ошибка:', err.message);
  if (err.response) {
    console.error('HTTP status:', err.response.status);
    console.error('Тело ответа:', JSON.stringify(err.response.data).slice(0, 500));
  } else if (err.code) {
    console.error('Код ошибки:', err.code);
  }
  process.exit(1);
});
