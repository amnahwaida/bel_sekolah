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

// Command ON / OFF (TANPA sudo, karena di dalam container)
const RELAY_ON  = `printf '\\x00\\xFF\\x01\\x00\\x00\\x00\\x00\\x00' > ${RELAY_DEVICE} 2>/dev/null`;
const RELAY_OFF = `printf '\\x00\\xFD\\x01\\x00\\x00\\x00\\x00\\x00' > ${RELAY_DEVICE} 2>/dev/null`;

// Mutex & debounce untuk mencegah race condition saat spam on/off
let relayBusy = false;        // lock agar tidak ada dua perintah relay bersamaan
let relayDebounceTimer = null; // debounce timer
const RELAY_DEBOUNCE_MS = 1000; // minimum jeda antar perintah relay (ms)

// Anti-spam mutex untuk /play, /stop, /schedule/toggle
let playBusy = false;          // mutex untuk mencegah spam klik play
let stopBusy = false;          // mutex untuk mencegah spam klik stop
let toggleBusy = false;        // mutex untuk mencegah spam toggle schedule
const PLAY_COOLDOWN_MS = 3000; // cooldown play (termasuk relay warmup)
const STOP_COOLDOWN_MS = 2000; // cooldown stop
const TOGGLE_COOLDOWN_MS = 1500; // cooldown toggle schedule

// Rate limiter untuk login (anti brute-force)
const loginAttempts = new Map(); // Map<IP, { count, lastAttempt }>
const LOGIN_MAX_ATTEMPTS = 5;   // max percobaan
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 menit window
const LOGIN_LOCKOUT_MS = 5 * 60 * 1000; // lockout 5 menit setelah max attempts

// Relay write dengan auto-retry untuk menghindari hardware EPROTO fail di STB
const writeRelay = async (cmd, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      await new Promise((resolve, reject) => {
        exec(cmd, (error) => {
          if (error) reject(error);
          else resolve(true);
        });
      });
      return true; // Berhasil
    } catch (error) {
      if (i === retries - 1) throw error; // Jika percobaan terakhir gagal
      console.warn(`⚠️ EPROTO/Write fail... retry ${i+1}/${retries}`);
      await new Promise(r => setTimeout(r, 500)); // tunggu sebelum retry
    }
  }
};

// Delay sebelum play (ms)
const AMP_WARMUP = 6500; // warmup 6.5 detik agar ampli sepenuhnya aktif dan tidak ada fade in hardware

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
app.use(express.static(path.join(__dirname, 'public')));

