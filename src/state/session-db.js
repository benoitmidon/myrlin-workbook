/**
 * SQLite-backed session↔transcript registry.
 *
 * Stores the binding between a Myrlin session and its Claude transcript
 * (resumeSessionId / JSONL UUID) with a UNIQUE constraint so the same
 * transcript can never be claimed by two sessions.
 *
 * This is a safety net on top of the JSON store — the JSON store remains
 * the source of truth for all session data, but this DB enforces uniqueness
 * and keeps a historical log of every binding for debugging.
 *
 * File: ~/.myrlin/sessions.db
 *
 * @module src/state/session-db
 */

'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const { getDataDir } = require('../utils/data-dir');

const DB_PATH = path.join(getDataDir(), 'sessions.db');

let _db = null;

/**
 * Get or create the singleton DB connection.
 * @returns {DatabaseSync}
 */
function getDb() {
  if (_db) return _db;
  _db = new DatabaseSync(DB_PATH);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS session_transcript (
      session_id             TEXT PRIMARY KEY,
      resume_session_id      TEXT UNIQUE,
      session_name           TEXT,
      first_message          TEXT,
      working_dir            TEXT,
      conversation_started_at TEXT,
      created_at             TEXT DEFAULT (datetime('now')),
      updated_at             TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS session_history (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id        TEXT NOT NULL,
      resume_session_id TEXT,
      session_name      TEXT,
      action            TEXT NOT NULL,
      timestamp         TEXT DEFAULT (datetime('now'))
    );
  `);
  // Migration: add conversation_started_at column if missing (existing DBs)
  try {
    _db.exec(`ALTER TABLE session_transcript ADD COLUMN conversation_started_at TEXT`);
  } catch (_) {
    // Column already exists — ignore
  }
  return _db;
}

/**
 * Register or update a session↔transcript binding.
 * Returns { ok: true } on success or { ok: false, error, conflictSession }
 * if the transcript is already claimed by another session.
 *
 * @param {string} sessionId - Myrlin session UUID
 * @param {string} resumeSessionId - Claude transcript UUID
 * @param {string} [sessionName] - Human-readable session name
 * @param {string} [firstMessage] - First user message (for identification)
 * @param {string} [workingDir] - Session working directory
 * @returns {{ ok: boolean, error?: string, conflictSession?: string }}
 */
function bindTranscript(sessionId, resumeSessionId, { sessionName, firstMessage, workingDir, conversationStartedAt } = {}) {
  const db = getDb();

  // Check if this session already has a binding — once set, never change
  const selfBinding = db.prepare(
    'SELECT resume_session_id, session_name FROM session_transcript WHERE session_id = ?'
  ).get(sessionId);

  if (selfBinding) {
    if (selfBinding.resume_session_id === resumeSessionId) {
      // Same binding, idempotent — OK
      return { ok: true };
    }
    // Attempting to change an existing binding — REJECT
    db.prepare(
      'INSERT INTO session_history (session_id, resume_session_id, session_name, action) VALUES (?, ?, ?, ?)'
    ).run(sessionId, resumeSessionId, sessionName || null,
      'rejected:immutable_existing_' + selfBinding.resume_session_id);

    return {
      ok: false,
      error: `Session ${sessionId} ("${selfBinding.session_name || ''}") already bound to ${selfBinding.resume_session_id} — bindings are immutable`,
      conflictSession: sessionId,
    };
  }

  // Check if transcript is already claimed by another session
  const existing = db.prepare(
    'SELECT session_id, session_name FROM session_transcript WHERE resume_session_id = ?'
  ).get(resumeSessionId);

  if (existing) {
    db.prepare(
      'INSERT INTO session_history (session_id, resume_session_id, session_name, action) VALUES (?, ?, ?, ?)'
    ).run(sessionId, resumeSessionId, sessionName || null, 'rejected:conflict_with_' + existing.session_id);

    return {
      ok: false,
      error: `Transcript ${resumeSessionId} already bound to session ${existing.session_id} ("${existing.session_name || ''}")`,
      conflictSession: existing.session_id,
    };
  }

  // Insert-only — once created, never modified
  db.prepare(
    'INSERT INTO session_transcript (session_id, resume_session_id, session_name, first_message, working_dir, conversation_started_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(sessionId, resumeSessionId, sessionName || null, firstMessage || null, workingDir || null, conversationStartedAt || null);

  // Log
  db.prepare(
    'INSERT INTO session_history (session_id, resume_session_id, session_name, action) VALUES (?, ?, ?, ?)'
  ).run(sessionId, resumeSessionId, sessionName || null, 'bind');

  return { ok: true };
}

/**
 * Look up which session owns a transcript.
 * @param {string} resumeSessionId
 * @returns {{ sessionId: string, sessionName: string } | null}
 */
function findOwner(resumeSessionId) {
  const db = getDb();
  const row = db.prepare(
    'SELECT session_id, session_name FROM session_transcript WHERE resume_session_id = ?'
  ).get(resumeSessionId);
  return row ? { sessionId: row.session_id, sessionName: row.session_name } : null;
}

/**
 * Get the transcript UUID for a session.
 * @param {string} sessionId
 * @returns {string | null}
 */
function getTranscript(sessionId) {
  const db = getDb();
  const row = db.prepare(
    'SELECT resume_session_id FROM session_transcript WHERE session_id = ?'
  ).get(sessionId);
  return row ? row.resume_session_id : null;
}

// No unbind/delete — bindings are immutable once created.
// Even if a session is deleted from the UI, the binding stays in the DB
// as a historical record to prevent the transcript from being reclaimed.

/**
 * Read metadata from a Claude JSONL transcript file.
 * Extracts the first user message and conversation start timestamp.
 * @param {string} jsonlPath - Absolute path to the .jsonl file
 * @returns {{ firstMessage: string|null, startedAt: string|null }}
 */
function readJsonlMeta(jsonlPath) {
  const fs = require('fs');
  let firstMessage = null;
  let startedAt = null;
  try {
    const content = fs.readFileSync(jsonlPath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const d = JSON.parse(line);
      // Get timestamp from the first entry
      if (!startedAt && d.timestamp) {
        startedAt = d.timestamp;
      }
      // Get first user message
      if (!firstMessage && d.type === 'user' && d.message && typeof d.message === 'object') {
        const c = d.message.content;
        if (typeof c === 'string' && c.trim()) {
          firstMessage = c.substring(0, 500);
          break;
        } else if (Array.isArray(c)) {
          for (const item of c) {
            if (item && item.type === 'text' && item.text && item.text.trim()) {
              firstMessage = item.text.substring(0, 500);
              break;
            }
          }
          if (firstMessage) break;
        }
      }
    }
  } catch (_) {}
  return { firstMessage, startedAt };
}

/**
 * Backfill first_message and conversation_started_at for existing bindings
 * that are missing this data. Call on startup.
 * @param {string} claudeProjectsDir - Path to ~/.claude/projects/
 */
function backfillMeta(claudeProjectsDir) {
  const fs = require('fs');
  const scanPath = require('path');
  const db = getDb();
  const rows = db.prepare(
    'SELECT session_id, resume_session_id FROM session_transcript WHERE first_message IS NULL OR conversation_started_at IS NULL'
  ).all();
  let filled = 0;
  for (const row of rows) {
    // Find the JSONL file
    try {
      const dirs = fs.readdirSync(claudeProjectsDir);
      for (const d of dirs) {
        const jsonlPath = scanPath.join(claudeProjectsDir, d, row.resume_session_id + '.jsonl');
        if (fs.existsSync(jsonlPath)) {
          const meta = readJsonlMeta(jsonlPath);
          if (meta.firstMessage || meta.startedAt) {
            db.prepare(
              'UPDATE session_transcript SET first_message = COALESCE(first_message, ?), conversation_started_at = COALESCE(conversation_started_at, ?) WHERE session_id = ?'
            ).run(meta.firstMessage, meta.startedAt, row.session_id);
            filled++;
          }
          break;
        }
      }
    } catch (_) {}
  }
  if (filled > 0) console.log(`[SessionDB] Backfilled metadata for ${filled} bindings`);
}

/**
 * Get full history for debugging.
 * @param {number} [limit=50]
 * @returns {Array}
 */
function getHistory(limit = 50) {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM session_history ORDER BY id DESC LIMIT ?'
  ).all(limit);
}

/**
 * Get all current bindings.
 * @returns {Array}
 */
function getAllBindings() {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM session_transcript ORDER BY updated_at DESC'
  ).all();
}

/**
 * Close the DB connection (for clean shutdown).
 */
function close() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/**
 * Update the session name in the DB (for rename sync from UI).
 * @param {string} sessionId
 * @param {string} newName
 */
function updateName(sessionId, newName) {
  const db = getDb();
  db.prepare('UPDATE session_transcript SET session_name = ? WHERE session_id = ?').run(newName, sessionId);
}

module.exports = {
  bindTranscript,
  findOwner,
  getTranscript,
  getHistory,
  getAllBindings,
  readJsonlMeta,
  backfillMeta,
  updateName,
  close,
};
