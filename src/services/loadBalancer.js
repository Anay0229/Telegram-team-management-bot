const db = require('../db/supabase');
const config = require('../config');

/**
 * Calculates load score for one editor.
 * Formula (PRD §6.3):
 *   Score = (active × 10) + (due-within-48h × 5) + (blocked × 3)
 * Lower = less loaded = recommended first.
 * Ties broken by all-time total assigned tasks.
 */
async function scoreEditor(editor) {
  const tasks = await db.getActiveTasksForEditor(editor.id);
  const allTasks = await db.getAllTasksForEditor(editor.id);

  const now = Date.now();
  const urgentCutoff = now + config.loadScore.urgentWindowHours * 60 * 60 * 1000;

  let score = 0;
  for (const task of tasks) {
    score += config.loadScore.activeTaskWeight;
    if (task.deadline && new Date(task.deadline).getTime() <= urgentCutoff) {
      score += config.loadScore.urgentTaskWeight;
    }
    if (task.status === 'blocked') {
      score += config.loadScore.blockedTaskWeight;
    }
  }

  return {
    editor,
    score,
    activeTasks: tasks,
    totalAssigned: allTasks.length,
  };
}

// Role → task type compatibility mapping
function isCompatible(editor, projectType) {
  const roles = Array.isArray(editor.role) ? editor.role : (editor.role ? [editor.role] : []);
  switch (projectType) {
    case 'edit':              return roles.includes('editor');
    case 'shoot':             return roles.includes('shoot');
    case 'graphic_designing': return roles.includes('graphic_designer');
    case 'data_sorting':      return true; // any employee can handle data sorting
    // Legacy fallbacks
    case 'pre-production':    return roles.includes('editor') || roles.includes('shoot');
    case 'post-production':   return roles.includes('editor') || roles.includes('graphic_designer');
    default:                  return true;
  }
}

/**
 * Returns all active editors ranked by load score (ascending).
 * Filters by role compatibility with the project type.
 */
async function getRankedEditors(projectType) {
  const editors = await db.getAllEditors();
  const compatible = editors.filter((e) => isCompatible(e, projectType));
  const scored = await Promise.all(compatible.map(scoreEditor));

  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.totalAssigned - b.totalAssigned;
  });

  return scored;
}

module.exports = { getRankedEditors };