// DYNAMIC PWA ICON ROUTE
app.get('/pwa-icon.svg', async (req, res) => {
  try {
    const branding = JSON.parse(await fs.readFile(BRANDING_FILE, 'utf8'));
    const themeMap = {
      midnight: '#1e3a8a', emerald: '#065f46', amethyst: '#6b21a8', crimson: '#9f1239',
      amber: '#92400e', slated: '#334155', teal: '#115e59', indigo: '#3730a3',
      graphite: '#1e293b', aurora: '#0369a1'
    };
    const primaryColor = themeMap[branding.theme] || '#1e3a8a';
    
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
        <rect width="512" height="512" rx="120" fill="${primaryColor}"/>
        <text x="50%" y="54%" font-family="Arial, sans-serif" font-weight="900" font-size="200" fill="white" text-anchor="middle" dominant-baseline="middle">BEL</text>
      </svg>
    `.trim();

    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
  } catch (err) {
    res.status(500).send('Error generating icon');
  }
});

// Middleware untuk menyuplai data user dan branding ke semua view
app.use(async (req, res, next) => {
  res.locals.user = req.session.user || null;
  try {
    const data = await fs.readFile(BRANDING_FILE, 'utf8');
    res.locals.branding = JSON.parse(data);
  } catch (e) {
    res.locals.branding = {}; // Fallback
  }
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
const BRANDING_FILE = path.join(DATA_DIR, 'branding.json');
const AUDIO_SETTINGS_FILE = path.join(DATA_DIR, 'audio_settings.json');

if (!fsSync.existsSync(USERS_FILE)) fsSync.writeFileSync(USERS_FILE, JSON.stringify([{ username: 'smamsa', password: 'smamsa12', role: 'root' }]));
if (!fsSync.existsSync(SCHEDULES_FILE)) fsSync.writeFileSync(SCHEDULES_FILE, JSON.stringify({
  enabled: true,
  mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: []
}));
if (!fsSync.existsSync(SPECIAL_SCHEDULES_FILE)) fsSync.writeFileSync(SPECIAL_SCHEDULES_FILE, JSON.stringify([]));
if (!fsSync.existsSync(LOGS_FILE)) fsSync.writeFileSync(LOGS_FILE, JSON.stringify([]));
if (!fsSync.existsSync(BRANDING_FILE)) {
  fsSync.writeFileSync(BRANDING_FILE, JSON.stringify({
    loginWelcome: "Selamat Datang",
    loginSubtitle: "Masuk ke Sistem Bel Sekolah",
    appName: "SMAMUHI",
    appSub: "Advanced Bell",
    footerCredit: 'Crafted with ❤️ by <a href="mailto:vannyezhaa@gmail.com" class="text-primary-400 hover:text-primary-300 transition-colors">vannyezha</a> </br> Business & Collaboration: +6285159982101',
    pageTitle: "BELL-SMAMUHI",
    theme: "crimson",
    logoUrl: null,
    faviconUrl: null
  }, null, 2));
}

// Default audio settings
const DEFAULT_AUDIO_SETTINGS = {
  volume: 85,     // 0-100 (amixer master volume %)
  bass: 0,        // -20 to +20 dB
  treble: 0,      // -20 to +20 dB  
  midrange: 0,    // -20 to +20 dB (mid EQ)
  micVolume: 100, // 0-100 (mic gain for live mic)
  micBass: 0,     // -20 to +20 dB
  micTreble: 0    // -20 to +20 dB
};
if (!fsSync.existsSync(AUDIO_SETTINGS_FILE)) {
  fsSync.writeFileSync(AUDIO_SETTINGS_FILE, JSON.stringify(DEFAULT_AUDIO_SETTINGS, null, 2));
}

// Helper: Read audio settings
const getAudioSettings = () => {
  try {
    return { ...DEFAULT_AUDIO_SETTINGS, ...JSON.parse(fsSync.readFileSync(AUDIO_SETTINGS_FILE, 'utf8')) };
  } catch (e) {
    return { ...DEFAULT_AUDIO_SETTINGS };
  }
};

// Helper: Build ffmpeg audio filter string from settings
const buildAudioFilter = (settings, isMic = false) => {
  const filters = [];
  const bass = isMic ? (settings.micBass || 0) : (settings.bass || 0);
  const treble = isMic ? (settings.micTreble || 0) : (settings.treble || 0);
  const mid = isMic ? 0 : (settings.midrange || 0);
  const vol = isMic ? (settings.micVolume || 100) : (settings.volume || 100);
  
  // Bass EQ (low shelf at 100Hz)
  if (bass !== 0) {
    filters.push(`equalizer=f=100:t=h:w=200:g=${bass}`);
  }
  // Midrange EQ (peak at 1000Hz)
  if (mid !== 0) {
    filters.push(`equalizer=f=1000:t=h:w=800:g=${mid}`);
  }
  // Treble EQ (high shelf at 3000Hz)
  if (treble !== 0) {
    filters.push(`equalizer=f=3000:t=h:w=2000:g=${treble}`);
  }
  // Volume adjustment
  if (vol !== 100) {
    filters.push(`volume=${vol / 100}`);
  }
  
  return filters.length > 0 ? filters.join(',') : null;
};

// Helper: Apply system volume via amixer
const applySystemVolume = (volumePercent) => {
  try {
    // Coba berbagai control name yang umum di STB/Linux
    const controls = ['Master', 'PCM', 'Speaker', 'Headphone'];
    for (const ctrl of controls) {
      try {
        require('child_process').execSync(`amixer set '${ctrl}' ${volumePercent}% 2>/dev/null`, { timeout: 2000 });
        console.log(`🔊 Volume ${ctrl} diatur ke ${volumePercent}%`);
        return true;
      } catch (e) { /* skip unavailable control */ }
    }
    console.warn('⚠️ Tidak ada ALSA control yang tersedia untuk volume');
    return false;
  } catch (e) {
    console.error('❌ Gagal mengatur volume sistem:', e.message);
    return false;
  }
};

// HELPER: Safe Redirect Back
const safeRedirect = (req, res, defaultPath, queryParams = {}) => {
  const referer = req.get('Referer');
  let target = referer || defaultPath;
  try {
    const url = new URL(target, `http://${req.headers.host || 'localhost'}`);
    // Hapus parameter feedback sebelumnya
    url.searchParams.delete('msg');
    url.searchParams.delete('type');
    url.searchParams.delete('play');
    url.searchParams.delete('stop');
    url.searchParams.delete('import');
    url.searchParams.delete('rename');
    for (const [k, v] of Object.entries(queryParams)) {
      url.searchParams.set(k, v);
    }
    target = url.pathname + url.search;
  } catch (e) {}
  res.redirect(target);
};

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

// HELPER: Delete Asset File Safely (Storage Optimization for STB)
const deleteFileSafely = async (fileUrl) => {
  if (!fileUrl || !fileUrl.startsWith('/branding/')) return;
  try {
    const fileName = fileUrl.replace('/branding/', '');
    const fullPath = path.join(__dirname, 'public', 'branding', fileName);
    if (fsSync.existsSync(fullPath)) {
      await fs.unlink(fullPath);
      console.log(`[Storage Cleanup] Deleted redundant asset: ${fileName}`);
    }
  } catch (err) {
    console.error(`[Storage Cleanup Error] Failed to delete ${fileUrl}:`, err);
  }
};

// HELPER: Migration (Plain to Hash & Roles)
const migrateUsers = async () => {
  try {
    const data = await fs.readFile(USERS_FILE, 'utf8');
    const users = JSON.parse(data);
    let changed = false;

    for (let user of users) {
      // 1. Password Migration
      if (!user.password.startsWith('$2a$') && !user.password.startsWith('$2b$')) {
        console.log(`🔐 Migrating password for user: ${user.username}`);
        user.password = await bcrypt.hash(user.password, 10);
        changed = true;
      }
      // 2. Role Migration (Default to root if missing)
      if (!user.role) {
        console.log(`🛡️ Assigning default role (root) to user: ${user.username}`);
        user.role = 'root';
        changed = true;
      }
    }

    if (changed) {
      await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
      console.log('✅ User data migration complete.');
      addLog('system', 'Migrasi data pengguna (enkripsi & level akses) berhasil dilakukan');
    }
  } catch (err) {
    console.error('Migration error:', err);
  }
};

migrateUsers();

// === Upload Audio (.mp3/.wav) ===
const BRANDING_UPLOAD_DIR = path.join(__dirname, 'public', 'branding');
if (!fsSync.existsSync(BRANDING_UPLOAD_DIR)) fsSync.mkdirSync(BRANDING_UPLOAD_DIR, { recursive: true });

const uploadBranding = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, BRANDING_UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      const field = file.fieldname;
      cb(null, `${field}-${Date.now()}${ext}`);
    }
  })
});

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

