export type ScreenTab = 'dashboard' | 'schedule' | 'students' | 'finances' | 'settings';

export type AppLanguage = 'en-US' | 'ru-RU';
export type AppCurrency = 'USD' | 'EUR' | 'RUB' | 'MDL';

export type LessonStatus = 'scheduled' | 'completed' | 'cancelled' | 'rescheduled';
export type PaymentKind = 'payment' | 'prepayment';
export type NotificationPermissionState = 'unknown' | 'granted' | 'denied' | 'unsupported';

export type Student = {
  id: string;
  name: string;
  subject: string;
  phone: string;
  parentName: string;
  parentPhone: string;
  email: string;
  notes: string;
  openingBalance: number;
  defaultRate: number;
  color: string;
  isArchived: boolean;
};

export type Lesson = {
  id: string;
  title: string;
  startAt: string;
  durationMinutes: number;
  costPerStudent: number;
  status: LessonStatus;
  studentIds: string[];
  note: string;
  recurrenceId?: string | null;
  recurrenceEveryWeeks?: number | null;
  recurrenceWeekdays?: number[] | null;
  recurrenceStartDate?: string | null;
};

export type Payment = {
  id: string;
  studentId: string;
  amount: number;
  paidAt: string;
  kind: PaymentKind;
  note: string;
};

export type AppData = {
  students: Student[];
  lessons: Lesson[];
  payments: Payment[];
  settings: AppSettings;
};

export type AppSettings = {
  language: AppLanguage;
  currency: AppCurrency;
  lessonRemindersEnabled: boolean;
  reminderMinutesBeforeLesson: number;
  lowBalanceRemindersEnabled: boolean;
  lowBalanceThreshold: number;
};

export type WidgetSnapshot = {
  generatedAt: string;
  todayLessonCount: number;
  dayLabel: string;
  lessonLines: string[];
  freeSlotsText: string;
};

export type StudentDraft = {
  name: string;
  subject: string;
  phone: string;
  parentName: string;
  parentPhone: string;
  email: string;
  notes: string;
  openingBalance: string;
  defaultRate: string;
  isArchived: boolean;
};

export type LessonDraft = {
  title: string;
  lessonDate: string;
  lessonTime: string;
  durationMinutes: string;
  status: LessonStatus;
  studentIds: string[];
  note: string;
};

export type PaymentDraft = {
  studentId: string;
  amount: string;
  paidAt: string;
  kind: PaymentKind;
  note: string;
};