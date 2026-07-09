import { type AppData, type LessonDraft, type PaymentDraft, type StudentDraft } from './types';

export const STORAGE_KEY = 'tutor-assistant.mobile.v1';

export const seedAppData: AppData = {
  students: [],
  lessons: [],
  payments: [],
  files: [],
  settings: {
    language: 'ru-RU',
    currency: 'MDL',
    lessonRemindersEnabled: true,
    reminderMinutesBeforeLesson: 45,
    lowBalanceRemindersEnabled: true,
    lowBalanceThreshold: 20,
  },
};

export function createEmptyStudentDraft(): StudentDraft {
  return {
    name: '',
    subject: '',
    phone: '',
    parentName: '',
    parentPhone: '',
    email: '',
    notes: '',
    openingBalance: '0',
    defaultRate: '0',
    isArchived: false,
  };
}

export function createEmptyLessonDraft(): LessonDraft {
  return {
    title: '',
    lessonDate: '2026-06-26',
    lessonTime: '16:00',
    durationMinutes: '60',
    costPerStudent: '40',
    status: 'planned',
    studentIds: [],
    note: '',
    attachmentIds: [],
  };
}

export function createEmptyPaymentDraft(): PaymentDraft {
  return {
    studentId: '',
    amount: '',
    paidAt: '2026-06-26',
    kind: 'payment',
    note: '',
  };
}