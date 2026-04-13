const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { spawn } = require('child_process');
const cron = require('node-cron');
const bodyParser = require('body-parser');
const multer = require('multer');
const { exec } = require("child_process");
const bcrypt = require('bcryptjs');
const http = require('http');
const socketIo = require('socket.io');

// ======================
// KONFIGURASI USB RELAY
// ======================

// Ganti sesuai device relay Anda
const RELAY_DEVICE = "/dev/hidraw1";
let relayStatus = false;      // true = ON, false = OFF
let manualOverride = false;   // jika true, auto-off tidak mematikan relay

// DATA TRACKING (NOW PLAYING)
let isAudioPlaying = false;
let activeAudioName = null;
let activeAudioProcess = null;
let activeFfmpegProcess = null;
let liveMicProcess = null;
let liveMicFfmpeg = null;

// matikan
// printf '\x00\xFD\x01\x00\x00\x00\x00\x00' | sudo tee /dev/hidraw1 > /dev/null
// nyalakan
// printf '\x00\xFF\x01\x00\x00\x00\x00\x00' | sudo tee /dev/hidraw1 > /dev/null

// Command ON / OFF (sesuaikan jika beda)
// const RELAY_ON  = "printf '\x00\xFF\x01\x00\x00\x00\x00\x00' | sudo tee /dev/hidraw1 > /dev/null";
// const RELAY_OFF = "printf '\x00\xFD\x01\x00\x00\x00\x00\x00' | sudo tee /dev/hidraw1 > /dev/null";
// const RELAY_ON  = `printf '\x00\xFF\x01\x00\x00\x00\x00\x00' | sudo tee ${RELAY_DEVICE} > /dev/null`;
// const RELAY_OFF = `printf '\x00\xFD\x01\x00\x00\x00\x00\x00' | sudo tee ${RELAY_DEVICE} > /dev/null`;
// const RELAY_ON  = `printf '\\x00\\xFF\\x01' > ${RELAY_DEVICE}`;
// const RELAY_OFF = `printf '\\x00\\xFD\\x01' > ${RELAY_DEVICE}`;
// ======================
// KONFIGURASI USB RELAY
// ======================

// Ganti sesuai device relay Anda

// Command ON / OFF (TANPA sudo, karena di dalam container)
const RELAY_ON  = `printf '\\x00\\xFF\\x01\\x00\\x00\\x00\\x00\\x00' > ${RELAY_DEVICE} 2>/dev/null`;
const RELAY_OFF = `printf '\\x00\\xFD\\x01\\x00\\x00\\x00\\x00\\x00' > ${RELAY_DEVICE} 2>/dev/null`;


// Delay sebelum play (ms)
const AMP_WARMUP = 3000;

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = 3000;

app.use(session({
  store: new FileStore({
    path: path.join('/app', 'data', 'sessions'),
    ttl: 86400 * 7, // 7 hari
    retries: 0
  }),
  secret: process.env.SESSION_SECRET || 'rahasia_b3l_s3k0lah_final_fallback_dev_only',
  resave: false,
  saveUninitialized: false, // Ubah ke false agar tidak buat file sesi kosong
  cookie: { 
    secure: false,
    maxAge: 1000 * 60 * 60 * 24 * 7 // 7 hari
  }
}));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));

// Middleware untuk menyuplai data user ke semua view
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const DATA_DIR = path.join('/app', 'data');
const MUSIC_DIR = path.join('/app', 'music');

[DATA_DIR, MUSIC_DIR].forEach(dir => {
  if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
});

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SCHEDULES_FILE = path.join(DATA_DIR, 'schedules.json');
const SPECIAL_SCHEDULES_FILE = path.join(DATA_DIR, 'special_schedules.json');
const LOGS_FILE = path.join(DATA_DIR, 'logs.json');

if (!fsSync.existsSync(USERS_FILE)) fsSync.writeFileSync(USERS_FILE, JSON.stringify([{ username: 'smamsa', password: 'smamsa12' }]));
if (!fsSync.existsSync(SCHEDULES_FILE)) fsSync.writeFileSync(SCHEDULES_FILE, JSON.stringify({
  enabled: true,
  mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: []
}));
if (!fsSync.existsSync(SPECIAL_SCHEDULES_FILE)) fsSync.writeFileSync(SPECIAL_SCHEDULES_FILE, JSON.stringify([]));
if (!fsSync.existsSync(LOGS_FILE)) fsSync.writeFileSync(LOGS_FILE, JSON.stringify([]));

// HELPER: Audit Logs
const addLog = async (type, message, user = 'System') => {
  try {
    const logs = JSON.parse(await fs.readFile(LOGS_FILE, 'utf8'));
    const newLog = {
      timestamp: new Date().toISOString(),
      type, // 'auth', 'audio', 'system', 'config'
      message,
      user
    };
    logs.unshift(newLog); // Terbaru di atas
    // Limit to 500 entries
    if (logs.length > 500) logs.splice(500);
    await fs.writeFile(LOGS_FILE, JSON.stringify(logs, null, 2));
  } catch (err) {
    console.error('Error writing log:', err);
  }
};