const requireRoot = (req, res, next) => {
  if (req.session.user && req.session.user.role === 'root') return next();
  res.redirect('/settings?msg=Akses ditolak: Hanya Root yang dapat mengelola pengguna&type=error');
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
    if (!checkRelayDevice()) {
      console.warn("⚠️ Relay device tidak tersedia, skip relayOn");
      resolve();
      return;
    }

    // Mutex: cegah concurrent write ke device
    if (relayBusy) {
      console.log("⏳ Relay sedang diproses, menunggu...");
      const waitInterval = setInterval(() => {
        if (!relayBusy) {
          clearInterval(waitInterval);
          doRelayOn(resolve);
        }
      }, 100);
      // Safety timeout agar tidak stuck selamanya
      setTimeout(() => {
        clearInterval(waitInterval);
        relayBusy = false;
        doRelayOn(resolve);
      }, 2000);
      return;
    }

    doRelayOn(resolve);
  });
};

const doRelayOn = async (resolve) => {
  relayBusy = true;
  try {
    await writeRelay(RELAY_ON);
    relayStatus = true;
    console.log("🔌 Amplifier ON");
  } catch (error) {
    console.error("⚠️ Gagal menyalakan relay:", error.message);
  } finally {
    // Beri jeda sebelum bisa dipakai lagi
    setTimeout(() => { relayBusy = false; }, RELAY_DEBOUNCE_MS);
  }
  setTimeout(resolve, AMP_WARMUP);
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

  if (!checkRelayDevice()) {
    console.warn("⚠️ Relay device tidak tersedia, reset status ke OFF");
    relayStatus = false;
    return;
  }

  // Mutex: cegah concurrent write
  if (relayBusy) {
    console.log("⏳ Relay sedang diproses, jadwalkan OFF setelah selesai...");
    const waitInterval = setInterval(() => {
      if (!relayBusy) {
        clearInterval(waitInterval);
        doRelayOff();
      }
    }, 100);
    setTimeout(() => {
      clearInterval(waitInterval);
      relayBusy = false;
      doRelayOff();
    }, 2000);
    return;
  }

  doRelayOff();
};

const doRelayOff = async () => {
  relayBusy = true;
  try {
    await writeRelay(RELAY_OFF);
    relayStatus = false;
    console.log("✅ 🔌 Amplifier OFF (otomatis)");
  } catch (error) {
    console.error('⚠️ Gagal mematikan relay:', error.message);
    relayStatus = false; // Reset status anyway
  } finally {
    setTimeout(() => { relayBusy = false; }, RELAY_DEBOUNCE_MS);
  }
};


