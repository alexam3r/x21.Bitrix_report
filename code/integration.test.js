import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeTask, aggregate } from './aggregate.js';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../test/fixtures/tasks-sample.json', import.meta.url)), 'utf8'),
);

const AUG = { start: '2026-08-01T00:00:00+03:00', end: '2026-09-01T00:00:00+03:00' };
const users = [
  { id: 7, name: 'Иванов' },
  { id: 9, name: 'Петров' },
];

test('интеграция: сырые задачи из fixture → normalize → aggregate', () => {
  const tasks = fixture.tasks.map(normalizeTask);
  const res = aggregate({ users, tasks, period: AUG });

  const ivanov = res.find((r) => r.userId === 7);
  const petrov = res.find((r) => r.userId === 9);

  // Иванов исполнитель: #101 (в срок), #102 (просрочка, не закрыта).
  assert.equal(ivanov.responsible.completed, 1); // только 101
  assert.equal(ivanov.responsible.due, 2); // 101 + 102 (дедлайны в августе)
  assert.equal(ivanov.responsible.onTime, 1);
  assert.equal(ivanov.responsible.overdue, 1);
  assert.equal(ivanov.responsible.completionRate, 0.5);
  // Как соисполнитель Иванов ещё в #103 → участие шире.
  assert.equal(ivanov.participation.completed, 2); // 101 + 103 (103 закрыта в августе)

  // Петров исполнитель: #103 (закрыта 25 авг, дедлайн 5 авг → просрочка),
  // #104 (без срока, закрыта в августе).
  assert.equal(petrov.responsible.completed, 2); // 103 + 104
  assert.equal(petrov.responsible.due, 1); // только 103 имеет дедлайн в августе
  assert.equal(petrov.responsible.onTime, 0);
  assert.equal(petrov.responsible.overdue, 1);
  assert.equal(petrov.responsible.noDeadline, 1); // 104
  assert.equal(petrov.responsible.completionRate, 0);
});
