const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

// ── Clients ──────────────────────────────────────────────────────────────────

async function createClient_({ name }) {
  const { data, error } = await supabase
    .from('clients')
    .insert({ name: name.trim() })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getAllClients() {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .order('name', { ascending: true });
  if (error) throw error;
  return data;
}

async function getAllActiveClients() {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('active', true)
    .order('name', { ascending: true });
  if (error) throw error;
  return data;
}

async function getClientById(id) {
  const { data, error } = await supabase
    .from('clients').select('*').eq('id', id).limit(1);
  if (error) throw error;
  return data[0] || null;
}

// Fuzzy name match — used when owner types a client name on Telegram.
async function getClientByName(name) {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .ilike('name', `%${name}%`)
    .eq('active', true);
  if (error) throw error;
  return data; // may return multiple; caller handles ambiguity
}

async function setClientActive(id, active) {
  const { data, error } = await supabase
    .from('clients').update({ active }).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

// ── Employees ─────────────────────────────────────────────────────────────────

async function createEditor({ name, telegramId, roles }) {
  const { data, error } = await supabase
    .from('editors')
    .insert({ name, telegram_id: telegramId, role: roles })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getAllEditors() {
  const { data, error } = await supabase
    .from('editors')
    .select('*')
    .eq('active', true);
  if (error) throw error;
  return data;
}

// Every editor, active or not — used by the admin portal's management view.
async function getAllEditorsIncludingInactive() {
  const { data, error } = await supabase
    .from('editors')
    .select('*')
    .order('active', { ascending: false })
    .order('name', { ascending: true });
  if (error) throw error;
  return data;
}

async function getEditorById(id) {
  const { data, error } = await supabase
    .from('editors')
    .select('*')
    .eq('id', id)
    .limit(1);
  if (error) throw error;
  return data[0] || null;
}

async function setEditorActive(id, active) {
  const { data, error } = await supabase
    .from('editors')
    .update({ active })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Marks an editor available / on-leave. Unavailable editors are skipped by the
// load balancer when ranking candidates for new work.
async function setEditorAvailable(id, available) {
  const { data, error } = await supabase
    .from('editors')
    .update({ available })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getEditorByTelegramId(telegramId) {
  const { data, error } = await supabase
    .from('editors')
    .select('*')
    .eq('telegram_id', String(telegramId))
    .limit(1);
  if (error) throw error;
  return data[0] || null;
}

async function getEditorByName(name) {
  const { data, error } = await supabase
    .from('editors')
    .select('*')
    .ilike('name', `%${name}%`)
    .eq('active', true);
  if (error) throw error;
  return data[0] || null;
}

// ── Tasks ────────────────────────────────────────────────────────────────────

async function createTask({ projectName, type, assignedTo, deadline, driveLink, note, clientId, priority }) {
  const base = {
    project_name: projectName,
    client_id: clientId || null,
    type,
    assigned_to: assignedTo,
    status: 'pending',
    deadline,
    drive_link: driveLink,
    note: note || null,
  };
  let { data, error } = await supabase
    .from('tasks')
    .insert({ ...base, priority: priority || 'normal' })
    .select()
    .single();
  // priority column not migrated yet → retry without it (best-effort).
  if (error && /priority/i.test(error.message || '')) {
    console.warn('[DB] createTask: priority column missing, inserting without it (run the migration).');
    ({ data, error } = await supabase.from('tasks').insert(base).select().single());
  }
  if (error) throw error;
  return data;
}

// Single task with its editor and client joined.
async function getTaskById(id) {
  const { data, error } = await supabase
    .from('tasks')
    .select('*, editors(name, telegram_id), clients(name)')
    .eq('id', id)
    .limit(1);
  if (error) throw error;
  return data[0] || null;
}

// Links a task to the Telegram message_id of its assignment notification,
// so an editor can reply to that message to update the correct task.
async function updateTaskAssignmentMsgId(taskId, assignmentMsgId) {
  const { error } = await supabase
    .from('tasks')
    .update({ assignment_msg_id: assignmentMsgId })
    .eq('id', taskId);
  if (error) throw error;
}

async function getTaskByAssignmentMsgId(assignmentMsgId) {
  const { data, error } = await supabase
    .from('tasks')
    .select('*, editors(name, telegram_id), clients(name)')
    .eq('assignment_msg_id', assignmentMsgId)
    .limit(1);
  if (error) throw error;
  return data[0] || null;
}

// Records the latest file an editor submitted for a task, so completion
// notifications can confirm a deliverable was received.
async function setTaskDeliverable(taskId, { fileId, fileType, fileName }) {
  const { error } = await supabase
    .from('tasks')
    .update({
      deliverable_file_id: fileId,
      deliverable_file_type: fileType,
      deliverable_file_name: fileName || null,
      deliverable_uploaded_at: new Date().toISOString(),
    })
    .eq('id', taskId);
  if (error) throw error;
}

// Stores the per-owner Telegram message_ids of a forwarded deliverable, so an
// owner can reply to that file to request changes. ownerMsgs = { ownerChatId: messageId }.
async function setTaskDeliverableOwnerMsgs(taskId, ownerMsgs) {
  const { error } = await supabase
    .from('tasks')
    .update({ deliverable_owner_msgs: ownerMsgs })
    .eq('id', taskId);
  if (error) throw error;
}

// Finds the task whose forwarded deliverable (in this owner's chat) has the
// given message_id — used to resolve "reply to the file" change requests.
async function getTaskByDeliverableOwnerMsg(ownerId, messageId) {
  const { data, error } = await supabase
    .from('tasks')
    .select('*, editors(name, telegram_id), clients(name)')
    .eq(`deliverable_owner_msgs->>${ownerId}`, String(messageId))
    .limit(1);
  if (error) throw error;
  return data[0] || null;
}

// Records a change-request round on a task.
async function setTaskRevision(taskId, { count, notes }) {
  const { error } = await supabase
    .from('tasks')
    .update({
      revision_count: count,
      revision_notes: notes,
      revision_requested_at: new Date().toISOString(),
    })
    .eq('id', taskId);
  if (error) throw error;
}

// Stamps the most recent review_log entry (the round being sent back) with when
// and why changes were requested, so the task detail timeline shows the full
// round-by-round story. Kept separate from setTaskRevision so a missing
// review_log column never blocks the core revision metadata write.
async function stampReviewRoundChangeRequest(taskId, notes) {
  const { data: cur } = await supabase
    .from('tasks').select('review_log').eq('id', taskId).single();
  const log = Array.isArray(cur?.review_log) ? cur.review_log : [];
  if (!log.length) return; // nothing delivered yet to stamp
  const last = log[log.length - 1];
  last.changes_requested_at = new Date().toISOString();
  last.notes = notes;
  const { error } = await supabase
    .from('tasks')
    .update({ review_log: log })
    .eq('id', taskId);
  if (error) throw error;
}

// Sets a task's ORIGINAL deadline once, at assignment time. Never overwritten by
// the revision flow, so the work-record history can always compare the first
// submission against the deadline the work was actually given.
async function markInitialDeadline(taskId, deadline) {
  const { error } = await supabase
    .from('tasks')
    .update({ initial_deadline: deadline })
    .eq('id', taskId);
  if (error) throw error;
}

// Records a delivery: stamps first_submitted_at (once) and appends a round entry
// to review_log capturing the deadline that applied and whether it was on time.
// round = revision_count at submission time (0 = initial delivery, 1+ = revisions).
async function recordSubmission(taskId) {
  const { data: cur } = await supabase
    .from('tasks')
    .select('deadline, revision_count, review_log, first_submitted_at')
    .eq('id', taskId)
    .single();

  const now = new Date().toISOString();
  const deadline = cur?.deadline || null;
  const log = Array.isArray(cur?.review_log) ? cur.review_log : [];

  log.push({
    round: cur?.revision_count || 0,
    deadline,
    submitted_at: now,
    on_time: deadline ? new Date(now) <= new Date(deadline) : null,
    changes_requested_at: null,
    notes: null,
  });

  const update = { review_log: log };
  if (!cur?.first_submitted_at) update.first_submitted_at = now;

  const { error } = await supabase
    .from('tasks')
    .update(update)
    .eq('id', taskId);
  if (error) throw error;
}

// Finds active tasks by main-work description OR client name — used by the mark command.
async function findActiveTasksByProjectName(name) {
  const { data: byWork, error: e1 } = await supabase
    .from('tasks')
    .select('*, editors(name, telegram_id), clients(name)')
    .ilike('project_name', `%${name}%`)
    .in('status', ['pending', 'in_progress', 'blocked', 'submitted_for_review'])
    .order('deadline', { ascending: true });
  if (e1) throw e1;

  // Also search by client name via a subquery workaround: fetch matching client ids first.
  const { data: matchedClients } = await supabase
    .from('clients').select('id').ilike('name', `%${name}%`).eq('active', true);
  const clientIds = (matchedClients || []).map((c) => c.id);

  let byClient = [];
  if (clientIds.length) {
    const { data, error: e2 } = await supabase
      .from('tasks')
      .select('*, editors(name, telegram_id), clients(name)')
      .in('client_id', clientIds)
      .in('status', ['pending', 'in_progress', 'blocked', 'submitted_for_review'])
      .order('deadline', { ascending: true });
    if (e2) throw e2;
    byClient = data;
  }

  // Merge, deduplicate by task id
  const seen = new Set();
  return [...byWork, ...byClient].filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

// Like findActiveTasksByProjectName but across ALL statuses (incl. completed),
// most recent first — used by the change-request flow, which targets delivered work.
async function findTasksByProjectNameAnyStatus(name) {
  const { data: byWork, error: e1 } = await supabase
    .from('tasks')
    .select('*, editors(name, telegram_id), clients(name)')
    .ilike('project_name', `%${name}%`)
    .order('created_at', { ascending: false });
  if (e1) throw e1;

  const { data: matchedClients } = await supabase
    .from('clients').select('id').ilike('name', `%${name}%`);
  const clientIds = (matchedClients || []).map((c) => c.id);

  let byClient = [];
  if (clientIds.length) {
    const { data, error: e2 } = await supabase
      .from('tasks')
      .select('*, editors(name, telegram_id), clients(name)')
      .in('client_id', clientIds)
      .order('created_at', { ascending: false });
    if (e2) throw e2;
    byClient = data;
  }

  const seen = new Set();
  return [...byWork, ...byClient].filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

// Tasks that have a submitted deliverable file — drives the admin Changes tab.
async function getTasksWithDeliverable(limit = 100) {
  const { data, error } = await supabase
    .from('tasks')
    .select('*, editors(name, telegram_id), clients(name)')
    .not('deliverable_file_id', 'is', null)
    .order('deliverable_uploaded_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

async function getActiveTasksForEditor(editorId) {
  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('assigned_to', editorId)
    .in('status', ['pending', 'in_progress', 'blocked']);
  if (error) throw error;
  return data;
}

async function getMostRecentActiveTaskForEditor(editorId) {
  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('assigned_to', editorId)
    .in('status', ['pending', 'in_progress', 'blocked'])
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data[0] || null;
}

async function updateTaskStatus(taskId, status, extra = {}) {
  const update = { status, ...extra };
  if (status === 'completed') update.completed_at = new Date().toISOString();
  if (status === 'in_progress') {
    // Only record started_at on the first in_progress transition
    const { data: cur } = await supabase
      .from('tasks').select('started_at').eq('id', taskId).single();
    if (!cur?.started_at) update.started_at = new Date().toISOString();
  }
  const { data, error } = await supabase
    .from('tasks')
    .update(update)
    .eq('id', taskId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Updates a task's deadline (used by the bulk "set deadline" admin action).
// Re-arms every deadline signal so the fresh deadline triggers reminders and
// escalation again instead of being suppressed by the old one's flags.
async function setTaskDeadline(taskId, deadline) {
  const { data, error } = await supabase
    .from('tasks')
    .update({ deadline, deadline_notified_at: null })
    .eq('id', taskId)
    .select()
    .single();
  if (error) throw error;
  await rearmDeadlineFlags(taskId); // best-effort (new columns)
  return data;
}

// Best-effort reset of the new pre-deadline-reminder and escalation flags after a
// deadline change. Silently no-ops if those columns aren't migrated yet, so the
// surrounding deadline update never hard-fails on an old schema.
async function rearmDeadlineFlags(taskId) {
  const { error } = await supabase
    .from('tasks')
    .update({ reminders_sent: [], escalated_at: null })
    .eq('id', taskId);
  if (error) console.warn('[DB] rearmDeadlineFlags skipped (run the migration):', error.message);
}

// Reassigns a task to a different employee (bulk reassign + single reassign).
async function setTaskAssignee(taskId, editorId) {
  const { data, error } = await supabase
    .from('tasks')
    .update({ assigned_to: editorId })
    .eq('id', taskId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getAllActiveTasks() {
  const { data, error } = await supabase
    .from('tasks')
    .select('*, editors(name, telegram_id), clients(name)')
    .in('status', ['pending', 'in_progress', 'blocked', 'submitted_for_review'])
    .order('deadline', { ascending: true });
  if (error) throw error;
  return data;
}

// Tasks an employee has submitted and that are awaiting an owner's approve /
// request-changes decision — drives the admin approval queue.
async function getTasksAwaitingReview(limit = 100) {
  const { data, error } = await supabase
    .from('tasks')
    .select('*, editors(name, telegram_id), clients(name)')
    .eq('status', 'submitted_for_review')
    .order('deliverable_uploaded_at', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

async function getOverdueTasks() {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('tasks')
    .select('*, editors(name, telegram_id), clients(name)')
    .in('status', ['pending', 'in_progress', 'blocked'])
    .lt('deadline', now)
    .order('deadline', { ascending: true });
  if (error) throw error;
  return data;
}

async function getCompletedToday() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from('tasks')
    .select('*, editors(name), clients(name)')
    .eq('status', 'completed')
    .gte('completed_at', startOfDay.toISOString());
  if (error) throw error;
  return data;
}

async function getTasksForEditorWithJoin(editorId) {
  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('assigned_to', editorId)
    .in('status', ['pending', 'in_progress', 'blocked', 'submitted_for_review'])
    .order('deadline', { ascending: true });
  if (error) throw error;
  return data;
}

async function getTasksDueSoon(windowMs) {
  const now = new Date();
  const cutoff = new Date(now.getTime() + windowMs);
  const { data, error } = await supabase
    .from('tasks')
    .select('*, editors(name, telegram_id), clients(name)')
    .in('status', ['pending', 'in_progress'])
    .gte('deadline', now.toISOString())
    .lte('deadline', cutoff.toISOString());
  if (error) throw error;
  return data;
}

async function getTasksStillInProgressAfterDeadline() {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('tasks')
    .select('*, editors(name, telegram_id), clients(name)')
    .eq('status', 'in_progress')
    .lt('deadline', now);
  if (error) throw error;
  return data;
}

// In-progress tasks more than `windowMs` past their deadline that have NOT yet
// been escalated to the owners. Persists dedup across restarts via escalated_at
// (vs. the old in-memory Set). Throws if escalated_at isn't migrated yet — the
// scheduler catches that and falls back to the in-memory approach.
async function getTasksNeedingEscalation(windowMs) {
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const { data, error } = await supabase
    .from('tasks')
    .select('*, editors(name, telegram_id), clients(name)')
    .eq('status', 'in_progress')
    .not('deadline', 'is', null)
    .lt('deadline', cutoff)
    .is('escalated_at', null);
  if (error) throw error;
  return data;
}

async function markTaskEscalated(taskId) {
  const { error } = await supabase
    .from('tasks')
    .update({ escalated_at: new Date().toISOString() })
    .eq('id', taskId);
  if (error) throw error;
}

async function getAllTasksForEditor(editorId) {
  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('assigned_to', editorId);
  if (error) throw error;
  return data;
}

// Completed tasks ordered by most recent — for the dashboard history table.
async function getCompletedTasksHistory(limit = 50) {
  const { data, error } = await supabase
    .from('tasks')
    .select('*, editors(name), clients(name)')
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

async function getCompletedThisWeek() {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('tasks').select('id').eq('status', 'completed').gte('completed_at', since);
  if (error) throw error;
  return data.length;
}

async function getCompletedThisMonth() {
  const start = new Date();
  start.setDate(1); start.setHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from('tasks').select('id').eq('status', 'completed').gte('completed_at', start.toISOString());
  if (error) throw error;
  return data.length;
}

// Aggregate stats for every editor — used by the Employee Sheet.
async function getEmployeeStats() {
  const [editors, tasksResult] = await Promise.all([
    getAllEditorsIncludingInactive(),
    supabase.from('tasks').select('id, assigned_to, status, deadline, started_at, completed_at, created_at, revision_count'),
  ]);
  if (tasksResult.error) throw tasksResult.error;
  const tasks = tasksResult.data;
  const now = new Date();

  const map = {};
  for (const e of editors) {
    map[e.id] = { total: 0, completed: 0, active: 0, overdue: 0, onTime: 0, lateCount: 0, firstPass: 0, turnaroundHours: [], lastStartedAt: null };
  }

  for (const t of tasks) {
    const s = map[t.assigned_to];
    if (!s) continue;
    s.total++;
    if (t.status === 'completed') {
      s.completed++;
      // Approved on the first submission = no change-request rounds.
      if (!t.revision_count) s.firstPass++;
      if (t.deadline && t.completed_at) {
        if (new Date(t.completed_at) <= new Date(t.deadline)) s.onTime++;
        else s.lateCount++;
      }
      if (t.started_at && t.completed_at) {
        const hrs = (new Date(t.completed_at) - new Date(t.started_at)) / 3600000;
        if (hrs >= 0) s.turnaroundHours.push(hrs);
      }
    } else {
      s.active++;
      // Work already submitted for review isn't "overdue" — the employee delivered.
      if (t.status !== 'submitted_for_review' && t.deadline && new Date(t.deadline) < now) s.overdue++;
    }
    if (t.started_at && (!s.lastStartedAt || new Date(t.started_at) > new Date(s.lastStartedAt))) {
      s.lastStartedAt = t.started_at;
    }
  }

  return editors.map((e) => {
    const s = map[e.id];
    const completedWithDeadline = s.onTime + s.lateCount;
    const onTimeRate = completedWithDeadline > 0 ? Math.round((s.onTime / completedWithDeadline) * 100) : null;
    const firstPassRate = s.completed > 0 ? Math.round((s.firstPass / s.completed) * 100) : null;
    const avgTurnaround = s.turnaroundHours.length > 0
      ? s.turnaroundHours.reduce((a, b) => a + b, 0) / s.turnaroundHours.length
      : null;
    return { editor: e, ...s, onTimeRate, firstPassRate, avgTurnaround };
  });
}

// Active tasks whose deadline has been reached and that haven't been reminded
// yet — drives the "remind exactly when the deadline is hit" reminder.
async function getTasksAtDeadlineNeedingReminder() {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('tasks')
    .select('*, editors(name, telegram_id), clients(name)')
    .in('status', ['pending', 'in_progress', 'blocked'])
    .not('deadline', 'is', null)
    .lte('deadline', now)
    .is('deadline_notified_at', null);
  if (error) throw error;
  return data;
}

// Tasks past their deadline that haven't been notified yet (or last notified >24 hrs ago).
async function getOverdueTasksNeedingEditorNotification() {
  const now = new Date();
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('tasks')
    .select('*, editors(name, telegram_id), clients(name)')
    .in('status', ['pending', 'in_progress', 'blocked'])
    .not('deadline', 'is', null)
    .lt('deadline', now.toISOString())
    .or(`deadline_notified_at.is.null,deadline_notified_at.lt.${cutoff}`);
  if (error) throw error;
  return data;
}

async function markTaskDeadlineNotified(taskId) {
  const { error } = await supabase
    .from('tasks')
    .update({ deadline_notified_at: new Date().toISOString() })
    .eq('id', taskId);
  if (error) throw error;
}

// Persists which pre-deadline hour-thresholds have already been sent for a task
// (e.g. [24, 2]). The scheduler reads tasks.reminders_sent and appends to it.
async function markReminderSent(taskId, remindersSent) {
  const { error } = await supabase
    .from('tasks')
    .update({ reminders_sent: remindersSent })
    .eq('id', taskId);
  if (error) throw error;
}

// Permanently deletes a single task — used by the admin portal's per-row Delete
// button to remove wrongly-created tasks. Returns the deleted row (or null).
async function deleteTaskById(taskId) {
  const { data, error } = await supabase
    .from('tasks')
    .delete()
    .eq('id', taskId)
    .select('id, project_name')
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Deletes every task whose project_name starts with the given prefix — used by
// the admin test endpoints to clean up seeded demo data. Returns the count removed.
async function deleteTasksByNamePrefix(prefix) {
  const { data, error } = await supabase
    .from('tasks')
    .delete()
    .ilike('project_name', `${prefix}%`)
    .select('id');
  if (error) throw error;
  return data ? data.length : 0;
}

module.exports = {
  createClient: createClient_,
  getAllClients,
  getAllActiveClients,
  getClientById,
  getClientByName,
  setClientActive,
  createEditor,
  getAllEditors,
  getAllEditorsIncludingInactive,
  getEditorById,
  setEditorActive,
  setEditorAvailable,
  getEditorByTelegramId,
  getEditorByName,
  createTask,
  getTaskById,
  updateTaskAssignmentMsgId,
  getTaskByAssignmentMsgId,
  setTaskDeliverable,
  setTaskDeliverableOwnerMsgs,
  getTaskByDeliverableOwnerMsg,
  setTaskRevision,
  stampReviewRoundChangeRequest,
  markInitialDeadline,
  recordSubmission,
  findActiveTasksByProjectName,
  findTasksByProjectNameAnyStatus,
  getTasksWithDeliverable,
  getActiveTasksForEditor,
  getMostRecentActiveTaskForEditor,
  updateTaskStatus,
  setTaskDeadline,
  rearmDeadlineFlags,
  setTaskAssignee,
  getAllActiveTasks,
  getTasksAwaitingReview,
  getOverdueTasks,
  getCompletedToday,
  getTasksForEditorWithJoin,
  getTasksDueSoon,
  getTasksAtDeadlineNeedingReminder,
  getTasksStillInProgressAfterDeadline,
  getTasksNeedingEscalation,
  markTaskEscalated,
  getAllTasksForEditor,
  getCompletedTasksHistory,
  getCompletedThisWeek,
  getCompletedThisMonth,
  getEmployeeStats,
  getOverdueTasksNeedingEditorNotification,
  markTaskDeadlineNotified,
  markReminderSent,
  deleteTaskById,
  deleteTasksByNamePrefix,
};
