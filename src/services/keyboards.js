// Inline-keyboard builders + the callback-data scheme shared by every quick button.
//
// Telegram limits callback_data to 64 bytes. Every action below encodes as a short
// 2-letter verb + ':' + a single UUID (36 chars) = ~39 bytes, well within budget.
//
//   st:<taskId>   editor → mark Started (in_progress)
//   dn:<taskId>   editor → mark Done (submit for review)
//   bl:<taskId>   editor → mark Blocked (then asks for a reason)
//   ap:<taskId>   owner  → Approve a submitted deliverable (→ completed)
//   ch:<taskId>   owner  → Request Changes (then asks for notes)
//   pa:<editorId> owner  → confirm assignment to this editor
//   sn:<taskId>   editor → "Got it 👍" — snooze pre-deadline reminders for this task
//   ae:<taskId>   owner  → "Mark Seen" — acknowledge an escalation (stops further alerts)

const ACTIONS = {
  STARTED: 'st',
  DONE: 'dn',
  BLOCKED: 'bl',
  APPROVE: 'ap',
  CHANGES: 'ch',
  PICK_EDITOR: 'pa',
  SNOOZE: 'sn',
  ACK_ESCALATION: 'ae',
  NOOP: 'no',
};

// Parses "verb:id" callback data into { action, id }. Returns null when malformed.
function parseCallbackData(data) {
  if (!data || typeof data !== 'string') return null;
  const idx = data.indexOf(':');
  if (idx === -1) return null;
  const action = data.slice(0, idx);
  const id = data.slice(idx + 1);
  if (!action || !id) return null;
  return { action, id };
}

// Buttons shown on the assignment / revision message sent to the assigned editor.
function editorTaskButtons(taskId) {
  return {
    inline_keyboard: [
      [
        { text: '🔄 Started', callback_data: `${ACTIONS.STARTED}:${taskId}` },
        { text: '✅ Done', callback_data: `${ACTIONS.DONE}:${taskId}` },
      ],
      [
        { text: '🚫 Blocked', callback_data: `${ACTIONS.BLOCKED}:${taskId}` },
      ],
    ],
  };
}

// A single, inert "status notice" button used to REPLACE an editor's action
// buttons once the task has been submitted. Leaving a visible notice (instead of
// clearing the keyboard to empty) keeps the original message obviously intact —
// so consuming the buttons never looks like the message was deleted. Tapping it
// is a no-op handled by the callback router.
function statusNoticeButton(label) {
  return { inline_keyboard: [[{ text: label, callback_data: `${ACTIONS.NOOP}:1` }]] };
}

// Buttons shown to owners on a submitted deliverable (file or "done" notice).
function ownerReviewButtons(taskId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `${ACTIONS.APPROVE}:${taskId}` },
        { text: '🔁 Request Changes', callback_data: `${ACTIONS.CHANGES}:${taskId}` },
      ],
    ],
  };
}

// Single "Got it 👍" button shown on a pre-deadline reminder. Tapping it snoozes
// further pre-deadline reminders for that task (config.reminders.snoozeHours).
function reminderButtons(taskId) {
  return { inline_keyboard: [[{ text: '👍 Got it', callback_data: `${ACTIONS.SNOOZE}:${taskId}` }]] };
}

// Single "Mark Seen" button shown on an escalation alert to the owners. Tapping it
// acknowledges the escalation so no further tiers fire for that task.
function escalationButtons(taskId) {
  return { inline_keyboard: [[{ text: '✅ Mark Seen', callback_data: `${ACTIONS.ACK_ESCALATION}:${taskId}` }]] };
}

// One button per ranked editor (up to `limit`) for assignment confirmation.
// `ranked` is the loadBalancer's scored list: [{ editor, score, activeTasks }].
function assignmentButtons(ranked, limit = 5) {
  const rows = ranked.slice(0, limit).map((s, i) => ([
    {
      text: `${i + 1}. ${s.editor.name} (${s.activeTasks.length} active)`,
      callback_data: `${ACTIONS.PICK_EDITOR}:${s.editor.id}`,
    },
  ]));
  return { inline_keyboard: rows };
}

module.exports = {
  ACTIONS,
  parseCallbackData,
  editorTaskButtons,
  statusNoticeButton,
  ownerReviewButtons,
  reminderButtons,
  escalationButtons,
  assignmentButtons,
};
