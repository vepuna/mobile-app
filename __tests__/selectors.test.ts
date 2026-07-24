import {
  calculateBalance,
  createNextWeekLesson,
  deriveDashboard,
  deriveWidgetSnapshot,
  findLessonConflicts,
  getVisibleLessons,
  parseLessonStart,
} from '../src/domain/selectors';
import { type AppData } from '../src/domain/types';

const testData: AppData = {
  students: [
    {
      id: 'student-maria',
      name: 'Maria Lee',
      subject: 'English',
      phone: '',
      parentName: '',
      parentPhone: '',
      email: '',
      notes: '',
      openingBalance: 20,
      defaultRate: 45,
      color: '#2667ff',
      isArchived: false,
    },
    {
      id: 'student-alex',
      name: 'Alex Carter',
      subject: 'Math',
      phone: '',
      parentName: '',
      parentPhone: '',
      email: '',
      notes: '',
      openingBalance: -30,
      defaultRate: 50,
      color: '#ff7a59',
      isArchived: false,
    },
  ],
  lessons: [
    {
      id: 'lesson-1',
      title: 'English vocabulary sprint',
      startAt: '2026-06-26T16:00:00',
      durationMinutes: 60,
      costPerStudent: 45,
      status: 'scheduled',
      studentIds: ['student-maria'],
      note: '',
    },
    {
      id: 'lesson-2',
      title: 'Math exam prep',
      startAt: '2026-06-27T11:30:00',
      durationMinutes: 90,
      costPerStudent: 50,
      status: 'completed',
      studentIds: ['student-alex'],
      note: '',
    },
    {
      id: 'lesson-3',
      title: 'Speaking club',
      startAt: '2026-06-28T09:00:00',
      durationMinutes: 75,
      costPerStudent: 30,
      status: 'cancelled',
      studentIds: ['student-maria', 'student-alex'],
      note: '',
    },
  ],
  payments: [
    {
      id: 'payment-1',
      studentId: 'student-maria',
      amount: 180,
      paidAt: '2026-06-20',
      kind: 'prepayment',
      note: '',
    },
    {
      id: 'payment-2',
      studentId: 'student-alex',
      amount: 100,
      paidAt: '2026-06-18',
      kind: 'payment',
      note: '',
    },
  ],
  settings: {
    language: 'en-US',
    currency: 'USD',
    lessonRemindersEnabled: true,
    reminderMinutesBeforeLesson: 45,
    lowBalanceRemindersEnabled: true,
    lowBalanceThreshold: 20,
    upcomingLessonsToDisplay: 5,
  },
};