// HELPER: Password Migration (Plain to Hash)
const migratePasswords = async () => {
  try {
    const data = await fs.readFile(USERS_FILE, 'utf8');
    const users = JSON.parse(data);
    let changed = false;

    for (let user of users) {
      // Jika password belum di-hash (bcrypt hash biasanya mulai dengan $2a$ atau $2b$)
      if (!user.password.startsWith('$2a$') && !user.password.startsWith('$2b$')) {
        console.log(`🔐 Migrating password for user: ${user.username}`);
        user.password = await bcrypt.hash(user.password, 10);
        changed = true;
      }
    }

    if (changed) {
      await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
      console.log('✅ All passwords migrated to secure hash format.');
      addLog('system', 'Sistem berhasil melakukan migrasi password ke format terenkripsi');
    }
  } catch (err) {
    console.error('Migration error:', err);
  }
};

migratePasswords();

// === Upload Audio (.mp3/.wav) ===
const uploadAudio = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, MUSIC_DIR),
    filename: (req, file, cb) => {
      const clean = file.originalname.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '');
      cb(null, Date.now() + '_' + clean);
    }
  }),
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

// === Upload JSON (.json) ===
const uploadJson = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, DATA_DIR),
    filename: (req, file, cb) => {
      const clean = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '');
      cb(null, 'import_' + Date.now() + '_' + clean);
    }
  }),
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/json' || file.originalname.toLowerCase().endsWith('.json')) {
      cb(null, true);
    } else {
      cb(new Error('Hanya file .json yang diizinkan untuk import'));
    }
  }
});

const requireAuth = (req, res, next) => {
  if (!req.session.user) return res.redirect('/login');
  next();
};

const ensureSchedules = (schedules) => {
  const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  days.forEach(d => { if (!Array.isArray(schedules[d])) schedules[d] = []; });
  if (typeof schedules.enabled !== 'boolean') schedules.enabled = true;
  if (!schedules.quickCallFile) schedules.quickCallFile = null;
  return schedules;
};

// const relayOn = () => {
//     return new Promise((resolve) => {
//       exec(RELAY_ON, () => {
//         console.log("🔌 Amplifier ON");
//         setTimeout(resolve, AMP_WARMUP);
//       });
//     });
//   };
  
//   const relayOff = () => {
//     exec(RELAY_OFF, () => {
//       console.log("🔌 Amplifier OFF");
//     });
//   };

const relayOn = () => {
  return new Promise((resolve) => {
    exec(RELAY_ON, () => {
      relayStatus = true;
      console.log("🔌 Amplifier ON");
      setTimeout(resolve, AMP_WARMUP);
    });
  });
};

const relayOff = () => {
  // Jika manual override aktif, jangan matikan relay
  if (manualOverride) {
    console.log("🔒 Manual override aktif, relay tidak dimatikan oleh scheduler");
    return;
  }

  // Cek apakah relay benar-benar ON sebelum dimatikan
  if (!relayStatus) {
    console.log("ℹ️ Relay sudah OFF, tidak perlu dimatikan lagi");
    return;
  }

  exec(RELAY_OFF, (error) => {
    if (error) {
      console.error('❌ Error mematikan relay:', error);
      return;
    }
    relayStatus = false;
    console.log("✅ 🔌 Amplifier OFF (otomatis)");
  });
};


app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
    const user = users.find(u => u.username === username);
    
    if (user && await bcrypt.compare(password, user.password)) {
      req.session.user = { username: user.username }; // Jangan simpan hash di session
      addLog('auth', `User ${username} berhasil login`, username);
      return res.redirect('/dashboard');
    }
    addLog('auth', `Gagal login: Username ${username} tidak ditemukan atau sandi salah`, username);
    res.render('login', { error: '❌ Username/password salah' });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).send('Error login');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    let schedules = JSON.parse(await fs.readFile(SCHEDULES_FILE, 'utf8'));
    schedules = ensureSchedules(schedules);
    const special = JSON.parse(await fs.readFile(SPECIAL_SCHEDULES_FILE, 'utf8'));
    const files = await fs.readdir(MUSIC_DIR);
    const musicFiles = files.filter(f => /\.(mp3|wav)$/i.test(f));
    res.render('dashboard', { 
      schedules, special, musicFiles, 
      rename: req.query.rename, 
      stop: req.query.stop, 
      import: req.query.import,
      play: req.query.play,
      quickCallFile: schedules.quickCallFile || null
    });
  } catch (err) {
    console.error('Render error:', err);
    res.status(500).send('<h2>❌ Error Dashboard</h2><pre>' + (err.message || err) + '</pre>');
  }
});

// === HALAMAN PENGATURAN ===
app.get('/settings', requireAuth, async (req, res) => {
  try {
    const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
    res.render('settings', { 
      msg: req.query.msg || null, 
      type: req.query.type || 'info',
      allUsers: users.map(u => ({ username: u.username })) // Jangan kirim password ke view
    });
  } catch (err) {
    res.status(500).send('Error loading settings');
  }
});

