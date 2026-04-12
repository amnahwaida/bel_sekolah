#!/bin/bash
# bel-sekolah-setup.sh
# Auto-setup Bel Sekolah Otomatis untuk STB HG860P
# Jalankan di: /home/vannyezha

set -e

echo "🚀 Memulai instalasi Bel Sekolah Otomatis..."
sleep 1

BASE_DIR="/home/vannyezha/bel_sekolah"
APP_DIR="$BASE_DIR/app"
MUSIC_DIR="$BASE_DIR/music"
DATA_DIR="$APP_DIR/data"
VIEWS_DIR="$APP_DIR/views"

mkdir -p "$MUSIC_DIR" "$DATA_DIR" "$VIEWS_DIR"

cd "$BASE_DIR"

echo "✅ Membuat docker-compose.yml..."
cat > docker-compose.yml << 'EOF'
version: '3.8'
services:
  bel-sekolah:
    build: .
    container_name: bel_sekolah
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./app:/app
      - ./music:/app/music
      - ./app/data:/app/data
    environment:
      - TZ=Asia/Jakarta
    devices:
      - /dev/snd:/dev/snd
EOF

echo "✅ Membuat Dockerfile..."
cat > Dockerfile << 'EOF'
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/music /app/data
EXPOSE 3000
CMD ["node", "server.js"]
EOF

echo "✅ Membuat package.json..."
mkdir -p app
cat > app/package.json << 'EOF'
{
  "name": "bel-sekolah",
  "version": "2.0.0",
  "description": "Sistem bel sekolah otomatis",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "express-session": "^1.17.3",
    "ejs": "^3.1.9",
    "body-parser": "^1.20.2",
    "multer": "^1.4.5-lts.1",
    "node-cron": "^3.0.3"
  }
}
EOF

echo "✅ Membuat server.js (versi lengkap)..."
cat > app/server.js << 'EOF'
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs').promises;
const { spawn } = require('child_process');
const cron = require('node-cron');
const bodyParser = require('body-parser');
const multer = require('multer');

const app = express();
const PORT = 3000;

app.use(session({
  secret: 'rahasia_b3l_s3k0lah_v3',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const DATA_DIR = path.join(__dirname, 'data');
const MUSIC_DIR = path.join(__dirname, 'music');

[DATA_DIR, MUSIC_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SCHEDULES_FILE = path.join(DATA_DIR, 'schedules.json');
const SPECIAL_SCHEDULES_FILE = path.join(DATA_DIR, 'special_schedules.json');

if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([{ username: 'admin', password: 'admin123' }]));
if (!fs.existsSync(SCHEDULES_FILE)) fs.writeFileSync(SCHEDULES_FILE, JSON.stringify({ weekdays: [], weekends: [] }));
if (!fs.existsSync(SPECIAL_SCHEDULES_FILE)) fs.writeFileSync(SPECIAL_SCHEDULES_FILE, JSON.stringify([]));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, MUSIC_DIR),
  filename: (req, file, cb) => {
    const clean = file.originalname.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '');
    cb(null, Date.now() + '_' + clean);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'audio/mpeg' || file.mimetype === 'audio/wav' ||
        file.originalname.toLowerCase().endsWith('.mp3') ||
        file.originalname.toLowerCase().endsWith('.wav')) {
      cb(null, true);
    } else {
      cb(new Error('Hanya .mp3/.wav'));
    }
  }
});

const requireAuth = (req, res, next) => {
  if (!req.session.user) return res.redirect('/login');
  next();
};

// === Routes Baru: Ganti Password & Export/Import ===
app.get('/change-password', requireAuth, (req, res) => {
  res.render('change-password', { error: null, success: null });
});

app.post('/change-password', requireAuth, async (req, res) => {
  const { current, new1, new2 } = req.body;
  if (new1 !== new2) {
    return res.render('change-password', { error: '❌ Password baru tidak cocok', success: null });
  }
  const users = JSON.parse(await fs.readFile(USERS_FILE));
  const user = users[0]; // hanya 1 user
  if (user.password !== current) {
    return res.render('change-password', { error: '❌ Password lama salah', success: null });
  }
  user.password = new1;
  await fs.writeFile(USERS_FILE, JSON.stringify([user]));
  req.session.user.password = new1;
  res.render('change-password', { error: null, success: '✅ Password berhasil diubah' });
});

