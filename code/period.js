// Вычисление границ отчётного периода. Полуинтервал [start, end) в ISO 8601.
// Для month/quarter берётся ПРЕДЫДУЩИЙ период относительно refDate (обычно now):
// отчёт формируется в начале нового периода за только что завершившийся.

const MONTHS_RU = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, offset) => `${y}-${pad(m)}-01T00:00:00${offset}`; // m: 1..12

export function computePeriod(mode, refDate, offset = '+03:00', custom = {}) {
  if (mode === 'custom') {
    return { start: custom.start, end: custom.end, label: 'Произвольный период' };
  }

  // «Текущие» год/месяц по компонентам refDate (UTC — для детерминизма расчёта).
  const y = refDate.getUTCFullYear();
  const m = refDate.getUTCMonth() + 1; // 1..12

  if (mode === 'quarter') {
    const curQ = Math.floor((m - 1) / 3); // 0..3
    let prevQ = curQ - 1;
    let year = y;
    if (prevQ < 0) { prevQ = 3; year -= 1; }
    const startMonth = prevQ * 3 + 1; // 1,4,7,10
    const endMonth = startMonth + 3; // может быть 13 → следующий год
    const end = endMonth > 12 ? iso(year + 1, endMonth - 12, offset) : iso(year, endMonth, offset);
    return { start: iso(year, startMonth, offset), end, label: `Q${prevQ + 1} ${year}` };
  }

  // mode === 'month' (по умолчанию)
  let year = y;
  let month = m - 1; // предыдущий месяц
  if (month < 1) { month = 12; year -= 1; }
  const endMonth = month + 1;
  const end = endMonth > 12 ? iso(year + 1, 1, offset) : iso(year, endMonth, offset);
  return { start: iso(year, month, offset), end, label: `${MONTHS_RU[month - 1]} ${year}` };
}
