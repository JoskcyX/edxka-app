require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const { Server } = require('socket.io');

const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const APP_NAME = 'EDxKa';
const FRONTEND_URL = process.env.FRONTEND_URL || `http://localhost:${PORT}`;
const IS_PROD = process.env.NODE_ENV === 'production';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || null;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------------------
// Health check — used by Docker, EC2, load balancers, and monitoring
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'edxka-server'
  });
});

// ---------------------------------------------------------------------------
// Mail transporter (used for the "forgot password" flow)
// ---------------------------------------------------------------------------
let transporter = null;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
}

async function sendResetEmail(toEmail, resetLink) {
  const subject = `Reset your ${APP_NAME} password`;
  const text = `We got a request to reset your ${APP_NAME} password.\n\nReset it here (valid for 1 hour):\n${resetLink}\n\nIf you didn't ask for this, you can ignore this email.`;
  const html = `
    <div style="font-family: Nunito, Arial, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:#0f1b2b;">Reset your ${APP_NAME} password</h2>
      <p>We got a request to reset the password on your ${APP_NAME} tutor account.</p>
      <p><a href="${resetLink}" style="background:#ff6a3d;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:700;display:inline-block;">Reset password</a></p>
      <p style="color:#666;font-size:13px;">This link expires in 1 hour. If you didn't request it, you can safely ignore this email.</p>
      <p style="color:#999;font-size:12px;word-break:break-all;">${resetLink}</p>
    </div>`;

  if (transporter) {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || `"${APP_NAME}" <no-reply@edxka.app>`,
      to: toEmail,
      subject,
      text,
      html,
    });
    return { sent: true };
  }

  // No SMTP configured (e.g. local dev). Log the link so the flow is still
  // testable end-to-end, and hand it back in the API response in non-prod.
  console.log(`\n[EDxKa] SMTP not configured — password reset link for ${toEmail}:\n${resetLink}\n`);
  return { sent: false, link: resetLink };
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
function signToken(user) {
  return jwt.sign({ uid: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Sign in required.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.uid;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Your session expired. Please sign in again.' });
  }
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email };
}

// ---------------------------------------------------------------------------
// Admin auth — simple HTTP Basic auth gate in front of the admin page + API.
// Set ADMIN_USER / ADMIN_PASS as env vars (never commit real values).
// ---------------------------------------------------------------------------
function adminAuthRequired(req, res, next) {
  if (!ADMIN_PASS) {
    return res.status(500).send('Admin access is not configured. Set ADMIN_PASS in your environment.');
  }
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, pass] = Buffer.from(encoded, 'base64').toString('utf-8').split(':');
    if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="EDxKa Admin"');
  return res.status(401).send('Authentication required.');
}

function makeQuizCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I for readability
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (db.getQuizByCode(code));
  return code;
}

function publicQuiz(q, { includeAnswers = false } = {}) {
  return {
    id: q.id,
    code: q.code,
    title: q.title,
    subject: q.subject || '',
    type: q.type || 'sync',
    status: q.status,
    asyncDurationSec: q.asyncDurationSec || 300,
    createdAt: q.createdAt,
    currentQuestionIndex: q.currentQuestionIndex,
    practiceStats: q.practiceStats || { attempts: 0, avgScorePct: null },
    questions: q.questions.map((qq) => ({
      id: qq.id,
      type: qq.type,
      text: qq.text,
      options: qq.options,
      items: qq.items,
      imageUrl: qq.imageUrl || '',
      topic: qq.topic || '',
      timeLimit: qq.timeLimit,
      tolerance: qq.tolerance,
      ...(includeAnswers ? { correctAnswer: qq.correctAnswer } : {}),
    })),
    participants: q.participants.map((p) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar || '🙂',
      phone: includeAnswers ? p.phone : undefined,
      score: p.score,
      totalTimeMs: p.totalTimeMs,
      bestStreak: p.bestStreak || 0,
      answered: p.answers.length,
    })),
  };
}

function leaderboardFor(q) {
  return [...q.participants]
    .sort((a, b) => (b.score - a.score) || (a.totalTimeMs - b.totalTimeMs))
    .map((p, i) => ({
      rank: i + 1,
      id: p.id,
      name: p.name,
      avatar: p.avatar || '🙂',
      score: p.score,
      totalTimeMs: p.totalTimeMs,
      bestStreak: p.bestStreak || 0,
      currentStreak: p.currentStreak || 0,
      badges: p.badges || [],
    }));
}

