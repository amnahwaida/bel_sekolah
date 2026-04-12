# 🔔 Sistem Bel Sekolah & Pengumuman (PA System)

Sistem Bel Sekolah pintar ini mendukung penjadwalan audio otomatis, audisi riwayat, dan fitur **Pengumuman Langsung (Live Microphone)**. Dokumen ini menjelaskan cara instalasi dan penanganan izin mikrofon.

---

## ⚙️ Persiapan awal (.env)
Sebelum menjalankan aplikasi, Anda perlu menyiapkan file konfigurasi environment:
1. Copy file `.env.example` menjadi `.env`:
   ```bash
   cp .env.example .env
   ```
2. Buka file `.env` dan isi nilai `SESSION_SECRET` serta `TUNNEL_TOKEN` (untuk Cloudflare Tunnel).

---

## 🛠️ Fitur Utama
- **Penjadwalan Otomatis**: Senin - Minggu dengan pengaturan khusus.
- **Riwayat Aktivitas**: Server-side pagination untuk performa optimal.
- **Aksi Cepat**: Pintasan panggilan Ketua Kelas (Dinamis).
- **Pengumuman Langsung (Live PA)**: Siaran suara real-time dari browser ke speaker STB.
- **Dark Mode Only**: Antarmuka premium yang nyaman di mata secara permanen.

---

## 🎤 Panduan Penggunaan Live Microphone
Browser modern (Chrome/Edge/Safari) mewajibkan **Secure Context (HTTPS)** atau **Localhost** untuk mengizinkan akses Mikrofon.

### 🌐 Kasus 1: Akses Online (Cloudflare Tunnel)
Jika Anda mengakses aplikasi menggunakan domain (misal: `https://bel.sekolah.id`):
1.  **Gunakan HTTPS**: Pastikan URL di browser dimulai dengan `https://`. Cloudflare menyediakan SSL gratis secara otomatis.
2.  **Izin Browser**: Klik ikon **Gembok** di sebelah kiri URL, pastikan Microphone diatur ke **Allow**.
3.  **Cloudflare Setting**: Pastikan fitur "Always Use HTTPS" aktif di dashboard Cloudflare Anda agar user tidak masuk melalui jalur HTTP yang tidak aman.

### 🏠 Kasus 2: Akses Offline / Lokal (Tanpa Internet)
Jika Anda mengakses aplikasi di jaringan Wifi yang sama dengan STB menggunakan alamat IP (contoh: `http://192.168.1.10:3000`):

Karena protokolnya `http` melalui IP (bukan https), browser akan memblokir mikrofon. **Solusinya adalah menggunakan Chrome/Edge Flags untuk memberikan pengecualian keamanan:**

1.  Buka browser Chrome/Edge di Laptop Anda.
2.  Ketik alamat ini di bilah alamat: 
    *   **Chrome**: `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
    *   **Edge**: `edge://flags/#unsafely-treat-insecure-origin-as-secure`
3.  Ubah status menjadi **Enabled**.
4.  Pada kotak teks di bawahnya, masukkan alamat IP STB Anda. Contoh: `http://192.168.1.10:3000`.
5.  Klik tombol **Relaunch** di pojok kanan bawah.
6.  Selesai! Mikrofon kini akan diizinkan oleh browser meskipun tanpa HTTPS.

---

## 🚀 Cara Menjalankan
1.  Pastikan Docker & Docker Compose sudah terpasang.
2.  Jalankan perintah:
    ```bash
    docker compose up -d
    ```
3.  Akses Dashboard di `http://localhost:3000` (akses lokal langsung di STB) atau alamat domain Cloudflare Anda.

## 📁 Struktur Data Penting
- `/app/data/schedules.json`: Menyimpan jadwal mingguan & konfigurasi tombol cepat.
- `/app/data/logs.json`: Menyimpan riwayat aktivitas sistem.
- `/music/`: Folder untuk menaruh file audio .mp3 yang akan diputar.

---
*Dibuat oleh Tim IT Sekolah - v2.0 Premium Dark Mode Edition*
