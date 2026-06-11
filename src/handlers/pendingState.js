// Shared in-memory conversation state, keyed by Telegram chat id, so the message
// handlers and the inline-button callback handler can coordinate multi-step flows
// without a circular require between handler modules.
//
// All maps are intentionally process-local and ephemeral — they only bridge the
// gap between a button tap and the follow-up text the user sends next. Losing them
// on restart is harmless: the user simply re-issues the command.

module.exports = {
  // ownerId -> { projectName, type, deadline, note, ranked, clientId, clientName }
  // An owner who ran "new project:" and is choosing whom to assign it to.
  pendingAssignments: new Map(),

  // editorTelegramId -> { taskId, title }
  // An editor who tapped the "Blocked" button and whose next message is the reason.
  pendingBlockReason: new Map(),

  // ownerId -> { taskId, title, attachments: [{ fileId, fileType, fileName }] }
  // An owner who tapped "Request Changes" and whose next message is the change notes.
  // `attachments` collects any optional reference files the owner sends before the
  // notes; they're forwarded to the editor when the change request is finalised.
  pendingChangeNotes: new Map(),
};