// API: Hapus User
app.post('/settings/user/delete', requireAuth, async (req, res) => {
  const { usernameToDelete } = req.body;
  if (usernameToDelete === req.session.user.username) {
    return res.redirect('/settings?msg=Anda tidak dapat menghapus diri sendiri!&type=error');
  }

  try {
    let users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
    if (users.length <= 1) {
      return res.redirect('/settings?msg=Minimal harus ada 1 user di sistem!&type=error');
    }

    const filteredUsers = users.filter(u => u.username !== usernameToDelete);
    if (users.length === filteredUsers.length) {
      return res.redirect('/settings?msg=User tidak ditemukan&type=error');
    }

    await fs.writeFile(USERS_FILE, JSON.stringify(filteredUsers, null, 2));
    addLog('system', `User ${usernameToDelete} telah dihapus`, req.session.user.username);
    res.redirect('/settings?msg=User berhasil dihapus&type=success');
  } catch (err) {
    console.error('Delete user error:', err);
    res.redirect('/settings?msg=Gagal menghapus user&type=error');
  }
});

// === HALAMAN RIWAYAT (LOGS) ===
app.get('/logs', requireAuth, async (req, res) => {
  try {
    const logs = JSON.parse(await fs.readFile(LOGS_FILE, 'utf8'));
    
    // Pagination Logic
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    
    const results = logs.slice(startIndex, endIndex);
    const totalPages = Math.ceil(logs.length / limit);

    res.render('logs', { 
      logs: results,
      currentPage: page,
      totalPages: totalPages,
      totalEntries: logs.length
    });
  } catch (err) {
    res.status(500).send('Error loading logs');
  }
});

// API: Ubah Password
app.post('/settings/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  
  if (newPassword !== confirmPassword) {
    return res.redirect('/settings?msg=Konfirmasi sandi baru tidak cocok&type=error');
  }

  try {
    const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
    const userIdx = users.findIndex(u => u.username === req.session.user.username);
    
    if (userIdx === -1 || !(await bcrypt.compare(currentPassword, users[userIdx].password))) {
      return res.redirect('/settings?msg=Sandi saat ini salah&type=error');
    }

    users[userIdx].password = await bcrypt.hash(newPassword, 10);
    await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
    
    addLog('auth', `Ganti password berhasil`, req.session.user.username);
    
    res.redirect('/settings?msg=Sandi berhasil diperbarui&type=success');
  } catch (err) {
    console.error('Change password error:', err);
    res.redirect('/settings?msg=Terjadi kesalahan sistem&type=error');
  }
});

// API: Tambah User Baru
app.post('/settings/user/add', requireAuth, async (req, res) => {
  const { newUsername, newUserPassword } = req.body;
  
  if (!newUsername || !newUserPassword) {
    return res.redirect('/settings?msg=Username and Password required&type=error');
  }

  try {
    const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
    
    if (users.some(u => u.username === newUsername)) {
      return res.redirect('/settings?msg=Username sudah digunakan&type=error');
    }

    const hashedPass = await bcrypt.hash(newUserPassword, 10);
    users.push({ username: newUsername, password: hashedPass });
    await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
    addLog('system', `User baru didaftarkan: ${newUsername}`, req.session.user.username);
    
    res.redirect('/settings?msg=User baru berhasil didaftarkan&type=success');
  } catch (err) {
    console.error('Add user error:', err);
    res.redirect('/settings?msg=Terjadi kesalahan sistem&type=error');
  }
});

app.post('/schedule/add', requireAuth, async (req, res) => {
  const { day, time, sound } = req.body;
  const validDays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  if (!validDays.includes(day)) return res.status(400).send('Hari tidak valid');
  if (!time || !sound) return res.status(400).send('Waktu & suara diperlukan');
  try {
    let schedules = JSON.parse(await fs.readFile(SCHEDULES_FILE, 'utf8'));
    schedules = ensureSchedules(schedules);
    schedules[day].push({ time, sound });
    schedules[day].sort((a, b) => a.time.localeCompare(b.time));
    await fs.writeFile(SCHEDULES_FILE, JSON.stringify(schedules, null, 2));
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Add schedule error:', err);
    res.status(500).send('Gagal tambah jadwal');
  }
});

app.post('/schedule/remove', requireAuth, async (req, res) => {
  const { day, index } = req.body;
  const validDays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  if (!validDays.includes(day)) return res.status(400).send('Hari tidak valid');
  try {
    let schedules = JSON.parse(await fs.readFile(SCHEDULES_FILE, 'utf8'));
    schedules = ensureSchedules(schedules);
    schedules[day].splice(parseInt(index), 1);
    await fs.writeFile(SCHEDULES_FILE, JSON.stringify(schedules, null, 2));
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Remove schedule error:', err);
    res.status(500).send('Gagal hapus jadwal');
  }
});

app.post('/schedule/toggle', requireAuth, async (req, res) => {
  try {
    let schedules = JSON.parse(await fs.readFile(SCHEDULES_FILE, 'utf8'));
    schedules = ensureSchedules(schedules);
    schedules.enabled = !schedules.enabled;
    await fs.writeFile(SCHEDULES_FILE, JSON.stringify(schedules, null, 2));
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Toggle error:', err);
    res.status(500).send('Gagal toggle');
  }
});

