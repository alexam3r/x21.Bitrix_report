import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRate, formatHours, buildReport, buildReportHtml } from './report.js';

const period = { start: '2026-07-01T00:00:00+03:00', end: '2026-08-01T00:00:00+03:00', label: 'Июль 2026' };

const rows = [
  {
    userId: 7, name: 'Иванов',
    responsible: { completed: 5, due: 6, onTime: 3, overdue: 3, noDeadline: 1, completionRate: 0.5 },
    participation: { completed: 7, due: 8, onTime: 4, overdue: 4, noDeadline: 1, completionRate: 0.5 },
  },
  {
    userId: 9, name: 'Петров',
    responsible: { completed: 4, due: 4, onTime: 4, overdue: 0, noDeadline: 0, completionRate: 1 },
    participation: { completed: 4, due: 4, onTime: 4, overdue: 0, noDeadline: 0, completionRate: 1 },
  },
];

test('formatRate: доля → проценты, null → «—»', () => {
  assert.equal(formatRate(0.5), '50%');
  assert.equal(formatRate(1), '100%');
  assert.equal(formatRate(0), '0%');
  assert.equal(formatRate(null), '—');
});

test('buildReport: содержит период и всех сотрудников', () => {
  const msg = buildReport(rows, period);
  assert.match(msg, /Июль 2026/);
  assert.match(msg, /Иванов/);
  assert.match(msg, /Петров/);
});

test('buildReport: проблемные сотрудники (больше просрочек) идут выше', () => {
  const msg = buildReport(rows, period);
  assert.ok(msg.indexOf('Иванов') < msg.indexOf('Петров'), 'Иванов (3 просрочки) должен быть выше Петрова (0)');
});

test('buildReport: есть строка сводных итогов по компании', () => {
  const msg = buildReport(rows, period);
  assert.match(msg, /Итого|Всего/i);
  // Суммарно выполнено (как исполнители): 5 + 4 = 9
  assert.match(msg, /9/);
});

test('buildReport: сотрудники без единой задачи не попадают в отчёт', () => {
  const withIdle = [
    ...rows,
    {
      userId: 11, name: 'Пустышкин',
      responsible: { completed: 0, due: 0, onTime: 0, overdue: 0, noDeadline: 0, completionRate: null },
      participation: { completed: 0, due: 0, onTime: 0, overdue: 0, noDeadline: 0, completionRate: null },
    },
    {
      // только соисполнитель: responsible нули, participation не нули → остаётся
      userId: 12, name: 'Соисполнителев',
      responsible: { completed: 0, due: 0, onTime: 0, overdue: 0, noDeadline: 0, completionRate: null },
      participation: { completed: 1, due: 0, onTime: 0, overdue: 0, noDeadline: 0, completionRate: null },
    },
  ];
  const msg = buildReport(withIdle, period);
  assert.doesNotMatch(msg, /Пустышкин/);
  assert.match(msg, /Соисполнителев/);
});

test('buildReport: все без задач → сообщение об отсутствии данных', () => {
  const allIdle = [{
    userId: 11, name: 'Пустышкин',
    responsible: { completed: 0, due: 0, onTime: 0, overdue: 0, noDeadline: 0, completionRate: null },
    participation: { completed: 0, due: 0, onTime: 0, overdue: 0, noDeadline: 0, completionRate: null },
  }];
  const msg = buildReport(allIdle, period);
  assert.match(msg, /нет данных/i);
});

test('buildReport: пустой список не падает', () => {
  const msg = buildReport([], period);
  assert.match(msg, /Июль 2026/);
  assert.ok(msg.length > 0);
});

test('formatHours: секунды → часы, компактно', () => {
  assert.equal(formatHours(3600), '1ч');
  assert.equal(formatHours(5400), '1.5ч');
  assert.equal(formatHours(0), '0ч');
});

test('buildReport: время и переносы показываются только когда ненулевые', () => {
  const withExtras = [
    { ...rows[0], timeSpentSeconds: 5400, deadlineShifts: 3, tasksRescheduled: 2 },
    { ...rows[1], timeSpentSeconds: 0, deadlineShifts: 0, tasksRescheduled: 0 },
  ];
  const msg = buildReport(withExtras, period);
  const ivanovLine = msg.split('\n').find((l) => l.includes('Иванов'));
  const petrovLine = msg.split('\n').find((l) => l.includes('Петров'));
  assert.match(ivanovLine, /⏱ 1\.5ч/);
  assert.match(ivanovLine, /переносы 3/);
  assert.doesNotMatch(petrovLine, /⏱/);
  assert.doesNotMatch(petrovLine, /переносы/);
});

test('buildReport: старые строки без полей времени/переносов не ломают отчёт', () => {
  const msg = buildReport(rows, period); // rows без timeSpentSeconds
  assert.match(msg, /Иванов/);
});

test('buildReportHtml: таблица с сотрудниками, без неактивных', () => {
  const withIdle = [
    { ...rows[0], timeSpentSeconds: 5400, deadlineShifts: 1, tasksRescheduled: 1 },
    {
      userId: 11, name: 'Пустышкин',
      responsible: { completed: 0, due: 0, onTime: 0, overdue: 0, noDeadline: 0, completionRate: null },
      participation: { completed: 0, due: 0, onTime: 0, overdue: 0, noDeadline: 0, completionRate: null },
    },
  ];
  const html = buildReportHtml(withIdle, period);
  assert.match(html, /<table/);
  assert.match(html, /Июль 2026/);
  assert.match(html, /Иванов/);
  assert.doesNotMatch(html, /Пустышкин/);
  assert.match(html, /1\.5ч/);
});