// Export jadwal
app.get('/export/schedules.json', requireAuth, async (req, res) => {
  const schedules = JSON.parse(await fs.readFile(SCHEDULES_FILE));
  const special = JSON.parse(await fs.readFile(SPECIAL_SCHEDULES_FILE));
  const exportData = { schedules, special, exportedAt: new Date().toISOString() };
  res.setHeader('Content-Disposition', 'attachment; filename="jadwal_bel_sekolah.json"');
  res.json(exportData);
});

// Import jadwal
app.post('/import', requireAuth, upload.single('importfile'), async (req, res) => {
  if (!req.file) return res.status(400).send('File tidak ditemukan');
  try {
    const data = JSON.parse(await fs.readFile(req.file.path, 'utf8'));
    if (data.schedules) await fs.writeFile(SCHEDULES_FILE, JSON.stringify(data.schedules, null, 2));
    if (data.special) await fs.writeFile(SPECIAL_SCHEDULES_FILE, JSON.stringify(data.special, null, 2));
    await fs.unlink(req.file.path);
    res.redirect('/dashboard?import=success');
  } catch (e) {
    console.error(e);
    res.redirect('/dashboard?import=error');
  }
});

// === Routes Lama (tidak berubah) ===
app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const users = JSON.parse(await fs.readFile(USERS_FILE));
  const user = users.find(u => u.username === username && u.password === password);
  if (user) {
    req.session.user = user;
    return res.redirect('/dashboard');
  }
  res.render('login', { error: '❌ Username/password salah' });
});
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/dashboard', requireAuth, async (req, res) => {
  const [schedules, special, files] = await Promise.all([
    fs.readFile(SCHEDULES_FILE, 'utf8').then(JSON.parse),
    fs.readFile(SPECIAL_SCHEDULES_FILE, 'utf8').then(JSON.parse),
    fs.readdir(MUSIC_DIR)
  ]);
  const musicFiles = files.filter(f => /\.(mp3|wav)$/i.test(f));
  const { import: imp } = req.query;
  res.render('dashboard', { 
    schedules, 
    special, 
    musicFiles,
    importSuccess: imp === 'success',
    importError: imp === 'error'
  });
});

app.post('/schedule/add', requireAuth, async (req, res) => {
  const { type, time, sound } = req.body;
  const schedules = JSON.parse(await fs.readFile(SCHEDULES_FILE));
  schedules[type].push({ time, sound });
  schedules[type].sort((a, b) => a.time.localeCompare(b.time));
  await fs.writeFile(SCHEDULES_FILE, JSON.stringify(schedules, null, 2));
  res.redirect('/dashboard');
});

app.post('/schedule/remove', requireAuth, async (req, res) => {
  const { type, index } = req.body;
  const schedules = JSON.parse(await fs.readFile(SCHEDULES_FILE));
  schedules[type].splice(parseInt(index), 1);
  await fs.writeFile(SCHEDULES_FILE, JSON.stringify(schedules, null, 2));
  res.redirect('/dashboard');
});

app.post('/special/add', requireAuth, async (req, res) => {
  const { date, time, sound } = req.body;
  const special = JSON.parse(await fs.readFile(SPECIAL_SCHEDULES_FILE));
  special.push({ date, time, sound });
  await fs.writeFile(SPECIAL_SCHEDULES_FILE, JSON.stringify(special, null, 2));
  res.redirect('/dashboard');
});

app.post('/special/remove', requireAuth, async (req, res) => {
  const { index } = req.body;
  const special = JSON.parse(await fs.readFile(SPECIAL_SCHEDULES_FILE));
  special.splice(parseInt(index), 1);
  await fs.writeFile(SPECIAL_SCHEDULES_FILE, JSON.stringify(special, null, 2));
  res.redirect('/dashboard');
});

app.post('/upload', requireAuth, upload.single('audiofile'), (req, res) => {
  res.redirect('/dashboard');
});

app.post('/music/delete', requireAuth, async (req, res) => {
  const { file } = req.body;
  try {
    await fs.unlink(path.join(MUSIC_DIR, file));
  } catch (e) { console.error(e); }
  res.redirect('/dashboard');
});

app.get('/preview/:file', requireAuth, (req, res) => {
  res.render('preview', { file: req.params.file });
});

