import test from 'node:test';
import assert from 'node:assert/strict';
import { runReport, sendMessage } from './collect.js';

// Мок httpRequest: отвечает по методу в URL и по наличию фильтра.
function makeHttp({ users, closedTasks, deadlineTasks, elapsed = [], historyByTask = {} }) {
  const calls = [];
  return {
    calls,
    http: async ({ url, body }) => {
      calls.push({ url, body });
      if (url.includes('user.get')) {
        // одна страница, без next
        return { result: users, total: users.length };
      }
      if (url.includes('tasks.task.list')) {
        const isClosed = '>=CLOSED_DATE' in body.filter;
        const data = isClosed ? closedTasks : deadlineTasks;
        // Пагинация: если start=0 и есть вторая страница-заглушка — вернём next.
        if (body.start === 0) {
          return { result: { tasks: data }, total: data.length };
        }
        return { result: { tasks: [] } };
      }
      if (url.includes('task.elapseditem.getlist')) {
        const page = body.PARAMS?.NAV_PARAMS?.iNumPage || 1;
        const size = body.PARAMS?.NAV_PARAMS?.nPageSize || 50;
        const chunk = elapsed.slice((page - 1) * size, page * size);
        return { result: chunk, total: elapsed.length };
      }
      if (url.includes('tasks.task.history.list')) {
        const list = historyByTask[body.taskId] || [];
        return { result: { list } };
      }
      throw new Error(`unexpected url ${url}`);
    },
  };
}

const config = {
  webhookBaseUrl: 'https://portal.bitrix24.ru/rest/1/TOKEN',
  managerDialogId: 42,
  mode: 'custom',
  start: '2026-08-01T00:00:00+03:00',
  end: '2026-09-01T00:00:00+03:00',
};

test('runReport: собирает отчёт из двух выборок, дедуп по id', async () => {
  const { http, calls } = makeHttp({
    users: [
      { ID: '7', NAME: 'Иван', LAST_NAME: 'Иванов' },
      { ID: '9', NAME: 'Пётр', LAST_NAME: 'Петров' },
    ],
    // Задача 101 присутствует в ОБЕИХ выборках (закрыта в срок, дедлайн в периоде)
    closedTasks: [
      { id: '101', responsibleId: '7', accomplices: ['9'], status: '5', deadline: '2026-08-20T18:00:00+03:00', closedDate: '2026-08-19T10:00:00+03:00' },
    ],
    deadlineTasks: [
      { id: '101', responsibleId: '7', accomplices: ['9'], status: '5', deadline: '2026-08-20T18:00:00+03:00', closedDate: '2026-08-19T10:00:00+03:00' },
      { id: '102', responsibleId: '7', accomplices: [], status: '3', deadline: '2026-08-10T18:00:00+03:00', closedDate: null },
    ],
  });

  const res = await runReport({ config, httpRequest: http });

  assert.equal(res.dialogId, 42);
  assert.equal(res.tasksCount, 2); // 101 не задвоилась
  assert.match(res.message, /Иванов/);
  assert.match(res.message, /Петров/);

  const ivanov = res.rows.find((r) => r.userId === 7);
  assert.equal(ivanov.responsible.completed, 1); // 101
  assert.equal(ivanov.responsible.due, 2); // 101 + 102
  assert.equal(ivanov.responsible.overdue, 1); // 102

  // Были вызовы: user.get + tasks.task.list (closed) + tasks.task.list (deadline)
  assert.ok(calls.some((c) => c.url.includes('user.get')));
  assert.equal(calls.filter((c) => c.url.includes('tasks.task.list')).length, 2);
});

test('runReport: пустой портал → отчёт без падения', async () => {
  const { http } = makeHttp({ users: [], closedTasks: [], deadlineTasks: [] });
  const res = await runReport({ config, httpRequest: http });
  assert.equal(res.tasksCount, 0);
  assert.match(res.message, /нет данных/i);
});

