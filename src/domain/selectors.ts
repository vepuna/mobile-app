import { type AppData, type Lesson, type LessonDraft, type Payment, type Student, type WidgetSnapshot } from './types';

export function sortLessons(lessons: Lesson[]): Lesson[] {
  return [...lessons].sort((left, right) => left.startAt.localeCompare(right.startAt));
}

export function parseLessonStart(dateValue: string, timeValue: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue) || !/^\d{2}:\d{2}$/.test(timeValue)) {
    return null;
  }

  const composed = new Date(`${dateValue}T${timeValue}:00`);
  if (Number.isNaN(composed.getTime())) {
    return null;
  }

  return `${dateValue}T${timeValue}:00`;
}

export function isValidLessonDraft(draft: LessonDraft): boolean {
  return Boolean(
    draft.title.trim() &&
      draft.lessonDate.trim() &&
      draft.lessonTime.trim() &&
      draft.studentIds.length > 0 &&
      Number(draft.durationMinutes) > 0 &&
      Number(draft.costPerStudent) >= 0,
  );
}

export function lessonChargeForStudent(lesson: Lesson, studentId: string): number {
  return lesson.status === 'done' && lesson.studentIds.includes(studentId) ? lesson.costPerStudent : 0;
}

export function calculateBalance(student: Student, lessons: Lesson[], payments: Payment[]): number {
  const lessonCharges = lessons.reduce((total, lesson) => total + lessonChargeForStudent(lesson, student.id), 0);
  const paid = payments
    .filter((payment) => payment.studentId === student.id)
    .reduce((total, payment) => total + payment.amount, 0);

  return student.openingBalance + paid - lessonCharges;
}

export function createNextWeekLesson(lesson: Lesson): Lesson {
  return {
    ...lesson,
    id: `${lesson.id}-next-${Date.now()}`,
    startAt: moveDateIsoByDays(lesson.startAt, 7),
    status: 'planned',
  };
}

export function moveLessonByDays(lesson: Lesson, dayShift: number): Lesson {
  return {
    ...lesson,
    startAt: moveDateIsoByDays(lesson.startAt, dayShift),
  };
}

export function moveDateIsoByDays(isoValue: string, dayShift: number): string {
  const nextDate = new Date(isoValue);
  nextDate.setDate(nextDate.getDate() + dayShift);

  const year = nextDate.getFullYear();
  const month = String(nextDate.getMonth() + 1).padStart(2, '0');
  const day = String(nextDate.getDate()).padStart(2, '0');
  const hours = String(nextDate.getHours()).padStart(2, '0');
  const minutes = String(nextDate.getMinutes()).padStart(2, '0');
  const seconds = String(nextDate.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}

export function deriveDashboard(data: AppData, now: Date) {
  const monthToken = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const balances = data.students.map((student) => calculateBalance(student, data.lessons, data.payments));
  const upcomingLessons = sortLessons(
    data.lessons.filter(
      (lesson) => lesson.status === 'planned' && new Date(lesson.startAt).getTime() >= now.getTime(),
    ),
  );
  const todayToken = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
  const todayLessons = data.lessons.filter(
    (lesson) => lesson.startAt.slice(0, 10) === todayToken && lesson.status === 'planned',
  );
  const calendarDays = Array.from({ length: 14 }, (_, offset) => {
    const date = new Date(now);
    date.setDate(now.getDate() + offset);
    return {
      isoDate: date.toISOString().slice(0, 10),
      weekday: date.toLocaleDateString(data.settings.language, { weekday: 'short' }),
      day: date.getDate(),
    };
  });
  const monthIncome = data.payments
    .filter((payment) => payment.paidAt.startsWith(monthToken))
    .reduce((total, payment) => total + payment.amount, 0);
  const monthBilled = data.lessons
    .filter((lesson) => lesson.startAt.startsWith(monthToken) && lesson.status === 'done')
    .reduce((total, lesson) => total + lesson.costPerStudent * lesson.studentIds.length, 0);

  return {
    activeStudentCount: data.students.filter((student) => !student.isArchived).length,
    archivedStudentCount: data.students.filter((student) => student.isArchived).length,
    debtorCount: balances.filter((balance) => balance < 0).length,
    totalDebtAbs: balances.filter((balance) => balance < 0).reduce((total, balance) => total + Math.abs(balance), 0),
    monthIncome,
    monthBilled,
    upcomingLessons,
    todayLessons,
    doneLessonsCount: data.lessons.filter((lesson) => lesson.status === 'done').length,
    missedLessonsCount: data.lessons.filter((lesson) => lesson.status === 'missed').length,
    plannedLessonsCount: data.lessons.filter((lesson) => lesson.status === 'planned').length,
    calendarDays,
    freeSlotsText:
      todayLessons.length < 4 ? 'На сегодня еще есть свободные окна.' : 'День почти полностью занят.',
  };
}

export function findLessonConflicts(
  draft: LessonDraft,
  lessons: Lesson[],
  editingLessonId: string | null,
): Lesson[] {
  const startAt = parseLessonStart(draft.lessonDate, draft.lessonTime);
  if (!startAt) {
    return [];
  }

  const draftStart = new Date(startAt).getTime();
  const draftEnd = draftStart + (Number(draft.durationMinutes) || 0) * 60 * 1000;

  return lessons.filter((lesson) => {
    if (lesson.id === editingLessonId) {
      return false;
    }
    const lessonStart = new Date(lesson.startAt).getTime();
    const lessonEnd = lessonStart + lesson.durationMinutes * 60 * 1000;
    return draftStart < lessonEnd && draftEnd > lessonStart;
  });
}

export function getCalendarTone(dateToken: string, lessons: Lesson[]): 'planned' | 'missed' {
  const matches = lessons.filter((lesson) => lesson.startAt.slice(0, 10) === dateToken);
  return matches.some((lesson) => lesson.status === 'missed') ? 'missed' : 'planned';
}

export function formatCurrency(value: number, formatter: Intl.NumberFormat): string {
  return formatter.format(value);
}

export function formatLessonDate(isoValue: string, locale = 'ru-RU'): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(isoValue));
}

export function formatShortDate(isoValue: string, locale = 'ru-RU'): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(isoValue));
}

export function formatMonthYear(isoValue: string, locale = 'ru-RU'): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
  }).format(new Date(isoValue));
}

export function deriveWidgetSnapshot(data: AppData, now: Date): WidgetSnapshot {
  const dashboard = deriveDashboard(data, now);
  const todayToken = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
  const todayLessons = sortLessons(
    data.lessons.filter((lesson) => lesson.startAt.slice(0, 10) === todayToken && lesson.status !== 'missed'),
  );
  const lessonLines = todayLessons.slice(0, 4).map((lesson) => {
    const studentNames = lesson.studentIds
      .map((studentId) => data.students.find((student) => student.id === studentId)?.name)
      .filter(Boolean)
      .join(', ');

    const lessonDate = new Date(lesson.startAt);
    const hour = String(lessonDate.getHours()).padStart(2, '0');
    const minute = String(lessonDate.getMinutes()).padStart(2, '0');
    return `${hour}:${minute} · ${studentNames || lesson.title}`;
  });

  return {
    generatedAt: now.toISOString(),
    todayLessonCount: todayLessons.length,
    dayLabel: formatShortDate(now.toISOString(), data.settings.language),
    lessonLines,
    freeSlotsText: todayLessons.length === 0 ? 'На сегодня уроков нет.' : dashboard.freeSlotsText,
  };
}