app.post('/play', requireAuth, (req, res) => {
  const { file } = req.body;
  const filePath = path.join(MUSIC_DIR, file);
  if (!fs.existsSync(filePath)) return res.status(404).send('File tidak ditemukan');

  let proc;
  if (file.toLowerCase().endsWith('.wav')) {
    proc = spawn('aplay', ['-D', 'plughw:0,0', filePath]);
  } else if (file.toLowerCase().endsWith('.mp3')) {
    const ffmpeg = spawn('ffmpeg', ['-i', filePath, '-f', 'wav', '-loglevel', 'quiet', '-']);
    const aplay = spawn('aplay', ['-D', 'plughw:0,0', '-q']);
    ffmpeg.stdout.pipe(aplay.stdin);
    ffmpeg.stderr.resume();
    proc = aplay;
  } else {
    return res.status(400).send('Format tidak didukung');
  }

  proc.on('error', (err) => console.error('Play error:', err));
  res.json({ status: 'playing', file });
});

const runScheduler = async () => {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toTimeString().substring(0, 5);
  const day = now.getDay();

  const special = JSON.parse(await fs.readFile(SPECIAL_SCHEDULES_FILE));
  const todaySpecial = special.find(s => s.date === dateStr && s.time === timeStr);
  if (todaySpecial) {
    playSound(todaySpecial.sound);
    return;
  }

  const schedules = JSON.parse(await fs.readFile(SCHEDULES_FILE));
  const list = (day === 0 || day === 6) ? schedules.weekends : schedules.weekdays;
  const match = list.find(s => s.time === timeStr);
  if (match) playSound(match.sound);
};

const playSound = (filename) => {
  const filePath = path.join(MUSIC_DIR, filename);
  if (!fs.existsSync(filePath)) return;

  if (filename.toLowerCase().endsWith('.wav')) {
    spawn('aplay', ['-D', 'plughw:0,0', filePath]);
  } else if (filename.toLowerCase().endsWith('.mp3')) {
    const ffmpeg = spawn('ffmpeg', ['-i', filePath, '-f', 'wav', '-loglevel', 'quiet', '-']);
    const aplay = spawn('aplay', ['-D', 'plughw:0,0', '-q']);
    ffmpeg.stdout.pipe(aplay.stdin);
    ffmpeg.stderr.resume();
  }
};

cron.schedule('* * * * *', runScheduler);

app.get('/music/:file', requireAuth, (req, res) => {
  const f = req.params.file;
  const p = path.join(MUSIC_DIR, f);
  res.sendFile(p, err => {
    if (err) res.status(404).send('File not found');
  });
});

app.get('/', (req, res) => {
  res.redirect(req.session.user ? '/dashboard' : '/login');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Bel Sekolah v3 berjalan di http://localhost:${PORT}`);
});
EOF

echo "✅ Membuat views..."
mkdir -p "$VIEWS_DIR"

cat > "$VIEWS_DIR/layout.ejs" << 'EOF'
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>🔔 Bel Sekolah</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = { theme: { extend: { colors: { primary: '#1e40af', success: '#16a34a', warning: '#d97706' } } } }
  </script>
</head>
<body class="bg-gray-50">
  <header class="bg-primary text-white p-4 shadow-md">
    <div class="container mx-auto flex justify-between items-center">
      <h1 class="text-xl font-bold">🔔 Bel Sekolah Otomatis</h1>
      <% if (locals.user) { %>
        <div class="flex gap-4 items-center">
          <span class="text-sm">Halo, <b><%= user.username %></b></span>
          <a href="/change-password" class="text-white hover:underline text-sm">🔐 Ganti Password</a>
          <a href="/logout" class="text-white hover:underline text-sm">Logout</a>
        </div>
      <% } %>
    </div>
  </header>
  <main class="container mx-auto mt-6 px-4">
    <%- body %>
  </main>
</body>
</html>
EOF

