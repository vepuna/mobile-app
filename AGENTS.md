# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v56.0.0/ before writing any code.

---

# Mobile UI & Navigation Improvements

## 1. Respect Android Safe Area

The application currently does not properly account for Android system navigation controls.

Current issue:

- Parts of the footer and several action buttons are covered by the Android navigation bar (Back / Home / Recent Apps).
- Some buttons become partially or completely inaccessible.

Requirements:

- Make the application fully safe-area aware.
- The bottom navigation and all footer actions must always be positioned **above** the Android system navigation area.
- No interactive element should ever be hidden behind system UI.
- Verify the layout on devices using both gesture navigation and the classic three-button navigation.

---

## 2. Redesign Navigation

Replace the current navigation with a modern bottom navigation bar.

Requirements:

- Navigation between the main sections should be performed using **icon buttons in a bottom navigation bar**.
- The bottom navigation should remain visible throughout the application.
- The currently selected section should be clearly highlighted.

The top header should become much simpler:

- Display only the title of the current page.
- Remove navigation controls from the header.

The goal is to make navigation consistent with modern Android and iOS applications.

---

## 3. Remove Permanent Statistics from the Header

The statistics section currently occupies too much valuable vertical space.

Requirements:

- Remove the permanent statistics block from the top of the application.
- Statistics should only be shown when the user opens the dedicated **Statistics** page.
- The main screens should focus entirely on scheduling and lesson management.

This change will significantly increase the usable workspace.

---

## 4. Remove Unnecessary Helper Text

The application contains several instructional messages that are useful only during the first launch.

Examples include:

- "Tap on a day to open the lesson list."
- Similar tips and helper descriptions.

Requirements:

- Remove all permanent instructional text.
- The interface should be intuitive enough that these explanations are unnecessary.
- Keep the UI clean and uncluttered.

---

## 5. Add "Create Lesson" Button to the Day View

When the user opens a specific day from the calendar, there should be a clear way to add a lesson.

Requirements:

- Add a prominent **Add Lesson** button inside the selected day view.
- Position it in an easily accessible location (for example, in the top-right corner of the day dialog/page or as a floating action button).
- Pressing the button should immediately open the lesson creation dialog with the selected date already pre-filled.

This makes creating multiple lessons for the same day much faster and avoids returning to the main calendar each time.

---

## Overall Mobile UX Goal

The application should feel like a polished native mobile app rather than a desktop interface adapted for mobile.

Focus on:

- maximizing usable screen space;
- respecting safe areas;
- minimizing unnecessary text;
- reducing the number of taps required to perform common actions;
- providing fast, intuitive navigation using a persistent bottom navigation bar;
- keeping lesson management as the primary focus of the interface.

---

# Settings & Mobile Layout Improvements

## 1. Move Reminder Settings to the Settings Screen

The **Reminders** section is currently located inside the **Statistics** page, which is not the appropriate place for application settings.

Requirements:

- Remove the **Reminders** block from the **Statistics** page.
- Move the entire reminder configuration to the **Settings** page.
- Keep all reminder functionality unchanged; only change its location.
- Group it together with the other application preferences and settings.

---

## 2. Raise the Bottom Area Across the Entire Application

The bottom portion of the interface is still positioned too low on mobile devices.

Requirements:

- Raise all bottom action areas throughout the application.
- This applies to:
	- the bottom navigation bar;
	- footer action buttons;
	- fixed bottom panels;
	- bottom sheets;
	- popup dialogs (modals);
	- confirmation dialogs.
- Ensure that every bottom action area respects the device's safe area and sits comfortably **above** the Android navigation bar.

Buttons must never be partially hidden or difficult to press.

Review the entire application and apply this consistently to every screen and every modal, rather than fixing only individual pages.

The goal is for every important action to remain fully visible and easily accessible on all Android devices, regardless of whether the user is using gesture navigation or the classic three-button navigation.