// ---- Badges, awarded once a quiz finishes -----------------------------
function computeBadges(quiz) {
  const totalQ = quiz.questions.length;
  if (totalQ === 0) return;
  const participants = quiz.participants;
  if (participants.length === 0) return;

  // Fastest average time among participants with a perfect or near-perfect run
  let speedAngelId = null;
  let bestAvgTime = Infinity;
  participants.forEach((p) => {
    if (p.answers.length === 0) return;
    const avg = p.totalTimeMs / p.answers.length;
    if (avg < bestAvgTime) { bestAvgTime = avg; speedAngelId = p.id; }
  });

  participants.forEach((p) => {
    p.badges = [];
    if (p.answers.length === totalQ && p.score === totalQ) p.badges.push({ id: 'perfect', icon: 'star', label: 'Perfect score' });
    if (p.id === speedAngelId && p.answers.length > 0) p.badges.push({ id: 'speed', icon: 'zap', label: 'Speed angel' });
    if ((p.bestStreak || 0) >= 3) p.badges.push({ id: 'streak', icon: 'flame', label: `${p.bestStreak}-streak` });
    if (p.answers.length >= Math.ceil(totalQ / 2)) {
      const half = Math.floor(p.answers.length / 2);
      const firstHalfCorrect = p.answers.slice(0, half).filter((a) => a.correct).length;
      const secondHalfCorrect = p.answers.slice(half).filter((a) => a.correct).length;
      if (half > 0 && secondHalfCorrect > firstHalfCorrect) p.badges.push({ id: 'comeback', icon: 'trending-up', label: 'Comeback kid' });
    }
  });
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------
app.post('/api/auth/signup', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email and password are all required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (db.getUserByEmail(email)) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }
  const user = db.createUser({
    id: uuidv4(),
    name,
    email,
    passwordHash: bcrypt.hashSync(password, 10),
    resetTokenHash: null,
    resetTokenExpiry: null,
    createdAt: new Date().toISOString(),
  });
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.post('/api/auth/signin', (req, res) => {
  const { email, password } = req.body || {};
  const user = email && db.getUserByEmail(email);
  if (!user || !bcrypt.compareSync(password || '', user.passwordHash)) {
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.get('/api/auth/me', authRequired, (req, res) => {
  const user = db.getUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ user: publicUser(user) });
});

// ---- Forgot / reset password ----------------------------------------------
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  const genericMsg = { message: 'If an account exists for that email, a reset link is on its way.' };
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  const user = db.getUserByEmail(email);
  if (!user) {
    // Don't reveal whether the account exists.
    return res.json(genericMsg);
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  db.updateUser(user.id, {
    resetTokenHash: bcrypt.hashSync(rawToken, 10),
    resetTokenExpiry: Date.now() + 60 * 60 * 1000, // 1 hour
  });

  const resetLink = `${FRONTEND_URL}/reset-password.html?uid=${user.id}&token=${rawToken}`;

  try {
    const result = await sendResetEmail(user.email, resetLink);
    if (!result.sent && !IS_PROD) {
      // Dev convenience only — never do this in production.
      return res.json({ ...genericMsg, devResetLink: result.link });
    }
    return res.json(genericMsg);
  } catch (e) {
    console.error('Failed to send reset email:', e.message);
    return res.status(500).json({ error: 'Could not send the reset email. Please try again shortly.' });
  }
});

app.post('/api/auth/reset-password', (req, res) => {
  const { uid, token, newPassword } = req.body || {};
  if (!uid || !token || !newPassword) {
    return res.status(400).json({ error: 'Missing reset details.' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  const user = db.getUserById(uid);
  if (!user || !user.resetTokenHash || !user.resetTokenExpiry) {
    return res.status(400).json({ error: 'This reset link is invalid. Request a new one.' });
  }
  if (Date.now() > user.resetTokenExpiry) {
    return res.status(400).json({ error: 'This reset link has expired. Request a new one.' });
  }
  if (!bcrypt.compareSync(token, user.resetTokenHash)) {
    return res.status(400).json({ error: 'This reset link is invalid. Request a new one.' });
  }
  db.updateUser(user.id, {
    passwordHash: bcrypt.hashSync(newPassword, 10),
    resetTokenHash: null,
    resetTokenExpiry: null,
  });
  res.json({ message: 'Password updated. You can sign in now.' });
});

// ---------------------------------------------------------------------------
// Admin — view registered tutors and students who've joined a quiz.
// Protected by HTTP Basic auth (ADMIN_USER / ADMIN_PASS env vars), separate
// from tutor sign-in.
// ---------------------------------------------------------------------------
app.get('/admin', adminAuthRequired, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

app.get('/api/admin/users', adminAuthRequired, (req, res) => {
  res.json({ users: db.adminUsers() });
});

app.get('/api/admin/participants', adminAuthRequired, (req, res) => {
  res.json({ participants: db.adminParticipants() });
});

// ---------------------------------------------------------------------------
// Quiz routes (tutor, authenticated)
// ---------------------------------------------------------------------------
app.get('/api/quizzes', authRequired, (req, res) => {
  const quizzes = db.getQuizzesByTutor(req.userId).map((q) => publicQuiz(q, { includeAnswers: true }));
  res.json({ quizzes });
});

app.post('/api/quizzes', authRequired, (req, res) => {
  const { title, subject, type } = req.body || {};
  const quizType = type === 'async' ? 'async' : 'sync';
  const quiz = db.createQuiz({
    id: uuidv4(),
    code: makeQuizCode(),
    tutorId: req.userId,
    title: title || 'Untitled quiz',
    subject: subject || '',
    type: quizType,
    // sync quizzes: draft -> lobby -> live -> finished
    // async quizzes: draft -> open -> closed
    status: 'draft',
    asyncDurationSec: 300, // default 5 minutes, tutor can change before publishing
    questions: [],
    participants: [],
    currentQuestionIndex: -1,
    questionStartedAt: null,
    practiceStats: { attempts: 0, scoreSum: 0, questionSum: 0, avgScorePct: null },
    createdAt: new Date().toISOString(),
  });
  res.json({ quiz: publicQuiz(quiz, { includeAnswers: true }) });
});

function requireOwnedQuiz(req, res, next) {
  const quiz = db.getQuizById(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found.' });
  if (quiz.tutorId !== req.userId) return res.status(403).json({ error: 'Not your quiz.' });
  req.quiz = quiz;
  next();
}

app.get('/api/quizzes/:id', authRequired, requireOwnedQuiz, (req, res) => {
  res.json({ quiz: publicQuiz(req.quiz, { includeAnswers: true }) });
});

app.put('/api/quizzes/:id', authRequired, requireOwnedQuiz, (req, res) => {
  const { title, subject } = req.body || {};
  if (title !== undefined) req.quiz.title = title;
  if (subject !== undefined) req.quiz.subject = subject;
  db.saveQuiz(req.quiz);
  res.json({ quiz: publicQuiz(req.quiz, { includeAnswers: true }) });
});

const QUESTION_TYPES = ['mcq', 'truefalse', 'typed', 'numeric', 'ordering'];

// Validates + normalizes one question's raw input into a stored question
// object. Shared by the single-question and bulk-import endpoints so both
// enforce identical rules. Returns { question } or { error }.
function buildQuestion(input) {
  const { type, text, options, items, correctAnswer, timeLimit, imageUrl, topic, tolerance } = input || {};
  if (!type || !QUESTION_TYPES.includes(type) || !text) {
    return { error: 'Question needs a valid type and text.' };
  }

  const question = {
    id: uuidv4(),
    type,
    text,
    imageUrl: imageUrl || '',
    topic: topic || '',
    timeLimit: Number(timeLimit) > 0 ? Number(timeLimit) : 20,
    options: [],
    items: undefined,
    correctAnswer: '',
  };

  if (type === 'mcq') {
    const opts = (options || []).map((o) => String(o).trim()).filter(Boolean);
    if (opts.length < 2) return { error: 'Add at least two options.' };
    if (!correctAnswer || !opts.includes(String(correctAnswer))) {
      return { error: 'Correct answer must match one option exactly.' };
    }
    question.options = opts;
    question.correctAnswer = String(correctAnswer);
  } else if (type === 'truefalse') {
    if (!['true', 'false'].includes(String(correctAnswer || '').toLowerCase())) {
      return { error: 'Correct answer must be True or False.' };
    }
    question.options = ['True', 'False'];
    question.correctAnswer = String(correctAnswer);
  } else if (type === 'typed') {
    // Accept several acceptable answers separated by "|" (fill-in-the-blank friendly)
    if (!correctAnswer) return { error: 'Add at least one accepted answer.' };
    question.correctAnswer = String(correctAnswer);
  } else if (type === 'numeric') {
    if (correctAnswer === undefined || correctAnswer === '' || isNaN(Number(correctAnswer))) {
      return { error: 'Correct answer must be a number.' };
    }
    question.correctAnswer = String(Number(correctAnswer));
    question.tolerance = Number(tolerance) >= 0 ? Number(tolerance) : 0;
  } else if (type === 'ordering') {
    const list = (items || []).map((o) => String(o).trim()).filter(Boolean);
    if (list.length < 2) return { error: 'Add at least two items to order.' };
    question.items = list; // canonical correct order is exactly this list
    question.correctAnswer = list.join('|');
  }

  return { question };
}

app.post('/api/quizzes/:id/questions', authRequired, requireOwnedQuiz, (req, res) => {
  if (req.quiz.status !== 'draft') {
    return res.status(400).json({ error: 'Stop the session before editing questions.' });
  }
  const result = buildQuestion(req.body);
  if (result.error) return res.status(400).json({ error: result.error });

  req.quiz.questions.push(result.question);
  db.saveQuiz(req.quiz);
  res.json({ quiz: publicQuiz(req.quiz, { includeAnswers: true }) });
});

// Bulk import: adds many questions in one request (used by the "Bulk import" modal).
app.post('/api/quizzes/:id/questions/bulk', authRequired, requireOwnedQuiz, (req, res) => {
  if (req.quiz.status !== 'draft') {
    return res.status(400).json({ error: 'Stop the session before editing questions.' });
  }
  const { questions } = req.body || {};
  if (!Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'No questions to add.' });
  }

  const built = [];
  for (let i = 0; i < questions.length; i++) {
    const result = buildQuestion(questions[i]);
    if (result.error) {
      return res.status(400).json({ error: `Question ${i + 1}: ${result.error}` });
    }
    built.push(result.question);
  }

  req.quiz.questions.push(...built);
  db.saveQuiz(req.quiz);
  res.json({ quiz: publicQuiz(req.quiz, { includeAnswers: true }) });
});

app.delete('/api/quizzes/:id/questions/:qid', authRequired, requireOwnedQuiz, (req, res) => {
  req.quiz.questions = req.quiz.questions.filter((q) => q.id !== req.params.qid);
  db.saveQuiz(req.quiz);
  res.json({ quiz: publicQuiz(req.quiz, { includeAnswers: true }) });
});

app.delete('/api/quizzes/:id', authRequired, requireOwnedQuiz, (req, res) => {
  db.deleteQuiz(req.quiz.id);
  res.json({ message: 'Quiz deleted.' });
});

// Public: minimal info so a student can see a title before joining
app.get('/api/quizzes/by-code/:code', (req, res) => {
  const quiz = db.getQuizByCode(req.params.code);
  if (!quiz) return res.status(404).json({ error: 'No quiz found with that code.' });
  res.json({ title: quiz.title, status: quiz.status, code: quiz.code });
});

// ---- Practice mode: solo, self-paced, no lobby, no login required ---------
app.get('/api/quizzes/by-code/:code/practice', (req, res) => {
  const quiz = db.getQuizByCode(req.params.code);
  if (!quiz) return res.status(404).json({ error: 'No quiz found with that code.' });
  if (quiz.questions.length === 0) {
    return res.status(400).json({ error: 'This quiz has no questions yet.' });
  }
  res.json({
    title: quiz.title,
    subject: quiz.subject || '',
    questions: quiz.questions.map((q) => ({
      id: q.id,
      type: q.type,
      text: q.text,
      options: q.options,
      items: q.type === 'ordering' ? shuffle(q.items) : undefined,
      imageUrl: q.imageUrl || '',
      topic: q.topic || '',
      timeLimit: q.timeLimit,
    })),
  });
});

app.post('/api/quizzes/by-code/:code/practice/submit', (req, res) => {
  const quiz = db.getQuizByCode(req.params.code);
  if (!quiz) return res.status(404).json({ error: 'No quiz found with that code.' });
  const { answers } = req.body || {}; // [{ questionId, answer }]
  if (!Array.isArray(answers)) return res.status(400).json({ error: 'Answers must be a list.' });

  const results = answers.map(({ questionId, answer }) => {
    const q = quiz.questions.find((qq) => qq.id === questionId);
    if (!q) return { questionId, correct: false, correctAnswer: null };
    return {
      questionId,
      correct: gradeAnswer(q, answer),
      correctAnswer: q.type === 'ordering' ? q.items : q.correctAnswer.split('|')[0],
    };
  });
  const score = results.filter((r) => r.correct).length;

  quiz.practiceStats = quiz.practiceStats || { attempts: 0, scoreSum: 0, questionSum: 0, avgScorePct: null };
  quiz.practiceStats.attempts += 1;
  quiz.practiceStats.scoreSum += score;
  quiz.practiceStats.questionSum += results.length;
  quiz.practiceStats.avgScorePct = quiz.practiceStats.questionSum > 0
    ? Math.round((quiz.practiceStats.scoreSum / quiz.practiceStats.questionSum) * 100)
    : null;
  db.saveQuiz(quiz);

  res.json({ score, total: results.length, results });
});

function shuffle(arr) {
  const a = [...(arr || [])];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// Async ("assign-and-collect") quizzes.
//
// Unlike the live/synchronous mode, nobody has to be online at the same
// time. The tutor sets a fixed time limit (e.g. 5 minutes), publishes the
// quiz, and shares the link. Each student who opens it gets that same fixed
// window, starting from the moment *they* begin — not a shared countdown.
// Answers are graded and stored as ordinary participants, so the existing
// leaderboard, tutor analytics, and CSV export all work without changes.
// ---------------------------------------------------------------------------
const ASYNC_SUBMIT_GRACE_MS = 15 * 1000; // network/latency slack past the deadline

app.post('/api/quizzes/:id/async-settings', authRequired, requireOwnedQuiz, (req, res) => {
  if (req.quiz.type !== 'async') return res.status(400).json({ error: 'Not an async quiz.' });
  if (req.quiz.status !== 'draft') return res.status(400).json({ error: 'Close or reset the quiz before changing its time limit.' });
  const minutes = Number((req.body || {}).minutes);
  if (!minutes || minutes <= 0 || minutes > 180) {
    return res.status(400).json({ error: 'Time limit must be between 1 and 180 minutes.' });
  }
  req.quiz.asyncDurationSec = Math.round(minutes * 60);
  db.saveQuiz(req.quiz);
  res.json({ quiz: publicQuiz(req.quiz, { includeAnswers: true }) });
});

app.post('/api/quizzes/:id/async/publish', authRequired, requireOwnedQuiz, (req, res) => {
  if (req.quiz.type !== 'async') return res.status(400).json({ error: 'Not an async quiz.' });
  if (req.quiz.questions.length === 0) {
    return res.status(400).json({ error: 'Add at least one question before publishing.' });
  }
  if (req.quiz.status !== 'draft') {
    return res.status(400).json({ error: 'This quiz is already published.' });
  }
  req.quiz.status = 'open';
  db.saveQuiz(req.quiz);
  res.json({ quiz: publicQuiz(req.quiz, { includeAnswers: true }) });
});

app.post('/api/quizzes/:id/async/close', authRequired, requireOwnedQuiz, (req, res) => {
  if (req.quiz.type !== 'async') return res.status(400).json({ error: 'This quiz is not open right now.' });
  if (req.quiz.status !== 'open') return res.status(400).json({ error: 'This quiz is not open right now.' });
  req.quiz.status = 'closed';
  computeBadges(req.quiz);
  db.saveQuiz(req.quiz);
  res.json({ quiz: publicQuiz(req.quiz, { includeAnswers: true }) });
});

app.post('/api/quizzes/:id/async/reopen', authRequired, requireOwnedQuiz, (req, res) => {
  if (req.quiz.type !== 'async') return res.status(400).json({ error: 'Not an async quiz.' });
  if (req.quiz.status !== 'closed') return res.status(400).json({ error: 'This quiz is not closed.' });
  req.quiz.status = 'open';
  db.saveQuiz(req.quiz);
  res.json({ quiz: publicQuiz(req.quiz, { includeAnswers: true }) });
});

// Public: minimal info a student needs before starting (no auth, no answers)
app.get('/api/quizzes/by-code/:code/async', (req, res) => {
  const quiz = db.getQuizByCode(req.params.code);
  if (!quiz || quiz.type !== 'async') return res.status(404).json({ error: 'No async quiz found with that code.' });
  res.json({
    title: quiz.title,
    subject: quiz.subject || '',
    status: quiz.status, // draft | open | closed
    durationSec: quiz.asyncDurationSec || 300,
    questionCount: quiz.questions.length,
  });
});

// Public: register (or resume) as a student and receive the question set
// plus a server-authoritative deadline. Calling this again with the same
// name/phone (or a remembered participantId) resumes the SAME deadline
// instead of resetting the clock — covers refreshes and flaky connections.
app.post('/api/quizzes/by-code/:code/async/start', (req, res) => {
  const quiz = db.getQuizByCode(req.params.code);
  if (!quiz || quiz.type !== 'async') return res.status(404).json({ error: 'No async quiz found with that code.' });
  if (quiz.status !== 'open') return res.status(400).json({ error: 'This quiz is not open right now.' });

  const { name, phone, participantId: savedParticipantId } = req.body || {};
  if ((!name || !phone) && !savedParticipantId) {
    return res.status(400).json({ error: 'Name and phone number are required.' });
  }

  let participant = savedParticipantId
    ? quiz.participants.find((p) => p.id === savedParticipantId)
    : null;
  if (!participant && name && phone) {
    participant = quiz.participants.find((p) => p.phone.toLowerCase() === String(phone).trim().toLowerCase());
  }

  if (participant && participant.asyncSubmittedAt) {
    return res.status(400).json({ error: 'You already completed this quiz.' });
  }

  const durationSec = quiz.asyncDurationSec || 300;

  if (!participant) {
    if (!name || !phone) return res.status(400).json({ error: 'Name and phone number are required.' });
    participant = {
      id: uuidv4(),
      name: String(name).trim(),
      phone: String(phone).trim(),
      avatar: '🙂',
      answers: [],
      score: 0,
      totalTimeMs: 0,
      currentStreak: 0,
      bestStreak: 0,
      badges: [],
      connected: true,
      joinedAt: Date.now(),
      asyncStartedAt: Date.now(),
      asyncDeadline: Date.now() + durationSec * 1000,
      asyncSubmittedAt: null,
    };
    quiz.participants.push(participant);
  } else if (!participant.asyncStartedAt) {
    // Resumed by participantId/phone before ever actually starting (shouldn't
    // normally happen, but keep it safe).
    participant.asyncStartedAt = Date.now();
    participant.asyncDeadline = Date.now() + durationSec * 1000;
  }
  // else: already in progress — hand back the SAME deadline, don't reset it.

  db.saveQuiz(quiz);

  res.json({
    participantId: participant.id,
    startedAt: participant.asyncStartedAt,
    deadline: participant.asyncDeadline,
    durationSec,
    title: quiz.title,
    subject: quiz.subject || '',
    questions: quiz.questions.map((q) => ({
      id: q.id,
      type: q.type,
      text: q.text,
      options: q.options,
      items: q.type === 'ordering' ? shuffle(q.items) : undefined,
      imageUrl: q.imageUrl || '',
      topic: q.topic || '',
    })),
  });
});

app.post('/api/quizzes/by-code/:code/async/submit', (req, res) => {
  const quiz = db.getQuizByCode(req.params.code);
  if (!quiz || quiz.type !== 'async') return res.status(404).json({ error: 'No async quiz found with that code.' });

  const { participantId, answers } = req.body || {};
  const participant = quiz.participants.find((p) => p.id === participantId);
  if (!participant) return res.status(404).json({ error: 'We could not find your session for this quiz. Please start again.' });
  if (participant.asyncSubmittedAt) return res.status(400).json({ error: 'You already submitted this quiz.' });
  if (!Array.isArray(answers)) return res.status(400).json({ error: 'Answers must be a list.' });

  const now = Date.now();
  if (participant.asyncDeadline && now > participant.asyncDeadline + ASYNC_SUBMIT_GRACE_MS) {
    return res.status(400).json({ error: 'Time is up — this submission arrived too late to be graded.' });
  }

  const elapsedMs = Math.max(0, now - (participant.asyncStartedAt || now));
  const results = answers.map(({ questionId, answer }) => {
    const q = quiz.questions.find((qq) => qq.id === questionId);
    if (!q) return { questionId, correct: false, correctAnswer: null };
    const correct = gradeAnswer(q, answer);
    participant.answers.push({ questionId, answer, correct, elapsedMs: Math.round(elapsedMs / Math.max(1, answers.length)) });
    return {
      questionId,
      correct,
      correctAnswer: q.type === 'ordering' ? q.items : q.correctAnswer.split('|')[0],
    };
  });

  participant.score = participant.answers.filter((a) => a.correct).length;
  participant.totalTimeMs = elapsedMs;
  participant.asyncSubmittedAt = now;
  db.saveQuiz(quiz);

  res.json({ score: participant.score, total: quiz.questions.length, results });
});

// ---- Session control (also mirrored over sockets for the live audience) ---
const questionTimers = new Map(); // quizId -> Timeout

// A participant who drops their socket (tab switched away, phone locked,
// flaky wifi) gets this long to come back before we drop their lobby spot.
// This is what actually fixes "ghost" duplicate profiles: instead of every
// reconnect creating a brand-new participant, join-lobby below re-attaches
// to the existing one, and this timer clears out people who genuinely left.
const LOBBY_DISCONNECT_GRACE_MS = 20 * 1000;
const lobbyRemovalTimers = new Map(); // participantId -> Timeout

function clearQuizTimer(quizId) {
  const t = questionTimers.get(quizId);
  if (t) clearTimeout(t);
  questionTimers.delete(quizId);
}

function broadcastLobby(quiz) {
  // Only show participants whose socket is currently attached. Someone who
  // stepped away is hidden immediately (so the headcount stays accurate)
  // but their record — and score, once the quiz is live — isn't deleted
  // until the grace-period timer below confirms they're really gone.
  const visible = quiz.participants.filter((p) => p.connected !== false);
  io.to(`quiz:${quiz.code}`).emit('lobby-update', {
    participants: visible.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar || '🙂' })),
    status: quiz.status,
  });
}

function broadcastLeaderboard(quiz) {
  io.to(`quiz:${quiz.code}`).emit('leaderboard-update', { leaderboard: leaderboardFor(quiz) });
}

// ---- Live "who's answered" snapshot, for the tutor's monitor pane --------
// `total` is every registered participant (not just currently-connected
// ones) so a student who drops off mid-quiz still counts — the tutor
// shouldn't have to guess whether "8 of 10 answered" means 2 are stuck or
// 2 simply aren't in the room anymore.
function answerProgressFor(quiz) {
  const question = quiz.questions[quiz.currentQuestionIndex] || null;
  const students = quiz.participants.map((p) => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar || '🙂',
    connected: p.connected !== false,
    answered: question ? p.answers.some((a) => a.questionId === question.id) : false,
  }));
  return {
    total: students.length,
    answeredCount: students.filter((s) => s.answered).length,
    question: question
      ? { id: question.id, index: quiz.currentQuestionIndex, total: quiz.questions.length, text: question.text }
      : null,
    students,
  };
}