cat > "$VIEWS_DIR/login.ejs" << 'EOF'
<%- include('layout') %>
<div class="max-w-md mx-auto bg-white p-8 rounded-lg shadow mt-10">
  <h2 class="text-2xl font-bold text-center mb-6">🔐 Login Admin</h2>
  <% if (error) { %>
    <div class="bg-red-100 text-red-700 p-3 rounded mb-4"><%= error %></div>
  <% } %>
  <form method="POST" action="/login">
    <div class="mb-4">
      <label class="block text-gray-700">Username</label>
      <input type="text" name="username" class="w-full px-4 py-2 border rounded" value="admin" required />
    </div>
    <div class="mb-6">
      <label class="block text-gray-700">Password</label>
      <input type="password" name="password" class="w-full px-4 py-2 border rounded" value="admin123" required />
    </div>
    <button type="submit" class="w-full bg-primary text-white py-2 rounded hover:bg-blue-700">
      Login
    </button>
  </form>
  <p class="text-center text-sm text-gray-500 mt-4">
    Default: admin / admin123 → ganti segera!
  </p>
</div>
EOF

cat > "$VIEWS_DIR/change-password.ejs" << 'EOF'
<%- include('layout') %>
<div class="max-w-md mx-auto bg-white p-8 rounded-lg shadow mt-10">
  <h2 class="text-2xl font-bold text-center mb-6">🔐 Ganti Password</h2>
  
  <% if (success) { %>
    <div class="bg-green-100 text-green-700 p-3 rounded mb-4"><%= success %></div>
  <% } %>
  <% if (error) { %>
    <div class="bg-red-100 text-red-700 p-3 rounded mb-4"><%= error %></div>
  <% } %>

  <form method="POST" action="/change-password">
    <div class="mb-4">
      <label class="block text-gray-700">Password Lama</label>
      <input type="password" name="current" class="w-full px-4 py-2 border rounded" required />
    </div>
    <div class="mb-4">
      <label class="block text-gray-700">Password Baru</label>
      <input type="password" name="new1" class="w-full px-4 py-2 border rounded" required />
    </div>
    <div class="mb-6">
      <label class="block text-gray-700">Ulangi Password Baru</label>
      <input type="password" name="new2" class="w-full px-4 py-2 border rounded" required />
    </div>
    <button type="submit" class="w-full bg-primary text-white py-2 rounded hover:bg-blue-700">
      Simpan Perubahan
    </button>
    <a href="/dashboard" class="block text-center mt-4 text-gray-600 hover:underline">← Batal</a>
  </form>
</div>
EOF

cat > "$VIEWS_DIR/dashboard.ejs" << 'EOF'
<%- include('layout') %>

<% if (importSuccess) { %>
  <div class="bg-green-100 text-green-700 p-3 rounded mb-4 flex items-center">
    <span>✅ Jadwal berhasil diimpor!</span>
  </div>
<% } else if (importError) { %>
  <div class="bg-red-100 text-red-700 p-3 rounded mb-4">
    ❌ Gagal mengimpor jadwal. Pastikan file JSON valid.
  </div>
<% } %>

<div class="flex justify-between items-center mb-6">
  <h1 class="text-2xl font-bold">📊 Dashboard Bel Sekolah</h1>
  <div class="space-x-2">
    <a href="/export/schedules.json" class="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded text-sm flex items-center">
      📤 Export Jadwal
    </a>
    <button onclick="document.getElementById('importForm').classList.toggle('hidden')" 
      class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded text-sm">
      📥 Import Jadwal
    </button>
  </div>
</div>

<!-- Form Import (hidden by default) -->
<div id="importForm" class="bg-white p-4 rounded shadow mb-6 hidden">
  <h3 class="font-bold mb-2">📤 Impor Jadwal dari File JSON</h3>
  <form method="POST" action="/import" enctype="multipart/form-data" class="flex gap-2">
    <input type="file" name="importfile" accept=".json" required class="flex-1" />
    <button type="submit" class="bg-blue-600 text-white px-3 rounded">
      Impor
    </button>
    <button type="button" onclick="document.getElementById('importForm').classList.add('hidden')"
      class="bg-gray-500 text-white px-3 rounded">×</button>
  </form>
  <p class="text-sm text-gray-600 mt-2">
    Format file: hasil export dari tombol "Export Jadwal"
  </p>
</div>

