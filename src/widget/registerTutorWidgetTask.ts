import React from 'react';
import { registerWidgetTaskHandler } from 'react-native-android-widget';
import { TutorAgendaWidget } from './TutorAgendaWidget';
import { loadTutorWidgetSnapshot } from './widgetState';

registerWidgetTaskHandler(async ({ widgetInfo, renderWidget }) => {
  const snapshot = await loadTutorWidgetSnapshot();
  renderWidget(
    React.createElement(TutorAgendaWidget, {
      snapshot,
      widgetInfo,
    }),
  );
});