app.post('/special/add', requireAuth, async (req, res) => {
  const { date, time, sound } = req.body;
  try {
    const special = JSON.parse(await fs.readFile(SPECIAL_SCHEDULES_FILE, 'utf8'));
    special.push({ date, time, sound });
    await fs.writeFile(SPECIAL_SCHEDULES_FILE, JSON.stringify(special, null, 2));
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Add special error:', err);
    res.status(500).send('Gagal tambah jadwal khusus');
  }
});

app.post('/special/remove', requireAuth, async (req, res) => {
  const { index } = req.body;
  try {
    const special = JSON.parse(await fs.readFile(SPECIAL_SCHEDULES_FILE, 'utf8'));
    special.splice(parseInt(index), 1);
    await fs.writeFile(SPECIAL_SCHEDULES_FILE, JSON.stringify(special, null, 2));
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Remove special error:', err);
    res.status(500).send('Gagal hapus jadwal khusus');
  }
});

// === EDIT JADWAL REGULER ===
app.post('/schedule/edit', requireAuth, async (req, res) => {
  const { day, index, time, sound } = req.body;
  const validDays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  if (!validDays.includes(day)) return res.status(400).send('Hari tidak valid');
  if (!time || !sound) return res.status(400).send('Waktu & suara diperlukan');
  try {
    let schedules = JSON.parse(await fs.readFile(SCHEDULES_FILE, 'utf8'));
    schedules = ensureSchedules(schedules);
    const idx = parseInt(index);
    if (idx < 0 || idx >= schedules[day].length) return res.status(400).send('Index tidak valid');
    schedules[day][idx] = { time, sound };
    schedules[day].sort((a, b) => a.time.localeCompare(b.time));
    await fs.writeFile(SCHEDULES_FILE, JSON.stringify(schedules, null, 2));
    addLog('config', `Jadwal ${day} #${idx} diubah: ${time} → ${sound}`, req.session.user.username);
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Edit schedule error:', err);
    res.status(500).send('Gagal edit jadwal');
  }
});

// === EDIT JADWAL KHUSUS ===
app.post('/special/edit', requireAuth, async (req, res) => {
  const { index, date, time, sound } = req.body;
  if (!date || !time || !sound) return res.status(400).send('Data tidak lengkap');
  try {
    const special = JSON.parse(await fs.readFile(SPECIAL_SCHEDULES_FILE, 'utf8'));
    const idx = parseInt(index);
    if (idx < 0 || idx >= special.length) return res.status(400).send('Index tidak valid');
    special[idx] = { date, time, sound };
    await fs.writeFile(SPECIAL_SCHEDULES_FILE, JSON.stringify(special, null, 2));
    addLog('config', `Jadwal khusus #${idx} diubah: ${date} ${time} → ${sound}`, req.session.user.username);
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Edit special error:', err);
    res.status(500).send('Gagal edit jadwal khusus');
  }
});

// 🔊 Upload musik — pakai uploadAudio
app.post('/upload', requireAuth, uploadAudio.single('audiofile'), (req, res) => {
  res.redirect('/dashboard');
});

// API: Set Quick Call File
app.post('/config/quick-call', requireAuth, async (req, res) => {
  const { filename } = req.body;
  try {
    let schedules = JSON.parse(await fs.readFile(SCHEDULES_FILE, 'utf8'));
    schedules = ensureSchedules(schedules);
    schedules.quickCallFile = filename;
    await fs.writeFile(SCHEDULES_FILE, JSON.stringify(schedules, null, 2));
    addLog('system', `Pintasan Panggilan Ketua Kelas diatur ke: ${filename}`, req.session.user.username);
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Config error:', err);
    res.status(500).send('Gagal mengatur pintasan');
  }
});

// 🗑️ Hapus musik
app.post('/music/delete', requireAuth, async (req, res) => {
  const file = path.basename(req.body.file || '');
  if (!file) return res.redirect('/dashboard');
  try {
    await fs.unlink(path.join(MUSIC_DIR, file));
    res.redirect('/dashboard');
  } catch (e) {
    console.error('Delete error:', e);
    res.redirect('/dashboard');
  }
});

app.post('/rename', requireAuth, async (req, res) => {
  const oldname = path.basename(req.body.oldname || '');
  const newname = path.basename(req.body.newname || '');
  if (!oldname || !newname) return res.status(400).send('Nama diperlukan');
  if (!/^[a-zA-Z0-9._-]+$/.test(newname)) return res.status(400).send('Nama tidak valid');
  if (newname === oldname) return res.redirect('/dashboard');
  try {
    await fs.rename(path.join(MUSIC_DIR, oldname), path.join(MUSIC_DIR, newname));
    res.redirect('/dashboard?rename=success');
  } catch (err) {
    console.error('Rename error:', err);
    res.redirect('/dashboard?rename=error');
  }
});

app.get('/preview/:file', requireAuth, (req, res) => {
  const file = path.basename(req.params.file || '');
  res.render('preview', { file });
});