function broadcastAnswerProgress(quiz) {
  io.to(`quiz:${quiz.code}`).emit('answer-progress', answerProgressFor(quiz));
}

function advanceQuestion(quizId) {
  const quiz = db.getQuizById(quizId);
  if (!quiz || quiz.status !== 'live') return;
  const nextIndex = quiz.currentQuestionIndex + 1;
  if (nextIndex >= quiz.questions.length) {
    quiz.status = 'finished';
    quiz.currentQuestionIndex = quiz.questions.length;
    computeBadges(quiz);
    db.saveQuiz(quiz);
    clearQuizTimer(quiz.id);
    io.to(`quiz:${quiz.code}`).emit('quiz-end', { leaderboard: leaderboardFor(quiz) });
    return;
  }
  quiz.currentQuestionIndex = nextIndex;
  quiz.questionStartedAt = Date.now();
  db.saveQuiz(quiz);
  const q = quiz.questions[nextIndex];
  io.to(`quiz:${quiz.code}`).emit('question-start', {
    index: nextIndex,
    total: quiz.questions.length,
    question: { id: q.id, type: q.type, text: q.text, options: q.options, timeLimit: q.timeLimit },
    startedAt: quiz.questionStartedAt,
  });
  broadcastAnswerProgress(quiz);
  clearQuizTimer(quiz.id);
  questionTimers.set(
    quiz.id,
    setTimeout(() => advanceQuestion(quiz.id), q.timeLimit * 1000)
  );
}