app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
  
  // Rate limiting: cek apakah IP ini sedang di-lockout
  const attempts = loginAttempts.get(clientIP);
  if (attempts) {
    const timeSinceFirst = Date.now() - attempts.firstAttempt;
    
    // Jika sudah melewati window, reset counter
    if (timeSinceFirst > LOGIN_WINDOW_MS) {
      loginAttempts.delete(clientIP);
    } else if (attempts.count >= LOGIN_MAX_ATTEMPTS) {
      const lockoutRemaining = Math.ceil((LOGIN_LOCKOUT_MS - (Date.now() - attempts.lastAttempt)) / 1000);
      if (lockoutRemaining > 0) {
        addLog('auth', `Login diblokir (rate limit): ${username} dari IP ${clientIP}`, username);
        return res.render('login', { error: `⛔ Terlalu banyak percobaan. Coba lagi dalam ${Math.ceil(lockoutRemaining / 60)} menit.` });
      } else {
        // Lockout sudah habis, reset
        loginAttempts.delete(clientIP);
      }
    }
  }
  
  try {
    const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
    const user = users.find(u => u.username === username);
    
    if (user && await bcrypt.compare(password, user.password)) {
      // Login berhasil — reset counter
      loginAttempts.delete(clientIP);
      req.session.user = { 
        username: user.username,
        role: user.role || 'admin'
      };
      addLog('auth', `User ${username} berhasil login (${req.session.user.role})`, username);
      return res.redirect('/dashboard');
    }
    
    // Login gagal — increment counter
    const current = loginAttempts.get(clientIP) || { count: 0, firstAttempt: Date.now(), lastAttempt: Date.now() };
    current.count++;
    current.lastAttempt = Date.now();
    loginAttempts.set(clientIP, current);
    
    const remaining = LOGIN_MAX_ATTEMPTS - current.count;
    addLog('auth', `Gagal login: Username ${username} (sisa ${remaining} percobaan dari IP ${clientIP})`, username);
    
    if (remaining <= 0) {
      res.render('login', { error: `⛔ Akun dikunci sementara. Coba lagi dalam 5 menit.` });
    } else if (remaining <= 2) {
      res.render('login', { error: `❌ Username/password salah (sisa ${remaining} percobaan)` });
    } else {
      res.render('login', { error: '❌ Username/password salah' });
    }
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
    res.render('dashboard', { 
      schedules,
      relayStatus,
      manualOverride,
      activePage: 'dashboard',
      quickCallFile: schedules.quickCallFile || null
    });
  } catch (err) {
    console.error('Render error:', err);
    res.status(500).send('<h2>❌ Error Dashboard</h2><pre>' + (err.message || err) + '</pre>');
  }
});

app.get('/schedules', requireAuth, async (req, res) => {
  try {
    let schedules = JSON.parse(await fs.readFile(SCHEDULES_FILE, 'utf8'));
    schedules = ensureSchedules(schedules);
    const special = JSON.parse(await fs.readFile(SPECIAL_SCHEDULES_FILE, 'utf8'));
    const files = await fs.readdir(MUSIC_DIR);
    const musicFiles = files.filter(f => /\.(mp3|wav)$/i.test(f));
    res.render('schedules', { 
      schedules, special, musicFiles,
      activePage: 'schedules',
      import: req.query.import
    });
  } catch (err) {
    res.status(500).send('Error loading schedules');
  }
});

app.get('/audio', requireAuth, async (req, res) => {
  try {
    const files = await fs.readdir(MUSIC_DIR);
    const musicFiles = files.filter(f => /\.(mp3|wav)$/i.test(f));
    let schedules = JSON.parse(await fs.readFile(SCHEDULES_FILE, 'utf8'));
    schedules = ensureSchedules(schedules);
    const audioSettings = getAudioSettings();
    res.render('audio', { 
      musicFiles,
      activePage: 'audio',
      quickCallFile: schedules.quickCallFile || null,
      rename: req.query.rename,
      audioSettings
    });
  } catch (err) {
    res.status(500).send('Error loading audio library');
  }
});

// === HALAMAN PENGATURAN ===
app.get('/settings', requireAuth, async (req, res) => {
  try {
    const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
    res.render('settings', { 
      msg: req.query.msg || null, 
      type: req.query.type || 'info',
      activePage: 'settings',
      allUsers: users.map(u => ({ username: u.username, role: u.role || 'admin' })) // Sertakan role untuk view
    });
  } catch (err) {
    res.status(500).send('Error loading settings');
  }
});

