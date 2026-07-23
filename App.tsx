import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
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
const DAY_SCHEDULE_HOURS = Array.from({ length: 16 }, (_, index) => index + 7);

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
  if (status === 'cancelled') {
    return 'Отменен';
  }
  return 'Перенесен';
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
  const [lessonDatePickerTarget, setLessonDatePickerTarget] = useState<'lesson' | 'recurrence'>('lesson');
  const [paymentDatePickerOpen, setPaymentDatePickerOpen] = useState(false);
  const [paymentDatePickerMonth, setPaymentDatePickerMonth] = useState<Date>(() => monthStart(new Date()));
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
            students: parsed.students ?? seedAppData.students,
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
  const studentColorById = useMemo(
    () =>
      Object.fromEntries(
        data.students.map((student, index) => [student.id, STUDENT_MARKER_COLORS[index % STUDENT_MARKER_COLORS.length]]),
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
    .filter((payment) => financeStudentIds.includes(payment.studentId))
    .sort((left, right) => right.paidAt.localeCompare(left.paidAt));
  const filteredIncome = filteredPayments.reduce((total, payment) => total + payment.amount, 0);
  const lessonConflicts = useMemo(
    () => findLessonConflicts(lessonDraft, activeLessons, editingLessonId),
    [activeLessons, editingLessonId, lessonDraft],
  );
  const lessonsByDate = useMemo(
    () =>
      activeLessons.reduce<Record<string, Lesson[]>>((acc, lesson) => {
        const dateToken = lesson.startAt.slice(0, 10);
        const list = acc[dateToken] ?? [];
        acc[dateToken] = [...list, lesson];
        return acc;
      }, {}),
    [activeLessons],
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
  const selectedDayStudentEntries = useMemo(
    () =>
      selectedDayLessons.flatMap((lesson) =>
        lesson.studentIds.map((studentId) => {
          const overview = studentPaymentOverview[studentId];
          const lessonPaymentStatus: PaymentStatus =
            lesson.status === 'completed' ? overview?.lessonCoverage?.get(lesson.id) ?? 'outstanding' : 'outstanding';
          return {
            key: `${lesson.id}-${studentId}`,
            lessonId: lesson.id,
            lessonTitle: lesson.title,
            studentId,
            studentName: studentsById[studentId]?.name ?? 'Неизвестный ученик',
            markerColor: studentColorById[studentId] ?? '#6b8293',
            lessonTime: new Intl.DateTimeFormat('ru-RU', {
              hour: '2-digit',
              minute: '2-digit',
            }).format(new Date(lesson.startAt)),
            status: lessonPaymentStatus,
            completionStatus: lesson.status,
          };
        }),
      ),
    [selectedDayLessons, studentColorById, studentPaymentOverview, studentsById],
  );
  const todayDateToken = toDateToken(new Date());
  const todayLessons = useMemo(
    () => sortLessons(lessonsByDate[todayDateToken] ?? []),
    [lessonsByDate, todayDateToken],
  );
  const todayStudentEntries = useMemo(
    () =>
      todayLessons.flatMap((lesson) =>
        lesson.studentIds.map((studentId) => {
          const overview = studentPaymentOverview[studentId];
          const lessonPaymentStatus: PaymentStatus =
            lesson.status === 'completed' ? overview?.lessonCoverage?.get(lesson.id) ?? 'outstanding' : 'outstanding';
          return {
            key: `${lesson.id}-${studentId}`,
            studentName: studentsById[studentId]?.name ?? 'Неизвестный ученик',
            lessonTime: new Intl.DateTimeFormat('ru-RU', {
              hour: '2-digit',
              minute: '2-digit',
            }).format(new Date(lesson.startAt)),
            status: lessonPaymentStatus,
            completionStatus: lesson.status,
          };
        }),
      ),
    [todayLessons, studentPaymentOverview, studentsById],
  );

  const hasTimeslotConflict = (
    lessons: Lesson[],
    startAt: string,
    excludeLessonId?: string | null,
    excludeRecurrenceId?: string | null,
  ) => {
    return lessons.some((lesson) => {
      if (excludeLessonId && lesson.id === excludeLessonId) {
        return false;
      }
      if (excludeRecurrenceId && lesson.recurrenceId === excludeRecurrenceId) {
        return false;
      }
      return areSameTimeslot(lesson.startAt, startAt);
    });
  };

  const upsertStudent = () => {
    if (!studentDraft.name.trim()) {
      Alert.alert('Нужно указать имя ученика', 'Введите имя ученика перед сохранением.');
      return;
    }

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
      costPerStudent: selectedStudent?.defaultRate ?? 0,
      status: lessonDraft.status,
      studentIds: selectedStudentId ? [selectedStudentId] : [],
      note: lessonDraft.note.trim(),
      recurrenceId: null,
      recurrenceEveryWeeks: null,
      recurrenceWeekdays: null,
      recurrenceStartDate: null,
    };

    if (hasTimeslotConflict(activeLessons, nextLesson.startAt, editingLessonId, null)) {
      Alert.alert('Слот уже занят', 'На это время уже запланирован другой урок. Выберите другое время.');
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
        const conflict = hasTimeslotConflict(
          activeLessons,
          recurringStart,
          editingLessonId,
          editingLessonId ? recurrenceId : null,
        ) || plannedLessons.some((lesson) => areSameTimeslot(lesson.startAt, recurringStart));
        if (conflict) {
          Alert.alert('Слот уже занят', `Урок на ${dateToken} ${lessonDraft.lessonTime} не создан: время уже занято.`);
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
            studentId: payment.studentId,
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

  const deleteLesson = (lessonId: string) => {
    Alert.alert('Удалить урок?', 'Урок будет удален из календаря. Это действие нельзя отменить.', [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: () => {
          setData((current) => ({
            ...current,
            lessons: current.lessons.filter((lesson) => lesson.id !== lessonId),
          }));
          if (editingLessonId === lessonId) {
            closeLessonModal();
          }
        },
      },
    ]);
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
    dashboard: 'Обзор',
    schedule: 'Календарь',
    students: 'Ученики',
    finances: 'Оплаты',
    settings: 'Настройки',
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <LinearGradient colors={['#123c69', '#1f6f78', '#2ea3a1']} style={styles.hero}>
        <View style={styles.heroMetrics}>
          <MetricBadge label="Доход за месяц" value={formatCurrency(dashboard.monthIncome, currencyFormatter)} />
          <MetricBadge label="Должники" value={String(dashboard.debtorCount)} />
          <MetricBadge label="Предстоящие" value={String(dashboard.upcomingLessons.length)} />
        </View>
      </LinearGradient>

      <View style={styles.shell}>
        <View style={styles.tabBar}>
          {(['dashboard', 'schedule', 'students', 'finances', 'settings'] as ScreenTab[]).map((tab) => (
            <Pressable
              key={tab}
              onPress={() => setActiveTab(tab)}
              style={[styles.tabButton, activeTab === tab && styles.tabButtonActive]}
            >
              <Text style={[styles.tabButtonText, activeTab === tab && styles.tabButtonTextActive]}>
                {tabLabels[tab]}
              </Text>
            </Pressable>
          ))}
        </View>

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

              <SectionCard title="Уроки на сегодня" subtitle="Фокус на сегодняшнем дне и быстрых действиях.">
                {todayStudentEntries.length === 0 ? (
                  <Text style={styles.noteText}>На сегодня уроков нет.</Text>
                ) : (
                  todayStudentEntries.map((entry) => (
                      <View key={`today-${entry.key}`} style={styles.paymentRow}>
                        <View>
                          <Text style={styles.financeName}>{entry.studentName}</Text>
                          <Text style={styles.financeMeta}>Время: {entry.lessonTime}</Text>
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

              <SectionCard title="Посещаемость и финансы" subtitle="Сводка по всем ученикам.">
                <RowLabelValue label="Проведенные уроки" value={String(dashboard.doneLessonsCount)} />
                <RowLabelValue label="Пропущенные уроки" value={String(dashboard.missedLessonsCount)} />
                <RowLabelValue label="Запланированные уроки" value={String(dashboard.plannedLessonsCount)} />
                <RowLabelValue
                  label="Общая задолженность"
                  value={formatCurrency(dashboard.totalDebtAbs, currencyFormatter)}
                />
              </SectionCard>

              <SectionCard
                title="Напоминания"
                subtitle="Управляйте локальными напоминаниями."
              >
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

          {activeTab === 'schedule' ? (
            <>
              <ActionHeader
                title="Расписание занятий"
                subtitle="Выбирайте день и сразу открывайте занятия в отдельном окне."
                actionLabel="Добавить урок"
                onAction={() => openLessonEditor()}
              />

              <SectionCard title="Календарь на месяц" subtitle="Нажмите день, чтобы открыть список уроков и статусов оплаты.">
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
                    const dayStudentMarkers = Array.from(new Set(dayLessons.flatMap((lesson) => lesson.studentIds)));
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
                          {dayStudentMarkers.slice(0, 6).map((studentId) => (
                            <View
                              key={`${dateToken}-${studentId}`}
                              style={[
                                styles.calendarDot,
                                { backgroundColor: studentColorById[studentId] ?? '#6b8293' },
                              ]}
                            />
                          ))}
                          {dayStudentMarkers.length > 6 ? <Text style={styles.calendarMore}>+{dayStudentMarkers.length - 6}</Text> : null}
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              </SectionCard>
            </>
          ) : null}

          {activeTab === 'students' ? (
            <>
              <ActionHeader
                title="Ученики"
                subtitle="Контакты, баланс и быстрая запись оплаты прямо в карточке ученика."
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
                title="Оплаты"
                subtitle="Простая аналитика: начислено, оплачено, остаток, последняя и следующая оплата."
                actionLabel="Добавить оплату"
                onAction={() => openPaymentEditor()}
              />
              <SectionCard title="Фильтр" subtitle="Показывайте общий поток оплат или одного ученика.">
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

              <SectionCard title="Статусы оплат" subtitle="Мгновенно видно, кто оплатил, кто частично, а у кого долг.">
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

              <SectionCard title="История платежей" subtitle="Хронология всех оплат с датой и типом операции.">
                {filteredPayments.map((payment) => (
                  <View key={payment.id} style={styles.paymentRow}>
                    <View>
                      <Text style={styles.financeName}>
                        {studentsById[payment.studentId]?.name ?? 'Неизвестный ученик'}
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
                title="Настройки"
                subtitle="Русская локализация и единая валюта MDL для всех финансовых экранов."
                actionLabel="К обзору"
                onAction={() => setActiveTab('dashboard')}
              />

              <SectionCard title="Язык" subtitle="Интерфейс полностью локализован на русский язык.">
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

              <SectionCard title="Валюта" subtitle="Во всех расчетах используется молдавский лей (MDL).">
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
            </>
          ) : null}
        </ScrollView>
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
        <ModalCard title={editingLessonId ? 'Редактировать урок' : 'Добавить урок'} onClose={closeLessonModal}>
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
          <Text style={[styles.conflictText, lessonConflicts.length === 0 ? styles.freeTimeText : styles.busyTimeText]}>
            {lessonConflicts.length === 0
              ? 'Выбранное время свободно.'
              : `Конфликт расписания: пересечений ${lessonConflicts.length}.`}
          </Text>

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
          <PrimaryButton label="Сохранить урок" onPress={upsertLesson} />
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
        >
          <Text style={styles.supportText}>Нажмите на свободное время, чтобы создать урок или резерв.</Text>
          <View style={styles.dayScheduleTimeline}>
            {DAY_SCHEDULE_HOURS.map((hour) => {
              const hourLabel = `${String(hour).padStart(2, '0')}:00`;
              const hourLessons = selectedDayLessons.filter((lesson) => new Date(lesson.startAt).getHours() === hour);

              return (
                <View key={hourLabel} style={styles.dayScheduleRow}>
                  <Text style={styles.dayScheduleHour}>{hourLabel}</Text>
                  <View style={styles.dayScheduleSlot}>
                    {hourLessons.length === 0 ? (
                      <Pressable
                        onPress={() => {
                          setDayLessonsModalOpen(false);
                          openLessonEditor(undefined, { date: selectedCalendarDate, time: hourLabel });
                        }}
                        style={styles.dayScheduleEmptySlot}
                      >
                        <Text style={styles.dayScheduleEmptyText}>Свободно</Text>
                      </Pressable>
                    ) : (
                      hourLessons.map((lesson) => {
                        const student = lesson.studentIds[0] ? studentsById[lesson.studentIds[0]] : undefined;
                        const time = new Intl.DateTimeFormat('ru-RU', {
                          hour: '2-digit',
                          minute: '2-digit',
                        }).format(new Date(lesson.startAt));

                        return (
                          <View key={lesson.id} style={styles.dayScheduleLesson}>
                            <Pressable
                              onPress={() => {
                                setDayLessonsModalOpen(false);
                                openLessonEditor(lesson);
                              }}
                              style={styles.dayScheduleLessonMain}
                            >
                              <Text style={styles.dayScheduleLessonTitle}>{lesson.title}</Text>
                              <Text style={styles.dayScheduleLessonMeta}>
                                {time} · {lesson.durationMinutes} мин · {student?.name ?? 'Резерв без ученика'}
                              </Text>
                              <Text
                                style={[
                                  styles.dayScheduleStatus,
                                  lesson.status === 'completed' && styles.dayScheduleStatusCompleted,
                                  lesson.status === 'cancelled' && styles.dayScheduleStatusCancelled,
                                  lesson.status === 'rescheduled' && styles.dayScheduleStatusRescheduled,
                                ]}
                              >
                                {formatLessonStatusLabel(lesson.status)}
                              </Text>
                            </Pressable>
                            <View style={styles.dayScheduleActions}>
                              <SmallAction
                                label="Изменить"
                                onPress={() => {
                                  setDayLessonsModalOpen(false);
                                  openLessonEditor(lesson);
                                }}
                              />
                              <SmallAction label="Удалить" onPress={() => deleteLesson(lesson.id)} />
                            </View>
                          </View>
                        );
                      })
                    )}
                  </View>
                </View>
              );
            })}
          </View>
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
                lessonDatePickerTarget === 'lesson' ? lessonDraft.lessonDate === token : recurrenceDraft.startDate === token;

              return (
                <Pressable
                  key={`lesson-picker-${token}`}
                  style={[styles.calendarCell, !isCurrentMonth && styles.calendarCellMuted, selected && styles.calendarCellSelected]}
                  onPress={() => {
                    if (lessonDatePickerTarget === 'lesson') {
                      setLessonDraft((current) => ({ ...current, lessonDate: token }));
                    } else {
                      setRecurrenceDraft((current) => ({ ...current, startDate: token }));
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
  );
}

function ActionHeader({
  title,
  subtitle,
  actionLabel,
  onAction,
}: {
  title: string;
  subtitle: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <View style={styles.actionHeader}>
      <View style={styles.actionHeaderTextBlock}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <Text style={styles.sectionSubtitle}>{subtitle}</Text>
      </View>
      <PrimaryButton label={actionLabel} onPress={onAction} compact />
    </View>
  );
}

function MetricBadge({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metricBadge}>
      <Text style={styles.metricBadgeLabel}>{label}</Text>
      <Text style={styles.metricBadgeValue}>{value}</Text>
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
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.sectionCard}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.sectionSubtitle}>{subtitle}</Text>
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
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <View style={styles.modalBackdrop}>
      <View style={styles.modalCard}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>{title}</Text>
          <Pressable onPress={onClose}>
            <Text style={styles.modalClose}>Закрыть</Text>
          </Pressable>
        </View>
        <ScrollView showsVerticalScrollIndicator={false}>{children}</ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#eaf1f6',
  },
  hero: {
    paddingHorizontal: 20,
    paddingTop: 22,
    paddingBottom: 14,
    borderBottomLeftRadius: 28,
    borderBottomRightRadius: 28,
  },
  heroEyebrow: {
    color: '#d3eef7',
    fontSize: 12,
    letterSpacing: 1.5,
    fontWeight: '700',
  },
  heroTitle: {
    marginTop: 10,
    color: '#ffffff',
    fontSize: 27,
    lineHeight: 34,
    fontWeight: '800',
  },
  heroMetrics: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 0,
  },
  metricBadge: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderRadius: 18,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  metricBadgeLabel: {
    color: '#d9f7ff',
    fontSize: 12,
  },
  metricBadgeValue: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '800',
    marginTop: 3,
  },
  shell: {
    flex: 1,
    marginTop: -8,
  },
  tabBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 14,
    paddingTop: 14,
  },
  tabButton: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 14,
    backgroundColor: '#d9e5ef',
  },
  tabButtonActive: {
    backgroundColor: '#123c69',
  },
  tabButtonText: {
    color: '#35506a',
    fontSize: 11,
    fontWeight: '800',
  },
  tabButtonTextActive: {
    color: '#ffffff',
  },
  content: {
    padding: 14,
    paddingBottom: 120,
    gap: 14,
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
    padding: 18,
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
    marginTop: 16,
    gap: 12,
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
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  actionHeaderTextBlock: {
    flex: 1,
  },
  primaryButton: {
    backgroundColor: '#123c69',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 13,
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
  dayScheduleTimeline: {
    marginTop: 12,
    borderTopWidth: 1,
    borderColor: '#e1ebf2',
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