app.post('/api/quizzes/:id/open-lobby', authRequired, requireOwnedQuiz, (req, res) => {
  if (req.quiz.type !== 'sync') return res.status(400).json({ error: 'This is an async quiz — use Publish instead.' });
  if (req.quiz.questions.length === 0) {
    return res.status(400).json({ error: 'Add at least one question before opening the lobby.' });
  }
  req.quiz.status = 'lobby';
  db.saveQuiz(req.quiz);
  broadcastLobby(req.quiz);
  res.json({ quiz: publicQuiz(req.quiz, { includeAnswers: true }) });
});

app.post('/api/quizzes/:id/start', authRequired, requireOwnedQuiz, (req, res) => {
  if (req.quiz.status !== 'lobby') {
    return res.status(400).json({ error: 'Open the lobby before starting the quiz.' });
  }
  req.quiz.status = 'live';
  req.quiz.currentQuestionIndex = -1;
  db.saveQuiz(req.quiz);
  advanceQuestion(req.quiz.id);
  res.json({ quiz: publicQuiz(req.quiz, { includeAnswers: true }) });
});

// The tutor can move on at any time — some students go quiet mid-quiz
// (lost connection, closed the tab, whatever) and waiting on them forever
// would stall the whole class. This is intentionally NOT gated on
// everyone having answered.
app.post('/api/quizzes/:id/skip-question', authRequired, requireOwnedQuiz, (req, res) => {
  if (req.quiz.status !== 'live') {
    return res.status(400).json({ error: 'The quiz is not live right now.' });
  }
  advanceQuestion(req.quiz.id);
  res.json({ quiz: publicQuiz(req.quiz, { includeAnswers: true }) });
});

