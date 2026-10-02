# EDxKa

A real-time quiz platform for classrooms. A tutor builds a quiz, opens a
lobby, and students join with just a name and phone number. Everyone
answers the same question at the same time against a shared countdown, and
the leaderboard ranks by correct answers first, then by total time.

Node/Express + Socket.IO on the backend, static HTML/CSS/JS on the
frontend — no build step, no frontend framework.

## Features

- **Live sessions** — draft → lobby → live → finished, all synced across
  every connected client over Socket.IO.
- **Async ("self-paced") quizzes** — the tutor sets a fixed time limit
  (e.g. 5 minutes), publishes the quiz, and shares one link. Students can
  open it anytime; the clock starts the moment *they* begin, not on a
  shared countdown. Scores land in the same leaderboard and CSV export as
  live sessions.
- **Question types** — multiple choice, true/false, typed (with multiple
  accepted answers), numeric (with an optional margin of error), and
  ordering/ranking. Questions can include an image and a topic tag.
- **Bulk question import** — paste a batch of questions in a simple text
  format and add them all at once, instead of one at a time.
- **Solo practice mode** — students can work through a quiz at their own
  pace outside of a live session, with a full answer review at the end.
- **Tutor analytics** — per-question accuracy and response time, plus a
  weakest-topics breakdown.
- **Engagement features** — streak tracking, end-of-session badges, sound
  effects, and a confetti finish.
- **Accounts & password reset** — tutor sign up/sign in with a working
  forgot-password email flow.
- **Admin panel** — a basic-auth-protected view of registered users and
  session participants, for support and moderation.
- **Responsive UI** — usable on phones as well as desktop, including the
  quiz editor and live leaderboard.

## Tech stack

| Layer     | Technology                          |
|-----------|--------------------------------------|
| Backend   | Node.js, Express, Socket.IO          |
| Database  | PostgreSQL (`pg`), in-memory cache in front of it |
| Auth      | JWT (tutors), HTTP Basic auth (admin panel) |
| Email     | Nodemailer (SMTP)                    |
| Frontend  | Static HTML/CSS/JS — no build step   |

## Project structure