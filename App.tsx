import AsyncStorage from '@react-native-async-storage/async-storage';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  STORAGE_KEY,
  createEmptyLessonDraft,
  createEmptyPaymentDraft,
  createEmptyStudentDraft,
  seedAppData,
} from './src/domain/seed';
import {
  calculateBalance,
  deriveDashboard,
  findLessonConflicts,
  formatCurrency,
  formatLessonDate,
  formatMonthYear,
  formatShortDate,
  isValidLessonDraft,
  parseLessonStart,
  sortLessons,
} from './src/domain/selectors';
import { syncReminderAutomation, type ReminderAutomationStatus } from './src/services/reminders';
import {
  type AppCurrency,
  type AppData,
  type AppLanguage,
  type AppSettings,
  type Lesson,
  type LessonDraft,
  type Payment,
  type PaymentDraft,
  type ScreenTab,
  type Student,
  type StudentDraft,
} from './src/domain/types';
import { syncTutorWidget } from './src/widget/widgetState';

const initialAutomationStatus: ReminderAutomationStatus & { widgetSyncedAt: string | null } = {
  notificationPermission: 'unknown',
  expoPushToken: '',
  pushTokenHint: 'Разрешения на уведомления еще не проверены.',
  scheduledLessonReminderCount: 0,
  lowBalanceReminderScheduled: false,
  widgetSyncedAt: null,
};

const WEEKDAY_LABELS_RU = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const RECURRENCE_PRESETS = [
  { key: 'mon', label: 'Каждый понедельник', weekdays: [1], everyWeeks: 1 },
  { key: 'tue-thu', label: 'Каждый вторник и четверг', weekdays: [2, 4], everyWeeks: 1 },
  { key: 'weekdays', label: 'Каждый будний день', weekdays: [1, 2, 3, 4, 5], everyWeeks: 1 },
  { key: 'biweekly', label: 'Раз в две недели (выбранные дни)', weekdays: [], everyWeeks: 2 },
] as const;
const STUDENT_MARKER_COLORS = ['#2667ff', '#ff7a59', '#1fa774', '#9a4dff', '#eb5757', '#f0a202', '#0ea5a0', '#7c4d2b'];
const ANONYMOUS_LESSON_COLOR = '#6b7280';
const TAB_ICONS: Record<ScreenTab, keyof typeof Ionicons.glyphMap> = {
  dashboard: 'stats-chart-outline',
  schedule: 'calendar-outline',
  students: 'people-outline',
  finances: 'card-outline',
  settings: 'settings-outline',
};

type PaymentStatus = 'paid' | 'partial' | 'outstanding';

type RecurrenceDraft = {
  enabled: boolean;
  weekdays: number[];
  everyWeeks: number;
  weeksCount: number;
  startDate: string;
};

function toDateToken(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function createMonthGrid(monthValue: Date): Date[] {
  const start = monthStart(monthValue);
  const mondayIndex = (start.getDay() + 6) % 7;
  const gridStart = new Date(start);
  gridStart.setDate(start.getDate() - mondayIndex);

  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(gridStart);
    day.setDate(gridStart.getDate() + index);
    return day;
  });
}

function dayOfWeekIso(dateToken: string): number {
  const date = new Date(`${dateToken}T00:00:00`);
  const day = date.getDay();
  return day === 0 ? 7 : day;
}

function areSameTimeslot(leftIso: string, rightIso: string): boolean {
  return leftIso.slice(0, 16) === rightIso.slice(0, 16);
}

function generateRecurringDateTokens(startDate: string, weekdays: number[], everyWeeks: number, weeksCount: number): string[] {
  const start = new Date(`${startDate}T00:00:00`);
  if (Number.isNaN(start.getTime()) || weekdays.length === 0 || weeksCount <= 0) {
    return [];
  }

  const normalizedWeekdays = [...new Set(weekdays)].sort((left, right) => left - right);
  const tokens: string[] = [];
  for (let weekOffset = 0; weekOffset < weeksCount; weekOffset += everyWeeks) {
    for (const weekday of normalizedWeekdays) {
      const base = new Date(start);
      base.setDate(start.getDate() + weekOffset * 7);
      const currentWeekday = dayOfWeekIso(toDateToken(base));
      const dayShift = weekday - currentWeekday;
      const target = new Date(base);
      target.setDate(base.getDate() + dayShift);
      if (target.getTime() < start.getTime()) {
        continue;
      }
      const token = toDateToken(target);
      if (!tokens.includes(token)) {
        tokens.push(token);
      }
    }
  }

  return tokens.sort((left, right) => left.localeCompare(right));
}

function formatLessonStatusLabel(status: Lesson['status']): string {
  if (status === 'scheduled') {
    return 'Запланирован';
  }
  if (status === 'completed') {
    return 'Проведен';
  }
  if (status === 'completed_paid') {
    return 'Проведен и оплачен';
  }
  if (status === 'cancelled') {
    return 'Отменен';
  }
  return 'Перенесен';
}

function formatLessonTime(isoValue: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(isoValue));
}