app.post('/play', requireAuth, (req, res) => {
  const file = path.basename(req.body.file || '');
  if (!file) return res.status(400).send('File diperlukan');
  
  if (isAudioPlaying) {
    return res.redirect('/dashboard?msg=Sistem sedang memutar audio lain&type=error');
  }

  // Gunakan fungsi playSound yang sudah mencakup Relay & State Management
  playSound(file, req.session.user.username);
  res.redirect('/dashboard?play=success');
});

app.post('/stop', requireAuth, (req, res) => {
  try {
    // Step 1: Unpipe all streams first to prevent EPIPE crashes
    if (activeFfmpegProcess && activeFfmpegProcess.stdout && activeAudioProcess && activeAudioProcess.stdin) {
      try { activeFfmpegProcess.stdout.unpipe(activeAudioProcess.stdin); } catch (e) {}
    }
    if (liveMicFfmpeg && liveMicFfmpeg.stdout && liveMicProcess && liveMicProcess.stdin) {
      try { liveMicFfmpeg.stdout.unpipe(liveMicProcess.stdin); } catch (e) {}
    }

    // Step 2: Force-kill all processes with SIGKILL (not SIGTERM)
    if (activeAudioProcess) { try { activeAudioProcess.kill('SIGKILL'); } catch (e) {} }
    if (activeFfmpegProcess) { try { activeFfmpegProcess.kill('SIGKILL'); } catch (e) {} }
    if (liveMicProcess) { try { liveMicProcess.kill('SIGKILL'); } catch (e) {} }
    if (liveMicFfmpeg) { try { liveMicFfmpeg.stdin.end(); } catch (e) {} try { liveMicFfmpeg.kill('SIGKILL'); } catch (e) {} }
    
    // Step 3: Immediate pkill safeguard (don't wait)
    spawn('pkill', ['-9', '-f', 'aplay']);
    spawn('pkill', ['-9', '-f', 'ffmpeg']);
    
    // Step 4: Reset ALL state
    isAudioPlaying = false;
    activeAudioName = null;
    activeAudioProcess = null;
    activeFfmpegProcess = null;
    liveMicProcess = null;
    liveMicFfmpeg = null;
    
    if (!manualOverride) relayOff();

    // Step 5: Second safeguard after 2s in case processes took time to die
    setTimeout(() => {
      spawn('pkill', ['-9', '-f', 'aplay']);
      spawn('pkill', ['-9', '-f', 'ffmpeg']);
      // Force reset state again
      isAudioPlaying = false;
      activeAudioName = null;
      activeAudioProcess = null;
      activeFfmpegProcess = null;
      liveMicProcess = null;
      liveMicFfmpeg = null;
    }, 2000);

    addLog('audio', `Semua audio dihentikan manual`, req.session.user.username);

    res.redirect('/dashboard?stop=success');
  } catch (err) {
    console.error('Stop error:', err);
    // Even on error, force kill everything
    spawn('pkill', ['-9', '-f', 'aplay']);
    spawn('pkill', ['-9', '-f', 'ffmpeg']);
    isAudioPlaying = false;
    activeAudioName = null;
    activeAudioProcess = null;
    activeFfmpegProcess = null;
    liveMicProcess = null;
    liveMicFfmpeg = null;
    res.redirect('/dashboard?stop=error');
  }
});

app.get('/export/schedules.json', requireAuth, async (req, res) => {
  try {
    let schedules = JSON.parse(await fs.readFile(SCHEDULES_FILE, 'utf8'));
    schedules = ensureSchedules(schedules);
    const special = JSON.parse(await fs.readFile(SPECIAL_SCHEDULES_FILE, 'utf8'));
    res.setHeader('Content-Disposition', 'attachment; filename="jadwal.json"');
    res.json({ schedules, special });
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).send('Gagal export');
  }
});

// 📥 Import jadwal — pakai uploadJson (bukan uploadAudio)
app.post('/import', requireAuth, uploadJson.single('importfile'), async (req, res) => {
  if (!req.file) return res.status(400).send('File tidak ada');
  try {
    const rawData = await fs.readFile(req.file.path, 'utf8');
    let data;
    try {
      data = JSON.parse(rawData);
    } catch (parseErr) {
      await fs.unlink(req.file.path);
      return res.status(400).send('Format file JSON tidak valid');
    }

    if (data.schedules) {
      // Basic validation to prevent completely broken data
      if (typeof data.schedules !== 'object' || Array.isArray(data.schedules)) {
         throw new Error('Format schedules tidak valid');
      }
      let s = ensureSchedules(data.schedules);
      await fs.writeFile(SCHEDULES_FILE, JSON.stringify(s, null, 2));
    }
    if (data.special) {
      if (!Array.isArray(data.special)) {
         throw new Error('Format special schedules tidak valid');
      }
      await fs.writeFile(SPECIAL_SCHEDULES_FILE, JSON.stringify(data.special, null, 2));
    }
    await fs.unlink(req.file.path);
    res.redirect('/dashboard?import=success');
  } catch (e) {
    console.error('Import error:', e);
    // Cleanup if file still exists
    try { if (req.file && req.file.path) await fs.unlink(req.file.path); } catch (cleanErr) {}
    res.redirect('/dashboard?import=error');
  }
});

