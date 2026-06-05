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

async function createTask({ projectName, type, assignedTo, deadline, driveLink, note, clientId }) {
  const { data, error } = await supabase
    .from('tasks')
    .insert({
      project_name: projectName,
      client_id: clientId || null,
      type,
      assigned_to: assignedTo,
      status: 'pending',
      deadline,
      drive_link: driveLink,
      note: note || null,
    })
    .select()
    .single();
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

// Finds active tasks by main-work description OR client name — used by the mark command.
async function findActiveTasksByProjectName(name) {
  const { data: byWork, error: e1 } = await supabase
    .from('tasks')
    .select('*, editors(name, telegram_id), clients(name)')
    .ilike('project_name', `%${name}%`)
    .in('status', ['pending', 'in_progress', 'blocked'])
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
      .in('status', ['pending', 'in_progress', 'blocked'])
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

async function getAllActiveTasks() {
  const { data, error } = await supabase
    .from('tasks')
    .select('*, editors(name, telegram_id), clients(name)')
    .in('status', ['pending', 'in_progress', 'blocked'])
    .order('deadline', { ascending: true });
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
    .in('status', ['pending', 'in_progress', 'blocked'])
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
    supabase.from('tasks').select('id, assigned_to, status, deadline, started_at, completed_at, created_at'),
  ]);
  if (tasksResult.error) throw tasksResult.error;
  const tasks = tasksResult.data;
  const now = new Date();

  const map = {};
  for (const e of editors) {
    map[e.id] = { total: 0, completed: 0, active: 0, overdue: 0, onTime: 0, lateCount: 0, turnaroundHours: [], lastStartedAt: null };
  }

  for (const t of tasks) {
    const s = map[t.assigned_to];
    if (!s) continue;
    s.total++;
    if (t.status === 'completed') {
      s.completed++;
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
      if (t.deadline && new Date(t.deadline) < now) s.overdue++;
    }
    if (t.started_at && (!s.lastStartedAt || new Date(t.started_at) > new Date(s.lastStartedAt))) {
      s.lastStartedAt = t.started_at;
    }
  }

  return editors.map((e) => {
    const s = map[e.id];
    const completedWithDeadline = s.onTime + s.lateCount;
    const onTimeRate = completedWithDeadline > 0 ? Math.round((s.onTime / completedWithDeadline) * 100) : null;
    const avgTurnaround = s.turnaroundHours.length > 0
      ? s.turnaroundHours.reduce((a, b) => a + b, 0) / s.turnaroundHours.length
      : null;
    return { editor: e, ...s, onTimeRate, avgTurnaround };
  });
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
  getEditorByTelegramId,
  getEditorByName,
  createTask,
  getTaskById,
  updateTaskAssignmentMsgId,
  getTaskByAssignmentMsgId,
  findActiveTasksByProjectName,
  getActiveTasksForEditor,
  getMostRecentActiveTaskForEditor,
  updateTaskStatus,
  getAllActiveTasks,
  getOverdueTasks,
  getCompletedToday,
  getTasksForEditorWithJoin,
  getTasksDueSoon,
  getTasksStillInProgressAfterDeadline,
  getAllTasksForEditor,
  getCompletedTasksHistory,
  getCompletedThisWeek,
  getCompletedThisMonth,
  getEmployeeStats,
  getOverdueTasksNeedingEditorNotification,
  markTaskDeadlineNotified,
};