test('callMethod: ошибка Битрикса прокидывается с error_description и именем метода', async () => {
  const http = async () => {
    const e = new Error('Request failed with status code 403');
    e.response = { data: { error: 'insufficient_scope', error_description: 'Требуются права выше' } };
    throw e;
  };
  await assert.rejects(
    runReport({ config, httpRequest: http }),
    (e) => /user\.get failed/.test(e.message) && /Требуются права выше/.test(e.message),
  );
});

test('runReport: время из elapseditem суммируется по пользователям (с пагинацией)', async () => {
  // 60 записей: 55 по Иванову (7) по 600 сек, 5 по Петрову (9) по 1200 сек → 2 страницы
  const elapsed = [
    ...Array.from({ length: 55 }, (_, i) => ({ ID: String(i + 1), USER_ID: '7', TASK_ID: '101', SECONDS: '600' })),
    ...Array.from({ length: 5 }, (_, i) => ({ ID: String(100 + i), USER_ID: '9', TASK_ID: '102', SECONDS: '1200' })),
  ];
  const { http, calls } = makeHttp({
    users: [{ ID: '7', NAME: 'Иван', LAST_NAME: 'Иванов' }, { ID: '9', NAME: 'Пётр', LAST_NAME: 'Петров' }],
    closedTasks: [],
    deadlineTasks: [],
    elapsed,
  });
  const res = await runReport({ config, httpRequest: http });
  const ivanov = res.rows.find((r) => r.userId === 7);
  const petrov = res.rows.find((r) => r.userId === 9);
  assert.equal(ivanov.timeSpentSeconds, 55 * 600);
  assert.equal(petrov.timeSpentSeconds, 5 * 1200);
  // Пагинация NAV_PARAMS: должно быть ≥2 вызова elapseditem
  const elapsedCalls = calls.filter((c) => c.url.includes('elapseditem'));
  assert.ok(elapsedCalls.length >= 2);
  // Старый API: аргументы позиционные (ORDER, FILTER, SELECT, PARAMS) — SELECT
  // обязан присутствовать, иначе PARAMS съезжает на его место (TASKS_ERROR #256).
  for (const c of elapsedCalls) {
    assert.ok(Array.isArray(c.body.SELECT), 'SELECT должен быть массивом');
    assert.ok(c.body.PARAMS, 'PARAMS должен присутствовать');
  }
});

test('runReport: переносы дедлайнов считаются из истории и попадают исполнителю', async () => {
  const deadlineTasks = [
    { id: '101', responsibleId: '7', accomplices: [], status: '3', deadline: '2026-08-20T18:00:00+03:00', closedDate: null },
    { id: '102', responsibleId: '9', accomplices: [], status: '3', deadline: '2026-08-25T18:00:00+03:00', closedDate: null },
  ];
  const historyByTask = {
    101: [
      // два реальных переноса + первоначальная установка (from пустой — не перенос)
      { id: '1', field: 'DEADLINE', value: { from: '', to: '2026-08-10T18:00:00+03:00' } },
      { id: '2', field: 'DEADLINE', value: { from: '2026-08-10T18:00:00+03:00', to: '2026-08-15T18:00:00+03:00' } },
      { id: '3', field: 'DEADLINE', value: { from: '2026-08-15T18:00:00+03:00', to: '2026-08-20T18:00:00+03:00' } },
    ],
    102: [],
  };
  const { http } = makeHttp({
    users: [{ ID: '7', NAME: 'Иван', LAST_NAME: 'Иванов' }, { ID: '9', NAME: 'Пётр', LAST_NAME: 'Петров' }],
    closedTasks: [],
    deadlineTasks,
    historyByTask,
  });
  const res = await runReport({ config, httpRequest: http });
  const ivanov = res.rows.find((r) => r.userId === 7);
  const petrov = res.rows.find((r) => r.userId === 9);
  assert.equal(ivanov.deadlineShifts, 2); // установка дедлайна переносом не считается
  assert.equal(ivanov.tasksRescheduled, 1);
  assert.equal(petrov.deadlineShifts, 0);
});

