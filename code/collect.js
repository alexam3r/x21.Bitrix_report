// Оркестрация сбора данных из Bitrix24 и формирования отчёта.
// httpRequest инъектируется (в n8n — this.helpers.httpRequest, в тестах — мок),
// поэтому модуль тестируется без живого портала.

import { computePeriod } from './period.js';
import { normalizeTask, aggregate, inPeriod } from './aggregate.js';
import { buildReport, buildReportHtml } from './report.js';

const TASK_SELECT = ['ID', 'RESPONSIBLE_ID', 'ACCOMPLICES', 'STATUS', 'DEADLINE', 'CLOSED_DATE', 'CREATED_DATE'];

// Один вызов REST-метода вебхука: <base>/<method>.json (POST JSON).
// ignoreHttpStatusErrors + returnFullResponse: в n8n 2.x Code-нода живёт в task
// runner'е, и исключение axios теряет response.data на RPC-границе — поэтому не
// бросаем на 4xx, а читаем тело сами и достаём error_description Битрикса.
async function callMethod(httpRequest, base, method, body) {
  const url = `${base.replace(/\/$/, '')}/${method}.json`;
  let resp;
  try {
    resp = await httpRequest({
      method: 'POST',
      url,
      body,
      json: true,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
    });
  } catch (err) {
    // Сетевая ошибка (DNS, таймаут) либо httpRequest без поддержки опций.
    const data = err && err.response && err.response.data ? err.response.data : {};
    const detail = data.error_description || data.error || (err && err.message) || 'unknown error';
    throw new Error(`Bitrix ${method} failed: ${detail}`);
  }

  // При returnFullResponse тело лежит в resp.body; моки/старые версии могут
  // вернуть данные как есть — поддерживаем оба варианта.
  const data = resp && resp.body !== undefined ? resp.body : resp;
  const status = resp && resp.statusCode !== undefined ? resp.statusCode : 200;

  if ((data && data.error) || status >= 400) {
    const detail = (data && (data.error_description || data.error)) || `HTTP ${status}`;
    throw new Error(`Bitrix ${method} failed: ${detail}`);
  }
  return data;
}

// Универсальная постраничная выборка. extract извлекает массив из result,
// пагинация — по полю next (offset). Ограничение на число страниц — предохранитель.
async function fetchAll(httpRequest, base, method, body, extract, maxPages = 200) {
  const out = [];
  let start = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const resp = await callMethod(httpRequest, base, method, { ...body, start });
    const chunk = extract(resp.result) || [];
    out.push(...chunk);
    if (resp.next === undefined || resp.next === null || chunk.length === 0) break;
    start = resp.next;
  }
  return out;
}

async function fetchUsers(httpRequest, base) {
  const raw = await fetchAll(
    httpRequest,
    base,
    'user.get',
    { FILTER: { ACTIVE: true, USER_TYPE: 'employee' } },
    (result) => (Array.isArray(result) ? result : []),
  );
  return raw.map((u) => ({
    id: Number(u.ID),
    name: [u.LAST_NAME, u.NAME].filter(Boolean).join(' ') || `ID ${u.ID}`,
  }));
}

// Учёт времени за период: task.elapseditem.getlist (старый стиль API —
// пагинация через PARAMS.NAV_PARAMS, не через start). Один проход по периоду,
// сумма секунд по каждому пользователю (кто залогировал — тому и время).
async function fetchTimeByUser(httpRequest, base, period, maxPages = 200) {
  const byUser = {};
  for (let page = 1; page <= maxPages; page += 1) {
    // Метод старого стиля: аргументы ПОЗИЦИОННЫЕ (ORDER, FILTER, SELECT, PARAMS).
    // SELECT обязателен, даже пустой — без него PARAMS съезжает на место select
    // и Битрикс отвечает TASKS_ERROR_EXCEPTION_#256 WRONG_ARGUMENTS.
    const resp = await callMethod(httpRequest, base, 'task.elapseditem.getlist', {
      ORDER: { ID: 'asc' },
      FILTER: { '>=CREATED_DATE': period.start, '<CREATED_DATE': period.end },
      SELECT: [],
      PARAMS: { NAV_PARAMS: { nPageSize: 50, iNumPage: page } },
    });
    const chunk = Array.isArray(resp && resp.result) ? resp.result : [];
    for (const rec of chunk) {
      const uid = Number(rec.USER_ID);
      byUser[uid] = (byUser[uid] || 0) + Number(rec.SECONDS || 0);
    }
    if (chunk.length < 50) break;
  }
  return byUser;
}

