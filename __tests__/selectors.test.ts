import {
  calculateBalance,
  createNextWeekLesson,
  deriveDashboard,
  deriveWidgetSnapshot,
  findLessonConflicts,
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
      status: 'planned',
      studentIds: ['student-maria'],
      note: '',
      attachmentIds: [],
    },
    {
      id: 'lesson-2',
      title: 'Math exam prep',
      startAt: '2026-06-27T11:30:00',
      durationMinutes: 90,
      costPerStudent: 50,
      status: 'done',
      studentIds: ['student-alex'],
      note: '',
      attachmentIds: [],
    },
    {
      id: 'lesson-3',
      title: 'Speaking club',
      startAt: '2026-06-28T09:00:00',
      durationMinutes: 75,
      costPerStudent: 30,
      status: 'missed',
      studentIds: ['student-maria', 'student-alex'],
      note: '',
      attachmentIds: [],
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
  files: [],
  settings: {
    language: 'en-US',
    currency: 'USD',
    lessonRemindersEnabled: true,
    reminderMinutesBeforeLesson: 45,
    lowBalanceRemindersEnabled: true,
    lowBalanceThreshold: 20,
  },
};

describe('tutor domain selectors', () => {
  it('calculates student balance with payments and completed lessons', () => {
    const maria = testData.students[0];
    expect(calculateBalance(maria, testData.lessons, testData.payments)).toBe(200);
  });

  it('duplicates a lesson into the next week and resets status to planned', () => {
    const lesson = testData.lessons[1];
    const duplicated = createNextWeekLesson(lesson);

    expect(duplicated.status).toBe('planned');
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
        costPerStudent: '50',
        status: 'planned',
        studentIds: ['student-alex'],
        note: '',
        attachmentIds: [],
      },
      testData.lessons,
      null,
    );

    expect(conflicts).toHaveLength(1);
  });

  it('summarizes dashboard metrics for the current month', () => {
    const dashboard = deriveDashboard(testData, new Date('2026-06-26T08:00:00.000Z'));

    expect(dashboard.monthIncome).toBe(280);
    expect(dashboard.monthBilled).toBe(50);
    expect(dashboard.debtorCount).toBe(0);
    expect(dashboard.upcomingLessons).toHaveLength(1);
  });

  it('parses lesson date and time into an iso string', () => {
    expect(parseLessonStart('2026-06-30', '17:15')).toContain('2026-06-30T');
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
});