test('runReport: возвраты на доработку считаются из истории статусов за период', async () => {
  const deadlineTasks = [
    { id: '101', responsibleId: '7', accomplices: ['9'], status: '3', deadline: '2026-08-20T18:00:00+03:00', closedDate: null },
  ];
  const historyByTask = {
    101: [
      // отправка на контроль — НЕ возврат
      { id: '1', field: 'STATUS', value: { from: '2', to: '4' }, createdDate: '2026-08-05T10:00:00+03:00' },
      // возврат с контроля в работу — возврат ✓
      { id: '2', field: 'STATUS', value: { from: '4', to: '2' }, createdDate: '2026-08-06T10:00:00+03:00' },
      // переоткрытие завершённой задачи — тоже возврат ✓
      { id: '3', field: 'STATUS', value: { from: '5', to: '2' }, createdDate: '2026-08-07T10:00:00+03:00' },
      // возврат ВНЕ расчётного периода — не считается
      { id: '4', field: 'STATUS', value: { from: '4', to: '2' }, createdDate: '2026-07-06T10:00:00+03:00' },
    ],
  };
  const { http, calls } = makeHttp({
    users: [{ ID: '7', NAME: 'Иван', LAST_NAME: 'Иванов' }, { ID: '9', NAME: 'Пётр', LAST_NAME: 'Петров' }],
    closedTasks: [],
    deadlineTasks,
    historyByTask,
  });
  const res = await runReport({ config, httpRequest: http });
  const ivanov = res.rows.find((r) => r.userId === 7);
  const petrov = res.rows.find((r) => r.userId === 9);

  assert.equal(ivanov.returns, 2);
  // Кид: Зплан=1, Зсрок=0, Звозв=2 → 0/1 − 0.3×2/1 = −0.6 → 0
  assert.equal(ivanov.kid, 0);
  // Возвраты не достаются соисполнителю
  assert.equal(petrov.returns, 0);

  // История запрашивается БЕЗ фильтра по полю: один запрос даёт и DEADLINE, и STATUS
  const historyCalls = calls.filter((c) => c.url.includes('history'));
  assert.ok(historyCalls.length > 0);
  for (const c of historyCalls) {
    assert.equal(c.body.filter?.FIELD, undefined);
  }
});

test('runReport: история сканирует и закрытые в периоде задачи без дедлайна в периоде', async () => {
  const closedTasks = [
    { id: '201', responsibleId: '7', accomplices: [], status: '5', deadline: null, closedDate: '2026-08-10T12:00:00+03:00' },
  ];
  const historyByTask = {
    201: [{ id: '1', field: 'STATUS', value: { from: '5', to: '2' }, createdDate: '2026-08-09T10:00:00+03:00' }],
  };
  const { http, calls } = makeHttp({
    users: [{ ID: '7', NAME: 'Иван', LAST_NAME: 'Иванов' }],
    closedTasks,
    deadlineTasks: [],
    historyByTask,
  });
  const res = await runReport({ config, httpRequest: http });
  assert.equal(res.rows.find((r) => r.userId === 7).returns, 1);
  assert.ok(calls.some((c) => c.url.includes('history') && String(c.body.taskId) === '201'));
});

test('runReport: при лимите истории задачи с дедлайном в периоде сканируются первыми', async () => {
  const closedTasks = [
    { id: '201', responsibleId: '7', accomplices: [], status: '5', deadline: null, closedDate: '2026-08-10T12:00:00+03:00' },
  ];
  const deadlineTasks = [
    { id: '101', responsibleId: '7', accomplices: [], status: '3', deadline: '2026-08-20T18:00:00+03:00', closedDate: null },
  ];
  const { http, calls } = makeHttp({
    users: [{ ID: '7', NAME: 'Иван', LAST_NAME: 'Иванов' }],
    closedTasks,
    deadlineTasks,
  });
  const res = await runReport({ config: { ...config, maxHistoryTasks: 1 }, httpRequest: http });
  const historyCalls = calls.filter((c) => c.url.includes('history'));
  assert.equal(historyCalls.length, 1);
  assert.equal(String(historyCalls[0].body.taskId), '101'); // дедлайновая — приоритет
  assert.equal(res.historySkipped, 1);
});

