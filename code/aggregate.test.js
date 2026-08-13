import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inPeriod,
  isClosed,
  classifyTask,
  normalizeTask,
  aggregate,
  STATUS,
} from './aggregate.js';

// Период август 2026, полуинтервал [start, end)
const AUG = { start: '2026-08-01T00:00:00+03:00', end: '2026-09-01T00:00:00+03:00' };

// ── inPeriod: полуинтервал ────────────────────────────────────────────────
test('inPeriod: start включительно', () => {
  assert.equal(inPeriod('2026-08-01T00:00:00+03:00', AUG), true);
});

test('inPeriod: end исключительно', () => {
  assert.equal(inPeriod('2026-09-01T00:00:00+03:00', AUG), false);
});

test('inPeriod: середина периода', () => {
  assert.equal(inPeriod('2026-08-15T12:00:00+03:00', AUG), true);
});

test('inPeriod: до периода', () => {
  assert.equal(inPeriod('2026-07-31T23:59:59+03:00', AUG), false);
});

test('inPeriod: null → false', () => {
  assert.equal(inPeriod(null, AUG), false);
});

// ── isClosed: только STATUS завершена + есть closedDate ────────────────────
test('isClosed: завершена (5) с датой закрытия', () => {
  assert.equal(isClosed({ status: STATUS.DONE, closedDate: '2026-08-10T10:00:00+03:00' }), true);
});

test('isClosed: ждёт контроля (4) НЕ считается закрытой', () => {
  assert.equal(isClosed({ status: 4, closedDate: '2026-08-10T10:00:00+03:00' }), false);
});

test('isClosed: завершена без closedDate → false', () => {
  assert.equal(isClosed({ status: STATUS.DONE, closedDate: null }), false);
});

// ── classifyTask: флаги одной задачи относительно периода ──────────────────
test('classifyTask: закрыта в срок в периоде', () => {
  const t = { status: STATUS.DONE, deadline: '2026-08-20T18:00:00+03:00', closedDate: '2026-08-19T10:00:00+03:00' };
  const c = classifyTask(t, AUG);
  assert.equal(c.completedInPeriod, true);
  assert.equal(c.deadlineInPeriod, true);
  assert.equal(c.onTime, true);
  assert.equal(c.overdue, false);
  assert.equal(c.noDeadline, false);
});

test('classifyTask: закрыта ПОСЛЕ дедлайна → просрочено, но выполнено за период', () => {
  const t = { status: STATUS.DONE, deadline: '2026-08-10T18:00:00+03:00', closedDate: '2026-08-25T10:00:00+03:00' };
  const c = classifyTask(t, AUG);
  assert.equal(c.completedInPeriod, true); // факт закрытия в периоде
  assert.equal(c.deadlineInPeriod, true);
  assert.equal(c.onTime, false);
  assert.equal(c.overdue, true);
});

test('classifyTask: дедлайн в периоде, не закрыта → просрочено', () => {
  const t = { status: 3, deadline: '2026-08-10T18:00:00+03:00', closedDate: null };
  const c = classifyTask(t, AUG);
  assert.equal(c.completedInPeriod, false);
  assert.equal(c.deadlineInPeriod, true);
  assert.equal(c.onTime, false);
  assert.equal(c.overdue, true);
});

test('classifyTask: закрыта в периоде без дедлайна → noDeadline, не в просрочках', () => {
  const t = { status: STATUS.DONE, deadline: null, closedDate: '2026-08-05T10:00:00+03:00' };
  const c = classifyTask(t, AUG);
  assert.equal(c.completedInPeriod, true);
  assert.equal(c.deadlineInPeriod, false);
  assert.equal(c.overdue, false);
  assert.equal(c.noDeadline, true);
});

test('classifyTask: дедлайн вне периода не порождает просрочку в этом периоде', () => {
  const t = { status: 3, deadline: '2026-07-01T18:00:00+03:00', closedDate: null };
  const c = classifyTask(t, AUG);
  assert.equal(c.deadlineInPeriod, false);
  assert.equal(c.overdue, false);
});

// ── normalizeTask: приведение типов из ответа API ──────────────────────────
test('normalizeTask: строки → числа, accomplices массив чисел', () => {
  const raw = { id: '101', responsibleId: '7', accomplices: ['3', '9'], status: '5', deadline: '2026-08-20T18:00:00+03:00', closedDate: '2026-08-19T10:00:00+03:00' };
  const n = normalizeTask(raw);
  assert.equal(n.id, 101);
  assert.equal(n.responsibleId, 7);
  assert.deepEqual(n.accomplices, [3, 9]);
  assert.equal(n.status, 5);
});

test('normalizeTask: accomplices отсутствует → пустой массив', () => {
  const n = normalizeTask({ id: 1, responsibleId: 2, status: 5, deadline: null, closedDate: null });
  assert.deepEqual(n.accomplices, []);
});

// ── aggregate: раскладка по сотрудникам ────────────────────────────────────
const users = [
  { id: 7, name: 'Иванов' },
  { id: 9, name: 'Петров' },
];

