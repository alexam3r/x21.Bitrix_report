// Smoke-прогон тела Code-ноды из собранного workflow БЕЗ n8n:
// эмулируем this.helpers.httpRequest и $input, исполняем jsCode, проверяем результат.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wf = JSON.parse(readFileSync(join(root, 'workflow', 'bitrix-report.n8n.json'), 'utf8'));

const codeNode = wf.nodes.find((n) => n.type === 'n8n-nodes-base.code');
const jsCode = codeNode.parameters.jsCode;

// Проверка 1: не осталось модульного синтаксиса.
for (const bad of [/^\s*import\s/m, /^export\s/m]) {
  if (bad.test(jsCode)) throw new Error(`В бандле остался модульный синтаксис: ${bad}`);
}

// Мок Bitrix: users + tasks + перехват im.message.add.
const sent = [];
const httpRequest = async ({ url, body }) => {
  if (url.includes('user.get')) {
    return { result: [{ ID: '7', NAME: 'Иван', LAST_NAME: 'Иванов' }, { ID: '9', NAME: 'Пётр', LAST_NAME: 'Петров' }] };
  }
  if (url.includes('tasks.task.list')) {
    const isClosed = '>=CLOSED_DATE' in body.filter;
    if (body.start !== 0) return { result: { tasks: [] } };
    const tasks = isClosed
      ? [{ id: '101', responsibleId: '7', accomplices: ['9'], status: '5', deadline: '2026-07-20T18:00:00+03:00', closedDate: '2026-07-19T10:00:00+03:00' }]
      : [
          { id: '101', responsibleId: '7', accomplices: ['9'], status: '5', deadline: '2026-07-20T18:00:00+03:00', closedDate: '2026-07-19T10:00:00+03:00' },
          { id: '102', responsibleId: '9', accomplices: [], status: '3', deadline: '2026-07-10T18:00:00+03:00', closedDate: null },
        ];
    return { result: { tasks } };
  }
  if (url.includes('task.elapseditem.getlist')) {
    const page = body.PARAMS?.NAV_PARAMS?.iNumPage || 1;
    const recs = page === 1
      ? [{ ID: '1', USER_ID: '7', TASK_ID: '101', SECONDS: '5400' }]
      : [];
    return { result: recs };
  }
  if (url.includes('tasks.task.history.list')) {
    const list = String(body.taskId) === '102'
      ? [{ id: '1', field: 'DEADLINE', value: { from: '2026-07-05T18:00:00+03:00', to: '2026-07-10T18:00:00+03:00' } }]
      : [];
    return { result: { list } };
  }
  if (url.includes('im.message.add')) {
    sent.push(body);
    return { result: 12345 };
  }
  throw new Error(`unexpected url ${url}`);
};

const thisCtx = { helpers: { httpRequest } };
const $input = {
  first: () => ({
    json: {
      webhookBaseUrl: 'https://portal.bitrix24.ru/rest/1/TOKEN',
      managerDialogId: 42,
      timezoneOffset: '+03:00',
      mode: 'month',
      dryRun: false,
    },
  }),
};

// Проверка 2: тело ноды парсится и исполняется.
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const fn = new AsyncFunction('$input', jsCode);
const now = new Date('2026-08-13T10:00:00Z'); // period → Июль 2026
// Подменяем Date по умолчанию не нужно: runReport берёт new Date() внутри.
// Чтобы период был детерминирован, временно фиксируем Date.now через обёртку:
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { return args.length ? new RealDate(...args) : new RealDate(now); }
  static now() { return now.getTime(); }
};

let out;
try {
  out = await fn.call(thisCtx, $input);
} finally {
  globalThis.Date = RealDate;
}

const res = out[0].json;
console.log('period:', res.period.label);
console.log('tasksCount:', res.tasksCount, '| sent:', res.sent);
console.log('sent messages:', sent.length, '| DIALOG_ID:', sent[0]?.DIALOG_ID);
console.log('--- message ---');
console.log(res.message);

// Проверка 3: базовые ожидания.
const assert = (cond, msg) => { if (!cond) throw new Error(`SMOKE FAIL: ${msg}`); };
assert(res.period.label === 'Июль 2026', 'период должен быть Июль 2026');
assert(res.sent === true, 'sent должно быть true при dryRun=false');
assert(sent.length === 1 && sent[0].DIALOG_ID === 42, 'должно уйти 1 сообщение на DIALOG_ID 42');
assert(res.sentMessageId === 12345, 'sentMessageId должен вернуться из im.message.add');
assert(/Иванов/.test(res.message) && /Петров/.test(res.message), 'в отчёте оба сотрудника');
// Фаза 2: время (5400с у Иванова) и перенос дедлайна (задача 102 → Петров).
assert(/⏱ 1\.5ч/.test(res.message), 'у Иванова должно быть время 1.5ч');
assert(/переносы 1/.test(res.message), 'у Петрова должен быть 1 перенос');
assert(/<table/.test(res.messageHtml), 'должен быть HTML-вариант отчёта');
console.log('\n✅ SMOKE OK');
