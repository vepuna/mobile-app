import React from 'react';
import { FlexWidget, TextWidget, type WidgetInfo } from 'react-native-android-widget';
import { type WidgetSnapshot } from '../domain/types';

export const TUTOR_WIDGET_NAME = 'TutorAgendaWidget';

export function TutorAgendaWidget({
  snapshot,
  widgetInfo,
}: {
  snapshot: WidgetSnapshot;
  widgetInfo: WidgetInfo;
}) {
  const compact = widgetInfo.width < 200 || widgetInfo.height < 120;
  const lessonNodes =
    snapshot.lessonLines.length === 0
      ? [
          React.createElement(TextWidget, {
            key: 'empty',
            text: 'На сегодня уроков нет',
            style: { color: '#EAF7FB', fontSize: 13 },
          }),
        ]
      : snapshot.lessonLines.map((line, index) =>
          React.createElement(TextWidget, {
            key: `${line}-${index}`,
            text: line,
            style: { color: '#EAF7FB', fontSize: 13, marginTop: index === 0 ? 0 : 6 },
            maxLines: 1,
            truncate: 'END',
          }),
        );

  return React.createElement(
    FlexWidget,
    {
      clickAction: 'OPEN_APP',
      accessibilityLabel: 'Виджет расписания репетитора',
      style: {
        width: 'match_parent',
        height: 'match_parent',
        padding: compact ? 14 : 18,
        borderRadius: 24,
        backgroundGradient: {
          from: '#123C69',
          to: '#2EA3A1',
          orientation: 'LEFT_RIGHT',
        },
      },
    },
    React.createElement(TextWidget, {
      text: snapshot.dayLabel,
      style: { color: '#D9F7FF', fontSize: 12, fontWeight: '700', letterSpacing: 1.2 },
    }),
    React.createElement(TextWidget, {
      text: `Сегодня уроков: ${snapshot.todayLessonCount}`,
      style: { color: '#FFFFFF', fontSize: compact ? 22 : 28, fontWeight: '800', marginTop: 8 },
    }),
    React.createElement(FlexWidget, { style: { marginTop: 12 } }, ...lessonNodes),
    React.createElement(TextWidget, {
      text: snapshot.freeSlotsText,
      style: { color: '#FFF1D6', fontSize: 12, marginTop: 12 },
      maxLines: 2,
      truncate: 'END',
    }),
  );
}