// =======================
// MANUAL AMPLIFIER CONTROL
// =======================

// Cek apakah relay device tersedia
const checkRelayDevice = () => {
  try {
    return fsSync.existsSync(RELAY_DEVICE);
  } catch (err) {
    console.error('Error checking relay device:', err);
    return false;
  }
};

app.post("/ampli/on", requireAuth, async (req, res) => {
  try {
    // Cek device availability
    if (!checkRelayDevice()) {
      return res.status(503).json({ 
        success: false, 
        error: 'Relay device tidak ditemukan',
        device: RELAY_DEVICE
      });
    }

    manualOverride = true;

    exec(RELAY_ON, (error) => {
      if (error) {
        console.error('❌ Gagal menyalakan amplifier:', error);
        relayStatus = false;
        return res.json({ 
          success: false, 
          error: 'Gagal menyalakan amplifier',
          status: "OFF"
        });
      }
      
      relayStatus = true;
      console.log("✅ 🔌 Amplifier ON (manual)");
      
      // Tunggu warmup sebelum kirim response
      setTimeout(() => {
        res.json({ 
          success: true, 
          status: "ON",
          message: "Amplifier menyala"
        });
      }, AMP_WARMUP);
    });
  } catch (err) {
    console.error('❌ Error di /ampli/on:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Terjadi kesalahan server',
      status: relayStatus ? "ON" : "OFF"
    });
  }
});

app.post("/ampli/off", requireAuth, async (req, res) => {
  try {
    // Cek device availability
    if (!checkRelayDevice()) {
      return res.status(503).json({ 
        success: false, 
        error: 'Relay device tidak ditemukan',
        device: RELAY_DEVICE
      });
    }

    manualOverride = false;

    exec(RELAY_OFF, (error) => {
      if (error) {
        console.error('❌ Gagal mematikan amplifier:', error);
        relayStatus = true;
        return res.json({ 
          success: false, 
          error: 'Gagal mematikan amplifier',
          status: "ON"
        });
      }
      
      relayStatus = false;
      console.log("✅ 🔌 Amplifier OFF (manual)");
      
      res.json({ 
        success: true, 
        status: "OFF",
        message: "Amplifier mati"
      });
    });
  } catch (err) {
    console.error('❌ Error di /ampli/off:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Terjadi kesalahan server',
      status: relayStatus ? "ON" : "OFF"
    });
  }
});