function lessonEndAt(lesson: Lesson): string {
  const end = new Date(lesson.startAt);
  end.setMinutes(end.getMinutes() + lesson.durationMinutes);
  const year = end.getFullYear();
  const month = String(end.getMonth() + 1).padStart(2, '0');
  const day = String(end.getDate()).padStart(2, '0');
  const hour = String(end.getHours()).padStart(2, '0');
  const minute = String(end.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}:00`;
}

function formatLessonTimeRange(lesson: Lesson): string {
  return `${formatLessonTime(lesson.startAt)} - ${formatLessonTime(lessonEndAt(lesson))}`;
}

function normalizeStoredLesson(lesson: Lesson): Lesson {
  const legacyStatus = lesson.status as string;
  const status: Lesson['status'] =
    legacyStatus === 'planned'
      ? 'scheduled'
      : legacyStatus === 'done'
      ? 'completed'
      : legacyStatus === 'missed'
      ? 'cancelled'
      : lesson.status;

  return {
    ...lesson,
    status,
    studentIds: lesson.studentIds ?? [],
  };
}

function createStudentColor(existingColors: Iterable<string>): string {
  const usedColors = new Set(existingColors);
  const paletteColor = STUDENT_MARKER_COLORS.find((color) => !usedColors.has(color));
  if (paletteColor) {
    return paletteColor;
  }

  for (let index = 0; index < 360; index += 1) {
    const hue = Math.round((index * 137.508) % 360);
    const color = `hsl(${hue}, 62%, 42%)`;
    if (!usedColors.has(color)) {
      return color;
    }
  }

  return '#1f6f78';
}

function normalizeStoredStudents(students: Student[]): Student[] {
  const usedColors = new Set<string>();

  return students.map((student) => {
    const color = student.color && !usedColors.has(student.color)
      ? student.color
      : createStudentColor(usedColors);
    usedColors.add(color);
    return { ...student, color };
  });
}

function formatPaymentKindLabel(kind: Payment['kind']): string {
  return kind === 'prepayment' ? 'Предоплата' : 'Оплата';
}

function formatPermissionLabel(state: ReminderAutomationStatus['notificationPermission']): string {
  if (state === 'granted') {
    return 'Разрешено';
  }
  if (state === 'denied') {
    return 'Запрещено';
  }
  if (state === 'unsupported') {
    return 'Не поддерживается';
  }
  return 'Неизвестно';
}

export default function App() {
  const [data, setData] = useState<AppData>(seedAppData);
  const [isReady, setIsReady] = useState(false);
  const [activeTab, setActiveTab] = useState<ScreenTab>('dashboard');
  const [studentDraft, setStudentDraft] = useState<StudentDraft>(createEmptyStudentDraft());
  const [lessonDraft, setLessonDraft] = useState<LessonDraft>(createEmptyLessonDraft());
  const [paymentDraft, setPaymentDraft] = useState<PaymentDraft>(createEmptyPaymentDraft());
  const [studentModalOpen, setStudentModalOpen] = useState(false);
  const [lessonModalOpen, setLessonModalOpen] = useState(false);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [dayLessonsModalOpen, setDayLessonsModalOpen] = useState(false);
  const [editingStudentId, setEditingStudentId] = useState<string | null>(null);
  const [editingLessonId, setEditingLessonId] = useState<string | null>(null);
  const [editingPaymentId, setEditingPaymentId] = useState<string | null>(null);
  const [selectedFinanceStudentId, setSelectedFinanceStudentId] = useState<string | null>(null);
  const [calendarMonth, setCalendarMonth] = useState<Date>(() => monthStart(new Date()));
  const [selectedCalendarDate, setSelectedCalendarDate] = useState<string>(() => toDateToken(new Date()));
  const [quickPaymentDrafts, setQuickPaymentDrafts] = useState<Record<string, string>>({});
  const [recurrenceDraft, setRecurrenceDraft] = useState<RecurrenceDraft>({
    enabled: false,
    weekdays: [],
    everyWeeks: 1,
    weeksCount: 8,
    startDate: toDateToken(new Date()),
  });
  const [lessonDatePickerOpen, setLessonDatePickerOpen] = useState(false);
  const [lessonDatePickerMonth, setLessonDatePickerMonth] = useState<Date>(() => monthStart(new Date()));
  const [lessonDatePickerTarget, setLessonDatePickerTarget] = useState<'lesson' | 'recurrence' | 'reschedule'>('lesson');
  const [paymentDatePickerOpen, setPaymentDatePickerOpen] = useState(false);
  const [paymentDatePickerMonth, setPaymentDatePickerMonth] = useState<Date>(() => monthStart(new Date()));
  const [statusMenuLessonId, setStatusMenuLessonId] = useState<string | null>(null);
  const [rescheduleModalOpen, setRescheduleModalOpen] = useState(false);
  const [reschedulingLessonId, setReschedulingLessonId] = useState<string | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState(toDateToken(new Date()));
  const [rescheduleTime, setRescheduleTime] = useState('16:00');
  const [deleteConfirmationLessonId, setDeleteConfirmationLessonId] = useState<string | null>(null);
  const [automationStatus, setAutomationStatus] = useState(initialAutomationStatus);

  useEffect(() => {
    const load = async () => {
      try {
        const stored = await AsyncStorage.getItem(STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored) as Partial<AppData>;
          setData({
            ...seedAppData,
            ...parsed,
            students: normalizeStoredStudents(parsed.students ?? seedAppData.students),
            lessons: (parsed.lessons ?? seedAppData.lessons).map(normalizeStoredLesson),
            payments: parsed.payments ?? seedAppData.payments,
            settings: {
              ...seedAppData.settings,
              ...(parsed.settings ?? {}),
              language: 'ru-RU',
              currency: 'MDL',
            },
          });
        }
      } catch (error) {
        console.warn('Не удалось загрузить сохраненные данные', error);
      } finally {
        setIsReady(true);
      }
    };

    void load();
  }, []);

  useEffect(() => {
    if (!isReady) {
      return;
    }

    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }, [data, isReady]);

  useEffect(() => {
    if (!isReady) {
      return;
    }

    let isCancelled = false;

    const syncAutomation = async () => {
      const reminderStatus = await syncReminderAutomation(data, false);
      const widgetSyncedAt = await syncTutorWidget(data);

      if (!isCancelled) {
        setAutomationStatus({
          ...reminderStatus,
          widgetSyncedAt,
        });
      }
    };

    void syncAutomation();

    return () => {
      isCancelled = true;
    };
  }, [data.lessons, data.payments, data.settings, data.students, isReady]);

  const studentsById = useMemo(
    () => Object.fromEntries(data.students.map((student) => [student.id, student] as const)),
    [data.students],
  );
  const activeStudents = useMemo(() => data.students.filter((student) => !student.isArchived), [data.students]);
  const activeStudentIds = useMemo(() => new Set(activeStudents.map((student) => student.id)), [activeStudents]);
  const activeLessons = useMemo(
    () =>
      data.lessons.filter(
        (lesson) => lesson.studentIds.length === 0 || lesson.studentIds.some((studentId) => activeStudentIds.has(studentId)),
      ),
    [activeStudentIds, data.lessons],
  );
  const scheduledLessons = useMemo(
    () => activeLessons.filter((lesson) => lesson.status !== 'rescheduled'),
    [activeLessons],
  );
  const studentColorById = useMemo(
    () =>
      Object.fromEntries(
        data.students.map((student) => [student.id, student.color]),
      ),
    [data.students],
  );
  const dashboard = useMemo(() => deriveDashboard(data, new Date()), [data]);
  const languageOptions: AppLanguage[] = ['ru-RU'];
  const currencyOptions: AppCurrency[] = ['MDL'];
  const currencyFormatter = useMemo(
    () =>
      new Intl.NumberFormat(data.settings.language, {
        style: 'currency',
        currency: data.settings.currency,
        maximumFractionDigits: 0,
      }),
    [data.settings.currency, data.settings.language],
  );
  const studentBalances = useMemo(
    () =>
      Object.fromEntries(
        activeStudents.map((student) => [
          student.id,
          calculateBalance(student, activeLessons, data.payments),
        ]),
      ),
    [activeLessons, activeStudents, data.payments],
  );
  const financeStudentIds = selectedFinanceStudentId
    ? [selectedFinanceStudentId]
    : activeStudents.map((student) => student.id);
  const filteredPayments = data.payments
    .filter((payment) =>
      selectedFinanceStudentId ? payment.studentId === selectedFinanceStudentId : payment.studentId === null || financeStudentIds.includes(payment.studentId),
    )
    .sort((left, right) => right.paidAt.localeCompare(left.paidAt));
  const filteredIncome = filteredPayments.reduce((total, payment) => total + payment.amount, 0);
  const lessonConflicts = useMemo(
    () => findLessonConflicts(lessonDraft, scheduledLessons, editingLessonId),
    [editingLessonId, lessonDraft, scheduledLessons],
  );
  const lessonsByDate = useMemo(
    () =>
      scheduledLessons.reduce<Record<string, Lesson[]>>((acc, lesson) => {
        const dateToken = lesson.startAt.slice(0, 10);
        const list = acc[dateToken] ?? [];
        acc[dateToken] = [...list, lesson];
        return acc;
      }, {}),
    [scheduledLessons],
  );
  const monthGridDays = useMemo(() => createMonthGrid(calendarMonth), [calendarMonth]);
  const selectedDayLessons = useMemo(
    () => sortLessons(lessonsByDate[selectedCalendarDate] ?? []),
    [lessonsByDate, selectedCalendarDate],
  );
  const studentPaymentOverview = useMemo(() => {
    return Object.fromEntries(
      activeStudents.map((student) => {
        const doneLessons = sortLessons(
          activeLessons.filter((lesson) => lesson.status === 'completed' && lesson.studentIds.includes(student.id)),
        );
        const totalDue = doneLessons.reduce((total, lesson) => total + lesson.costPerStudent, 0);
        const totalPaid = data.payments
          .filter((payment) => payment.studentId === student.id)
          .reduce((total, payment) => total + payment.amount, 0);
        const remaining = Math.max(totalDue - totalPaid, 0);
        const studentPayments = data.payments
          .filter((payment) => payment.studentId === student.id)
          .sort((left, right) => right.paidAt.localeCompare(left.paidAt));
        const lastPaymentDate = studentPayments[0]?.paidAt ?? null;
        const nextExpected = sortLessons(
          activeLessons.filter(
            (lesson) =>
              lesson.status === 'scheduled' &&
              lesson.studentIds.includes(student.id) &&
              new Date(lesson.startAt).getTime() > Date.now(),
          ),
        )[0]?.startAt;

        const lessonCoverage = new Map<string, PaymentStatus>();
        let remainingPayments = Math.max(totalPaid, 0);
        for (const lesson of doneLessons) {
          if (remainingPayments >= lesson.costPerStudent) {
            lessonCoverage.set(lesson.id, 'paid');
            remainingPayments -= lesson.costPerStudent;
          } else if (remainingPayments > 0) {
            lessonCoverage.set(lesson.id, 'partial');
            remainingPayments = 0;
          } else {
            lessonCoverage.set(lesson.id, 'outstanding');
          }
        }

        const status: PaymentStatus =
          doneLessons.length === 0
            ? 'outstanding'
            : remaining <= 0
            ? 'paid'
            : totalPaid > 0
            ? 'partial'
            : 'outstanding';

        return [
          student.id,
          {
            totalDue,
            totalPaid,
            remaining,
            lastPaymentDate,
            nextExpected,
            status,
            lessonCoverage,
          },
        ];
      }),
    );
  }, [activeLessons, activeStudents, data.payments]);
  const todayDateToken = toDateToken(new Date());
  const todayLessons = useMemo(
    () => sortLessons(lessonsByDate[todayDateToken] ?? []),
    [lessonsByDate, todayDateToken],
  );
  const todayStudentEntries = useMemo(
    () =>
      todayLessons.map((lesson) => {
        const studentId = lesson.studentIds[0];
        const overview = studentId ? studentPaymentOverview[studentId] : undefined;
        const lessonPaymentStatus: PaymentStatus =
          lesson.status === 'completed' ? overview?.lessonCoverage?.get(lesson.id) ?? 'outstanding' : 'outstanding';
        return {
          key: lesson.id,
          lessonTitle: lesson.title,
          studentName: studentId ? studentsById[studentId]?.name ?? 'Неизвестный ученик' : 'Резерв без ученика',
          markerColor: studentId ? studentColorById[studentId] ?? ANONYMOUS_LESSON_COLOR : ANONYMOUS_LESSON_COLOR,
          lessonTime: new Intl.DateTimeFormat('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
          }).format(new Date(lesson.startAt)),
          status: lessonPaymentStatus,
          completionStatus: lesson.status,
        };
      }),
    [studentColorById, studentPaymentOverview, studentsById, todayLessons],
  );

  const findTimeslotConflict = (
    lessons: Lesson[],
    startAt: string,
    durationMinutes: number,
    excludeLessonId?: string | null,
    excludeRecurrenceId?: string | null,
  ): Lesson | undefined => {
    const slotStart = new Date(startAt).getTime();
    const slotEnd = slotStart + durationMinutes * 60 * 1000;
    return lessons.find((lesson) => {
      if (excludeLessonId && lesson.id === excludeLessonId) {
        return false;
      }
      if (excludeRecurrenceId && lesson.recurrenceId === excludeRecurrenceId) {
        return false;
      }
      const lessonStart = new Date(lesson.startAt).getTime();
      const lessonEnd = lessonStart + lesson.durationMinutes * 60 * 1000;
      return slotStart < lessonEnd && slotEnd > lessonStart;
    });
  };

  const describeConflict = (lesson: Lesson): string => {
    const studentId = lesson.studentIds[0];
    const studentName = studentId ? studentsById[studentId]?.name ?? 'Неизвестный ученик' : 'Анонимный урок';
    return `${studentName} (${formatLessonTimeRange(lesson)})`;
  };

  const upsertStudent = () => {
    if (!studentDraft.name.trim()) {
      Alert.alert('Нужно указать имя ученика', 'Введите имя ученика перед сохранением.');
      return;
    }

    const existingStudent = editingStudentId ? data.students.find((student) => student.id === editingStudentId) : undefined;
    const nextStudent: Student = {
      id: editingStudentId ?? `student-${Date.now()}`,
      name: studentDraft.name.trim(),
      subject: studentDraft.subject.trim(),
      phone: studentDraft.phone.trim(),
      parentName: studentDraft.parentName.trim(),
      parentPhone: studentDraft.parentPhone.trim(),
      email: studentDraft.email.trim(),
      notes: studentDraft.notes.trim(),
      openingBalance: Number(studentDraft.openingBalance) || 0,
      defaultRate: Number(studentDraft.defaultRate) || 0,
      color: existingStudent?.color ?? createStudentColor(data.students.map((student) => student.color)),
      isArchived: studentDraft.isArchived,
    };

    setData((current) => {
      const students = editingStudentId
        ? current.students.map((student) => (student.id === editingStudentId ? nextStudent : student))
        : [nextStudent, ...current.students];
      return { ...current, students };
    });

    closeStudentModal();
  };

  const upsertLesson = () => {
    if (!isValidLessonDraft(lessonDraft)) {
      Alert.alert('Данные урока неполные', 'Укажите тему, дату, время и длительность.');
      return;
    }

    const startAt = parseLessonStart(lessonDraft.lessonDate, lessonDraft.lessonTime);
    if (!startAt) {
      Alert.alert('Некорректные дата или время', 'Используйте форматы YYYY-MM-DD и HH:mm.');
      return;
    }

    const selectedStudentId = lessonDraft.studentIds[0];
    const selectedStudent = selectedStudentId ? studentsById[selectedStudentId] : undefined;
    const nextLesson: Lesson = {
      id: editingLessonId ?? `lesson-${Date.now()}`,
      title: lessonDraft.title.trim(),
      startAt,
      durationMinutes: Number(lessonDraft.durationMinutes) || 60,
      costPerStudent: selectedStudent?.defaultRate ?? Math.max(0, Number(lessonDraft.anonymousPrice) || 0),
      status: lessonDraft.status,
      studentIds: selectedStudentId ? [selectedStudentId] : [],
      note: lessonDraft.note.trim(),
      recurrenceId: null,
      recurrenceEveryWeeks: null,
      recurrenceWeekdays: null,
      recurrenceStartDate: null,
    };

    if (lessonConflicts.length > 0) {
      Alert.alert('Пересечение в расписании', `Урок пересекается с ${describeConflict(lessonConflicts[0])}.`);
      return;
    }

    if (recurrenceDraft.enabled && recurrenceDraft.weekdays.length > 0) {
      const sourceLesson = editingLessonId ? data.lessons.find((lesson) => lesson.id === editingLessonId) : null;
      const recurrenceId = sourceLesson?.recurrenceId ?? `series-${Date.now()}`;
      const dateTokens = generateRecurringDateTokens(
        recurrenceDraft.startDate || lessonDraft.lessonDate,
        recurrenceDraft.weekdays,
        recurrenceDraft.everyWeeks,
        recurrenceDraft.weeksCount,
      );

      if (dateTokens.length === 0) {
        Alert.alert('Не удалось создать серию', 'Проверьте дни недели и параметры повторения.');
        return;
      }

      const plannedLessons: Lesson[] = [];
      for (const dateToken of dateTokens) {
        const recurringStart = parseLessonStart(dateToken, lessonDraft.lessonTime);
        if (!recurringStart) {
          continue;
        }
        const existingConflict = findTimeslotConflict(
          scheduledLessons,
          recurringStart,
          nextLesson.durationMinutes,
          editingLessonId,
          editingLessonId ? recurrenceId : null,
        );
        const plannedConflict = plannedLessons.find((lesson) => {
          const currentStart = new Date(recurringStart).getTime();
          const currentEnd = currentStart + nextLesson.durationMinutes * 60 * 1000;
          const plannedStart = new Date(lesson.startAt).getTime();
          const plannedEnd = plannedStart + lesson.durationMinutes * 60 * 1000;
          return currentStart < plannedEnd && currentEnd > plannedStart;
        });
        if (existingConflict || plannedConflict) {
          Alert.alert(
            'Пересечение в расписании',
            `Урок на ${dateToken} ${lessonDraft.lessonTime} пересекается с ${describeConflict(existingConflict ?? plannedConflict!)}.`,
          );
          return;
        }

        plannedLessons.push({
          ...nextLesson,
          id: `lesson-${Date.now()}-${dateToken}`,
          startAt: recurringStart,
          recurrenceId,
          recurrenceEveryWeeks: recurrenceDraft.everyWeeks,
          recurrenceWeekdays: recurrenceDraft.weekdays,
          recurrenceStartDate: recurrenceDraft.startDate || lessonDraft.lessonDate,
        });
      }

      setData((current) => {
        const cleaned = editingLessonId
          ? current.lessons.filter((lesson) => {
              if (sourceLesson?.recurrenceId && lesson.recurrenceId === sourceLesson.recurrenceId) {
                return lesson.startAt.slice(0, 10) < (recurrenceDraft.startDate || lessonDraft.lessonDate);
              }
              return lesson.id !== editingLessonId;
            })
          : current.lessons;
        return {
          ...current,
          lessons: [...plannedLessons, ...cleaned],
        };
      });

      closeLessonModal();
      return;
    }

    setData((current) => {
      const lessons = editingLessonId
        ? current.lessons.map((lesson) => (lesson.id === editingLessonId ? nextLesson : lesson))
        : [nextLesson, ...current.lessons];
      return { ...current, lessons };
    });

    closeLessonModal();
  };

  const upsertPayment = () => {
    if (!paymentDraft.studentId || !paymentDraft.amount) {
      Alert.alert('Данные платежа неполные', 'Выберите ученика и укажите сумму платежа.');
      return;
    }

    const amount = Number(paymentDraft.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      Alert.alert('Некорректная сумма', 'Введите сумму больше нуля.');
      return;
    }

    const nextPayment: Payment = {
      id: editingPaymentId ?? `payment-${Date.now()}`,
      studentId: paymentDraft.studentId,
      amount,
      paidAt: paymentDraft.paidAt || toDateToken(new Date()),
      kind: paymentDraft.kind,
      note: paymentDraft.note.trim(),
    };

    setData((current) => {
      const payments = editingPaymentId
        ? current.payments.map((payment) => (payment.id === editingPaymentId ? nextPayment : payment))
        : [nextPayment, ...current.payments];
      return {
        ...current,
        payments,
      };
    });

    closePaymentModal();
  };

  const deletePayment = (paymentId: string) => {
    Alert.alert('Удалить оплату?', 'Действие нельзя отменить. Баланс и статистика будут пересчитаны.', [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: () => {
          setData((current) => ({
            ...current,
            payments: current.payments.filter((payment) => payment.id !== paymentId),
          }));

          if (editingPaymentId === paymentId) {
            closePaymentModal();
          }
        },
      },
    ]);
  };

  const addQuickPayment = (studentId: string) => {
    const amountRaw = quickPaymentDrafts[studentId] ?? '';
    const amount = Number(amountRaw);
    if (!Number.isFinite(amount) || amount <= 0) {
      Alert.alert('Некорректная сумма', 'Введите сумму больше нуля.');
      return;
    }

    const nextPayment: Payment = {
      id: `payment-${Date.now()}`,
      studentId,
      amount,
      paidAt: toDateToken(new Date()),
      kind: 'payment',
      note: '',
    };

    setData((current) => ({
      ...current,
      payments: [nextPayment, ...current.payments],
    }));
    setQuickPaymentDrafts((current) => ({ ...current, [studentId]: '' }));
  };

  const openStudentEditor = (student?: Student) => {
    if (student) {
      setEditingStudentId(student.id);
      setStudentDraft({
        name: student.name,
        subject: student.subject,
        phone: student.phone,
        parentName: student.parentName,
        parentPhone: student.parentPhone,
        email: student.email,
        notes: student.notes,
        openingBalance: String(student.openingBalance),
        defaultRate: String(student.defaultRate),
        isArchived: student.isArchived,
      });
    } else {
      setEditingStudentId(null);
      setStudentDraft(createEmptyStudentDraft());
    }

    setStudentModalOpen(true);
  };

  const openLessonEditor = (lesson?: Lesson, slot?: { date: string; time: string }) => {
    if (lesson) {
      const [datePart, timePartWithSeconds] = lesson.startAt.split('T');
      setEditingLessonId(lesson.id);
      setLessonDraft({
        title: lesson.title,
        lessonDate: datePart,
        lessonTime: timePartWithSeconds.slice(0, 5),
        durationMinutes: String(lesson.durationMinutes),
        anonymousPrice: String(lesson.costPerStudent),
        studentIds: lesson.studentIds.slice(0, 1),
        note: lesson.note,
        status: lesson.status,
      });
      setRecurrenceDraft({
        enabled: Boolean(lesson.recurrenceId),
        weekdays: lesson.recurrenceWeekdays ?? [],
        everyWeeks: lesson.recurrenceEveryWeeks ?? 1,
        weeksCount: 8,
        startDate: lesson.recurrenceStartDate ?? datePart,
      });
      setLessonDatePickerMonth(monthStart(new Date(`${datePart}T00:00:00`)));
    } else {
      setEditingLessonId(null);
      setLessonDraft({
        ...createEmptyLessonDraft(),
        lessonDate: slot?.date ?? selectedCalendarDate,
        lessonTime: slot?.time ?? '16:00',
      });
      setRecurrenceDraft({
        enabled: false,
        weekdays: [],
        everyWeeks: 1,
        weeksCount: 8,
        startDate: toDateToken(new Date()),
      });
      setLessonDatePickerMonth(monthStart(new Date(`${slot?.date ?? selectedCalendarDate}T00:00:00`)));
    }

    setLessonModalOpen(true);
  };

  const openPaymentEditor = (studentId?: string, payment?: Payment) => {
    const paidAt = payment?.paidAt ?? toDateToken(new Date());
    setEditingPaymentId(payment?.id ?? null);
    setPaymentDraft(
      payment
        ? {
          studentId: payment.studentId ?? '',
            amount: String(payment.amount),
            paidAt: payment.paidAt,
            kind: payment.kind,
            note: payment.note,
          }
        : {
            ...createEmptyPaymentDraft(),
            studentId: studentId ?? selectedFinanceStudentId ?? data.students[0]?.id ?? '',
            paidAt,
          },
    );
    setPaymentDatePickerMonth(monthStart(new Date(`${paidAt}T00:00:00`)));
    setPaymentModalOpen(true);
  };

  const closeStudentModal = () => {
    setStudentModalOpen(false);
    setEditingStudentId(null);
    setStudentDraft(createEmptyStudentDraft());
  };

  const closeLessonModal = () => {
    setLessonModalOpen(false);
    setEditingLessonId(null);
    setLessonDraft(createEmptyLessonDraft());
    setRecurrenceDraft({
      enabled: false,
      weekdays: [],
      everyWeeks: 1,
      weeksCount: 8,
      startDate: toDateToken(new Date()),
    });
  };

  const closePaymentModal = () => {
    setPaymentModalOpen(false);
    setEditingPaymentId(null);
    setPaymentDraft(createEmptyPaymentDraft());
  };

  const updateLessonStatus = (lessonId: string, status: Lesson['status']) => {
    setData((current) => ({
      ...current,
      lessons: current.lessons.map((lesson) => (lesson.id === lessonId ? { ...lesson, status } : lesson)),
    }));
  };

  const completeAnonymousLessonAndRecordPayment = (lessonId: string) => {
    setData((current) => {
      const lesson = current.lessons.find((item) => item.id === lessonId);
      if (!lesson || lesson.studentIds.length > 0) {
        return current;
      }
      const hasLinkedPayment = current.payments.some((payment) => payment.lessonId === lesson.id);
      const payment: Payment | null = hasLinkedPayment
        ? null
        : {
            id: `payment-${Date.now()}-anonymous`,
            studentId: null,
            lessonId: lesson.id,
            amount: lesson.costPerStudent,
            paidAt: lesson.startAt.slice(0, 10),
            kind: 'payment',
            note: `Оплата анонимного урока: ${lesson.title}`,
          };

      return {
        ...current,
        lessons: current.lessons.map((item) =>
          item.id === lesson.id ? { ...item, status: 'completed_paid' } : item,
        ),
        payments: payment ? [payment, ...current.payments] : current.payments,
      };
    });
  };

  const openRescheduleDialog = (lesson: Lesson) => {
    const [date, timeWithSeconds] = lesson.startAt.split('T');
    setReschedulingLessonId(lesson.id);
    setRescheduleDate(date);
    setRescheduleTime(timeWithSeconds.slice(0, 5));
    setLessonDatePickerMonth(monthStart(new Date(`${date}T00:00:00`)));
    setRescheduleModalOpen(true);
  };

  const handleQuickLessonStatusChange = (lesson: Lesson, status: Lesson['status']) => {
    setStatusMenuLessonId(null);
    if (status === 'rescheduled') {
      openRescheduleDialog(lesson);
      return;
    }
    if (status === 'completed_paid') {
      completeAnonymousLessonAndRecordPayment(lesson.id);
      return;
    }
    updateLessonStatus(lesson.id, status);
  };

  const confirmReschedule = () => {
    const originalLesson = reschedulingLessonId
      ? data.lessons.find((lesson) => lesson.id === reschedulingLessonId)
      : undefined;
    const startAt = parseLessonStart(rescheduleDate, rescheduleTime);

    if (!originalLesson || !startAt) {
      Alert.alert('Некорректные дата или время', 'Используйте форматы YYYY-MM-DD и HH:mm.');
      return;
    }
    const rescheduleConflicts = findLessonConflicts(
      {
        title: originalLesson.title,
        lessonDate: rescheduleDate,
        lessonTime: rescheduleTime,
        durationMinutes: String(originalLesson.durationMinutes),
        anonymousPrice: String(originalLesson.costPerStudent),
        status: 'scheduled',
        studentIds: originalLesson.studentIds,
        note: originalLesson.note,
      },
      scheduledLessons,
      originalLesson.id,
    );
    if (rescheduleConflicts.length > 0) {
      Alert.alert('Пересечение в расписании', `Урок пересекается с ${describeConflict(rescheduleConflicts[0])}.`);
      return;
    }

    const movedLesson: Lesson = {
      ...originalLesson,
      id: `lesson-${Date.now()}-rescheduled`,
      startAt,
      status: 'scheduled',
      recurrenceId: null,
      recurrenceEveryWeeks: null,
      recurrenceWeekdays: null,
      recurrenceStartDate: null,
    };

    setData((current) => ({
      ...current,
      lessons: [
        movedLesson,
        ...current.lessons.map((lesson): Lesson =>
          lesson.id === originalLesson.id ? { ...lesson, status: 'rescheduled' } : lesson,
        ),
      ],
    }));
    setRescheduleModalOpen(false);
    setReschedulingLessonId(null);
  };

  const requestLessonDeletion = (lessonId: string) => {
    setDeleteConfirmationLessonId(lessonId);
  };

  const confirmLessonDeletion = () => {
    if (!deleteConfirmationLessonId) {
      return;
    }
    const lessonId = deleteConfirmationLessonId;
    setData((current) => ({
      ...current,
      lessons: current.lessons.filter((lesson) => lesson.id !== lessonId),
      payments: current.payments.filter((payment) => payment.lessonId !== lessonId),
    }));
    setDeleteConfirmationLessonId(null);
    if (editingLessonId === lessonId) {
      closeLessonModal();
    }
  };

  const toggleStudentArchive = (studentId: string) => {
    setData((current) => ({
      ...current,
      students: current.students.map((student) =>
        student.id === studentId ? { ...student, isArchived: !student.isArchived } : student,
      ),
    }));
  };

  const updateSettings = (patch: Partial<AppSettings>) => {
    setData((current) => ({
      ...current,
      settings: {
        ...current.settings,
        ...patch,
      },
    }));
  };

  const enableNotificationsAndPush = async () => {
    const reminderStatus = await syncReminderAutomation(data, true);
    setAutomationStatus((current) => ({
      ...current,
      ...reminderStatus,
    }));
  };

  const tabLabels: Record<ScreenTab, string> = {
    dashboard: 'Статистика',
    schedule: 'Календарь',
    students: 'Ученики',
    finances: 'Оплаты',
    settings: 'Настройки',
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
        <StatusBar style="dark" />
        <View style={styles.pageHeader}>
          <Text style={styles.pageHeaderTitle}>{tabLabels[activeTab]}</Text>
        </View>

        <View style={styles.shell}>
          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {activeTab === 'dashboard' ? (
            <>
              <View style={styles.grid}>
                <StatCard
                  label="Активные ученики"
                  value={String(dashboard.activeStudentCount)}
                  accent="#4f8cff"
                />
                <StatCard
                  label="В архиве"
                  value={String(dashboard.archivedStudentCount)}
                  accent="#9aa6b2"
                />
                <StatCard
                  label="Поступило за месяц"
                  value={formatCurrency(dashboard.monthIncome, currencyFormatter)}
                  accent="#1a9c6a"
                />
                <StatCard
                  label="Начислено за месяц"
                  value={formatCurrency(dashboard.monthBilled, currencyFormatter)}
                  accent="#ff8c42"
                />
              </View>

              <SectionCard title="Уроки на сегодня">
                {todayStudentEntries.length === 0 ? (
                  <Text style={styles.noteText}>На сегодня уроков нет.</Text>
                ) : (
                  todayStudentEntries.map((entry) => (
                      <View key={`today-${entry.key}`} style={styles.paymentRow}>
                        <View>
                          <View style={styles.calendarLessonTitleRow}>
                            <View style={[styles.calendarDot, { backgroundColor: entry.markerColor }]} />
                            <Text style={styles.financeName}>{entry.studentName}</Text>
                          </View>
                          <Text style={styles.financeMeta}>{entry.lessonTitle} · {entry.lessonTime}</Text>
                        </View>
                        <View style={styles.todayLessonStatusWrap}>
                          <Text
                            style={[
                              styles.statusBadge,
                              entry.status === 'paid'
                                ? styles.statusPaid
                                : entry.status === 'partial'
                                ? styles.statusPartial
                                : styles.statusOutstanding,
                            ]}
                          >
                            {entry.status === 'paid' ? 'Оплачено' : entry.status === 'partial' ? 'Частично оплачено' : 'Есть долг'}
                          </Text>
                          <Text style={styles.financeMeta}>
                            {entry.completionStatus === 'completed'
                              ? 'Проведен'
                              : entry.completionStatus === 'cancelled'
                              ? 'Отменен'
                              : entry.completionStatus === 'rescheduled'
                              ? 'Перенесен'
                              : 'Запланирован'}
                          </Text>
                        </View>
                      </View>
                    ))
                )}
              </SectionCard>

              <SectionCard title="Посещаемость и финансы">
                <RowLabelValue label="Проведенные уроки" value={String(dashboard.doneLessonsCount)} />
                <RowLabelValue label="Пропущенные уроки" value={String(dashboard.missedLessonsCount)} />
                <RowLabelValue label="Запланированные уроки" value={String(dashboard.plannedLessonsCount)} />
                <RowLabelValue
                  label="Общая задолженность"
                  value={formatCurrency(dashboard.totalDebtAbs, currencyFormatter)}
                />
              </SectionCard>

            </>
          ) : null}

          {activeTab === 'schedule' ? (
            <>
              <ActionHeader
                actionLabel="Добавить урок"
                onAction={() => openLessonEditor()}
              />

              <SectionCard title="Календарь на месяц">
                <View style={styles.calendarMonthHeader}>
                  <SmallAction
                    label="← Месяц"
                    onPress={() =>
                      setCalendarMonth((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1))
                    }
                  />
                  <Text style={styles.calendarMonthTitle}>{formatMonthYear(calendarMonth.toISOString(), 'ru-RU')}</Text>
                  <SmallAction
                    label="Месяц →"
                    onPress={() =>
                      setCalendarMonth((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1))
                    }
                  />
                </View>

                <View style={styles.calendarWeekHeader}>
                  {WEEKDAY_LABELS_RU.map((label) => (
                    <Text key={label} style={styles.calendarWeekHeaderLabel}>
                      {label}
                    </Text>
                  ))}
                </View>

                <View style={styles.calendarGrid}>
                  {monthGridDays.map((gridDay) => {
                    const dateToken = toDateToken(gridDay);
                    const dayLessons = lessonsByDate[dateToken] ?? [];
                    const dayLessonMarkers = dayLessons.map((lesson) => ({
                      id: lesson.id,
                      color: lesson.studentIds[0]
                        ? studentColorById[lesson.studentIds[0]] ?? ANONYMOUS_LESSON_COLOR
                        : ANONYMOUS_LESSON_COLOR,
                    }));
                    const isCurrentMonth = gridDay.getMonth() === calendarMonth.getMonth();
                    const isSelected = selectedCalendarDate === dateToken;
                    const isToday = dateToken === toDateToken(new Date());
                    const hasCancelledLesson = dayLessons.some((lesson) => lesson.status === 'cancelled');
                    const hasRescheduledLesson = dayLessons.some((lesson) => lesson.status === 'rescheduled');

                    return (
                      <Pressable
                        key={dateToken}
                        style={[
                          styles.calendarCell,
                          !isCurrentMonth && styles.calendarCellMuted,
                          hasCancelledLesson && styles.calendarCellCancelled,
                          hasRescheduledLesson && styles.calendarCellRescheduled,
                          isSelected && styles.calendarCellSelected,
                        ]}
                        onPress={() => {
                          setSelectedCalendarDate(dateToken);
                          if (!isCurrentMonth) {
                            setCalendarMonth(monthStart(gridDay));
                          }
                          setDayLessonsModalOpen(true);
                        }}
                      >
                        <Text
                          style={[
                            styles.calendarCellDay,
                            !isCurrentMonth && styles.calendarCellDayMuted,
                            isToday && styles.calendarCellDayToday,
                          ]}
                        >
                          {gridDay.getDate()}
                        </Text>
                        <View style={styles.calendarDotsRow}>
                          {dayLessonMarkers.map((marker) => (
                            <View
                              key={`${dateToken}-${marker.id}`}
                              style={[
                                styles.calendarDot,
                                { backgroundColor: marker.color },
                              ]}
                            />
                          ))}
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
                <View style={styles.calendarLegend}>
                  {activeStudents.map((student) => (
                    <View key={student.id} style={styles.calendarLegendItem}>
                      <View style={[styles.calendarDot, { backgroundColor: student.color }]} />
                      <Text style={styles.calendarLegendText}>{student.name}</Text>
                    </View>
                  ))}
                  <View style={styles.calendarLegendItem}>
                    <View style={[styles.calendarDot, { backgroundColor: ANONYMOUS_LESSON_COLOR }]} />
                    <Text style={styles.calendarLegendText}>Резерв без ученика</Text>
                  </View>
                </View>
              </SectionCard>

            </>
          ) : null}

          {activeTab === 'students' ? (
            <>
              <ActionHeader
                actionLabel="Добавить ученика"
                onAction={() => openStudentEditor()}
              />
              {data.students.map((student) => (
                <SectionCard
                  key={student.id}
                  title={student.name}
                  subtitle={`${student.subject || 'Предмет не указан'} • ${student.phone || 'Телефон не указан'}`}
                >
                  <RowLabelValue label="Родитель" value={student.parentName || 'Не указано'} />
                  <RowLabelValue label="Телефон родителя" value={student.parentPhone || 'Не указано'} />
                  <RowLabelValue label="Email" value={student.email || 'Не указано'} />
                  <RowLabelValue
                    label="Текущий баланс"
                    value={formatCurrency(studentBalances[student.id] ?? 0, currencyFormatter)}
                  />
                  <RowLabelValue
                    label="Ставка по умолчанию"
                    value={formatCurrency(student.defaultRate, currencyFormatter)}
                  />
                  <Text style={styles.noteText}>{student.notes || 'Заметок пока нет.'}</Text>

                  <View style={styles.paymentOverviewCard}>
                    <Text
                      style={[
                        styles.statusBadge,
                        studentPaymentOverview[student.id]?.status === 'paid'
                          ? styles.statusPaid
                          : studentPaymentOverview[student.id]?.status === 'partial'
                          ? styles.statusPartial
                          : styles.statusOutstanding,
                      ]}
                    >
                      {studentPaymentOverview[student.id]?.status === 'paid'
                        ? 'Оплачено'
                        : studentPaymentOverview[student.id]?.status === 'partial'
                        ? 'Частично оплачено'
                        : 'Есть долг'}
                    </Text>
                    <RowLabelValue
                      label="Всего начислено"
                      value={formatCurrency(studentPaymentOverview[student.id]?.totalDue ?? 0, currencyFormatter)}
                    />
                    <RowLabelValue
                      label="Всего оплачено"
                      value={formatCurrency(studentPaymentOverview[student.id]?.totalPaid ?? 0, currencyFormatter)}
                    />
                    <RowLabelValue
                      label="Остаток"
                      value={formatCurrency(studentPaymentOverview[student.id]?.remaining ?? 0, currencyFormatter)}
                    />
                    <RowLabelValue
                      label="Последняя оплата"
                      value={
                        studentPaymentOverview[student.id]?.lastPaymentDate
                          ? formatShortDate(studentPaymentOverview[student.id]?.lastPaymentDate ?? '', 'ru-RU')
                          : 'Нет оплат'
                      }
                    />
                    <RowLabelValue
                      label="Следующий ожидаемый платеж"
                      value={
                        studentPaymentOverview[student.id]?.nextExpected
                          ? formatLessonDate(studentPaymentOverview[student.id]?.nextExpected ?? '', 'ru-RU')
                          : 'Не запланирован'
                      }
                    />

                    <View style={styles.quickPaymentRow}>
                      <TextInput
                        value={quickPaymentDrafts[student.id] ?? ''}
                        onChangeText={(value) =>
                          setQuickPaymentDrafts((current) => ({
                            ...current,
                            [student.id]: value,
                          }))
                        }
                        placeholder="Сумма"
                        placeholderTextColor="#8a9ba8"
                        keyboardType="numeric"
                        style={styles.quickPaymentInput}
                      />
                      <SmallAction label="Добавить оплату" onPress={() => addQuickPayment(student.id)} />
                    </View>
                  </View>

                  <View style={styles.inlineActions}>
                    <SmallAction label="Редактировать" onPress={() => openStudentEditor(student)} />
                    <SmallAction
                      label={student.isArchived ? 'Восстановить' : 'В архив'}
                      onPress={() => toggleStudentArchive(student.id)}
                    />
                    <SmallAction label="Оплата" onPress={() => openPaymentEditor(student.id)} />
                  </View>
                </SectionCard>
              ))}
            </>
          ) : null}

          {activeTab === 'finances' ? (
            <>
              <ActionHeader
                actionLabel="Добавить оплату"
                onAction={() => openPaymentEditor()}
              />
              <SectionCard title="Фильтр">
                <View style={styles.chipWrap}>
                  <Pill
                    label="Все ученики"
                    selected={selectedFinanceStudentId === null}
                    onPress={() => setSelectedFinanceStudentId(null)}
                  />
                  {activeStudents.map((student) => (
                    <Pill
                      key={student.id}
                      label={student.name}
                      selected={selectedFinanceStudentId === student.id}
                      onPress={() => setSelectedFinanceStudentId(student.id)}
                    />
                  ))}
                </View>
                <RowLabelValue label="Получено оплат" value={formatCurrency(filteredIncome, currencyFormatter)} />
              </SectionCard>

              <SectionCard title="Статусы оплат">
                {activeStudents
                  .filter((student) => selectedFinanceStudentId === null || student.id === selectedFinanceStudentId)
                  .map((student) => {
                  const overview = studentPaymentOverview[student.id];
                  return (
                    <View key={student.id} style={styles.financeRow}>
                      <View>
                        <Text style={styles.financeName}>{student.name}</Text>
                        <Text style={styles.financeMeta}>{student.subject || 'Предмет не указан'}</Text>
                      </View>
                      <View>
                        <Text
                          style={[
                            styles.statusBadge,
                            overview?.status === 'paid'
                              ? styles.statusPaid
                              : overview?.status === 'partial'
                              ? styles.statusPartial
                              : styles.statusOutstanding,
                          ]}
                        >
                          {overview?.status === 'paid'
                            ? 'Оплачено'
                            : overview?.status === 'partial'
                            ? 'Частично оплачено'
                            : 'Есть долг'}
                        </Text>
                        <Text style={styles.financeBalance}>
                          {formatCurrency(overview?.remaining ?? 0, currencyFormatter)}
                        </Text>
                      </View>
                    </View>
                  );
                })}
              </SectionCard>

              <SectionCard title="История платежей">
                {filteredPayments.map((payment) => (
                  <View key={payment.id} style={styles.paymentRow}>
                    <View>
                      <Text style={styles.financeName}>
                        {payment.studentId ? studentsById[payment.studentId]?.name ?? 'Неизвестный ученик' : 'Анонимный урок'}
                      </Text>
                      <Text style={styles.financeMeta}>
                        {formatPaymentKindLabel(payment.kind)} • {formatShortDate(payment.paidAt, 'ru-RU')}
                      </Text>
                    </View>
                    <View style={styles.paymentActions}>
                      <Text style={styles.paymentAmount}>{formatCurrency(payment.amount, currencyFormatter)}</Text>
                      <View style={styles.inlineActions}>
                        <SmallAction label="Изменить" onPress={() => openPaymentEditor(undefined, payment)} />
                        <SmallAction label="Удалить" onPress={() => deletePayment(payment.id)} />
                      </View>
                    </View>
                  </View>
                ))}
              </SectionCard>
            </>
          ) : null}

          {activeTab === 'settings' ? (
            <>
              <ActionHeader
                actionLabel="К обзору"
                onAction={() => setActiveTab('dashboard')}
              />

              <SectionCard title="Язык">
                <View style={styles.chipWrap}>
                  {languageOptions.map((language) => (
                    <Pill
                      key={language}
                      label="Русский"
                      selected={data.settings.language === language}
                      onPress={() => updateSettings({ language })}
                    />
                  ))}
                </View>
              </SectionCard>

              <SectionCard title="Валюта">
                <View style={styles.chipWrap}>
                  {currencyOptions.map((currency) => (
                    <Pill
                      key={currency}
                      label="MDL (Lei)"
                      selected={data.settings.currency === currency}
                      onPress={() => updateSettings({ currency })}
                    />
                  ))}
                </View>
              </SectionCard>

              <SectionCard title="Напоминания">
                <RowLabelValue label="Доступ к уведомлениям" value={formatPermissionLabel(automationStatus.notificationPermission)} />
                <RowLabelValue
                  label="Напоминания об уроках"
                  value={String(automationStatus.scheduledLessonReminderCount)}
                />
                <RowLabelValue
                  label="Напоминание о балансе"
                  value={automationStatus.lowBalanceReminderScheduled ? 'Ежедневно в 08:00' : 'Не запланировано'}
                />
                <View style={styles.switchRow}>
                  <Text style={styles.switchLabel}>Напоминания об уроках</Text>
                  <Switch
                    value={data.settings.lessonRemindersEnabled}
                    onValueChange={(value) => updateSettings({ lessonRemindersEnabled: value })}
                  />
                </View>
                <Field
                  label="Минут до урока"
                  value={String(data.settings.reminderMinutesBeforeLesson)}
                  onChangeText={(value) =>
                    updateSettings({ reminderMinutesBeforeLesson: Math.max(5, Number(value) || 5) })
                  }
                  placeholder="45"
                  keyboardType="numeric"
                />
                <View style={styles.switchRow}>
                  <Text style={styles.switchLabel}>Напоминания о низком балансе</Text>
                  <Switch
                    value={data.settings.lowBalanceRemindersEnabled}
                    onValueChange={(value) => updateSettings({ lowBalanceRemindersEnabled: value })}
                  />
                </View>
                <Field
                  label="Порог низкого баланса"
                  value={String(data.settings.lowBalanceThreshold)}
                  onChangeText={(value) =>
                    updateSettings({ lowBalanceThreshold: Math.max(-9999, Number(value) || 0) })
                  }
                  placeholder="20"
                  keyboardType="numeric"
                />
                <Text style={styles.supportText}>{automationStatus.pushTokenHint}</Text>
                {automationStatus.expoPushToken ? (
                  <Text selectable style={styles.tokenText}>
                    {automationStatus.expoPushToken}
                  </Text>
                ) : null}
                <View style={styles.inlineActions}>
                  <SmallAction label="Включить уведомления" onPress={() => void enableNotificationsAndPush()} />
                </View>
              </SectionCard>
            </>
          ) : null}
          </ScrollView>

          <SafeAreaView style={styles.tabBar} edges={['bottom', 'left', 'right']}>
            {(['dashboard', 'schedule', 'students', 'finances', 'settings'] as ScreenTab[]).map((tab) => {
              const isActive = activeTab === tab;
              return (
                <Pressable
                  key={tab}
                  accessibilityLabel={tabLabels[tab]}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: isActive }}
                  onPress={() => setActiveTab(tab)}
                  style={[styles.tabButton, isActive && styles.tabButtonActive]}
                >
                  <Ionicons name={TAB_ICONS[tab]} size={22} color={isActive ? '#123c69' : '#688096'} />
                  <Text style={[styles.tabButtonText, isActive && styles.tabButtonTextActive]}>{tabLabels[tab]}</Text>
                </Pressable>
              );
            })}
          </SafeAreaView>
        </View>

      <Modal visible={studentModalOpen} animationType="slide" transparent onRequestClose={closeStudentModal}>
        <ModalCard title={editingStudentId ? 'Редактировать ученика' : 'Добавить ученика'} onClose={closeStudentModal}>
          <Field
            label="Имя ученика"
            value={studentDraft.name}
            onChangeText={(value) => setStudentDraft((current) => ({ ...current, name: value }))}
            placeholder="Мария Иванова"
          />
          <Field
            label="Предмет"
            value={studentDraft.subject}
            onChangeText={(value) => setStudentDraft((current) => ({ ...current, subject: value }))}
            placeholder="Английский"
          />
          <Field
            label="Телефон"
            value={studentDraft.phone}
            onChangeText={(value) => setStudentDraft((current) => ({ ...current, phone: value }))}
            placeholder="+373 69 123 456"
            keyboardType="phone-pad"
          />
          <Field
            label="Имя родителя"
            value={studentDraft.parentName}
            onChangeText={(value) => setStudentDraft((current) => ({ ...current, parentName: value }))}
            placeholder="Елена Иванова"
          />
          <Field
            label="Телефон родителя"
            value={studentDraft.parentPhone}
            onChangeText={(value) => setStudentDraft((current) => ({ ...current, parentPhone: value }))}
            placeholder="+373 69 987 654"
            keyboardType="phone-pad"
          />
          <Field
            label="Email"
            value={studentDraft.email}
            onChangeText={(value) => setStudentDraft((current) => ({ ...current, email: value }))}
            placeholder="maria@example.com"
            keyboardType="email-address"
          />
          <Field
            label="Начальный баланс"
            value={studentDraft.openingBalance}
            onChangeText={(value) => setStudentDraft((current) => ({ ...current, openingBalance: value }))}
            placeholder="0"
            keyboardType="numeric"
          />
          <Field
            label="Ставка урока по умолчанию"
            value={studentDraft.defaultRate}
            onChangeText={(value) => setStudentDraft((current) => ({ ...current, defaultRate: value }))}
            placeholder="45"
            keyboardType="numeric"
          />
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Архивировать ученика</Text>
            <Switch
              value={studentDraft.isArchived}
              onValueChange={(value) => setStudentDraft((current) => ({ ...current, isArchived: value }))}
            />
          </View>
          <TextArea
            label="Заметки"
            value={studentDraft.notes}
            onChangeText={(value) => setStudentDraft((current) => ({ ...current, notes: value }))}
            placeholder="Цели, удобное время, комментарии"
          />
          <PrimaryButton label="Сохранить ученика" onPress={upsertStudent} />
        </ModalCard>
      </Modal>

      <Modal visible={lessonModalOpen} animationType="slide" transparent onRequestClose={closeLessonModal}>
        <ModalCard
          title={editingLessonId ? 'Редактировать урок' : 'Добавить урок'}
          onClose={closeLessonModal}
          footer={
            <View style={styles.lessonEditorFooter}>
              <SmallAction label="Отмена" onPress={closeLessonModal} />
              <View style={styles.lessonEditorFooterMain}>
                {editingLessonId ? (
                  <Pressable style={styles.destructiveFooterButton} onPress={() => requestLessonDeletion(editingLessonId)}>
                    <Text style={styles.destructiveFooterButtonText}>Удалить</Text>
                  </Pressable>
                ) : null}
                <PrimaryButton label="Сохранить" onPress={upsertLesson} compact />
              </View>
            </View>
          }
        >
          <Field
            label="Название урока"
            value={lessonDraft.title}
            onChangeText={(value) => setLessonDraft((current) => ({ ...current, title: value }))}
            placeholder="Разговорный клуб"
          />
          <DateFieldButton
            label="Дата"
            value={formatShortDate(`${lessonDraft.lessonDate}T00:00:00`, 'ru-RU')}
            onPress={() => {
              setLessonDatePickerTarget('lesson');
              setLessonDatePickerOpen(true);
            }}
          />
          <Field
            label="Время"
            value={lessonDraft.lessonTime}
            onChangeText={(value) => setLessonDraft((current) => ({ ...current, lessonTime: value }))}
            placeholder="16:00"
          />
          <Field
            label="Длительность, минут"
            value={lessonDraft.durationMinutes}
            onChangeText={(value) => setLessonDraft((current) => ({ ...current, durationMinutes: value }))}
            placeholder="60"
            keyboardType="numeric"
          />
          <Text style={styles.selectorTitle}>Ученик</Text>
          <View style={styles.chipWrap}>
            {data.students
              .filter((student) => !student.isArchived)
              .map((student) => {
                const selected = lessonDraft.studentIds.includes(student.id);
                return (
                  <Pill
                    key={student.id}
                    label={student.name}
                    selected={selected}
                    onPress={() =>
                      setLessonDraft((current) => ({
                        ...current,
                        studentIds: selected ? [] : [student.id],
                      }))
                    }
                  />
                );
              })}
          </View>
          <Text style={styles.supportText}>Цена урока берется из ставки выбранного ученика. Без выбора урок сохраняется как резерв.</Text>
          {lessonDraft.studentIds.length === 0 ? (
            <Field
              label="Цена анонимного урока (MDL)"
              value={lessonDraft.anonymousPrice}
              onChangeText={(value) => setLessonDraft((current) => ({ ...current, anonymousPrice: value }))}
              placeholder="0"
              keyboardType="numeric"
            />
          ) : null}
          <Text style={[styles.conflictText, lessonConflicts.length === 0 ? styles.freeTimeText : styles.busyTimeText]}>
            {lessonConflicts.length === 0
              ? 'Выбранное время свободно.'
              : `Пересечение с ${lessonConflicts.length} уроком(ами):`}
          </Text>
          {lessonConflicts.map((lesson) => (
            <Text key={lesson.id} style={styles.conflictDetailText}>
              {describeConflict(lesson)}
            </Text>
          ))}

          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Создать серию уроков</Text>
            <Switch
              value={recurrenceDraft.enabled}
              onValueChange={(value) =>
                setRecurrenceDraft((current) => ({
                  ...current,
                  enabled: value,
                  weekdays: value ? (current.weekdays.length ? current.weekdays : [dayOfWeekIso(lessonDraft.lessonDate)]) : [],
                  startDate: lessonDraft.lessonDate,
                }))
              }
            />
          </View>

          {recurrenceDraft.enabled ? (
            <View style={styles.recurrencePanel}>
              <Text style={styles.selectorTitle}>Шаблоны повторений</Text>
              <View style={styles.chipWrap}>
                {RECURRENCE_PRESETS.map((preset) => (
                  <Pill
                    key={preset.key}
                    label={preset.label}
                    selected={
                      recurrenceDraft.everyWeeks === preset.everyWeeks &&
                      preset.weekdays.every((day) => recurrenceDraft.weekdays.includes(day)) &&
                      recurrenceDraft.weekdays.length === (preset.weekdays.length || recurrenceDraft.weekdays.length)
                    }
                    onPress={() =>
                      setRecurrenceDraft((current) => ({
                        ...current,
                        everyWeeks: preset.everyWeeks,
                        weekdays: preset.weekdays.length > 0 ? [...preset.weekdays] : current.weekdays,
                      }))
                    }
                  />
                ))}
              </View>

              <Text style={styles.selectorTitle}>Дни недели</Text>
              <View style={styles.chipWrap}>
                {WEEKDAY_LABELS_RU.map((label, index) => {
                  const dayNumber = index + 1;
                  const selected = recurrenceDraft.weekdays.includes(dayNumber);
                  return (
                    <Pill
                      key={label}
                      label={label}
                      selected={selected}
                      onPress={() =>
                        setRecurrenceDraft((current) => ({
                          ...current,
                          weekdays: selected
                            ? current.weekdays.filter((value) => value !== dayNumber)
                            : [...current.weekdays, dayNumber],
                        }))
                      }
                    />
                  );
                })}
              </View>

              <Field
                label="Интервал в неделях"
                value={String(recurrenceDraft.everyWeeks)}
                onChangeText={(value) =>
                  setRecurrenceDraft((current) => ({
                    ...current,
                    everyWeeks: Math.max(1, Number(value) || 1),
                  }))
                }
                placeholder="1"
                keyboardType="numeric"
              />
              <Field
                label="На сколько недель вперед создать"
                value={String(recurrenceDraft.weeksCount)}
                onChangeText={(value) =>
                  setRecurrenceDraft((current) => ({
                    ...current,
                    weeksCount: Math.max(1, Number(value) || 1),
                  }))
                }
                placeholder="8"
                keyboardType="numeric"
              />
              <DateFieldButton
                label="Дата начала серии"
                value={formatShortDate(`${recurrenceDraft.startDate}T00:00:00`, 'ru-RU')}
                onPress={() => {
                  setLessonDatePickerTarget('recurrence');
                  setLessonDatePickerOpen(true);
                }}
              />
            </View>
          ) : null}

          <Text style={styles.selectorTitle}>Статус</Text>
          <View style={styles.chipWrap}>
            {(['scheduled', 'completed', 'cancelled', 'rescheduled'] as Lesson['status'][]).map((status) => (
              <Pill
                key={status}
                label={formatLessonStatusLabel(status)}
                selected={lessonDraft.status === status}
                onPress={() => setLessonDraft((current) => ({ ...current, status }))}
              />
            ))}
          </View>
          <TextArea
            label="Заметки"
            value={lessonDraft.note}
            onChangeText={(value) => setLessonDraft((current) => ({ ...current, note: value }))}
            placeholder="Домашнее задание, аудитория, ссылка"
          />
        </ModalCard>
      </Modal>

      <Modal
        visible={deleteConfirmationLessonId !== null}
        animationType="fade"
        transparent
        onRequestClose={() => setDeleteConfirmationLessonId(null)}
      >
        <ModalCard
          title="Удалить урок?"
          onClose={() => setDeleteConfirmationLessonId(null)}
          footer={
            <View style={styles.lessonEditorFooter}>
              <SmallAction label="Отмена" onPress={() => setDeleteConfirmationLessonId(null)} />
              <Pressable style={styles.destructiveFooterButton} onPress={confirmLessonDeletion}>
                <Text style={styles.destructiveFooterButtonText}>Удалить урок</Text>
              </Pressable>
            </View>
          }
        >
          <Text style={styles.supportText}>Урок будет удален из календаря, статистики и виджета. Это действие нельзя отменить.</Text>
        </ModalCard>
      </Modal>

      <Modal visible={paymentModalOpen} animationType="slide" transparent onRequestClose={closePaymentModal}>
        <ModalCard title={editingPaymentId ? 'Редактировать оплату' : 'Добавить оплату'} onClose={closePaymentModal}>
          <Text style={styles.selectorTitle}>Ученик</Text>
          <View style={styles.chipWrap}>
            {activeStudents.map((student) => (
              <Pill
                key={student.id}
                label={student.name}
                selected={paymentDraft.studentId === student.id}
                onPress={() => setPaymentDraft((current) => ({ ...current, studentId: student.id }))}
              />
            ))}
          </View>
          <Field
            label="Сумма (MDL)"
            value={paymentDraft.amount}
            onChangeText={(value) => setPaymentDraft((current) => ({ ...current, amount: value }))}
            placeholder="120"
            keyboardType="numeric"
          />
          <Text style={styles.selectorTitle}>Тип оплаты</Text>
          <View style={styles.chipWrap}>
            {(['payment', 'prepayment'] as Payment['kind'][]).map((kind) => (
              <Pill
                key={kind}
                label={formatPaymentKindLabel(kind)}
                selected={paymentDraft.kind === kind}
                onPress={() => setPaymentDraft((current) => ({ ...current, kind }))}
              />
            ))}
          </View>
          <DateFieldButton
            label="Дата"
            value={formatShortDate(`${paymentDraft.paidAt}T00:00:00`, 'ru-RU')}
            onPress={() => setPaymentDatePickerOpen(true)}
          />
          <TextArea
            label="Комментарий"
            value={paymentDraft.note}
            onChangeText={(value) => setPaymentDraft((current) => ({ ...current, note: value }))}
            placeholder="Назначение платежа"
          />
          <PrimaryButton label="Сохранить оплату" onPress={upsertPayment} />
        </ModalCard>
      </Modal>

      <Modal
        visible={dayLessonsModalOpen}
        animationType="slide"
        transparent
        onRequestClose={() => setDayLessonsModalOpen(false)}
      >
        <ModalCard
          title={`Расписание: ${formatShortDate(`${selectedCalendarDate}T00:00:00`, 'ru-RU')}`}
          onClose={() => setDayLessonsModalOpen(false)}
          footer={
            <PrimaryButton
              label="Добавить урок"
              onPress={() => {
                setDayLessonsModalOpen(false);
                openLessonEditor(undefined, { date: selectedCalendarDate, time: '16:00' });
              }}
            />
          }
        >
          {selectedDayLessons.length === 0 ? (
            <Text style={styles.noteText}>На выбранный день уроков нет.</Text>
          ) : (
            <View style={styles.dayLessonList}>
              {selectedDayLessons.map((lesson) => (
                <ScheduleLessonCard
                  key={lesson.id}
                  lesson={lesson}
                  student={lesson.studentIds[0] ? studentsById[lesson.studentIds[0]] : undefined}
                  statusMenuOpen={statusMenuLessonId === lesson.id}
                  onToggleStatus={() =>
                    setStatusMenuLessonId((current) => (current === lesson.id ? null : lesson.id))
                  }
                  onStatusChange={(status) => {
                    if (status === 'rescheduled') {
                      setDayLessonsModalOpen(false);
                    }
                    handleQuickLessonStatusChange(lesson, status);
                  }}
                  onEdit={() => {
                    setDayLessonsModalOpen(false);
                    openLessonEditor(lesson);
                  }}
                />
              ))}
            </View>
          )}
        </ModalCard>
      </Modal>

      <Modal
        visible={rescheduleModalOpen}
        animationType="fade"
        transparent
        onRequestClose={() => setRescheduleModalOpen(false)}
      >
        <ModalCard
          title="Перенести урок"
          onClose={() => {
            setRescheduleModalOpen(false);
            setReschedulingLessonId(null);
          }}
        >
          <DateFieldButton
            label="Новая дата"
            value={formatShortDate(`${rescheduleDate}T00:00:00`, 'ru-RU')}
            onPress={() => {
              setLessonDatePickerTarget('reschedule');
              setLessonDatePickerOpen(true);
            }}
          />
          <Field
            label="Новое время"
            value={rescheduleTime}
            onChangeText={setRescheduleTime}
            placeholder="16:00"
          />
          <PrimaryButton label="Перенести урок" onPress={confirmReschedule} />
        </ModalCard>
      </Modal>

      <Modal visible={lessonDatePickerOpen} animationType="fade" transparent onRequestClose={() => setLessonDatePickerOpen(false)}>
        <ModalCard title="Выбор даты урока" onClose={() => setLessonDatePickerOpen(false)}>
          <View style={styles.calendarMonthHeader}>
            <SmallAction
              label="←"
              onPress={() =>
                setLessonDatePickerMonth((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1))
              }
            />
            <Text style={styles.calendarMonthTitle}>{formatMonthYear(lessonDatePickerMonth.toISOString(), 'ru-RU')}</Text>
            <SmallAction
              label="→"
              onPress={() =>
                setLessonDatePickerMonth((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1))
              }
            />
          </View>
          <View style={styles.calendarWeekHeader}>
            {WEEKDAY_LABELS_RU.map((label) => (
              <Text key={`picker-${label}`} style={styles.calendarWeekHeaderLabel}>
                {label}
              </Text>
            ))}
          </View>
          <View style={styles.calendarGrid}>
            {createMonthGrid(lessonDatePickerMonth).map((gridDay) => {
              const token = toDateToken(gridDay);
              const isCurrentMonth = gridDay.getMonth() === lessonDatePickerMonth.getMonth();
              const selected =
                lessonDatePickerTarget === 'lesson'
                  ? lessonDraft.lessonDate === token
                  : lessonDatePickerTarget === 'recurrence'
                  ? recurrenceDraft.startDate === token
                  : rescheduleDate === token;

              return (
                <Pressable
                  key={`lesson-picker-${token}`}
                  style={[styles.calendarCell, !isCurrentMonth && styles.calendarCellMuted, selected && styles.calendarCellSelected]}
                  onPress={() => {
                    if (lessonDatePickerTarget === 'lesson') {
                      setLessonDraft((current) => ({ ...current, lessonDate: token }));
                    } else if (lessonDatePickerTarget === 'recurrence') {
                      setRecurrenceDraft((current) => ({ ...current, startDate: token }));
                    } else {
                      setRescheduleDate(token);
                    }
                    setLessonDatePickerOpen(false);
                  }}
                >
                  <Text style={[styles.calendarCellDay, !isCurrentMonth && styles.calendarCellDayMuted]}>{gridDay.getDate()}</Text>
                </Pressable>
              );
            })}
          </View>
        </ModalCard>
      </Modal>

      <Modal visible={paymentDatePickerOpen} animationType="fade" transparent onRequestClose={() => setPaymentDatePickerOpen(false)}>
        <ModalCard title="Выбор даты оплаты" onClose={() => setPaymentDatePickerOpen(false)}>
          <View style={styles.calendarMonthHeader}>
            <SmallAction
              label="←"
              onPress={() =>
                setPaymentDatePickerMonth((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1))
              }
            />
            <Text style={styles.calendarMonthTitle}>{formatMonthYear(paymentDatePickerMonth.toISOString(), 'ru-RU')}</Text>
            <SmallAction
              label="→"
              onPress={() =>
                setPaymentDatePickerMonth((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1))
              }
            />
          </View>
          <View style={styles.calendarWeekHeader}>
            {WEEKDAY_LABELS_RU.map((label) => (
              <Text key={`pay-picker-${label}`} style={styles.calendarWeekHeaderLabel}>
                {label}
              </Text>
            ))}
          </View>
          <View style={styles.calendarGrid}>
            {createMonthGrid(paymentDatePickerMonth).map((gridDay) => {
              const token = toDateToken(gridDay);
              const isCurrentMonth = gridDay.getMonth() === paymentDatePickerMonth.getMonth();
              const selected = paymentDraft.paidAt === token;

              return (
                <Pressable
                  key={`payment-picker-${token}`}
                  style={[styles.calendarCell, !isCurrentMonth && styles.calendarCellMuted, selected && styles.calendarCellSelected]}
                  onPress={() => {
                    setPaymentDraft((current) => ({ ...current, paidAt: token }));
                    setPaymentDatePickerOpen(false);
                  }}
                >
                  <Text style={[styles.calendarCellDay, !isCurrentMonth && styles.calendarCellDayMuted]}>{gridDay.getDate()}</Text>
                </Pressable>
              );
            })}
          </View>
        </ModalCard>
      </Modal>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function ActionHeader({
  actionLabel,
  onAction,
}: {
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <View style={styles.actionHeader}>
      <PrimaryButton label={actionLabel} onPress={onAction} compact />
    </View>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <View style={styles.statCard}>
      <View style={[styles.statAccent, { backgroundColor: accent }]} />
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.sectionCard}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {subtitle ? <Text style={styles.sectionSubtitle}>{subtitle}</Text> : null}
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function LessonCard({
  lesson,
  studentsById,
  language,
  currencyFormatter,
  onEdit,
  onStatusChange,
  onDuplicate,
}: {
  lesson: Lesson;
  studentsById: Record<string, Student>;
  language: string;
  currencyFormatter: Intl.NumberFormat;
  onEdit: () => void;
  onStatusChange: (lessonId: string, status: Lesson['status']) => void;
  onDuplicate: (lessonId: string) => void;
}) {
  const attendeeNames = lesson.studentIds
    .map((studentId) => studentsById[studentId]?.name)
    .filter(Boolean)
    .join(', ');

  return (
    <View style={styles.lessonCard}>
      <View style={styles.lessonCardHeader}>
        <View style={styles.lessonCardText}>
          <Text style={styles.lessonTitle}>{lesson.title}</Text>
          <Text style={styles.lessonMeta}>
            {formatLessonDate(lesson.startAt, language)} • {attendeeNames || 'Ученики не выбраны'}
          </Text>
          <Text style={styles.lessonMeta}>
            {lesson.durationMinutes} мин • {formatCurrency(lesson.costPerStudent, currencyFormatter)} за ученика
          </Text>
        </View>
        <Pressable onPress={onEdit} style={styles.editButton}>
          <Text style={styles.editButtonText}>Изменить</Text>
        </Pressable>
      </View>
      <View style={styles.chipWrap}>
        {(['scheduled', 'completed', 'cancelled', 'rescheduled'] as Lesson['status'][]).map((status) => (
          <Pill
            key={status}
            label={formatLessonStatusLabel(status)}
            selected={lesson.status === status}
            onPress={() => onStatusChange(lesson.id, status)}
          />
        ))}
      </View>
      <View style={styles.inlineActions}>
        <SmallAction label="Дублировать на +1 неделю" onPress={() => onDuplicate(lesson.id)} />
      </View>
    </View>
  );
}

function Pill({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.pill, selected && styles.pillSelected]}>
      <Text style={[styles.pillText, selected && styles.pillTextSelected]}>{label}</Text>
    </Pressable>
  );
}

function RowLabelValue({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.rowLabelValue}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function DateFieldButton({ label, value, onPress }: { label: string; value: string; onPress: () => void }) {
  return (
    <View style={styles.fieldBlock}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Pressable onPress={onPress} style={styles.dateFieldButton}>
        <Text style={styles.dateFieldButtonText}>{value}</Text>
      </Pressable>
    </View>
  );
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  keyboardType?: 'default' | 'email-address' | 'numeric' | 'phone-pad';
}) {
  return (
    <View style={styles.fieldBlock}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#8a9ba8"
        keyboardType={keyboardType}
        style={styles.input}
      />
    </View>
  );
}

function TextArea({
  label,
  value,
  onChangeText,
  placeholder,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
}) {
  return (
    <View style={styles.fieldBlock}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#8a9ba8"
        multiline
        textAlignVertical="top"
        style={styles.textArea}
      />
    </View>
  );
}

function PrimaryButton({ label, onPress, compact = false }: { label: string; onPress: () => void; compact?: boolean }) {
  return (
    <Pressable onPress={onPress} style={[styles.primaryButton, compact && styles.primaryButtonCompact]}>
      <Text style={styles.primaryButtonText}>{label}</Text>
    </Pressable>
  );
}

function StatusButton({ status, onPress }: { status: Lesson['status']; onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel={`Статус: ${formatLessonStatusLabel(status)}`}
      onPress={onPress}
      style={[
        styles.statusSelectorButton,
        status === 'completed' && styles.statusSelectorCompleted,
        status === 'completed_paid' && styles.statusSelectorCompleted,
        status === 'cancelled' && styles.statusSelectorCancelled,
        status === 'rescheduled' && styles.statusSelectorRescheduled,
      ]}
    >
      <View
        style={[
          styles.statusSelectorDot,
          status === 'completed' && styles.statusSelectorDotCompleted,
          status === 'completed_paid' && styles.statusSelectorDotCompleted,
          status === 'cancelled' && styles.statusSelectorDotCancelled,
          status === 'rescheduled' && styles.statusSelectorDotRescheduled,
        ]}
      />
      <Text style={styles.statusSelectorText}>{formatLessonStatusLabel(status)}</Text>
    </Pressable>
  );
}

function ScheduleLessonCard({
  lesson,
  student,
  statusMenuOpen,
  onToggleStatus,
  onStatusChange,
  onEdit,
}: {
  lesson: Lesson;
  student?: Student;
  statusMenuOpen: boolean;
  onToggleStatus: () => void;
  onStatusChange: (status: Lesson['status']) => void;
  onEdit: () => void;
}) {
  const studentLabel = student?.name ?? 'Анонимный урок';
  const statusOptions: Lesson['status'][] = lesson.studentIds.length === 0
    ? ['scheduled', 'completed', 'completed_paid', 'cancelled', 'rescheduled']
    : ['scheduled', 'completed', 'cancelled', 'rescheduled'];

  return (
    <View style={[styles.scheduleLessonCard, { borderLeftColor: student?.color ?? ANONYMOUS_LESSON_COLOR }]}>
      <View style={styles.scheduleLessonHeader}>
        <View style={styles.scheduleLessonDetails}>
          <View style={styles.calendarLessonTitleRow}>
            <View style={[styles.calendarDot, { backgroundColor: student?.color ?? ANONYMOUS_LESSON_COLOR }]} />
            <Text style={styles.scheduleLessonStudent}>{studentLabel}</Text>
          </View>
          <Text style={styles.scheduleLessonTitle}>{lesson.title}</Text>
          <Text style={styles.scheduleLessonMeta}>{formatLessonTimeRange(lesson)} · {lesson.durationMinutes} мин</Text>
        </View>
        <StatusButton status={lesson.status} onPress={onToggleStatus} />
      </View>
      <View style={styles.dayScheduleActions}>
        <SmallAction label="Изменить" onPress={onEdit} />
      </View>
      {statusMenuOpen ? (
        <View style={styles.dayScheduleStatusMenu}>
          {statusOptions.map((status) => (
            <Pill
              key={status}
              label={formatLessonStatusLabel(status)}
              selected={lesson.status === status}
              onPress={() => onStatusChange(status)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function SmallAction({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.smallActionButton}>
      <Text style={styles.smallActionText}>{label}</Text>
    </Pressable>
  );
}

function ModalCard({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <SafeAreaProvider>
      <ModalCardContent title={title} onClose={onClose} footer={footer}>
        {children}
      </ModalCardContent>
    </SafeAreaProvider>
  );
}

function ModalCardContent({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.modalBackdrop}>
      <View style={[styles.modalCard, { paddingBottom: Math.max(32, insets.bottom + 20) }]}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>{title}</Text>
          <Pressable onPress={onClose}>
            <Text style={styles.modalClose}>Закрыть</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.modalScrollContent} showsVerticalScrollIndicator={false}>
          {children}
        </ScrollView>
        {footer ? <View style={styles.modalFooter}>{footer}</View> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#eaf1f6',
  },
  pageHeader: {
    minHeight: 56,
    justifyContent: 'center',
    paddingHorizontal: 20,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#dbe7ef',
  },
  pageHeaderTitle: {
    color: '#153047',
    fontSize: 20,
    fontWeight: '800',
  },
  shell: {
    flex: 1,
  },
  tabBar: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#ffffff',
    borderTopWidth: 1,
    borderTopColor: '#dbe7ef',
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 12,
  },
  tabButton: {
    flex: 1,
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    borderRadius: 8,
  },
  tabButtonActive: {
    backgroundColor: '#e7f0ff',
  },
  tabButtonText: {
    color: '#688096',
    fontSize: 10,
    fontWeight: '800',
  },
  tabButtonTextActive: {
    color: '#123c69',
  },
  content: {
    padding: 12,
    paddingBottom: 24,
    gap: 12,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  statCard: {
    width: '48%',
    backgroundColor: '#ffffff',
    borderRadius: 20,
    padding: 16,
  },
  statAccent: {
    width: 40,
    height: 6,
    borderRadius: 99,
  },
  statLabel: {
    marginTop: 12,
    color: '#688096',
    fontSize: 13,
  },
  statValue: {
    marginTop: 6,
    color: '#18324b',
    fontSize: 24,
    fontWeight: '800',
  },
  sectionCard: {
    backgroundColor: '#ffffff',
    borderRadius: 24,
    padding: 14,
  },
  sectionTitle: {
    color: '#153047',
    fontSize: 19,
    fontWeight: '800',
  },
  sectionSubtitle: {
    color: '#6b8293',
    fontSize: 13,
    marginTop: 4,
    lineHeight: 18,
  },
  sectionBody: {
    marginTop: 12,
    gap: 10,
  },
  widgetPreview: {
    backgroundColor: '#153047',
    borderRadius: 22,
    padding: 18,
    gap: 6,
  },
  widgetTitle: {
    color: '#99d1e6',
    fontSize: 13,
    fontWeight: '700',
  },
  widgetValue: {
    color: '#ffffff',
    fontSize: 24,
    fontWeight: '800',
  },
  widgetSubtle: {
    color: '#d8edf4',
    fontSize: 14,
  },
  widgetDebt: {
    color: '#ffd199',
    fontSize: 14,
    fontWeight: '700',
  },
  rowLabelValue: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  rowLabel: {
    color: '#5d7384',
    fontSize: 14,
    flex: 1,
  },
  rowValue: {
    color: '#163148',
    fontSize: 14,
    fontWeight: '700',
  },
  lessonCard: {
    borderWidth: 1,
    borderColor: '#d8e4eb',
    borderRadius: 18,
    padding: 14,
    gap: 10,
  },
  lessonCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  lessonCardText: {
    flex: 1,
  },
  lessonTitle: {
    color: '#14324d',
    fontSize: 16,
    fontWeight: '800',
  },
  lessonMeta: {
    marginTop: 4,
    color: '#648094',
    fontSize: 13,
  },
  editButton: {
    backgroundColor: '#eef5fb',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignSelf: 'flex-start',
  },
  editButtonText: {
    color: '#14324d',
    fontWeight: '700',
  },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#eef4f8',
  },
  pillSelected: {
    backgroundColor: '#123c69',
  },
  pillText: {
    color: '#43647c',
    fontSize: 12,
    fontWeight: '700',
  },
  pillTextSelected: {
    color: '#ffffff',
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  inlineActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  smallActionButton: {
    backgroundColor: '#d9eef0',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  smallActionText: {
    color: '#184956',
    fontSize: 12,
    fontWeight: '700',
  },
  actionHeader: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  primaryButton: {
    backgroundColor: '#123c69',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 11,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  primaryButtonCompact: {
    marginTop: 0,
  },
  primaryButtonText: {
    color: '#ffffff',
    fontWeight: '800',
    fontSize: 13,
  },
  destructiveButton: {
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
    paddingVertical: 11,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e6a4ad',
    backgroundColor: '#fff2f3',
  },
  destructiveButtonText: {
    color: '#b83d4b',
    fontSize: 13,
    fontWeight: '800',
  },
  calendarMonthHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  calendarMonthTitle: {
    color: '#17344e',
    fontSize: 16,
    fontWeight: '800',
  },
  calendarWeekHeader: {
    flexDirection: 'row',
    marginTop: 12,
    marginBottom: 6,
  },
  calendarWeekHeaderLabel: {
    width: `${100 / 7}%`,
    textAlign: 'center',
    color: '#6b8293',
    fontSize: 12,
    fontWeight: '700',
  },
  calendarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderWidth: 1,
    borderColor: '#e1ebf2',
    borderRadius: 14,
    overflow: 'hidden',
  },
  calendarCell: {
    width: `${100 / 7}%`,
    minHeight: 62,
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#edf3f7',
    backgroundColor: '#ffffff',
  },
  calendarCellMuted: {
    backgroundColor: '#f6f9fc',
  },
  calendarCellSelected: {
    backgroundColor: '#e7f0ff',
  },
  calendarCellCancelled: {
    backgroundColor: '#fff0f0',
  },
  calendarCellRescheduled: {
    backgroundColor: '#fff7e8',
  },
  calendarCellDay: {
    color: '#17344e',
    fontSize: 14,
    fontWeight: '700',
  },
  calendarCellDayMuted: {
    color: '#8da0af',
  },
  calendarCellDayToday: {
    color: '#1d5fcf',
  },
  calendarDotsRow: {
    marginTop: 7,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 4,
  },
  calendarLegend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 14,
  },
  calendarLegendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  calendarLegendText: {
    color: '#527086',
    fontSize: 12,
    fontWeight: '700',
  },
  dayScheduleTimeline: {
    marginTop: 12,
    borderTopWidth: 1,
    borderColor: '#e1ebf2',
  },
  dayLessonList: {
    gap: 10,
  },
  dayScheduleRow: {
    flexDirection: 'row',
    minHeight: 74,
    borderBottomWidth: 1,
    borderColor: '#e1ebf2',
  },
  dayScheduleHour: {
    width: 52,
    paddingTop: 12,
    color: '#6b8293',
    fontSize: 12,
    fontWeight: '700',
  },
  dayScheduleSlot: {
    flex: 1,
    borderLeftWidth: 1,
    borderColor: '#e1ebf2',
    paddingVertical: 6,
    paddingLeft: 10,
  },
  dayScheduleEmptySlot: {
    flex: 1,
    minHeight: 60,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#c8d9e6',
    backgroundColor: '#f8fbfd',
  },
  dayScheduleEmptyText: {
    color: '#6b8293',
    fontSize: 13,
    fontWeight: '700',
  },
  dayScheduleLesson: {
    borderLeftWidth: 4,
    borderColor: '#2ea3a1',
    borderRadius: 8,
    backgroundColor: '#e8f6f5',
    padding: 10,
  },
  scheduleLessonCard: {
    borderLeftWidth: 4,
    borderRadius: 8,
    backgroundColor: '#e8f6f5',
    padding: 10,
  },
  scheduleLessonHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  scheduleLessonDetails: {
    flex: 1,
    gap: 3,
  },
  scheduleLessonStudent: {
    color: '#17344e',
    fontSize: 13,
    fontWeight: '800',
  },
  scheduleLessonTitle: {
    color: '#17344e',
    fontSize: 15,
    fontWeight: '800',
  },
  scheduleLessonMeta: {
    color: '#527086',
    fontSize: 12,
  },
  statusSelectorButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 8,
    backgroundColor: '#e7f0ff',
    paddingHorizontal: 8,
    paddingVertical: 7,
  },
  statusSelectorCompleted: {
    backgroundColor: '#e3f5ed',
  },
  statusSelectorCancelled: {
    backgroundColor: '#ffe8ea',
  },
  statusSelectorRescheduled: {
    backgroundColor: '#fff2d9',
  },
  statusSelectorDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#1d5fcf',
  },
  statusSelectorDotCompleted: {
    backgroundColor: '#176d68',
  },
  statusSelectorDotCancelled: {
    backgroundColor: '#b83d4b',
  },
  statusSelectorDotRescheduled: {
    backgroundColor: '#a26200',
  },
  statusSelectorText: {
    color: '#17344e',
    fontSize: 11,
    fontWeight: '800',
  },
  dayScheduleLessonMain: {
    gap: 3,
  },
  dayScheduleLessonTitle: {
    color: '#17344e',
    fontSize: 15,
    fontWeight: '800',
  },
  dayScheduleLessonMeta: {
    color: '#527086',
    fontSize: 12,
  },
  dayScheduleStatus: {
    color: '#1d5fcf',
    fontSize: 12,
    fontWeight: '700',
  },
  dayScheduleStatusCompleted: {
    color: '#176d68',
  },
  dayScheduleStatusCancelled: {
    color: '#b83d4b',
  },
  dayScheduleStatusRescheduled: {
    color: '#a26200',
  },
  dayScheduleActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  dayScheduleStatusMenu: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  calendarStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  calendarDayCard: {
    width: 64,
    backgroundColor: '#eef5fb',
    borderRadius: 18,
    paddingVertical: 12,
    paddingHorizontal: 10,
    alignItems: 'center',
    gap: 6,
  },
  calendarWeekday: {
    color: '#73889a',
    fontSize: 11,
    fontWeight: '700',
  },
  calendarDayNumber: {
    color: '#163149',
    fontSize: 20,
    fontWeight: '800',
  },
  calendarDot: {
    width: 10,
    height: 10,
    borderRadius: 999,
  },
  calendarDotPlanned: {
    backgroundColor: '#3d7eff',
  },
  calendarDotDone: {
    backgroundColor: '#1a9c6a',
  },
  calendarDotMissed: {
    backgroundColor: '#e84c5b',
  },
  calendarMore: {
    color: '#6b8293',
    fontSize: 11,
    fontWeight: '700',
  },
  noteText: {
    color: '#4c687e',
    lineHeight: 20,
  },
  financeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#edf2f6',
  },
  financeName: {
    color: '#14314c',
    fontSize: 15,
    fontWeight: '700',
  },
  financeMeta: {
    color: '#6d8596',
    fontSize: 12,
    marginTop: 2,
  },
  financeBalance: {
    fontSize: 15,
    fontWeight: '800',
  },
  positiveBalance: {
    color: '#208455',
  },
  negativeBalance: {
    color: '#c84b4b',
  },
  paymentRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#edf2f6',
  },
  paymentAmount: {
    color: '#123c69',
    fontWeight: '800',
  },
  paymentActions: {
    alignItems: 'flex-end',
    gap: 8,
  },
  todayLessonStatusWrap: {
    alignItems: 'flex-end',
    gap: 4,
  },
  calendarLessonTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  recurrencePanel: {
    backgroundColor: '#f4f8fc',
    borderRadius: 14,
    padding: 12,
    gap: 8,
    marginBottom: 8,
  },
  paymentOverviewCard: {
    backgroundColor: '#f2f7fb',
    borderRadius: 14,
    padding: 12,
    gap: 6,
  },
  statusBadge: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    fontSize: 12,
    fontWeight: '700',
    overflow: 'hidden',
  },
  statusPaid: {
    backgroundColor: '#e5f8ef',
    color: '#187c4f',
  },
  statusPartial: {
    backgroundColor: '#fff3df',
    color: '#b86c17',
  },
  statusOutstanding: {
    backgroundColor: '#fde8ea',
    color: '#b33f4a',
  },
  quickPaymentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  quickPaymentInput: {
    flex: 1,
    backgroundColor: '#ffffff',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#17344e',
    borderWidth: 1,
    borderColor: '#d8e4eb',
  },
  fileRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#edf2f6',
  },
  fileMetaBlock: {
    flex: 1,
  },
  fileDate: {
    color: '#5e7384',
    fontSize: 12,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(7, 25, 35, 0.45)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    maxHeight: '88%',
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 20,
    paddingVertical: 18,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  modalScrollContent: {
    paddingBottom: 16,
  },
  modalFooter: {
    borderTopWidth: 1,
    borderTopColor: '#e1ebf2',
    paddingTop: 12,
  },
  lessonEditorFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  lessonEditorFooterMain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  destructiveFooterButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 40,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e6a4ad',
    backgroundColor: '#fff2f3',
    paddingHorizontal: 12,
  },
  destructiveFooterButtonText: {
    color: '#b83d4b',
    fontSize: 12,
    fontWeight: '800',
  },
  modalTitle: {
    color: '#163149',
    fontSize: 21,
    fontWeight: '800',
  },
  modalClose: {
    color: '#123c69',
    fontWeight: '700',
  },
  fieldBlock: {
    marginBottom: 12,
  },
  fieldLabel: {
    color: '#4b6478',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#eef4f8',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#163149',
  },
  dateFieldButton: {
    backgroundColor: '#eef4f8',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  dateFieldButtonText: {
    color: '#163149',
    fontSize: 14,
    fontWeight: '700',
  },
  textArea: {
    backgroundColor: '#eef4f8',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 96,
    color: '#163149',
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  switchLabel: {
    color: '#4b6478',
    fontWeight: '700',
  },
  selectorTitle: {
    color: '#4b6478',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 8,
  },
  conflictText: {
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 8,
  },
  conflictDetailText: {
    color: '#b83d4b',
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 4,
  },
  freeTimeText: {
    color: '#208455',
  },
  busyTimeText: {
    color: '#c84b4b',
  },
  supportText: {
    color: '#4c687e',
    lineHeight: 19,
  },
  tokenText: {
    color: '#163149',
    fontSize: 12,
    lineHeight: 18,
  },
});