test('aggregate: исполнитель и соисполнитель считаются в разных разрезах', () => {
  const tasks = [
    // Иванов исполнитель, закрыл в срок
    { id: 1, responsibleId: 7, accomplices: [9], status: STATUS.DONE, deadline: '2026-08-20T18:00:00+03:00', closedDate: '2026-08-19T10:00:00+03:00' },
  ];
  const res = aggregate({ users, tasks, period: AUG });
  const ivanov = res.find((r) => r.userId === 7);
  const petrov = res.find((r) => r.userId === 9);

  // Иванов как исполнитель
  assert.equal(ivanov.responsible.completed, 1);
  assert.equal(ivanov.responsible.due, 1);
  assert.equal(ivanov.responsible.onTime, 1);
  assert.equal(ivanov.responsible.overdue, 0);
  assert.equal(ivanov.responsible.completionRate, 1);

  // Петров только соисполнитель → в responsible ноль, в participation единица
  assert.equal(petrov.responsible.completed, 0);
  assert.equal(petrov.participation.completed, 1);
  assert.equal(petrov.participation.due, 1);
});

test('aggregate: одна задача, где сотрудник и исполнитель, и соисполнитель — учёт один раз', () => {
  const tasks = [
    { id: 5, responsibleId: 7, accomplices: [7], status: STATUS.DONE, deadline: '2026-08-20T18:00:00+03:00', closedDate: '2026-08-19T10:00:00+03:00' },
  ];
  const res = aggregate({ users, tasks, period: AUG });
  const ivanov = res.find((r) => r.userId === 7);
  assert.equal(ivanov.participation.completed, 1); // не 2
  assert.equal(ivanov.participation.due, 1);
});

test('aggregate: completionRate = null при нулевом знаменателе', () => {
  const tasks = [
    // задача без дедлайна, закрыта — due=0
    { id: 8, responsibleId: 7, accomplices: [], status: STATUS.DONE, deadline: null, closedDate: '2026-08-05T10:00:00+03:00' },
  ];
  const res = aggregate({ users, tasks, period: AUG });
  const ivanov = res.find((r) => r.userId === 7);
  assert.equal(ivanov.responsible.completed, 1);
  assert.equal(ivanov.responsible.due, 0);
  assert.equal(ivanov.responsible.noDeadline, 1);
  assert.equal(ivanov.responsible.completionRate, null);
});

test('aggregate: просрочка попадает в overdue и снижает completionRate', () => {
  const tasks = [
    { id: 10, responsibleId: 7, accomplices: [], status: 3, deadline: '2026-08-10T18:00:00+03:00', closedDate: null },
    { id: 11, responsibleId: 7, accomplices: [], status: STATUS.DONE, deadline: '2026-08-12T18:00:00+03:00', closedDate: '2026-08-11T10:00:00+03:00' },
  ];
  const res = aggregate({ users, tasks, period: AUG });
  const ivanov = res.find((r) => r.userId === 7);
  assert.equal(ivanov.responsible.due, 2);
  assert.equal(ivanov.responsible.onTime, 1);
  assert.equal(ivanov.responsible.overdue, 1);
  assert.equal(ivanov.responsible.completionRate, 0.5);
});

test('aggregate: пустой набор задач → нули и completionRate null', () => {
  const res = aggregate({ users, tasks: [], period: AUG });
  assert.equal(res.length, 2);
  for (const r of res) {
    assert.equal(r.responsible.completed, 0);
    assert.equal(r.responsible.due, 0);
    assert.equal(r.responsible.completionRate, null);
    assert.equal(r.participation.completed, 0);
  }
});

test('aggregate: время и переносы дедлайнов попадают в строки сотрудников', () => {
  const tasks = [
    { id: 1, responsibleId: 7, accomplices: [9], status: STATUS.DONE, deadline: '2026-08-20T18:00:00+03:00', closedDate: '2026-08-19T10:00:00+03:00' },
    { id: 2, responsibleId: 9, accomplices: [], status: 3, deadline: '2026-08-25T18:00:00+03:00', closedDate: null },
  ];
  const res = aggregate({
    users, tasks, period: AUG,
    timeSecondsByUser: { 7: 5400 },
    deadlineShiftsByTaskId: { 1: 2, 2: 1 },
  });
  const ivanov = res.find((r) => r.userId === 7);
  const petrov = res.find((r) => r.userId === 9);

  assert.equal(ivanov.timeSpentSeconds, 5400);
  assert.equal(petrov.timeSpentSeconds, 0);

  // Переносы атрибуцируются исполнителю задачи
  assert.equal(ivanov.deadlineShifts, 2); // задача 1
  assert.equal(ivanov.tasksRescheduled, 1);
  assert.equal(petrov.deadlineShifts, 1); // задача 2
  assert.equal(petrov.tasksRescheduled, 1);
});

test('aggregate: без extras строки получают нулевые время/переносы', () => {
  const res = aggregate({ users, tasks: [], period: AUG });
  for (const r of res) {
    assert.equal(r.timeSpentSeconds, 0);
    assert.equal(r.deadlineShifts, 0);
    assert.equal(r.tasksRescheduled, 0);
  }
});

test('aggregate: задачи чужих пользователей игнорируются', () => {
  const tasks = [
    { id: 20, responsibleId: 999, accomplices: [888], status: STATUS.DONE, deadline: '2026-08-20T18:00:00+03:00', closedDate: '2026-08-19T10:00:00+03:00' },
  ];
  const res = aggregate({ users, tasks, period: AUG });
  for (const r of res) assert.equal(r.responsible.completed, 0);
});
