import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { calculateBalance, getVisibleLessons, sortLessons } from '../domain/selectors';
import { type AppData, type NotificationPermissionState } from '../domain/types';

const REMINDER_CHANNEL_ID = 'tutor-reminders';

export type ReminderAutomationStatus = {
  notificationPermission: NotificationPermissionState;
  expoPushToken: string;
  pushTokenHint: string;
  firebaseConfigured: boolean | null;
  tokenReady: boolean;
  scheduledLessonReminderCount: number;
  lowBalanceReminderScheduled: boolean;
};

export type NotificationTestResult = {
  success: boolean;
  message: string;
};

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

function isPermissionGranted(settings: Notifications.NotificationPermissionsStatus): boolean {
  return settings.granted || settings.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
}

function firebaseIsConfigured(): boolean {
  return Boolean(Constants.expoConfig?.android?.googleServicesFile);
}

function friendlyPushTokenFailure(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('firebase') || message.includes('google services') || message.includes('messaging instance')) {
    return 'Удаленные push-уведомления не настроены: добавьте google-services.json в Android-конфигурацию и соберите новое приложение.';
  }
  return 'Не удалось получить токен удаленных push-уведомлений. Проверьте подключение к интернету и настройки push-уведомлений.';
}

async function ensureNotificationChannel(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }

  await Notifications.setNotificationChannelAsync(REMINDER_CHANNEL_ID, {
    name: 'Напоминания репетитора',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#2EA3A1',
  });
}

export async function syncReminderAutomation(
  data: AppData,
  requestPermissions = false,
): Promise<ReminderAutomationStatus> {
  if (Platform.OS === 'web') {
    return {
      notificationPermission: 'unsupported',
      expoPushToken: '',
      pushTokenHint: 'Уведомления доступны только в сборке Android или iOS. Веб-версия не планирует нативные напоминания.',
      firebaseConfigured: null,
      tokenReady: false,
      scheduledLessonReminderCount: 0,
      lowBalanceReminderScheduled: false,
    };
  }

  await ensureNotificationChannel();

  let permissionSettings = await Notifications.getPermissionsAsync();
  if (!isPermissionGranted(permissionSettings) && requestPermissions) {
    permissionSettings = await Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: true,
        allowSound: true,
      },
    });
  }

  if (!isPermissionGranted(permissionSettings)) {
    await Notifications.cancelAllScheduledNotificationsAsync();
    return {
      notificationPermission: 'denied',
      expoPushToken: '',
      pushTokenHint: 'Разрешите уведомления, чтобы включить напоминания об уроках и балансе.',
      firebaseConfigured: Platform.OS === 'android' ? firebaseIsConfigured() : null,
      tokenReady: false,
      scheduledLessonReminderCount: 0,
      lowBalanceReminderScheduled: false,
    };
  }

  let expoPushToken = '';
  let pushTokenHint = 'Локальные напоминания включены.';
  const firebaseConfigured = Platform.OS === 'android' ? firebaseIsConfigured() : null;

  if (Device.isDevice) {
    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    if (Platform.OS === 'android' && !firebaseConfigured) {
      pushTokenHint = 'Локальные напоминания работают. Для удаленных push-уведомлений добавьте google-services.json в Android-конфигурацию и соберите новое приложение.';
    } else if (projectId) {
      try {
        expoPushToken = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
        pushTokenHint = 'Токен Expo Push получен. Теперь можно подключить удаленные push-уведомления через backend.';
      } catch (error) {
        pushTokenHint = friendlyPushTokenFailure(error);
      }
    } else {
      pushTokenHint = 'Локальные напоминания включены. Выполните EAS init/build, чтобы получить extra.eas.projectId для удаленных push-уведомлений.';
    }
  } else {
    pushTokenHint = 'Локальные напоминания включены. Используйте физическое устройство, чтобы получить токен удаленных push-уведомлений.';
  }

  await Notifications.cancelAllScheduledNotificationsAsync();

  let scheduledLessonReminderCount = 0;
  const activeLessons = getVisibleLessons(data, new Date());

  if (data.settings.lessonRemindersEnabled) {
    const reminderLeadMs = data.settings.reminderMinutesBeforeLesson * 60 * 1000;
    for (const lesson of sortLessons(activeLessons).filter((item) => item.status === 'scheduled')) {
      const triggerAt = new Date(lesson.startAt).getTime() - reminderLeadMs;
      if (triggerAt <= Date.now()) {
        continue;
      }

      const studentCount = lesson.studentIds.length;
      await Notifications.scheduleNotificationAsync({
        content: {
          title: `Скоро урок: ${lesson.title}`,
          body: `Через ${data.settings.reminderMinutesBeforeLesson} мин. Учащихся: ${studentCount}.`,
          data: {
            screen: 'schedule',
            lessonId: lesson.id,
          },
          sound: 'default',
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: new Date(triggerAt),
          channelId: REMINDER_CHANNEL_ID,
        },
      });
      scheduledLessonReminderCount += 1;
    }
  }

  const atRiskStudents = data.students.filter(
    (student) =>
      !student.isArchived &&
      calculateBalance(student, activeLessons, data.payments) <= data.settings.lowBalanceThreshold,
  );
  let lowBalanceReminderScheduled = false;

  if (data.settings.lowBalanceRemindersEnabled && atRiskStudents.length > 0) {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Напоминание о низком балансе',
        body: `Проверьте баланс: ${atRiskStudents.slice(0, 3).map((student) => student.name).join(', ')}.`,
        data: {
          screen: 'finances',
        },
        sound: 'default',
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour: 8,
        minute: 0,
        channelId: REMINDER_CHANNEL_ID,
      },
    });
    lowBalanceReminderScheduled = true;
  }

  return {
    notificationPermission: 'granted',
    expoPushToken,
    pushTokenHint,
    firebaseConfigured,
    tokenReady: Boolean(expoPushToken),
    scheduledLessonReminderCount,
    lowBalanceReminderScheduled,
  };
}

export async function sendTestNotification(): Promise<NotificationTestResult> {
  if (Platform.OS === 'web') {
    return {
      success: false,
      message: 'Проверка уведомлений доступна только в сборке Android или iOS.',
    };
  }

  try {
    await ensureNotificationChannel();
    const permissionSettings = await Notifications.getPermissionsAsync();
    if (!isPermissionGranted(permissionSettings)) {
      return {
        success: false,
        message: 'Разрешение на уведомления не выдано. Включите его в настройках приложения и повторите проверку.',
      };
    }

    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Проверка уведомлений',
        body: 'Локальные уведомления работают корректно.',
        sound: 'default',
      },
      trigger: null,
    });
    return {
      success: true,
      message: 'Тестовое локальное уведомление отправлено. Оно должно появиться сразу.',
    };
  } catch {
    return {
      success: false,
      message: 'Не удалось отправить тестовое уведомление. Проверьте разрешение на уведомления и системные настройки устройства.',
    };
  }
}