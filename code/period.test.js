import test from 'node:test';
import assert from 'node:assert/strict';
import { computePeriod } from './period.js';

const OFFSET = '+03:00';

test('month: берётся предыдущий месяц относительно refDate', () => {
  const p = computePeriod('month', new Date('2026-08-13T10:00:00Z'), OFFSET);
  assert.equal(p.start, '2026-07-01T00:00:00+03:00');
  assert.equal(p.end, '2026-08-01T00:00:00+03:00');
  assert.equal(p.label, 'Июль 2026');
});

test('month: январь → декабрь прошлого года', () => {
  const p = computePeriod('month', new Date('2026-01-10T10:00:00Z'), OFFSET);
  assert.equal(p.start, '2025-12-01T00:00:00+03:00');
  assert.equal(p.end, '2026-01-01T00:00:00+03:00');
  assert.equal(p.label, 'Декабрь 2025');
});

test('quarter: берётся предыдущий квартал', () => {
  // refDate во 2-м квартале (май) → предыдущий квартал Q1
  const p = computePeriod('quarter', new Date('2026-05-15T10:00:00Z'), OFFSET);
  assert.equal(p.start, '2026-01-01T00:00:00+03:00');
  assert.equal(p.end, '2026-04-01T00:00:00+03:00');
  assert.equal(p.label, 'Q1 2026');
});

test('quarter: Q1 → Q4 прошлого года', () => {
  const p = computePeriod('quarter', new Date('2026-02-15T10:00:00Z'), OFFSET);
  assert.equal(p.start, '2025-10-01T00:00:00+03:00');
  assert.equal(p.end, '2026-01-01T00:00:00+03:00');
  assert.equal(p.label, 'Q4 2025');
});

test('custom: границы берутся как заданы', () => {
  const p = computePeriod('custom', new Date('2026-08-13T10:00:00Z'), OFFSET, {
    start: '2026-03-01T00:00:00+03:00',
    end: '2026-06-01T00:00:00+03:00',
  });
  assert.equal(p.start, '2026-03-01T00:00:00+03:00');
  assert.equal(p.end, '2026-06-01T00:00:00+03:00');
});
