// One-off helper: if you still have a server/data.json file with existing
// users/quizzes in it (from before this migration to Postgres), run this
// once to copy that data into your new Postgres database.
//
// Usage:
//   1. Make sure DATABASE_URL is set (in .env, or exported in your shell)
//   2. node migrate-json-to-pg.js
//
// Safe to run more than once — existing rows are skipped (ON CONFLICT DO NOTHING).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DATA_PATH = path.join(__dirname, 'data.json');

async function main() {
  if (!fs.existsSync(DATA_PATH)) {
    console.log('No server/data.json found — nothing to migrate.');
    return;
  }
  const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  const users = raw.users || [];
  const quizzes = raw.quizzes || [];

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
      ? { rejectUnauthorized: false }
      : false,
  });

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

  let userCount = 0;
  for (const u of users) {
    const result = await pool.query(
      `INSERT INTO users (id, name, email, password_hash, reset_token_hash, reset_token_expiry, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO NOTHING`,
      [u.id, u.name, u.email, u.passwordHash, u.resetTokenHash || null, u.resetTokenExpiry || null, u.createdAt || new Date().toISOString()]
    );
    if (result.rowCount > 0) userCount += 1;
  }

  let quizCount = 0;
  for (const q of quizzes) {
    const result = await pool.query(
      `INSERT INTO quizzes (id, code, tutor_id, data) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO NOTHING`,
      [q.id, q.code, q.tutorId, q]
    );
    if (result.rowCount > 0) quizCount += 1;
  }

  console.log(`Migrated ${userCount} new user(s) and ${quizCount} new quiz(zes) into Postgres.`);
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
