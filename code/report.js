// Формирование текста отчёта для отправки в личку руководителю (im.message.add).
// Использует BB-коды Bitrix ([B], [TABLE]) минимально — основной вид текстовый,
// чтобы читалось и в чате, и в уведомлении.

export function formatRate(rate) {
  if (rate === null || rate === undefined) return '—';
  return `${Math.round(rate * 100)}%`;
}

// Секунды → часы компактно: 5400 → «1.5ч», 3600 → «1ч».
export function formatHours(seconds) {
  const h = Math.round(((seconds || 0) / 3600) * 10) / 10;
  return `${h}ч`;
}

function sum(rows, path) {
  return rows.reduce((acc, r) => acc + (r.responsible[path] || 0), 0);
}

// Сортировка: проблемные выше — сначала по числу просрочек (убыв.),
// затем по % выполнения (возр.), затем по имени.
function sortRows(rows) {
  return [...rows].sort((a, b) => {
    if (b.responsible.overdue !== a.responsible.overdue) {
      return b.responsible.overdue - a.responsible.overdue;
    }
    const ra = a.responsible.completionRate ?? 1;
    const rb = b.responsible.completionRate ?? 1;
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name, 'ru');
  });
}

// Сотрудник «активен» в периоде, если по разрезу «участие» (исполнитель ИЛИ
// соисполнитель) есть хоть что-то: выполненное или с дедлайном в периоде.
// onTime/overdue/noDeadline — подмножества этих двух, отдельно проверять не надо.
function hasActivity(row) {
  return row.participation.completed > 0 || row.participation.due > 0;
}

export function buildReport(allRows, period) {
  const rows = allRows.filter(hasActivity);

  const lines = [];
  lines.push(`[B]Отчёт по задачам — ${period.label}[/B]`);
  lines.push('');

  if (rows.length === 0) {
    lines.push('За период нет данных по сотрудникам.');
    return lines.join('\n');
  }

  // Сводка по компании (по разрезу «как исполнитель»).
  const totalCompleted = sum(rows, 'completed');
  const totalDue = sum(rows, 'due');
  const totalOnTime = sum(rows, 'onTime');
  const totalOverdue = sum(rows, 'overdue');
  const companyRate = totalDue > 0 ? totalOnTime / totalDue : null;

  lines.push(
    `[B]Итого по компании:[/B] выполнено ${totalCompleted}, ` +
      `к выполнению ${totalDue}, в срок ${totalOnTime} (${formatRate(companyRate)}), ` +
      `просрочено ${totalOverdue}`,
  );
  lines.push('');
  lines.push('[B]По сотрудникам[/B] (как исполнитель; в скобках — с учётом соисполнения):');

  for (const r of sortRows(rows)) {
    const resp = r.responsible;
    const part = r.participation;
    const flag = resp.overdue > 0 ? '⚠️ ' : '';
    const noDl = resp.noDeadline > 0 ? `, без срока ${resp.noDeadline}` : '';
    const time = r.timeSpentSeconds > 0 ? `, ⏱ ${formatHours(r.timeSpentSeconds)}` : '';
    const shifts = r.deadlineShifts > 0 ? `, переносы ${r.deadlineShifts}` : '';
    lines.push(
      `${flag}${r.name}: выполнено ${resp.completed} (${part.completed}), ` +
        `в срок ${resp.onTime}/${resp.due} = ${formatRate(resp.completionRate)}, ` +
        `просрочено ${resp.overdue}${noDl}${time}${shifts}`,
    );
  }

  return lines.join('\n');
}

// HTML-версия отчёта — для резервного канала email (n8n Send Email, поле HTML).
export function buildReportHtml(allRows, period) {
  const rows = allRows.filter(hasActivity);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const head = `<h3>Отчёт по задачам — ${esc(period.label)}</h3>`;
  if (rows.length === 0) return `${head}<p>За период нет данных по сотрудникам.</p>`;

  const totalCompleted = sum(rows, 'completed');
  const totalDue = sum(rows, 'due');
  const totalOnTime = sum(rows, 'onTime');
  const totalOverdue = sum(rows, 'overdue');
  const companyRate = totalDue > 0 ? totalOnTime / totalDue : null;

  const summary =
    `<p><b>Итого по компании:</b> выполнено ${totalCompleted}, к выполнению ${totalDue}, ` +
    `в срок ${totalOnTime} (${formatRate(companyRate)}), просрочено ${totalOverdue}</p>`;

  const header =
    '<tr><th align="left">Сотрудник</th><th>Выполнено</th><th>В срок</th><th>%</th>' +
    '<th>Просрочено</th><th>Без срока</th><th>Время</th><th>Переносы</th></tr>';

  const body = sortRows(rows)
    .map((r) => {
      const resp = r.responsible;
      return (
        `<tr><td>${esc(r.name)}</td>` +
        `<td align="center">${resp.completed} (${r.participation.completed})</td>` +
        `<td align="center">${resp.onTime}/${resp.due}</td>` +
        `<td align="center">${formatRate(resp.completionRate)}</td>` +
        `<td align="center">${resp.overdue}</td>` +
        `<td align="center">${resp.noDeadline || ''}</td>` +
        `<td align="center">${r.timeSpentSeconds > 0 ? formatHours(r.timeSpentSeconds) : ''}</td>` +
        `<td align="center">${r.deadlineShifts > 0 ? r.deadlineShifts : ''}</td></tr>`
      );
    })
    .join('');

  const note = '<p style="color:#888;font-size:12px">Формат: как исполнитель (в скобках — с учётом соисполнения).</p>';
  return `${head}${summary}<table border="1" cellpadding="6" cellspacing="0">${header}${body}</table>${note}`;
}
