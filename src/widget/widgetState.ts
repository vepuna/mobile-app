import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import { Platform } from 'react-native';
import { requestWidgetUpdate } from 'react-native-android-widget';
import { deriveWidgetSnapshot } from '../domain/selectors';
import { type AppData, type WidgetSnapshot } from '../domain/types';
import { TutorAgendaWidget, TUTOR_WIDGET_NAME } from './TutorAgendaWidget';

const WIDGET_STORAGE_KEY = 'tutor-assistant.widget.v1';
let widgetSyncQueue: Promise<void> = Promise.resolve();

const emptySnapshot: WidgetSnapshot = {
  generatedAt: new Date(0).toISOString(),
  todayLessonCount: 0,
  dayLabel: '1 янв. 1970',
  lessonLines: [],
  freeSlotsText: 'На сегодня уроков нет.',
};

export async function loadTutorWidgetSnapshot(): Promise<WidgetSnapshot> {
  const rawValue = await AsyncStorage.getItem(WIDGET_STORAGE_KEY);
  if (!rawValue) {
    return emptySnapshot;
  }

  try {
    return JSON.parse(rawValue) as WidgetSnapshot;
  } catch {
    return emptySnapshot;
  }
}

export function syncTutorWidget(data: AppData): Promise<string> {
  const snapshot = deriveWidgetSnapshot(data, new Date());
  widgetSyncQueue = widgetSyncQueue
    .catch(() => {})
    .then(async () => {
      await AsyncStorage.setItem(WIDGET_STORAGE_KEY, JSON.stringify(snapshot));

      if (Platform.OS === 'android') {
        await requestWidgetUpdate({
          widgetName: TUTOR_WIDGET_NAME,
          renderWidget: (widgetInfo) =>
            React.createElement(TutorAgendaWidget, {
              snapshot,
              widgetInfo,
            }),
          widgetNotFound: () => {},
        });
      }
    });

  return widgetSyncQueue.then(() => snapshot.generatedAt);
}