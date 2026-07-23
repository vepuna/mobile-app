import React from 'react';
import { Platform } from 'react-native';
import { registerWidgetTaskHandler } from 'react-native-android-widget';
import { TutorAgendaWidget } from './TutorAgendaWidget';
import { loadTutorWidgetSnapshot } from './widgetState';

if (Platform.OS === 'android') {
  registerWidgetTaskHandler(async ({ widgetInfo, renderWidget }) => {
    const snapshot = await loadTutorWidgetSnapshot();
    renderWidget(
      React.createElement(TutorAgendaWidget, {
        snapshot,
        widgetInfo,
      }),
    );
  });
}