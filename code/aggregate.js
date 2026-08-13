// Ядро расчёта метрик отчёта по задачам Bitrix24.
// Источник правды по формулам — docs/metrics.md.
// Чистый модуль без сетевых вызовов: n8n Code-нода передаёт сюда уже собранные
// массивы и получает готовую раскладку по сотрудникам.

// Коды статусов Bitrix24 (tasks.task.list, поле STATUS). Держим в одном месте —
// если на портале кастомная схема, правим здесь.
export const STATUS = { DONE: 5 };

// Дата попадает в период по полуинтервалу [start, end).
export function inPeriod(dateStr, period) {
  if (!dateStr) return false;
  const t = new Date(dateStr).getTime();
  return t >= new Date(period.start).getTime() && t < new Date(period.end).getTime();
}

// «Закрыта» = финальный статус (Завершена) И зафиксирована дата закрытия.
export function isClosed(task) {
  return task.status === STATUS.DONE && Boolean(task.closedDate);
}

// Приводит «сырую» задачу из ответа API к нормализованному виду (числа/массивы).
export function normalizeTask(raw) {
  const toNum = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const accomplices = Array.isArray(raw.accomplices) ? raw.accomplices.map(Number) : [];
  return {
    id: toNum(raw.id),
    responsibleId: toNum(raw.responsibleId),
    accomplices,
    status: toNum(raw.status),
    deadline: raw.deadline || null,
    closedDate: raw.closedDate || null,
  };
}

// Классифицирует одну задачу относительно периода (без привязки к сотруднику).
export function classifyTask(task, period) {
  const closed = isClosed(task);
  const completedInPeriod = closed && inPeriod(task.closedDate, period);
  const deadlineInPeriod = inPeriod(task.deadline, period);

  // «В срок» — из множества «к выполнению»: закрыта и не позже дедлайна.
  const onTime =
    deadlineInPeriod &&
    closed &&
    new Date(task.closedDate).getTime() <= new Date(task.deadline).getTime();

  // «Просрочено» = «к выполнению» − «в срок».
  const overdue = deadlineInPeriod && !onTime;

  // «Без срока» — среди выполненных за период задачи без дедлайна.
  const noDeadline = completedInPeriod && !task.deadline;

  return { completedInPeriod, deadlineInPeriod, onTime, overdue, noDeadline };
}

function emptyBucket() {
  return { completed: 0, due: 0, onTime: 0, overdue: 0, noDeadline: 0 };
}

function addToBucket(bucket, c) {
  if (c.completedInPeriod) bucket.completed += 1;
  if (c.deadlineInPeriod) bucket.due += 1;
  if (c.onTime) bucket.onTime += 1;
  if (c.overdue) bucket.overdue += 1;
  if (c.noDeadline) bucket.noDeadline += 1;
}

function withRate(bucket) {
  return {
    ...bucket,
    completionRate: bucket.due > 0 ? bucket.onTime / bucket.due : null,
  };
}

// Основная функция: раскладывает задачи по сотрудникам и считает метрики.
// Вход: { users: [{id, name}], tasks: [normalizedTask], period: {start, end},
//   timeSecondsByUser?: {userId: seconds}   — учтённое время (task.elapseditem),
//   deadlineShiftsByTaskId?: {taskId: n}    — число переносов дедлайна по задаче }.
// Выход: массив по каждому сотруднику с разрезами responsible и participation.
export function aggregate({ users, tasks, period, timeSecondsByUser = {}, deadlineShiftsByTaskId = {} }) {
  return users.map((user) => {
    const responsible = emptyBucket();
    const participation = emptyBucket();
    let deadlineShifts = 0;
    let tasksRescheduled = 0;

    for (const task of tasks) {
      const isResponsible = task.responsibleId === user.id;
      const isAccomplice = Array.isArray(task.accomplices) && task.accomplices.includes(user.id);
      if (!isResponsible && !isAccomplice) continue; // чужая задача

      const c = classifyTask(task, period);
      // «Участие» — любая роль, задача учитывается один раз (цикл по задачам).
      addToBucket(participation, c);
      // «Как исполнитель» — только где сотрудник RESPONSIBLE_ID.
      if (isResponsible) {
        addToBucket(responsible, c);
        // Переносы дедлайна атрибуцируются исполнителю задачи.
        const shifts = deadlineShiftsByTaskId[task.id] || 0;
        if (shifts > 0) {
          deadlineShifts += shifts;
          tasksRescheduled += 1;
        }
      }
    }

    return {
      userId: user.id,
      name: user.name,
      responsible: withRate(responsible),
      participation: withRate(participation),
      timeSpentSeconds: timeSecondsByUser[user.id] || 0,
      deadlineShifts,
      tasksRescheduled,
    };
  });
}