app.get("/ampli/status", requireAuth, async (req, res) => {
  try {
    const deviceAvailable = checkRelayDevice();
    
    res.json({
      relay: relayStatus ? "ON" : "OFF",
      manualOverride,
      deviceAvailable,
      device: RELAY_DEVICE,
      audio: {
        isPlaying: isAudioPlaying,
        activeFile: activeAudioName
      },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('❌ Error di /ampli/status:', err);
    res.status(500).json({
      relay: "UNKNOWN",
      manualOverride: false,
      deviceAvailable: false,
      error: 'Gagal mendapatkan status'
    });
  }
});

// Endpoint untuk cek kesehatan relay
app.get("/ampli/health", requireAuth, async (req, res) => {
  const deviceAvailable = checkRelayDevice();
  
  res.json({
    status: deviceAvailable ? "OK" : "ERROR",
    device: RELAY_DEVICE,
    deviceAvailable,
    relayStatus: relayStatus ? "ON" : "OFF",
    manualOverride
  });
});

const runScheduler = async () => {
  try {
    if (!fsSync.existsSync(SCHEDULES_FILE)) {
      console.log('ℹ️ Schedule file tidak ditemukan, skip...');
      return;
    }

    const now = new Date();
    const year  = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day   = String(now.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;
    const timeStr = now.toTimeString().slice(0,5);

    const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const dayKey = dayKeys[now.getDay()];

    console.log(`🕐 Scheduler check - ${dateStr} ${timeStr} (${dayKey})`);

    // Cek jadwal khusus
    const special = JSON.parse(await fs.readFile(SPECIAL_SCHEDULES_FILE, 'utf8'));
    const todaySpecial = special.find(s => s.date === dateStr && s.time === timeStr);
    
    if (todaySpecial) {
      console.log(`🎯 Jadwal khusus ditemukan: ${todaySpecial.sound}`);
      return playSound(todaySpecial.sound);
    }

    // Cek jadwal reguler
    let schedules = JSON.parse(await fs.readFile(SCHEDULES_FILE, 'utf8'));
    schedules = ensureSchedules(schedules);
    
    if (!schedules.enabled) {
      console.log('⏸️ Jadwal reguler dinonaktifkan');
      return;
    }

    const list = schedules[dayKey] || [];
    const match = list.find(s => s.time === timeStr);
    
    if (match) {
      console.log(`⏰ Jadwal reguler: ${match.sound}`);
      playSound(match.sound);
    } else {
      console.log('ℹ️ Tidak ada jadwal untuk waktu ini');
    }
  } catch (err) {
    console.error('❌ Scheduler error:', err);
  }
};

const playSound = async (filename, user = 'System') => {
  try {
    const filePath = path.join(MUSIC_DIR, filename);
    if (!fsSync.existsSync(filePath)) {
      console.error(`❌ File tidak ditemukan: ${filename}`);
      return;
    }

    if (isAudioPlaying) {
      console.log(`⚠️ Skip pemutaran "${filename}" karena audio lain sedang diputar`);
      return;
    }

    console.log(`🎵 Memutar: ${filename} (oleh: ${user})`);
    isAudioPlaying = true;
    activeAudioName = filename;
    addLog('audio', `Memutar audio: ${filename}`, user);

    // 🔌 NYALAKAN AMPLI DULU (hanya jika bukan manual override)
    if (!manualOverride) {
      await relayOn();
    } else {
      console.log("ℹ️ Manual override aktif, amplifier tidak dinyalakan otomatis");
    }

    if (filename.toLowerCase().endsWith('.wav')) {
      activeAudioProcess = spawn('aplay', ['-D', 'plughw:0,0', filePath]);
    } else if (filename.toLowerCase().endsWith('.mp3')) {
      activeFfmpegProcess = spawn('ffmpeg', ['-i', filePath, '-f', 'wav', '-loglevel', 'quiet', '-']);
      activeAudioProcess = spawn('aplay', ['-D', 'plughw:0,0', '-q']);
      activeFfmpegProcess.stdout.pipe(activeAudioProcess.stdin);
      activeFfmpegProcess.stderr.resume();
    } else {
      console.error(`❌ Format file tidak didukung: ${filename}`);
      isAudioPlaying = false;
      activeAudioName = null;
      if (!manualOverride) relayOff();
      return;
    }

    const handleError = (err) => {
      if (err.code !== 'EPIPE') {
        console.error('❌ Play error:', err);
      }
      isAudioPlaying = false;
      activeAudioName = null;
      activeAudioProcess = null;
      activeFfmpegProcess = null;
      if (!manualOverride) relayOff();
    };

    if (activeAudioProcess) {
      activeAudioProcess.on('error', handleError);

      activeAudioProcess.on('close', (code) => {
        console.log(`✅ Audio selesai (exit code: ${code})`);
        isAudioPlaying = false;
        activeAudioName = null;
        activeAudioProcess = null;
        activeFfmpegProcess = null;
        if (!manualOverride) {
          relayOff(); // 🔌 MATIKAN AMPLI setelah selesai (jika bukan manual)
        }
      });
    }
    
    if (activeFfmpegProcess) {
       activeFfmpegProcess.on('error', handleError);
    }
  } catch (err) {
    console.error('❌ Error di playSound:', err);
    isAudioPlaying = false;
    activeAudioName = null;
    activeAudioProcess = null;
    activeFfmpegProcess = null;
    if (!manualOverride) relayOff();
  }
};
  

// const playSound = (filename) => {
//   const filePath = path.join(MUSIC_DIR, filename);
//   if (!fsSync.existsSync(filePath)) return;
//   const handleError = (err) => { if (err.code !== 'EPIPE') console.error('Play error:', err); };
//   if (filename.toLowerCase().endsWith('.wav')) {
//     const proc = spawn('aplay', ['-D', 'plughw:0,0', filePath]);
//     proc.on('error', handleError);
//   } else if (filename.toLowerCase().endsWith('.mp3')) {
//     const ffmpeg = spawn('ffmpeg', ['-i', filePath, '-f', 'wav', '-loglevel', 'quiet', '-']);
//     const aplay = spawn('aplay', ['-D', 'plughw:0,0', '-q']);
//     ffmpeg.stdout.pipe(aplay.stdin);
//     ffmpeg.stderr.resume();
//     ffmpeg.on('error', handleError);
//     aplay.on('error', handleError);
//   }
// };

cron.schedule('* * * * *', runScheduler);

app.get('/music/:file', requireAuth, (req, res) => {
  const file = path.basename(req.params.file || '');
  if (!file) return res.status(404).send('File tidak valid');
  const p = path.join(MUSIC_DIR, file);
  res.sendFile(p, err => {
    if (err) res.status(404).send('File not found');
  });
});

app.get('/', (req, res) => {
  res.redirect(req.session.user ? '/dashboard' : '/login');
});

// =======================
// LIVE MICROPHONE (PA)
// =======================

io.on('connection', (socket) => {
  // Track cleanup state per socket to prevent double-cleanup race conditions
  let micCleanedUp = false;

  socket.on('start-mic', async () => {
    if (isAudioPlaying) {
      return socket.emit('mic-error', 'Sistem sedang sibuk');
    }

    console.log('🎙️ Memulai siaran langsung...');
    micCleanedUp = false;
    isAudioPlaying = true;
    activeAudioName = "SIARAN LANGSUNG";
    addLog('audio', 'Memulai pengumuman langsung', 'Admin');

    if (!manualOverride) await relayOn();

    // Spawn ffmpeg to decode incoming WebM/Opus and pipe to aplay
    liveMicFfmpeg = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-f', 's16le',
      '-ar', '44100',
      '-ac', '1',
      'pipe:1',
      '-loglevel', 'quiet'
    ]);

    liveMicProcess = spawn('aplay', ['-D', 'plughw:0,0', '-r', '44100', '-f', 'S16_LE', '-c', '1', '-q']);

    // Error handlers to prevent unhandled exceptions and reset state
    liveMicFfmpeg.on('error', (err) => {
      console.error('❌ Live mic ffmpeg error:', err.message);
      cleanupMic('ffmpeg error');
    });

    liveMicProcess.on('error', (err) => {
      console.error('❌ Live mic aplay error:', err.message);
      cleanupMic('aplay error');
    });

    // If aplay exits unexpectedly (e.g. device busy), trigger full cleanup
    liveMicProcess.on('close', (code) => {
      console.log(`ℹ️ Live mic aplay closed (exit code: ${code})`);
      cleanupMic('aplay closed');
    });

    // If ffmpeg exits unexpectedly, trigger full cleanup
    liveMicFfmpeg.on('close', (code) => {
      console.log(`ℹ️ Live mic ffmpeg closed (exit code: ${code})`);
      // Only cleanup if aplay hasn't already triggered it
      if (!micCleanedUp) {
        cleanupMic('ffmpeg closed');
      }
    });

    // Pipe ffmpeg decoded output to aplay
    liveMicFfmpeg.stdout.pipe(liveMicProcess.stdin);

    // Suppress ffmpeg stderr
    if (liveMicFfmpeg.stderr) liveMicFfmpeg.stderr.resume();

    socket.emit('mic-ready');
  });

  socket.on('audio-data', (data) => {
    if (liveMicFfmpeg && liveMicFfmpeg.stdin && liveMicFfmpeg.stdin.writable) {
      try {
        liveMicFfmpeg.stdin.write(data);
      } catch (e) {
        // stdin might be destroyed between writable check and write
        console.error('❌ Error writing audio data:', e.message);
      }
    }
  });

  const cleanupMic = (reason = 'manual') => {
    // Prevent double cleanup (both ffmpeg close + aplay close can fire)
    if (micCleanedUp) return;
    micCleanedUp = true;

    console.log(`🧹 Membersihkan mic (alasan: ${reason})`);

    // Step 1: Unpipe to prevent EPIPE crashes
    if (liveMicFfmpeg && liveMicFfmpeg.stdout && liveMicProcess && liveMicProcess.stdin) {
      try { liveMicFfmpeg.stdout.unpipe(liveMicProcess.stdin); } catch (e) {}
    }

    // Step 2: Close ffmpeg stdin gracefully, then force kill
    if (liveMicFfmpeg) {
      try { liveMicFfmpeg.stdin.end(); } catch (e) {}
      try { liveMicFfmpeg.kill('SIGKILL'); } catch (e) {}
      liveMicFfmpeg = null;
    }

    // Step 3: Kill aplay
    if (liveMicProcess) {
      try { liveMicProcess.kill('SIGKILL'); } catch (e) {}
      liveMicProcess = null;
    }

    // Step 4: Safeguard — kill any lingering aplay/ffmpeg child processes
    // This is critical to free the audio device /dev/snd/*
    try {
      spawn('pkill', ['-f', 'aplay.*plughw']);
    } catch (e) {}
    try {
      spawn('pkill', ['-f', 'ffmpeg.*pipe']);
    } catch (e) {}

    // Step 5: Reset global audio state
    if (isAudioPlaying && activeAudioName === "SIARAN LANGSUNG") {
      isAudioPlaying = false;
      activeAudioName = null;
      activeAudioProcess = null;
      activeFfmpegProcess = null;
      if (!manualOverride) relayOff();
    }

    // Step 6: Final safety net — if state somehow stuck after 3 seconds, force reset
    setTimeout(() => {
      if (isAudioPlaying && activeAudioName === "SIARAN LANGSUNG") {
        console.warn('⚠️ Force-resetting stuck audio state after mic cleanup');
        isAudioPlaying = false;
        activeAudioName = null;
        activeAudioProcess = null;
        activeFfmpegProcess = null;
        liveMicProcess = null;
        liveMicFfmpeg = null;
        // Do one more pkill to be absolutely sure
        spawn('pkill', ['-9', '-f', 'aplay']);
        if (!manualOverride) relayOff();
      }
    }, 3000);
  };

  socket.on('stop-mic', () => {
    console.log('🛑 Menghentikan siaran langsung');
    cleanupMic('stop-mic');
    addLog('audio', 'Pengumuman langsung selesai', 'Admin');
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err);
    cleanupMic('socket error');
  });

  socket.on('disconnect', () => {
    console.log('⚠️ Socket disconnected, membersihkan mic...');
    cleanupMic('socket disconnect');
  });
});

// 404 Security Handler
app.use((req, res) => {
  res.redirect('/dashboard');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Bel Sekolah vFINAL berjalan di http://localhost:${PORT}`);
});
