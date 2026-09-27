/**
 * migrate_to_matches_schema.js
 * ------------------------------------------------------------------
 * Разовый перенос уже собранных данных из старой, разбросанной по пяти
 * веткам схемы (dvv_live, archive, match_stats, match_history, match_index)
 * в новую, единую: matches/{matchUuid}/{live, raw, stats, history, title}.
 *
 * Ничего не удаляет из старых веток — только копирует в новые. Старые
 * ветки можно будет удалить вручную в консоли Firebase после того, как
 * вы своими глазами проверите, что в matches/ всё на месте.
 *
 * Запуск:
 *   node migrate_to_matches_schema.js
 *
 * Можно запускать несколько раз подряд без вреда — каждый раз просто
 * перезаписывает те же самые пути теми же данными (кроме history — она
 * копируется только если matches/{uuid}/history ещё пустая, чтобы не
 * задваивать записи при повторном запуске).
 * ------------------------------------------------------------------
 */
'use strict';

const axios = require('axios');
const FIREBASE_BASE_URL = 'https://sams-score-3liga-default-rtdb.europe-west1.firebasedatabase.app';

async function getJson(path) {
  try {
    const res = await axios.get(`${FIREBASE_BASE_URL}/${path}.json`, { timeout: 30000 });
    return res.data;
  } catch (e) {
    console.error(`  не удалось прочитать ${path}:`, e.message);
    return null;
  }
}

async function putJson(path, value) {
  try {
    await axios.put(`${FIREBASE_BASE_URL}/${path}.json`, value, { timeout: 30000 });
    return true;
  } catch (e) {
    const detail = e.response ? `${e.response.status} ${JSON.stringify(e.response.data)}` : e.message;
    console.error(`    ОШИБКА записи ${path}: ${detail}`);
    return false;
  }
}

async function main() {
  console.log('Читаю старые ветки...');
  const [dvvLive, archive, matchStats, matchHistory, matchIndex] = await Promise.all([
    getJson('dvv_live'),
    getJson('archive'),
    getJson('match_stats'),
    getJson('match_history'),
    getJson('match_index'),
  ]);

  const allUuids = new Set([
    ...Object.keys(dvvLive || {}),
    ...Object.keys(archive || {}),
    ...Object.keys(matchStats || {}),
    ...Object.keys(matchHistory || {}),
    ...Object.keys(matchIndex || {}),
  ]);

  console.log(`Найдено матчей во всех старых ветках: ${allUuids.size}`);

  const failed = [];

  for (const uuid of allUuids) {
    console.log(`\n[${uuid}]`);
    try {
      const title = matchIndex?.[uuid];
      const live = dvvLive?.[uuid];
      const raw = archive?.[uuid];
      const stats = matchStats?.[uuid];
      const history = matchHistory?.[uuid];

      let ok = true;
      if (title !== undefined) ok = (await putJson(`matches/${uuid}/title`, title)) && ok;
      if (live) ok = (await putJson(`matches/${uuid}/live`, live)) && ok;
      if (raw) ok = (await putJson(`matches/${uuid}/raw`, raw)) && ok;
      if (stats) ok = (await putJson(`matches/${uuid}/stats`, stats)) && ok;

      if (history) {
        const existing = await getJson(`matches/${uuid}/history`);
        if (existing) {
          console.log('  history: в matches/ уже что-то есть — пропускаю, чтобы не задвоить');
        } else {
          const historyOk = await putJson(`matches/${uuid}/history`, history);
          ok = historyOk && ok;
          if (historyOk) console.log(`  history перенесена (${Object.keys(history).length} слепков)`);
        }
      }

      if (ok) {
        console.log('  готово');
      } else {
        failed.push(uuid);
      }
    } catch (e) {
      console.error(`  НЕОЖИДАННАЯ ОШИБКА по этому матчу: ${e.message} — иду дальше`);
      failed.push(uuid);
    }
  }

  console.log('\n=== Готово. Проверьте matches/ в консоли Firebase. ===');
  if (failed.length) {
    console.log(`С проблемами (см. подробности выше по каждому): ${failed.length} из ${allUuids.size}`);
    failed.forEach(u => console.log(`  - ${u}`));
  } else {
    console.log('Все матчи перенесены без ошибок.');
  }
  console.log('Старые ветки (dvv_live, archive, match_stats, match_history, match_index)');
  console.log('можно удалить вручную, когда убедитесь, что всё перенеслось верно.');
}

main().catch(e => { console.error('Ошибка миграции:', e.message); process.exit(1); });
