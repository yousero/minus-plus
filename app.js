const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const morgan = require('morgan');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');

const app = express();

// paths
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'app.sqlite3');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// db init
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  bio TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS friends (
  user_id INTEGER NOT NULL,
  friend_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, friend_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (friend_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

// app config
app.set('view engine', 'pug');
app.set('views', path.join(__dirname, 'views'));

app.use(morgan('dev'));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }, // 7 days
    store: new SQLiteStore({ db: 'sessions.sqlite3', dir: DATA_DIR })
  })
);

// helpers
function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  return next();
}

function getUserByLogin(login) {
  return db.prepare('SELECT * FROM users WHERE login = ?').get(login);
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function userToPublic(user) {
  if (!user) return null;
  return { id: user.id, login: user.login, display_name: user.display_name, bio: user.bio };
}

// expose session user to views
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user ? userToPublic(req.session.user) : null;
  next();
});

// routes
app.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect('/mypage');
  }
  return res.render('home');
});

// auth
app.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/mypage');
  res.render('register');
});

app.post('/register', async (req, res) => {
  const { login, password, display_name } = req.body;
  if (!login || !password || !display_name) {
    return res.status(400).render('register', { error: 'Please fill out all fields' });
  }
  try {
    const existing = getUserByLogin(login);
    if (existing) {
      return res.status(400).render('register', { error: 'Login is already taken' });
    }
    const password_hash = await bcrypt.hash(password, 10);
    const info = db
      .prepare('INSERT INTO users (login, password_hash, display_name) VALUES (?, ?, ?)')
      .run(login, password_hash, display_name);
    const user = getUserById(info.lastInsertRowid);
    req.session.user = user;
    return res.redirect('/mypage');
  } catch (e) {
    return res.status(500).render('register', { error: 'Registration failed' });
  }
});

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/mypage');
  res.render('login');
});

app.post('/login', async (req, res) => {
  const { login, password } = req.body;
  const user = getUserByLogin(login);
  if (!user) {
    return res.status(400).render('login', { error: 'Invalid login or password' });
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return res.status(400).render('login', { error: 'Invalid login or password' });
  }
  req.session.user = user;
  return res.redirect('/mypage');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// profile
app.get('/mypage', requireAuth, (req, res) => {
  return res.redirect(`/u/${req.session.user.login}`);
});

app.get('/u/:login', (req, res) => {
  const profileUser = getUserByLogin(req.params.login);
  if (!profileUser) return res.status(404).render('404');

  const isOwn = req.session.user && req.session.user.id === profileUser.id;

  // friends of this profile
  const friends = db
    .prepare(
      `SELECT u.id, u.login, u.display_name, u.bio
       FROM friends f JOIN users u ON u.id = f.friend_id
       WHERE f.user_id = ? ORDER BY u.login`
    )
    .all(profileUser.id);

  res.render('profile', { profile: userToPublic(profileUser), friends, isOwn });
});

// friends
app.get('/friends', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const friends = db
    .prepare(
      `SELECT u.id, u.login, u.display_name, u.bio
       FROM friends f JOIN users u ON u.id = f.friend_id
       WHERE f.user_id = ? ORDER BY u.login`
    )
    .all(userId);

  res.render('friends', { friends });
});

app.post('/friends/add', requireAuth, (req, res) => {
  const { login } = req.body;
  const target = getUserByLogin(login);
  if (!target) return res.status(404).render('friends', { error: 'User not found' });
  if (target.id === req.session.user.id) return res.redirect('/friends');
  try {
    db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)')
      .run(req.session.user.id, target.id);
  } catch (_) {}
  return res.redirect('/friends');
});

app.post('/friends/remove', requireAuth, (req, res) => {
  const { user_id } = req.body;
  const id = parseInt(user_id, 10);
  if (!Number.isFinite(id)) return res.redirect('/friends');
  db.prepare('DELETE FROM friends WHERE user_id = ? AND friend_id = ?').run(req.session.user.id, id);
  return res.redirect('/friends');
});

// settings
app.get('/settings', requireAuth, (req, res) => {
  res.render('settings', { user: userToPublic(req.session.user) });
});

app.post('/settings', requireAuth, async (req, res) => {
  const { display_name, bio, password } = req.body;
  const user = req.session.user;
  let password_hash = user.password_hash;
  try {
    if (password && password.trim()) {
      password_hash = await bcrypt.hash(password, 10);
    }
    db.prepare('UPDATE users SET display_name = ?, bio = ?, password_hash = ? WHERE id = ?')
      .run(display_name || user.display_name, bio || '', password_hash, user.id);
    const updated = getUserById(user.id);
    req.session.user = updated;
    return res.redirect('/settings');
  } catch (e) {
    return res.status(500).render('settings', { user: userToPublic(user), error: 'Failed to save' });
  }
});

// 404
app.use((req, res) => {
  res.status(404).render('404');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});