// Переносы дедлайна одной задачи из истории: пары from→to, где обе стороны
// непустые (первоначальная установка срока переносом не считается).
function countPostponements(entries) {
  let n = 0;
  for (const e of entries) {
    if (e.field !== 'DEADLINE') continue;
    const from = e.value && e.value.from;
    const to = e.value && e.value.to;
    if (from && to && from !== to) n += 1;
  }
  return n;
}

// История дедлайнов по списку задач (по одному запросу на задачу — дорого,
// поэтому есть верхний предел maxTasks; остаток честно возвращаем как skipped).
async function fetchDeadlineShifts(httpRequest, base, taskIds, maxTasks) {
  const shiftsByTaskId = {};
  const scanned = taskIds.slice(0, maxTasks);
  for (const taskId of scanned) {
    const resp = await callMethod(httpRequest, base, 'tasks.task.history.list', {
      taskId,
      filter: { FIELD: 'DEADLINE' },
    });
    const list = resp && resp.result && Array.isArray(resp.result.list) ? resp.result.list : [];
    const n = countPostponements(list);
    if (n > 0) shiftsByTaskId[taskId] = n;
  }
  return { shiftsByTaskId, skipped: taskIds.length - scanned.length };
}

async function fetchTasks(httpRequest, base, filter) {
  const raw = await fetchAll(
    httpRequest,
    base,
    'tasks.task.list',
    { filter, select: TASK_SELECT },
    // tasks.task.list отдаёт result.tasks; на всякий случай поддержим и массив.
    (result) => (result && Array.isArray(result.tasks) ? result.tasks : Array.isArray(result) ? result : []),
  );
  return raw;
}

// Главная функция. config: { webhookBaseUrl, managerDialogId, mode,
// timezoneOffset, start, end }. now инъектируется для детерминизма в тестах.
export async function runReport({ config, httpRequest, now = new Date() }) {
  const period = computePeriod(config.mode || 'month', now, config.timezoneOffset || '+03:00', {
    start: config.start,
    end: config.end,
  });

  const users = await fetchUsers(httpRequest, config.webhookBaseUrl);

  const closed = await fetchTasks(httpRequest, config.webhookBaseUrl, {
    '>=CLOSED_DATE': period.start,
    '<CLOSED_DATE': period.end,
  });
  const byDeadline = await fetchTasks(httpRequest, config.webhookBaseUrl, {
    '>=DEADLINE': period.start,
    '<DEADLINE': period.end,
  });

  // Объединяем две выборки и дедуплицируем по id.
  const map = new Map();
  for (const t of [...closed, ...byDeadline]) {
    const n = normalizeTask(t);
    map.set(n.id, n);
  }
  const tasks = [...map.values()];

  // Фаза 2: учтённое время (один пагинируемый запрос за период).
  const timeSecondsByUser =
    config.collectTime === false
      ? {}
      : await fetchTimeByUser(httpRequest, config.webhookBaseUrl, period);

  // Фаза 2: переносы дедлайнов из истории задач с дедлайном в периоде.
  let deadlineShiftsByTaskId = {};
  let historySkipped = 0;
  if (config.collectDeadlineShifts !== false) {
    const dueTaskIds = tasks.filter((t) => inPeriod(t.deadline, period)).map((t) => t.id);
    const { shiftsByTaskId, skipped } = await fetchDeadlineShifts(
      httpRequest,
      config.webhookBaseUrl,
      dueTaskIds,
      config.maxHistoryTasks || 300,
    );
    deadlineShiftsByTaskId = shiftsByTaskId;
    historySkipped = skipped;
  }

  const rows = aggregate({ users, tasks, period, timeSecondsByUser, deadlineShiftsByTaskId });
  const message = buildReport(rows, period);
  const messageHtml = buildReportHtml(rows, period);

  return {
    message,
    messageHtml,
    dialogId: config.managerDialogId,
    period,
    rows,
    tasksCount: tasks.length,
    historySkipped,
  };
}

// Отправка готового сообщения в личку руководителю (im.message.add).
export async function sendMessage(httpRequest, base, dialogId, message) {
  return callMethod(httpRequest, base, 'im.message.add', {
    DIALOG_ID: dialogId,
    MESSAGE: message,
  });
}