app.post('/api/quizzes/:id/end', authRequired, requireOwnedQuiz, (req, res) => {
  clearQuizTimer(req.quiz.id);
  req.quiz.status = 'finished';
  computeBadges(req.quiz);
  db.saveQuiz(req.quiz);
  io.to(`quiz:${req.quiz.code}`).emit('quiz-end', { leaderboard: leaderboardFor(req.quiz) });
  res.json({ quiz: publicQuiz(req.quiz, { includeAnswers: true }) });
});

// ---- Tutor analytics: per-question accuracy + weakest topics --------------
app.get('/api/quizzes/:id/stats', authRequired, requireOwnedQuiz, (req, res) => {
  const quiz = req.quiz;
  const totalParticipants = quiz.participants.length;
  const perQuestion = quiz.questions.map((q) => {
    let correctCount = 0;
    let answeredCount = 0;
    let timeSum = 0;
    quiz.participants.forEach((p) => {
      const a = p.answers.find((ans) => ans.questionId === q.id);
      if (a) {
        answeredCount += 1;
        timeSum += a.elapsedMs;
        if (a.correct) correctCount += 1;
      }
    });
    return {
      id: q.id,
      text: q.text,
      topic: q.topic || 'General',
      answeredCount,
      correctCount,
      accuracy: answeredCount > 0 ? Math.round((correctCount / answeredCount) * 100) : null,
      avgTimeMs: answeredCount > 0 ? Math.round(timeSum / answeredCount) : null,
    };
  });

  const topicMap = {};
  perQuestion.forEach((q) => {
    if (q.accuracy === null) return;
    const key = q.topic || 'General';
    if (!topicMap[key]) topicMap[key] = { topic: key, correctSum: 0, answeredSum: 0 };
    topicMap[key].correctSum += q.correctCount;
    topicMap[key].answeredSum += q.answeredCount;
  });
  const topicBreakdown = Object.values(topicMap)
    .map((t) => ({ topic: t.topic, accuracy: t.answeredSum > 0 ? Math.round((t.correctSum / t.answeredSum) * 100) : null }))
    .sort((a, b) => (a.accuracy ?? 100) - (b.accuracy ?? 100));

  res.json({ totalParticipants, perQuestion, topicBreakdown, practiceStats: quiz.practiceStats || null });
});

