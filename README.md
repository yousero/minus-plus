# MinusPlus — minimal social app (Node.js + Pug + SQLite)

Tiny Express app with Pug templates and SQLite (better-sqlite3): sign up/login, login-based profile pages, friends, and settings.

## Quick start

1. Install deps:
```
npm install
```
2. Run in dev mode:
```
npm run dev
```
App will be available at `http://localhost:3000`.

## Features
- Sign up / login / logout (SQLite-backed sessions)
- My page: `/mypage` redirects to `/u/:login`
- User profile: `/u/:login`
- Friends: `/friends` — add by login, remove
- Settings: `/settings` — name, bio, change password

## Tech
- Express, Pug
- better-sqlite3 for DB
- express-session + connect-sqlite3 for sessions
- bcrypt for password hashing

## Structure
```
app.js
views/
  layout.pug, home.pug, register.pug, login.pug,
  profile.pug, friends.pug, settings.pug, 404.pug
public/
  styles.css
data/
  app.sqlite3 (created automatically)
```

## Env vars
- SESSION_SECRET — session secret (optional in dev; recommended in prod).

## Notes
- DB is created automatically in `data/`.
- For production, set SESSION_SECRET and configure proxy/SSL.