// API: Hapus User
app.post('/settings/user/delete', requireAuth, requireRoot, async (req, res) => {
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
      activePage: 'logs',
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
app.post('/settings/user/add', requireAuth, requireRoot, async (req, res) => {
  const { newUsername, newUserPassword, newRole } = req.body;
  
  if (!newUsername || !newUserPassword) {
    return res.redirect('/settings?msg=Username and Password required&type=error');
  }

  try {
    const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
    
    if (users.some(u => u.username === newUsername)) {
      return res.redirect('/settings?msg=Username sudah digunakan&type=error');
    }

    const hashedPass = await bcrypt.hash(newUserPassword, 10);
    users.push({ 
      username: newUsername, 
      password: hashedPass,
      role: newRole || 'admin'
    });
    await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
    addLog('system', `User baru didaftarkan: ${newUsername} (${newRole || 'admin'})`, req.session.user.username);
    
    res.redirect('/settings?msg=User baru berhasil didaftarkan&type=success');
  } catch (err) {
    console.error('Add user error:', err);
    res.redirect('/settings?msg=Terjadi kesalahan sistem&type=error');
  }
});

// API: Update Branding Text
app.post('/settings/branding/update', requireAuth, requireRoot, async (req, res) => {
  try {
    const updates = req.body;
    const current = JSON.parse(await fs.readFile(BRANDING_FILE, 'utf8'));
    const updated = { ...current, ...updates };
    await fs.writeFile(BRANDING_FILE, JSON.stringify(updated, null, 2));
    addLog('system', 'Personalisasi branding diperbarui', req.session.user.username);
    res.redirect('/settings?msg=Branding berhasil diperbarui&type=success');
  } catch (err) {
    console.error('Branding update error:', err);
    res.redirect('/settings?msg=Gagal memperbarui branding&type=error');
  }
});

// API: Upload Branding Assets
app.post('/settings/branding/upload', requireAuth, requireRoot, uploadBranding.fields([
  { name: 'logo', maxCount: 1 },
  { name: 'favicon', maxCount: 1 }
]), async (req, res) => {
  try {
    const current = JSON.parse(await fs.readFile(BRANDING_FILE, 'utf8'));
    let changed = false;
    
    // Capture old URLs for cleanup
    const oldLogo = current.logoUrl;
    const oldFavicon = current.faviconUrl;
    
    if (req.files['logo'] && req.files['logo'][0]) {
      current.logoUrl = `/branding/${req.files['logo'][0].filename}`;
      changed = true;
      if (oldLogo) await deleteFileSafely(oldLogo);
    }
    if (req.files['favicon'] && req.files['favicon'][0]) {
      current.faviconUrl = `/branding/${req.files['favicon'][0].filename}`;
      changed = true;
      if (oldFavicon) await deleteFileSafely(oldFavicon);
    }
    
    if (changed) {
      await fs.writeFile(BRANDING_FILE, JSON.stringify(current, null, 2));
      addLog('system', 'Aset branding (logo/favicon) diperbarui', req.session.user.username);
      res.redirect('/settings?msg=Aset branding berhasil diunggah&type=success');
    } else {
      res.redirect('/settings?msg=Tidak ada file yang dipilih untuk diunggah&type=error');
    }
  } catch (err) {
    console.error('Branding upload error:', err);
    res.redirect('/settings?msg=Gagal mengunggah aset branding: ' + err.message + '&type=error');
  }
});

// API: Reset Branding to Default
app.post('/settings/branding/reset', requireAuth, requireRoot, async (req, res) => {
  try {
    const current = JSON.parse(await fs.readFile(BRANDING_FILE, 'utf8'));
    
    // Cleanup custom assets before reset
    if (current.logoUrl) await deleteFileSafely(current.logoUrl);
    if (current.faviconUrl) await deleteFileSafely(current.faviconUrl);

    const defaults = {
      loginWelcome: "Selamat Datang",
      loginSubtitle: "Masuk ke Sistem Bel Sekolah",
      appName: "SMAMUHI",
      appSub: "Advanced Bell",
      footerCredit: 'Crafted with ❤️ by <a href="mailto:vannyezhaa@gmail.com" class="text-primary-400 hover:text-primary-300 transition-colors">vannyezha</a> </br> Business & Collaboration: +6285159982101',
      pageTitle: "BELL-SMAMUHI",
      theme: "crimson",
      logoUrl: null,
      faviconUrl: null
    };
    await fs.writeFile(BRANDING_FILE, JSON.stringify(defaults, null, 2));
    addLog('system', 'Branding dikembalikan ke pengaturan awal', req.session.user.username);
    res.redirect('/settings?msg=Branding dikembalikan ke default&type=success');
  } catch (err) {
    console.error('Branding reset error:', err);
    res.redirect('/settings?msg=Gagal mereset branding&type=error');
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
    safeRedirect(req, res, '/schedules');
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
    safeRedirect(req, res, '/schedules');
  } catch (err) {
    console.error('Remove schedule error:', err);
    res.status(500).send('Gagal hapus jadwal');
  }
});

app.post('/schedule/toggle', requireAuth, async (req, res) => {
  // Anti-spam: cegah toggle berulang
  if (toggleBusy) {
    return safeRedirect(req, res, '/dashboard', { msg: 'Tunggu sebentar sebelum mengubah status scheduler', type: 'error' });
  }
  toggleBusy = true;
  
  try {
    let schedules = JSON.parse(await fs.readFile(SCHEDULES_FILE, 'utf8'));
    schedules = ensureSchedules(schedules);
    schedules.enabled = !schedules.enabled;
    await fs.writeFile(SCHEDULES_FILE, JSON.stringify(schedules, null, 2));
    addLog('system', `Scheduler ${schedules.enabled ? 'diaktifkan' : 'dinonaktifkan'}`, req.session.user.username);
    safeRedirect(req, res, '/dashboard');
  } catch (err) {
    console.error('Toggle error:', err);
    res.status(500).send('Gagal toggle');
  } finally {
    setTimeout(() => { toggleBusy = false; }, TOGGLE_COOLDOWN_MS);
  }
});

app.post('/special/add', requireAuth, async (req, res) => {
  const { date, time, sound } = req.body;
  try {
    const special = JSON.parse(await fs.readFile(SPECIAL_SCHEDULES_FILE, 'utf8'));
    special.push({ date, time, sound });
    await fs.writeFile(SPECIAL_SCHEDULES_FILE, JSON.stringify(special, null, 2));
    safeRedirect(req, res, '/schedules');
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
    safeRedirect(req, res, '/schedules');
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
    safeRedirect(req, res, '/schedules');
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
    safeRedirect(req, res, '/schedules');
  } catch (err) {
    console.error('Edit special error:', err);
    res.status(500).send('Gagal edit jadwal khusus');
  }
});

// 🔊 Upload musik — pakai uploadAudio
app.post('/upload', requireAuth, uploadAudio.single('audiofile'), (req, res) => {
  safeRedirect(req, res, '/audio');
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
    safeRedirect(req, res, '/audio');
  } catch (err) {
    console.error('Config error:', err);
    res.status(500).send('Gagal mengatur pintasan');
  }
});

// 🗑️ Hapus musik
app.post('/music/delete', requireAuth, async (req, res) => {
  const file = path.basename(req.body.file || '');
  if (!file) return safeRedirect(req, res, '/audio');
  try {
    await fs.unlink(path.join(MUSIC_DIR, file));
    safeRedirect(req, res, '/audio');
  } catch (e) {
    console.error('Delete error:', e);
    safeRedirect(req, res, '/audio', { msg: 'Gagal menghapus file', type: 'error' });
  }
});

app.post('/rename', requireAuth, async (req, res) => {
  const oldname = path.basename(req.body.oldname || '');
  const newname = path.basename(req.body.newname || '');
  if (!oldname || !newname) return res.status(400).send('Nama diperlukan');
  if (!/^[a-zA-Z0-9._-]+$/.test(newname)) return res.status(400).send('Nama tidak valid');
  if (newname === oldname) return safeRedirect(req, res, '/audio');
  try {
    await fs.rename(path.join(MUSIC_DIR, oldname), path.join(MUSIC_DIR, newname));
    safeRedirect(req, res, '/audio', { rename: 'success' });
  } catch (err) {
    console.error('Rename error:', err);
    safeRedirect(req, res, '/audio', { rename: 'error' });
  }
});

app.get('/preview/:file', requireAuth, (req, res) => {
  const file = path.basename(req.params.file || '');
  res.render('preview', { file });
});

app.post('/play', requireAuth, (req, res) => {
  const file = path.basename(req.body.file || '');
  if (!file) return res.status(400).send('File diperlukan');
  
  // Anti-spam: cegah spam klik play
  if (playBusy) {
    return safeRedirect(req, res, '/dashboard', { msg: 'Sistem sedang memproses, tunggu sebentar', type: 'error' });
  }
  
  if (isAudioPlaying) {
    return safeRedirect(req, res, '/dashboard', { msg: 'Sistem sedang memutar audio lain', type: 'error' });
  }

  // Set mutex segera SEBELUM playSound (tutup race condition window)
  playBusy = true;
  isAudioPlaying = true;
  activeAudioName = file;

  // Gunakan fungsi playSound yang sudah mencakup Relay & State Management
  playSound(file, req.session.user.username);
  
  // Beri cooldown sebelum bisa play lagi
  setTimeout(() => { playBusy = false; }, PLAY_COOLDOWN_MS);
  
  safeRedirect(req, res, '/dashboard', { play: 'success' });
});

app.post('/stop', requireAuth, (req, res) => {
  // Anti-spam: cegah spam klik stop
  if (stopBusy) {
    return safeRedirect(req, res, '/dashboard', { msg: 'Proses penghentian sedang berjalan, tunggu sebentar', type: 'error' });
  }
  stopBusy = true;
  
  try {
    // Step 1: Unpipe all streams first to prevent EPIPE crashes
    if (activeFfmpegProcess && activeFfmpegProcess.stdout && activeAudioProcess && activeAudioProcess.stdin) {
      try { activeFfmpegProcess.stdout.unpipe(activeAudioProcess.stdin); } catch (e) {}
    }
    if (liveMicFfmpeg && liveMicFfmpeg.stdout && liveMicProcess && liveMicProcess.stdin) {
      try { liveMicFfmpeg.stdout.unpipe(liveMicProcess.stdin); } catch (e) {}
    }

    // Step 2: Kill all processes with SIGTERM first (graceful)
    if (activeAudioProcess) { try { activeAudioProcess.kill('SIGTERM'); } catch (e) {} }
    if (activeFfmpegProcess) { try { activeFfmpegProcess.kill('SIGTERM'); } catch (e) {} }
    if (liveMicProcess) { try { liveMicProcess.kill('SIGTERM'); } catch (e) {} }
    if (liveMicFfmpeg) { try { liveMicFfmpeg.stdin.end(); } catch (e) {} try { liveMicFfmpeg.kill('SIGTERM'); } catch (e) {} }
    
    // Step 3: Immediate pkill safeguard (polite terminate)
    spawn('pkill', ['-15', '-f', 'aplay']);
    spawn('pkill', ['-15', '-f', 'ffmpeg']);
    
    // Step 4: Reset ALL state
    isAudioPlaying = false;
    activeAudioName = null;
    activeAudioProcess = null;
    activeFfmpegProcess = null;
    liveMicProcess = null;
    liveMicFfmpeg = null;
    playBusy = false; // Reset play mutex juga
    
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

    safeRedirect(req, res, '/dashboard', { stop: 'success' });
  } catch (err) {
    console.error('Stop error:', err);
    // Even on error, polite terminate then force kill later
    spawn('pkill', ['-15', '-f', 'aplay']);
    spawn('pkill', ['-15', '-f', 'ffmpeg']);
    setTimeout(() => {
      spawn('pkill', ['-9', '-f', 'aplay']);
      spawn('pkill', ['-9', '-f', 'ffmpeg']);
    }, 2000);
    isAudioPlaying = false;
    activeAudioName = null;
    activeAudioProcess = null;
    activeFfmpegProcess = null;
    liveMicProcess = null;
    liveMicFfmpeg = null;
    playBusy = false;
    safeRedirect(req, res, '/dashboard', { stop: 'error' });
  } finally {
    setTimeout(() => { stopBusy = false; }, STOP_COOLDOWN_MS);
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
    safeRedirect(req, res, '/dashboard', { import: 'success' });
  } catch (e) {
    console.error('Import error:', e);
    // Cleanup if file still exists
    try { if (req.file && req.file.path) await fs.unlink(req.file.path); } catch (cleanErr) {}
    safeRedirect(req, res, '/dashboard', { import: 'error' });
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

    // Debounce: cegah spam klik
    if (relayBusy) {
      return res.json({ 
        success: false, 
        error: 'Relay sedang diproses, tunggu sebentar',
        status: relayStatus ? "ON" : "OFF"
      });
    }

    manualOverride = true;
    relayBusy = true;

    try {
      await writeRelay(RELAY_ON);
      relayStatus = true;
      console.log("✅ 🔌 Amplifier ON (manual)");
    } catch (error) {
      console.error('❌ Gagal menyalakan amplifier:', error.message);
      relayBusy = false;
      return res.json({ 
        success: false, 
        error: 'Gagal menyalakan amplifier: ' + error.message,
        status: "OFF"
      });
    }

    // Beri jeda debounce setelah write berhasil
    setTimeout(() => { relayBusy = false; }, RELAY_DEBOUNCE_MS);
      
    // Tunggu warmup sebelum kirim response
    setTimeout(() => {
      res.json({ 
        success: true, 
        status: "ON",
        message: "Amplifier menyala"
      });
    }, AMP_WARMUP);
  } catch (err) {
    console.error('❌ Error di /ampli/on:', err);
    relayBusy = false;
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

    // Debounce: cegah spam klik
    if (relayBusy) {
      return res.json({ 
        success: false, 
        error: 'Relay sedang diproses, tunggu sebentar',
        status: relayStatus ? "ON" : "OFF"
      });
    }

    manualOverride = false;
    relayBusy = true;

    try {
      await writeRelay(RELAY_OFF);
      relayStatus = false;
      console.log("✅ 🔌 Amplifier OFF (manual)");
    } catch (error) {
      console.error('❌ Gagal mematikan amplifier:', error.message);
      relayBusy = false;
      return res.json({ 
        success: false, 
        error: 'Gagal mematikan amplifier: ' + error.message,
        status: "ON"
      });
    }

    // Beri jeda debounce setelah write berhasil
    setTimeout(() => { relayBusy = false; }, RELAY_DEBOUNCE_MS);
      
    res.json({ 
      success: true, 
      status: "OFF",
      message: "Amplifier mati"
    });
  } catch (err) {
    console.error('❌ Error di /ampli/off:', err);
    relayBusy = false;
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
      relayBusy,
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

// =======================
// AUDIO SETTINGS API
// =======================

app.get('/api/audio-settings', requireAuth, (req, res) => {
  res.json(getAudioSettings());
});

app.post('/api/audio-settings', requireAuth, async (req, res) => {
  try {
    const current = getAudioSettings();
    const updates = {};
    
    // Validasi dan clamp setiap field
    const fields = [
      { key: 'volume', min: 0, max: 100 },
      { key: 'bass', min: -20, max: 20 },
      { key: 'treble', min: -20, max: 20 },
      { key: 'midrange', min: -20, max: 20 },
      { key: 'micVolume', min: 0, max: 100 },
      { key: 'micBass', min: -20, max: 20 },
      { key: 'micTreble', min: -20, max: 20 }
    ];
    
    for (const f of fields) {
      if (req.body[f.key] !== undefined) {
        const val = parseFloat(req.body[f.key]);
        if (!isNaN(val)) {
          updates[f.key] = Math.max(f.min, Math.min(f.max, val));
        }
      }
    }
    
    const merged = { ...current, ...updates };
    await fs.writeFile(AUDIO_SETTINGS_FILE, JSON.stringify(merged, null, 2));
    
    // Terapkan volume sistem via amixer
    if (updates.volume !== undefined) {
      applySystemVolume(merged.volume);
    }
    
    addLog('config', `Audio settings diperbarui: ${JSON.stringify(updates)}`, req.session.user.username);
    res.json({ success: true, settings: merged });
  } catch (err) {
    console.error('Audio settings error:', err);
    res.status(500).json({ success: false, error: 'Gagal menyimpan pengaturan audio' });
  }
});

app.post('/api/audio-settings/reset', requireAuth, async (req, res) => {
  try {
    await fs.writeFile(AUDIO_SETTINGS_FILE, JSON.stringify(DEFAULT_AUDIO_SETTINGS, null, 2));
    applySystemVolume(DEFAULT_AUDIO_SETTINGS.volume);
    addLog('config', 'Audio settings direset ke default', req.session.user.username);
    res.json({ success: true, settings: DEFAULT_AUDIO_SETTINGS });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Gagal reset audio settings' });
  }
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

    if (isAudioPlaying && activeAudioName !== filename) {
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
      // WAV: pipe melalui ffmpeg untuk EQ, lalu ke aplay
      const audioSettings = getAudioSettings();
      const audioFilter = buildAudioFilter(audioSettings, false);
      
      if (audioFilter) {
        activeFfmpegProcess = spawn('ffmpeg', [
          '-i', filePath,
          '-af', audioFilter,
          '-f', 'wav',
          '-loglevel', 'quiet',
          '-'
        ]);
        activeAudioProcess = spawn('aplay', ['-D', 'plughw:0,0', '-q']);
        activeFfmpegProcess.stdout.pipe(activeAudioProcess.stdin);
        activeFfmpegProcess.stderr.resume();
      } else {
        activeAudioProcess = spawn('aplay', ['-D', 'plughw:0,0', filePath]);
      }
    } else if (filename.toLowerCase().endsWith('.mp3')) {
      const audioSettings = getAudioSettings();
      const audioFilter = buildAudioFilter(audioSettings, false);
      const ffmpegArgs = ['-i', filePath];
      if (audioFilter) {
        ffmpegArgs.push('-af', audioFilter);
      }
      ffmpegArgs.push('-f', 'wav', '-loglevel', 'quiet', '-');
      
      activeFfmpegProcess = spawn('ffmpeg', ffmpegArgs);
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

    // Spawn ffmpeg to decode incoming WebM/Opus with EQ filters and pipe to aplay
    const audioSettings = getAudioSettings();
    const micFilter = buildAudioFilter(audioSettings, true);
    const ffmpegArgs = [
      '-i', 'pipe:0',
    ];
    if (micFilter) {
      ffmpegArgs.push('-af', micFilter);
    }
    ffmpegArgs.push(
      '-f', 's16le',
      '-ar', '44100',
      '-ac', '1',
      'pipe:1',
      '-loglevel', 'quiet'
    );
    
    liveMicFfmpeg = spawn('ffmpeg', ffmpegArgs);

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

    // Step 2: Close ffmpeg stdin gracefully, then polite kill
    if (liveMicFfmpeg) {
      try { liveMicFfmpeg.stdin.end(); } catch (e) {}
      try { liveMicFfmpeg.kill('SIGTERM'); } catch (e) {}
      liveMicFfmpeg = null;
    }

    // Step 3: Kill aplay polite
    if (liveMicProcess) {
      try { liveMicProcess.kill('SIGTERM'); } catch (e) {}
      liveMicProcess = null;
    }

    // Step 4: Safeguard — kill any lingering aplay/ffmpeg child processes
    // HANYA JIKA sedang siaran langsung (cegah bug bel mati jika tab ditutup saat bel normal berbunyi)
    if (activeAudioName === "SIARAN LANGSUNG") {
      try {
        spawn('pkill', ['-15', '-f', 'aplay.*plughw']);
        spawn('pkill', ['-15', '-f', 'ffmpeg.*pipe']);
      } catch (e) {}
    }

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
