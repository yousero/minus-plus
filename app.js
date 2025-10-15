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
\tfs.mkdirSync(DATA_DIR, { recursive: true });
}

// db init
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
\tid INTEGER PRIMARY KEY AUTOINCREMENT,
\tlogin TEXT UNIQUE NOT NULL,
\tpassword_hash TEXT NOT NULL,
\tdisplay_name TEXT NOT NULL,
\tbio TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS friends (
\tuser_id INTEGER NOT NULL,
\tfriend_id INTEGER NOT NULL,
\tcreated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
\tPRIMARY KEY (user_id, friend_id),
\tFOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
\tFOREIGN KEY (friend_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

// app config
app.set('view engine', 'pug');
app.set('views', path.join(__dirname, 'views'));

app.use(morgan('dev'));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(
\tsession({
\t\tsecret: process.env.SESSION_SECRET || 'dev-secret-change-me',
\t\tresave: false,
\t\tsaveUninitialized: false,
\t\tcookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }, // 7 days
\t\tstore: new SQLiteStore({ db: 'sessions.sqlite3', dir: DATA_DIR })
\t})
);

// helpers
function requireAuth(req, res, next) {
\tif (!req.session.user) {
\t\treturn res.redirect('/login');
\t}
\treturn next();
}

function getUserByLogin(login) {
\treturn db.prepare('SELECT * FROM users WHERE login = ?').get(login);
}

function getUserById(id) {
\treturn db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function userToPublic(user) {
\tif (!user) return null;
\treturn { id: user.id, login: user.login, display_name: user.display_name, bio: user.bio };
}

// expose session user to views
app.use((req, res, next) => {
\tres.locals.currentUser = req.session.user ? userToPublic(req.session.user) : null;
\tnext();
});

// routes
app.get('/', (req, res) => {
\tif (req.session.user) {
\t\treturn res.redirect('/mypage');
\t}
\treturn res.render('home');
});

// auth
app.get('/register', (req, res) => {
\tif (req.session.user) return res.redirect('/mypage');
\tres.render('register');
});

app.post('/register', async (req, res) => {
\tconst { login, password, display_name } = req.body;
\tif (!login || !password || !display_name) {
\t\treturn res.status(400).render('register', { error: 'Please fill out all fields' });
\t}
\ttry {
\t\tconst existing = getUserByLogin(login);
\t\tif (existing) {
\t\t\treturn res.status(400).render('register', { error: 'Login is already taken' });
\t\t}
\t\tconst password_hash = await bcrypt.hash(password, 10);
\t\tconst info = db
\t\t\t.prepare('INSERT INTO users (login, password_hash, display_name) VALUES (?, ?, ?)')
\t\t\t.run(login, password_hash, display_name);
\t\tconst user = getUserById(info.lastInsertRowid);
\t\treq.session.user = user;
\t\treturn res.redirect('/mypage');
\t} catch (e) {
\t\treturn res.status(500).render('register', { error: 'Registration failed' });
\t}
});

app.get('/login', (req, res) => {
\tif (req.session.user) return res.redirect('/mypage');
\tres.render('login');
});

app.post('/login', async (req, res) => {
\tconst { login, password } = req.body;
\tconst user = getUserByLogin(login);
\tif (!user) {
\t\treturn res.status(400).render('login', { error: 'Invalid login or password' });
\t}
\tconst ok = await bcrypt.compare(password, user.password_hash);
\tif (!ok) {
\t\treturn res.status(400).render('login', { error: 'Invalid login or password' });
\t}
\treq.session.user = user;
\treturn res.redirect('/mypage');
});

app.post('/logout', (req, res) => {
\treq.session.destroy(() => {
\t\tres.redirect('/');
\t});
});

// profile
app.get('/mypage', requireAuth, (req, res) => {
\treturn res.redirect(`/u/${req.session.user.login}`);
});

app.get('/u/:login', (req, res) => {
\tconst profileUser = getUserByLogin(req.params.login);
\tif (!profileUser) return res.status(404).render('404');

\tconst isOwn = req.session.user && req.session.user.id === profileUser.id;

\t// friends of this profile
\tconst friends = db
\t\t.prepare(
\t\t\t`SELECT u.id, u.login, u.display_name, u.bio
\t\t\t FROM friends f JOIN users u ON u.id = f.friend_id
\t\t\t WHERE f.user_id = ? ORDER BY u.login`
\t\t)
\t\t.all(profileUser.id);

\tres.render('profile', { profile: userToPublic(profileUser), friends, isOwn });
});

// friends
app.get('/friends', requireAuth, (req, res) => {
\tconst userId = req.session.user.id;
\tconst friends = db
\t\t.prepare(
\t\t\t`SELECT u.id, u.login, u.display_name, u.bio
\t\t\t FROM friends f JOIN users u ON u.id = f.friend_id
\t\t\t WHERE f.user_id = ? ORDER BY u.login`
\t\t)
\t\t.all(userId);

\tres.render('friends', { friends });
});

app.post('/friends/add', requireAuth, (req, res) => {
\tconst { login } = req.body;
\tconst target = getUserByLogin(login);
\tif (!target) return res.status(404).render('friends', { error: 'User not found' });
\tif (target.id === req.session.user.id) return res.redirect('/friends');
\ttry {
\t\tdb.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)')
\t\t\t.run(req.session.user.id, target.id);
\t} catch (_) {}
\treturn res.redirect('/friends');
});

app.post('/friends/remove', requireAuth, (req, res) => {
\tconst { user_id } = req.body;
\tconst id = parseInt(user_id, 10);
\tif (!Number.isFinite(id)) return res.redirect('/friends');
\tdb.prepare('DELETE FROM friends WHERE user_id = ? AND friend_id = ?').run(req.session.user.id, id);
\treturn res.redirect('/friends');
});

// settings
app.get('/settings', requireAuth, (req, res) => {
\tres.render('settings', { user: userToPublic(req.session.user) });
});

app.post('/settings', requireAuth, async (req, res) => {
\tconst { display_name, bio, password } = req.body;
\tconst user = req.session.user;
\tlet password_hash = user.password_hash;
\ttry {
\t\tif (password && password.trim()) {
\t\t\tpassword_hash = await bcrypt.hash(password, 10);
\t\t}
\t\tdb.prepare('UPDATE users SET display_name = ?, bio = ?, password_hash = ? WHERE id = ?')
\t\t\t.run(display_name || user.display_name, bio || '', password_hash, user.id);
\t\tconst updated = getUserById(user.id);
\t\treq.session.user = updated;
\t\treturn res.redirect('/settings');
\t} catch (e) {
\t\treturn res.status(500).render('settings', { user: userToPublic(user), error: 'Failed to save' });
\t}
});

// 404
app.use((req, res) => {
\tres.status(404).render('404');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
\tconsole.log(`Server listening on http://localhost:${PORT}`);
});