describe('tutor domain selectors', () => {
  it('calculates student balance with payments and completed lessons', () => {
    const maria = testData.students[0];
    expect(calculateBalance(maria, testData.lessons, testData.payments)).toBe(200);
  });

  it('duplicates a lesson into the next week and resets status to scheduled', () => {
    const lesson = testData.lessons[1];
    const duplicated = createNextWeekLesson(lesson);

    expect(duplicated.status).toBe('scheduled');
    expect(new Date(duplicated.startAt).getTime() - new Date(lesson.startAt).getTime()).toBe(
      7 * 24 * 60 * 60 * 1000,
    );
  });

  it('detects overlapping lessons for availability checks', () => {
    const conflicts = findLessonConflicts(
      {
        title: 'Overlap check',
        lessonDate: '2026-06-27',
        lessonTime: '11:45',
        durationMinutes: '45',
        anonymousPrice: '0',
        status: 'scheduled',
        studentIds: ['student-alex'],
        note: '',
      },
      testData.lessons,
      null,
    );

    expect(conflicts).toHaveLength(1);
  });

  it('frees a rescheduled lesson original slot for a new lesson', () => {
    const rescheduledLesson = { ...testData.lessons[0], status: 'rescheduled' as const };
    const conflicts = findLessonConflicts(
      {
        title: 'Replacement lesson',
        lessonDate: '2026-06-26',
        lessonTime: '16:00',
        durationMinutes: '60',
        anonymousPrice: '0',
        status: 'scheduled',
        studentIds: [],
        note: '',
      },
      [rescheduledLesson],
      null,
    );

    expect(conflicts).toHaveLength(0);
  });

  it('summarizes dashboard metrics for the current month', () => {
    const dashboard = deriveDashboard(testData, new Date('2026-06-26T08:00:00.000Z'));

    expect(dashboard.monthIncome).toBe(280);
    expect(dashboard.monthBilled).toBe(50);
    expect(dashboard.debtorCount).toBe(0);
    expect(dashboard.upcomingLessons).toHaveLength(1);
  });

  it('includes anonymous lesson payments in income without changing a student balance', () => {
    const anonymousLesson = {
      id: 'lesson-anonymous-paid',
      title: 'Anonymous conversation practice',
      startAt: '2026-06-26T18:00:00',
      durationMinutes: 60,
      costPerStudent: 80,
      status: 'completed_paid' as const,
      studentIds: [],
      note: '',
    };
    const anonymousPayment = {
      id: 'payment-anonymous-paid',
      studentId: null,
      lessonId: anonymousLesson.id,
      amount: 80,
      paidAt: '2026-06-26',
      kind: 'payment' as const,
      note: 'Anonymous lesson payment',
    };
    const dataWithAnonymousPayment: AppData = {
      ...testData,
      lessons: [...testData.lessons, anonymousLesson],
      payments: [...testData.payments, anonymousPayment],
    };

    const dashboard = deriveDashboard(dataWithAnonymousPayment, new Date('2026-06-26T08:00:00.000Z'));
    expect(dashboard.monthIncome).toBe(360);
    expect(dashboard.monthBilled).toBe(50);
    expect(calculateBalance(testData.students[0], dataWithAnonymousPayment.lessons, dataWithAnonymousPayment.payments)).toBe(200);
  });

  it('parses lesson date and time into an iso string', () => {
    expect(parseLessonStart('2026-06-30', '17:15')).toBe('2026-06-30T17:15:00');
    expect(parseLessonStart('invalid', '17:15')).toBeNull();
  });

  it('builds a compact widget snapshot from app data', () => {
    const snapshot = deriveWidgetSnapshot(testData, new Date('2026-06-26T08:00:00.000Z'));

    expect(snapshot.todayLessonCount).toBe(1);
    expect(snapshot.lessonLines).toHaveLength(1);
    expect(snapshot.lessonLines[0]).toContain('Maria Lee');
  });

  it('widget does not show students from other days when today is empty', () => {
    const snapshot = deriveWidgetSnapshot(testData, new Date('2026-06-29T08:00:00.000Z'));

    expect(snapshot.todayLessonCount).toBe(0);
    expect(snapshot.lessonLines).toHaveLength(0);
    expect(snapshot.freeSlotsText).toContain('На сегодня уроков нет');
  });

  it('keeps anonymous lessons visible in dashboard and widget scheduling views', () => {
    const anonymousLesson = {
      id: 'lesson-reserve',
      title: 'Reserved consultation',
      startAt: '2026-06-26T18:00:00',
      durationMinutes: 60,
      costPerStudent: 0,
      status: 'scheduled' as const,
      studentIds: [],
      note: '',
    };
    const dataWithReserve: AppData = {
      ...testData,
      lessons: [...testData.lessons, anonymousLesson],
    };

    const dashboard = deriveDashboard(dataWithReserve, new Date('2026-06-26T08:00:00.000Z'));
    const snapshot = deriveWidgetSnapshot(dataWithReserve, new Date('2026-06-26T08:00:00.000Z'));

    expect(dashboard.upcomingLessons).toHaveLength(2);
    expect(dashboard.plannedLessonsCount).toBe(2);
    expect(snapshot.todayLessonCount).toBe(2);
    expect(snapshot.lessonLines.some((line) => line.includes('Reserved consultation'))).toBe(true);
  });

  it('does not include archived students or their lessons in dashboard metrics and widgets', () => {
    const archivedData: AppData = {
      ...testData,
      students: testData.students.map((student) =>
        student.id === 'student-maria' ? { ...student, isArchived: true } : student,
      ),
    };

    const dashboard = deriveDashboard(archivedData, new Date('2026-06-26T08:00:00.000Z'));
    const snapshot = deriveWidgetSnapshot(archivedData, new Date('2026-06-26T08:00:00.000Z'));

    expect(dashboard.upcomingLessons).toHaveLength(0);
    expect(snapshot.todayLessonCount).toBe(0);
  });

  it('counts debt only for completed unpaid lessons', () => {
    const alex = testData.students[1];
    const unpaidCompleted = { ...testData.lessons[1], status: 'completed' as const };
    const futureLesson = { ...testData.lessons[0], studentIds: ['student-alex'], status: 'scheduled' as const };
    const cancelledLesson = { ...testData.lessons[2], studentIds: ['student-alex'], status: 'cancelled' as const };

    expect(calculateBalance(alex, [unpaidCompleted, futureLesson, cancelledLesson], [])).toBe(-80);
  });

  it('keeps past lessons while hiding archived student upcoming lessons and restores them later', () => {
    const archivedStudent = {
      ...testData.students[0],
      isArchived: true,
      archiveLessonVisibility: 'upcoming' as const,
    };
    const completedPastLesson = { ...testData.lessons[0], status: 'completed' as const, startAt: '2026-06-25T16:00:00' };
    const scheduledFutureLesson = { ...testData.lessons[0], id: 'lesson-future', startAt: '2026-06-27T16:00:00' };
    const archivedData: AppData = {
      ...testData,
      students: [archivedStudent],
      lessons: [completedPastLesson, scheduledFutureLesson],
    };

    expect(getVisibleLessons(archivedData, new Date('2026-06-26T08:00:00')).map((lesson) => lesson.id)).toEqual(['lesson-1']);

    const restoredData: AppData = {
      ...archivedData,
      students: [{ ...archivedStudent, isArchived: false }],
    };
    expect(getVisibleLessons(restoredData, new Date('2026-06-26T08:00:00'))).toHaveLength(2);
  });

  it('uses available balance for completed lessons and never charges a future lesson', () => {
    const student = { ...testData.students[0], openingBalance: 45 };
    const completedLesson = { ...testData.lessons[0], status: 'completed' as const, costPerStudent: 45 };
    const futureLesson = { ...testData.lessons[0], id: 'lesson-future', startAt: '2026-07-01T16:00:00' };

    expect(calculateBalance(student, [completedLesson, futureLesson], [])).toBe(0);
    expect(calculateBalance({ ...student, openingBalance: 20 }, [completedLesson, futureLesson], [])).toBe(-25);
  });
});