<div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
  <!-- Jadwal Reguler -->
  <div class="bg-white p-6 rounded shadow">
    <h2 class="text-xl font-bold mb-4">⏰ Jadwal Reguler</h2>
    <!-- Weekdays & Weekends (sama seperti sebelumnya) -->
    <div class="mb-6">
      <h3 class="font-semibold text-gray-700 flex items-center">
        <span class="bg-blue-100 text-blue-800 text-xs px-2 py-1 rounded mr-2">Senin–Jumat</span>
      </h3>
      <ul class="space-y-1 mt-2">
        <% schedules.weekdays.forEach((s, i) => { %>
          <li class="flex justify-between items-center bg-gray-50 p-2 rounded">
            <span class="font-mono"><%= s.time %> → <b><%= s.sound %></b></span>
            <form method="POST" action="/schedule/remove" class="inline">
              <input type="hidden" name="type" value="weekdays" />
              <input type="hidden" name="index" value="<%= i %>" />
              <button type="submit" class="text-red-500 hover:text-red-700">×</button>
            </form>
          </li>
        <% }) %>
        <% if (schedules.weekdays.length === 0) { %>
          <li class="text-gray-400 italic">Belum ada jadwal</li>
        <% } %>
      </ul>
      <form method="POST" action="/schedule/add" class="mt-3 flex gap-2">
        <input type="hidden" name="type" value="weekdays" />
        <input type="time" name="time" class="px-2 py-1 border rounded" required />
        <select name="sound" class="px-2 py-1 border rounded" required>
          <% musicFiles.forEach(f => { %>
            <option value="<%= f %>"><%= f %></option>
          <% }) %>
        </select>
        <button type="submit" class="bg-green-500 text-white px-3 rounded text-sm">➕ Tambah</button>
      </form>
    </div>
    <div>
      <h3 class="font-semibold text-gray-700 flex items-center">
        <span class="bg-purple-100 text-purple-800 text-xs px-2 py-1 rounded mr-2">Sabtu–Minggu</span>
      </h3>
      <ul class="space-y-1 mt-2">
        <% schedules.weekends.forEach((s, i) => { %>
          <li class="flex justify-between items-center bg-gray-50 p-2 rounded">
            <span class="font-mono"><%= s.time %> → <b><%= s.sound %></b></span>
            <form method="POST" action="/schedule/remove" class="inline">
              <input type="hidden" name="type" value="weekends" />
              <input type="hidden" name="index" value="<%= i %>" />
              <button type="submit" class="text-red-500 hover:text-red-700">×</button>
            </form>
          </li>
        <% }) %>
        <% if (schedules.weekends.length === 0) { %>
          <li class="text-gray-400 italic">Tidak ada bel (kosongkan untuk hari libur)</li>
        <% } %>
      </ul>
      <form method="POST" action="/schedule/add" class="mt-3 flex gap-2">
        <input type="hidden" name="type" value="weekends" />
        <input type="time" name="time" class="px-2 py-1 border rounded" required />
        <select name="sound" class="px-2 py-1 border rounded" required>
          <% musicFiles.forEach(f => { %>
            <option value="<%= f %>"><%= f %></option>
          <% }) %>
        </select>
        <button type="submit" class="bg-green-500 text-white px-3 rounded text-sm">➕ Tambah</button>
      </form>
    </div>
  </div>

  <!-- Jadwal Khusus + Musik -->
  <div class="space-y-6">
    <div class="bg-white p-6 rounded shadow">
      <h2 class="text-xl font-bold mb-3">📅 Jadwal Khusus (Per Tanggal)</h2>
      <ul class="space-y-2">
        <% special.forEach((s, i) => { %>
          <li class="flex justify-between bg-blue-50 p-3 rounded">
            <div>
              <b class="text-blue-800"><%= s.date %></b> @ <span class="font-mono"><%= s.time %></span>
              <br><small>🎵 <%= s.sound %></small>
            </div>
            <form method="POST" action="/special/remove" class="inline">
              <input type="hidden" name="index" value="<%= i %>" />
              <button class="text-red-600">×</button>
            </form>
          </li>
        <% }) %>
        <% if (special.length === 0) { %>
          <li class="text-gray-400 italic">Belum ada jadwal khusus</li>
        <% } %>
      </ul>
      <form method="POST" action="/special/add" class="mt-4 flex flex-wrap gap-2">
        <input type="date" name="date" class="px-2 py-1 border rounded" required />
        <input type="time" name="time" class="px-2 py-1 border rounded" required />
        <select name="sound" class="px-2 py-1 border rounded" required>
          <% musicFiles.forEach(f => { %>
            <option value="<%= f %>"><%= f %></option>
          <% }) %>
        </select>
        <button type="submit" class="bg-blue-500 text-white px-3 rounded text-sm whitespace-nowrap">➕ Jadwal Khusus</button>
      </form>
    </div>

    <div class="bg-white p-6 rounded shadow">
      <h2 class="text-xl font-bold mb-3">📤 Upload & Daftar Musik</h2>
      <form method="POST" action="/upload" enctype="multipart/form-data" class="mb-4 p-3 bg-green-50 rounded">
        <input type="file" name="audiofile" accept=".mp3,.wav" class="mb-2" required />
        <button type="submit" class="bg-green-600 text-white py-1 px-3 rounded text-sm">
          📤 Upload MP3/WAV (max 20 MB)
        </button>
      </form>
      <h3 class="font-semibold mb-2">🎵 File Musik (<%= musicFiles.length %>)</h3>
      <div class="space-y-2 max-h-60 overflow-y-auto">
        <% musicFiles.forEach(f => { %>
          <div class="flex justify-between items-center border-b pb-1">
            <span class="font-mono text-sm text-gray-700"><%= f %></span>
            <div>
              <a href="/preview/<%= f %>" class="text-blue-600 hover:underline text-xs mr-2">🔊 Web</a>
              <form method="POST" action="/play" class="inline">
                <input type="hidden" name="file" value="<%= f %>" />
                <button type="submit" class="text-green-600 hover:text-green-800 text-xs">
                  🎧 STB
                </button>
              </form>
              <form method="POST" action="/music/delete" class="inline ml-2">
                <input type="hidden" name="file" value="<%= f %>" />
                <button type="submit" class="text-red-500 hover:text-red-700 text-xs"
                  onclick="return confirm('Hapus <%= f %> ?')">🗑️</button>
              </form>
            </div>
          </div>
        <% }) %>
      </div>
    </div>
  </div>