test('runReport: collectTime/collectDeadlineShifts = false отключают доп. запросы', async () => {
  const { http, calls } = makeHttp({
    users: [{ ID: '7', NAME: 'Иван', LAST_NAME: 'Иванов' }],
    closedTasks: [],
    deadlineTasks: [{ id: '101', responsibleId: '7', accomplices: [], status: '3', deadline: '2026-08-20T18:00:00+03:00', closedDate: null }],
  });
  await runReport({ config: { ...config, collectTime: false, collectDeadlineShifts: false }, httpRequest: http });
  assert.equal(calls.filter((c) => c.url.includes('elapseditem')).length, 0);
  assert.equal(calls.filter((c) => c.url.includes('history')).length, 0);
});

test('runReport: maxHistoryTasks ограничивает число запросов истории', async () => {
  const deadlineTasks = Array.from({ length: 10 }, (_, i) => ({
    id: String(200 + i), responsibleId: '7', accomplices: [], status: '3',
    deadline: '2026-08-20T18:00:00+03:00', closedDate: null,
  }));
  const { http, calls } = makeHttp({
    users: [{ ID: '7', NAME: 'Иван', LAST_NAME: 'Иванов' }],
    closedTasks: [],
    deadlineTasks,
  });
  const res = await runReport({ config: { ...config, maxHistoryTasks: 3 }, httpRequest: http });
  assert.equal(calls.filter((c) => c.url.includes('history')).length, 3);
  assert.equal(res.historySkipped, 7);
});

test('runReport: в выходе есть messageHtml', async () => {
  const { http } = makeHttp({
    users: [{ ID: '7', NAME: 'Иван', LAST_NAME: 'Иванов' }],
    closedTasks: [{ id: '101', responsibleId: '7', accomplices: [], status: '5', deadline: '2026-08-20T18:00:00+03:00', closedDate: '2026-08-19T10:00:00+03:00' }],
    deadlineTasks: [],
  });
  const res = await runReport({ config, httpRequest: http });
  assert.match(res.messageHtml, /<table/);
  assert.match(res.messageHtml, /Иванов/);
});

test('callMethod: 4xx с телом (returnFullResponse) → читаемая ошибка со scope', async () => {
  // Так отвечает n8n httpRequest с ignoreHttpStatusErrors: не бросает, а отдаёт body.
  const http = async () => ({
    statusCode: 401,
    body: { error: 'insufficient_scope', error_description: 'The request requires higher privileges' },
  });
  await assert.rejects(
    runReport({ config, httpRequest: http }),
    (e) => /user\.get failed/.test(e.message) && /higher privileges/.test(e.message),
  );
});

test('callMethod: голый 4xx без тела → ошибка с кодом статуса', async () => {
  const http = async () => ({ statusCode: 502, body: undefined });
  await assert.rejects(
    runReport({ config, httpRequest: http }),
    (e) => /user\.get failed: HTTP 502/.test(e.message),
  );
});

test('sendMessage: вызывает im.message.add с DIALOG_ID и MESSAGE', async () => {
  const calls = [];
  const http = async (opts) => { calls.push(opts); return { result: 555 }; };
  const resp = await sendMessage(http, 'https://portal.bitrix24.ru/rest/1/TOKEN', 42, 'Привет');
  assert.equal(resp.result, 555);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /im\.message\.add\.json$/);
  assert.equal(calls[0].body.DIALOG_ID, 42);
  assert.equal(calls[0].body.MESSAGE, 'Привет');
});
