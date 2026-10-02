// Postgres-backed "database" with an in-memory cache in front of it.
//
// Why the cache? The original JSON-file version kept everything in memory
// and every function was synchronous — server.js (and the socket.io live-quiz
// logic in particular) relies on that: it reads a quiz object, mutates it in
// place, then calls db.saveQuiz(quiz). Making every one of those call sites
// `async`/`await` would have meant rewriting most of server.js.
//
// Instead: on boot we load everything from Postgres into `cache`. All the
// getters read from that cache (still synchronous, nothing else changes).
// All the writers (createUser, updateUser, createQuiz, saveQuiz, deleteQuiz)
// update the cache immediately AND fire an async write to Postgres in the
// background. If a write fails it's logged to the console rather than
// crashing the request — the in-memory state is never out of sync with what
// the user just did, and Postgres is what makes that state survive restarts
// and deploys (unlike the old data.json file, which lived on Render's
// ephemeral disk and was wiped on every redeploy).

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn('[EDxKa] DATABASE_URL is not set. Set it in your .env (local) or Render/host env vars.');
}

const pool = new Pool({
  connectionString,
  // Most managed Postgres providers (Neon, Render, Supabase, etc.) require SSL
  // and use certs that Node won't validate out of the box. Local Postgres
  // (localhost) doesn't need SSL at all.
  ssl: connectionString && !connectionString.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
});

let cache = { users: [], quizzes: [] };
let ready = false;

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      reset_token_hash TEXT,
      reset_token_expiry BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS quizzes (
      id UUID PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      tutor_id UUID REFERENCES users(id) ON DELETE CASCADE,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const { rows: userRows } = await pool.query('SELECT * FROM users ORDER BY created_at ASC');
  cache.users = userRows.map(rowToUser);

  const { rows: quizRows } = await pool.query('SELECT data FROM quizzes ORDER BY updated_at ASC');
  cache.quizzes = quizRows.map((r) => r.data);

  ready = true;
  console.log(`[EDxKa] Postgres ready — loaded ${cache.users.length} user(s) and ${cache.quizzes.length} quiz(zes).`);
}

function rowToUser(r) {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    passwordHash: r.password_hash,
    resetTokenHash: r.reset_token_hash,
    resetTokenExpiry: r.reset_token_expiry !== null && r.reset_token_expiry !== undefined ? Number(r.reset_token_expiry) : null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  };
}

// ---------- Users ----------
function getUserByEmail(email) {
  return cache.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
}

function getUserById(id) {
  return cache.users.find((u) => u.id === id);
}

function createUser(user) {
  cache.users.push(user);
  pool.query(
    `INSERT INTO users (id, name, email, password_hash, reset_token_hash, reset_token_expiry, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO NOTHING`,
    [user.id, user.name, user.email, user.passwordHash, user.resetTokenHash, user.resetTokenExpiry, user.createdAt]
  ).catch((e) => console.error('[EDxKa] Failed to save new user to Postgres:', e.message));
  return user;
}

function updateUser(id, patch) {
  const u = getUserById(id);
  if (!u) return null;
  Object.assign(u, patch);
  pool.query(
    `UPDATE users SET name=$2, email=$3, password_hash=$4, reset_token_hash=$5, reset_token_expiry=$6 WHERE id=$1`,
    [u.id, u.name, u.email, u.passwordHash, u.resetTokenHash, u.resetTokenExpiry]
  ).catch((e) => console.error('[EDxKa] Failed to update user in Postgres:', e.message));
  return u;
}

// ---------- Quizzes ----------
function getQuizzesByTutor(tutorId) {
  return cache.quizzes.filter((q) => q.tutorId === tutorId);
}

function getQuizById(id) {
  return cache.quizzes.find((q) => q.id === id);
}

function getQuizByCode(code) {
  return cache.quizzes.find((q) => q.code.toUpperCase() === code.toUpperCase());
}

function createQuiz(quiz) {
  cache.quizzes.push(quiz);
  pool.query(
    `INSERT INTO quizzes (id, code, tutor_id, data) VALUES ($1,$2,$3,$4)
     ON CONFLICT (id) DO NOTHING`,
    [quiz.id, quiz.code, quiz.tutorId, quiz]
  ).catch((e) => console.error('[EDxKa] Failed to save new quiz to Postgres:', e.message));
  return quiz;
}

function saveQuiz(quiz) {
  // Called after mutating a quiz object obtained via getQuizById/getQuizByCode.
  // `quiz` is the same object reference stored in `cache.quizzes`, so the
  // in-memory cache is already up to date — this just writes that snapshot
  // through to Postgres so it isn't lost if the server restarts or redeploys.
  if (!quiz) return;
  pool.query(
    `UPDATE quizzes SET data = $2, updated_at = now() WHERE id = $1`,
    [quiz.id, quiz]
  ).catch((e) => console.error('[EDxKa] Failed to save quiz to Postgres:', e.message));
}

function deleteQuiz(id) {
  cache.quizzes = cache.quizzes.filter((q) => q.id !== id);
  pool.query('DELETE FROM quizzes WHERE id = $1', [id])
    .catch((e) => console.error('[EDxKa] Failed to delete quiz in Postgres:', e.message));
}

// ---------- Admin helpers ----------
// Tutors (people who created an account) — this is "registered users" in the
// account sense.
function adminUsers() {
  return cache.users
    .map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      createdAt: u.createdAt,
      quizCount: cache.quizzes.filter((q) => q.tutorId === u.id).length,
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// Students — they don't create accounts, they just join a quiz with a name +
// phone number, so this flattens that out of every quiz into one list.
function adminParticipants() {
  const rows = [];
  cache.quizzes.forEach((q) => {
    (q.participants || []).forEach((p) => {
      rows.push({
        name: p.name,
        phone: p.phone,
        avatar: p.avatar || '🙂',
        score: p.score,
        totalTimeMs: p.totalTimeMs,
        quizTitle: q.title,
        quizCode: q.code,
        tutorId: q.tutorId,
        joinedAt: p.joinedAt ? new Date(p.joinedAt).toISOString() : null,
      });
    });
  });
  rows.sort((a, b) => new Date(b.joinedAt) - new Date(a.joinedAt));
  return rows;
}

module.exports = {
  init,
  isReady: () => ready,
  getUserByEmail,
  getUserById,
  createUser,
  updateUser,
  getQuizzesByTutor,
  getQuizById,
  getQuizByCode,
  createQuiz,
  saveQuiz,
  deleteQuiz,
  adminUsers,
  adminParticipants,
};