</div>
EOF

cat > "$VIEWS_DIR/preview.ejs" << 'EOF'
<%- include('layout') %>
<div class="max-w-2xl mx-auto bg-white p-6 rounded shadow text-center mt-6">
  <h2 class="text-2xl font-bold mb-4">🎧 Preview: <span class="text-primary"><%= file %></span></h2>
  
  <audio controls class="w-full mb-4">
    <source src="/music/<%= encodeURIComponent(file) %>" type="audio/mpeg">
    Browser tidak mendukung audio.
  </audio>

  <div class="flex justify-center gap-3">
    <form method="POST" action="/play" class="inline">
      <input type="hidden" name="file" value="<%= file %>" />
      <button type="submit" class="bg-primary text-white py-2 px-6 rounded hover:bg-blue-700 flex items-center">
        <span>▶️ Putar di Speaker STB</span>
      </button>
    </form>
    <a href="/dashboard" class="py-2 px-4 bg-gray-200 rounded hover:bg-gray-300">← Kembali</a>
  </div>
</div>

<script>
document.querySelector('form').onsubmit = function() {
  alert('🔊 Perintah dikirim ke STB...\nCek speaker USB Anda dalam 2 detik!');
};
</script>
EOF

echo "✅ Menyiapkan izin audio..."
sudo usermod -aG audio $USER 2>/dev/null || true

echo "✅ Menginstal dependensi (npm install)..."
cd app
npm install --omit=dev > /dev/null 2>&1

echo "✅ Menjalankan docker-compose..."
cd ..
docker-compose up -d --build > /dev/null 2>&1

echo ""
echo "🎉 Instalasi SELESAI!"
echo ""
echo "🔗 Akses web: http://$(hostname -I | awk '{print $1}'):3000"
echo "🔐 Login: admin / admin123"
echo ""
echo "📁 Lokasi file:"
echo "   - Musik: /home/vannyezha/bel_sekolah/music/"
echo "   - Jadwal: /home/vannyezha/bel_sekolah/app/data/"
echo ""
echo "💡 Tips:"
echo "   - Ganti password segera di dashboard"
echo "   - Untuk backup: klik 'Export Jadwal'"
echo "   - Untuk restore: 'Import Jadwal'"
echo ""
echo "Terima kasih! 🙏"