// ---- Downloadable results (CSV) --------------------------------------
function csvEscape(value) {
  const s = value === undefined || value === null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function formatAnswerForCsv(answer) {
  if (Array.isArray(answer)) return answer.join(' → ');
  return String(answer === undefined || answer === null ? '' : answer);
}

app.get('/api/quizzes/:id/results.csv', authRequired, requireOwnedQuiz, (req, res) => {
  const quiz = req.quiz;
  const totalQuestions = quiz.questions.length;
  const rows = leaderboardFor(quiz);

  const header = [
    'Rank', 'Name', 'Phone', 'Score', 'Total questions', 'Accuracy %',
    'Total time (s)', 'Best streak', 'Badges',
  ];
  quiz.questions.forEach((q, i) => header.push(`Q${i + 1}: ${q.text}`));

  const lines = [header.map(csvEscape).join(',')];
  rows.forEach((r) => {
    const participant = quiz.participants.find((p) => p.id === r.id);
    const accuracy = totalQuestions > 0 ? Math.round((r.score / totalQuestions) * 100) : 0;
    const badgesStr = (r.badges || []).map((b) => b.label).join('; ');
    const row = [
      r.rank, r.name, participant ? participant.phone : '', r.score, totalQuestions,
      accuracy, (r.totalTimeMs / 1000).toFixed(1), r.bestStreak, badgesStr,
    ];
    quiz.questions.forEach((q) => {
      const a = participant ? participant.answers.find((ans) => ans.questionId === q.id) : null;
      row.push(a ? `${formatAnswerForCsv(a.answer)} (${a.correct ? 'correct' : 'incorrect'})` : 'No answer');
    });
    lines.push(row.map(csvEscape).join(','));
  });

  const filename = `${(quiz.title || 'quiz').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-results.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // Leading BOM so Excel opens UTF-8 (accented names, etc.) correctly.
  res.send('\uFEFF' + lines.join('\r\n'));
});

app.post('/api/quizzes/:id/reset', authRequired, requireOwnedQuiz, (req, res) => {
  // Back to draft so the tutor can edit questions and run it again.
  clearQuizTimer(req.quiz.id);
  if (req.quiz.type === 'async' && !['open', 'closed'].includes(req.quiz.status)) {
    return res.status(400).json({ error: 'Nothing to reset yet.' });
  }
  req.quiz.status = 'draft';
  req.quiz.currentQuestionIndex = -1;
  req.quiz.questionStartedAt = null;
  req.quiz.participants = [];
  db.saveQuiz(req.quiz);
  res.json({ quiz: publicQuiz(req.quiz, { includeAnswers: true }) });
});

function gradeAnswer(question, answer) {
  if (question.type === 'numeric') {
    const given = Number(answer);
    if (isNaN(given)) return false;
    const tol = Number(question.tolerance) || 0;
    return Math.abs(given - Number(question.correctAnswer)) <= tol;
  }
  if (question.type === 'ordering') {
    const givenList = Array.isArray(answer) ? answer : String(answer || '').split('|');
    const correctList = question.correctAnswer.split('|');
    if (givenList.length !== correctList.length) return false;
    return givenList.every((v, i) => String(v).trim().toLowerCase() === correctList[i].trim().toLowerCase());
  }
  if (question.type === 'typed') {
    // correctAnswer may contain several accepted answers separated by "|"
    const accepted = question.correctAnswer.split('|').map((s) => s.trim().toLowerCase());
    return accepted.includes(String(answer).trim().toLowerCase());
  }
  // mcq / truefalse
  return String(answer).trim().toLowerCase() === question.correctAnswer.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Socket.IO — lobby join, live question flow, answer submission
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  socket.on('join-room', ({ code }) => {
    if (!code) return;
    socket.join(`quiz:${code}`);
    // Tutor page refresh mid-quiz: send this socket the current snapshot
    // right away instead of waiting for the next answer to trickle in.
    const quiz = db.getQuizByCode(code);
    if (quiz && quiz.status === 'live') {
      socket.emit('answer-progress', answerProgressFor(quiz));
    }
  });

  socket.on('join-lobby', ({ code, name, phone, avatar, participantId: savedParticipantId }, ack) => {
    const quiz = db.getQuizByCode(code || '');
    if (!quiz) return ack && ack({ error: 'Quiz code not found.' });
    if (!['lobby', 'live'].includes(quiz.status)) {
      return ack && ack({ error: 'This quiz is not open for joining yet.' });
    }
    if (!name || !phone) return ack && ack({ error: 'Name and phone number are required.' });

    const trimmedName = name.trim();
    const trimmedPhone = phone.trim();

    // Re-attach to an existing participant instead of creating a new one.
    // First choice: the id the browser remembers from its last join. Fallback:
    // same phone number already in this quiz (covers a cleared/incognito
    // browser — the phone number is still how we know it's the same person).
    let participant = savedParticipantId
      ? quiz.participants.find((p) => p.id === savedParticipantId)
      : null;
    if (!participant) {
      participant = quiz.participants.find((p) => p.phone.toLowerCase() === trimmedPhone.toLowerCase());
    }

    if (participant) {
      const pendingRemoval = lobbyRemovalTimers.get(participant.id);
      if (pendingRemoval) {
        clearTimeout(pendingRemoval);
        lobbyRemovalTimers.delete(participant.id);
      }
      participant.name = trimmedName;
      participant.avatar = avatar || participant.avatar || '🙂';
      participant.socketId = socket.id;
      participant.connected = true;
      participant.lastSeenAt = Date.now();
    } else {
      participant = {
        id: uuidv4(),
        name: trimmedName,
        phone: trimmedPhone,
        avatar: avatar || '🙂',
        socketId: socket.id,
        answers: [],
        score: 0,
        totalTimeMs: 0,
        currentStreak: 0,
        bestStreak: 0,
        badges: [],
        connected: true,
        joinedAt: Date.now(),
        lastSeenAt: Date.now(),
      };
      quiz.participants.push(participant);
    }

    db.saveQuiz(quiz);
    socket.join(`quiz:${quiz.code}`);
    socket.data.quizCode = quiz.code;
    socket.data.participantId = participant.id;
    ack && ack({ participantId: participant.id, status: quiz.status });
    broadcastLobby(quiz);
    // A student can join late while the quiz is already live — keep the
    // tutor's headcount accurate the moment that happens.
    if (quiz.status === 'live') broadcastAnswerProgress(quiz);
  });

  socket.on('submit-answer', ({ code, participantId, questionId, answer }, ack) => {
    const quiz = db.getQuizByCode(code || '');
    if (!quiz || quiz.status !== 'live') return ack && ack({ error: 'Quiz is not live.' });
    const participant = quiz.participants.find((p) => p.id === participantId);
    if (!participant) return ack && ack({ error: 'You are not registered for this quiz.' });
    const question = quiz.questions[quiz.currentQuestionIndex];
    if (!question || question.id !== questionId) return ack && ack({ error: 'That question is no longer active.' });
    if (participant.answers.some((a) => a.questionId === questionId)) {
      return ack && ack({ error: 'You already answered this question.' });
    }

    const elapsedMs = Date.now() - (quiz.questionStartedAt || Date.now());
    const correct = gradeAnswer(question, answer);
    participant.answers.push({ questionId, answer, correct, elapsedMs });
    if (correct) {
      participant.score += 1;
      participant.currentStreak = (participant.currentStreak || 0) + 1;
      participant.bestStreak = Math.max(participant.bestStreak || 0, participant.currentStreak);
    } else {
      participant.currentStreak = 0;
    }
    participant.totalTimeMs += elapsedMs;
    db.saveQuiz(quiz);

    ack && ack({ correct, correctAnswer: question.correctAnswer, streak: participant.currentStreak });
    broadcastLeaderboard(quiz);
    broadcastAnswerProgress(quiz);
  });

  socket.on('disconnect', () => {
    const { quizCode, participantId } = socket.data || {};
    if (!quizCode || !participantId) return;
    const quiz = db.getQuizByCode(quizCode);
    if (!quiz) return;
    const participant = quiz.participants.find((p) => p.id === participantId);
    // If a newer connection from the same participant already took over
    // (e.g. a quick refresh), this stale socket's disconnect is a no-op.
    if (!participant || participant.socketId !== socket.id) return;

    participant.connected = false;
    participant.lastSeenAt = Date.now();
    db.saveQuiz(quiz);
    broadcastLobby(quiz);
    // Let the tutor's monitor pane show this student went offline
    // mid-quiz — they still count toward "total", just flagged.
    if (quiz.status === 'live') broadcastAnswerProgress(quiz);

    if (quiz.status === 'lobby') {
      const timer = setTimeout(() => {
        lobbyRemovalTimers.delete(participantId);
        const q = db.getQuizByCode(quizCode);
        if (!q || q.status !== 'lobby') return;
        const p = q.participants.find((pp) => pp.id === participantId);
        if (!p || p.connected) return; // they came back before the timer fired
        q.participants = q.participants.filter((pp) => pp.id !== participantId);
        db.saveQuiz(q);
        broadcastLobby(q);
      }, LOBBY_DISCONNECT_GRACE_MS);
      lobbyRemovalTimers.set(participantId, timer);
    }
  });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
db.init()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`\n${APP_NAME} server running: http://0.0.0.0:${PORT}\n`);
    });
  })
  .catch((err) => {
    console.error('\n[EDxKa] Could not connect to Postgres. Check that DATABASE_URL is set correctly.\n', err);
    process.exit(1);
  });