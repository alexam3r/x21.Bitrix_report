// Сборка n8n workflow: бандлит проверенные модули code/*.js в тело одной Code-ноды
// и генерирует workflow/bitrix-report.n8n.json. Единый источник правды — code/*.js
// (покрыты тестами), workflow — производный артефакт. Запуск: npm run build:workflow.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Порядок важен для читаемости (объявления функций всё равно поднимаются).
const modules = ['aggregate.js', 'period.js', 'report.js', 'collect.js'];

function stripModuleSyntax(src) {
  return src
    .split('\n')
    .filter((line) => !/^\s*import\s.+from\s.+;?\s*$/.test(line)) // убрать import
    .join('\n')
    .replace(/^export\s+/gm, ''); // export function/const/async → без export
}

const bundle = modules
  .map((f) => `// ===== ${f} =====\n${stripModuleSyntax(readFileSync(join(root, 'code', f), 'utf8'))}`)
  .join('\n\n');

const glue = `
// ===== n8n glue (Code node, Run Once for All Items) =====
// Только расчёт. Отправкой занимаются следующие ноды workflow:
// IF (гейт dryRun) → HTTP Request (im.message.add) и Send Email (messageHtml).
const config = $input.first().json;
const httpRequest = (opts) => this.helpers.httpRequest(opts);

const res = await runReport({ config, httpRequest });

return [{ json: {
  period: res.period,
  tasksCount: res.tasksCount,
  historySkipped: res.historySkipped,
  message: res.message,
  messageHtml: res.messageHtml,
  // Проброс настроек для нод отправки.
  dryRun: config.dryRun === true,
  webhookBaseUrl: config.webhookBaseUrl,
  managerDialogId: config.managerDialogId,
} }];
`;

const jsCode = `${bundle}\n${glue}`;

// ── Ноды настроек: базовые поля + режим периода ────────────────────────────
function settingsNode(id, name, mode, position) {
  return {
    parameters: {
      assignments: {
        assignments: [
          { id: `${id}-a`, name: 'webhookBaseUrl', type: 'string', value: 'https://ВАШ_ПОРТАЛ.bitrix24.ru/rest/1/ВАШ_ТОКЕН' },
          { id: `${id}-b`, name: 'managerDialogId', type: 'number', value: 1 },
          { id: `${id}-c`, name: 'timezoneOffset', type: 'string', value: '+03:00' },
          { id: `${id}-d`, name: 'mode', type: 'string', value: mode },
          { id: `${id}-e`, name: 'dryRun', type: 'boolean', value: true },
          { id: `${id}-f`, name: 'collectTime', type: 'boolean', value: true },
          { id: `${id}-g`, name: 'collectDeadlineShifts', type: 'boolean', value: true },
          { id: `${id}-h`, name: 'maxHistoryTasks', type: 'number', value: 300 },
        ],
      },
      options: {},
    },
    id,
    name,
    type: 'n8n-nodes-base.set',
    typeVersion: 3.4,
    position,
  };
}

function scheduleNode(id, name, cron, position) {
  return {
    parameters: { rule: { interval: [{ field: 'cronExpression', expression: cron }] } },
    id,
    name,
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.2,
    position,
  };
}

const nodes = [
  { parameters: {}, id: 'trig-manual', name: 'Запуск вручную', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
  scheduleNode('trig-month', 'Ежемесячно (1-е, 06:00)', '0 6 1 * *', [0, 180]),
  scheduleNode('trig-quarter', 'Ежеквартально (1 янв/апр/июл/окт, 07:00)', '0 7 1 1,4,7,10 *', [0, 360]),
  settingsNode('set-month', 'Настройки: месяц', 'month', [280, 60]),
  settingsNode('set-quarter', 'Настройки: квартал', 'quarter', [280, 360]),
  {
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode },
    id: 'code-main',
    name: 'Собрать отчёт',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [560, 200],
  },
  // Гейт сухого прогона: дальше проходим только при dryRun = false.
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'if-dryrun-false',
            leftValue: '={{ $json.dryRun }}',
            rightValue: '',
            operator: { type: 'boolean', operation: 'false', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    id: 'if-send',
    name: 'Отправлять? (dryRun = false)',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: [840, 200],
  },
  // Отправка в личку руководителю. Выход ноды = ответ im.message.add:
  // поле result с ID сообщения — это и есть подтверждение доставки.
  {
    parameters: {
      method: 'POST',
      url: '={{ $json.webhookBaseUrl }}/im.message.add.json',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify({ DIALOG_ID: $json.managerDialogId, MESSAGE: $json.message }) }}',
      options: {},
    },
    id: 'send-im',
    name: 'В личку Bitrix (im.message.add)',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [1120, 100],
  },
  // Дубль отчёта на email. Выключена: SMTP-креденшелы не экспортируются в JSON —
  // после импорта выберите креденшелы, заполните адреса и включите ноду.
  {
    parameters: {
      fromEmail: '',
      toEmail: '',
      subject: '=Отчёт по задачам — {{ $json.period.label }}',
      emailFormat: 'html',
      html: '={{ $json.messageHtml }}',
      options: {},
    },
    id: 'send-email',
    name: 'Отчёт на email (SMTP)',
    type: 'n8n-nodes-base.emailSend',
    typeVersion: 2.1,
    position: [1120, 300],
    disabled: true,
  },
];

const connections = {
  'Запуск вручную': { main: [[{ node: 'Настройки: месяц', type: 'main', index: 0 }]] },
  'Ежемесячно (1-е, 06:00)': { main: [[{ node: 'Настройки: месяц', type: 'main', index: 0 }]] },
  'Ежеквартально (1 янв/апр/июл/окт, 07:00)': { main: [[{ node: 'Настройки: квартал', type: 'main', index: 0 }]] },
  'Настройки: месяц': { main: [[{ node: 'Собрать отчёт', type: 'main', index: 0 }]] },
  'Настройки: квартал': { main: [[{ node: 'Собрать отчёт', type: 'main', index: 0 }]] },
  'Собрать отчёт': { main: [[{ node: 'Отправлять? (dryRun = false)', type: 'main', index: 0 }]] },
  'Отправлять? (dryRun = false)': {
    main: [
      [
        { node: 'В личку Bitrix (im.message.add)', type: 'main', index: 0 },
        { node: 'Отчёт на email (SMTP)', type: 'main', index: 0 },
      ],
      [],
    ],
  },
};

const workflow = {
  name: 'Bitrix24 — отчёт по задачам сотрудников',
  nodes,
  connections,
  active: false,
  settings: { executionOrder: 'v1' },
  pinData: {},
};

mkdirSync(join(root, 'workflow'), { recursive: true });
const outPath = join(root, 'workflow', 'bitrix-report.n8n.json');
writeFileSync(outPath, `${JSON.stringify(workflow, null, 2)}\n`, 'utf8');
console.log(`workflow written: ${outPath} (${nodes.length} nodes, jsCode ${jsCode.length} chars)`);
