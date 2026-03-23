# Ringkasan Arsitektur Mephisto Chess Extension

Ringkasan singkat, alur data, dan rekomendasi untuk codebase.

**Tujuan**
- Ekstensi browser untuk memberikan analisis "next-best-move" dan opsi otomatisasi pada situs catur (Chess.com, Lichess, BlitzTactics).

**Entrypoints & Komponen**
- `manifest.json` — deklarasi extension (MV3).
- `src/scripts/background-script.js` — background service worker: global error handlers, runtime message glue.
- `src/scripts/content-script.js` — content script yang di-inject ke situs target: scraping papan, ekstraksi FEN/moves, menerima perintah automove, mensimulasikan klik internal (mengirim koordinat ke popup).
- `src/popup/popup.js` & `src/popup/popup.html` — UI popup: menampilkan papan analisis, inisialisasi engine (Worker/WASM/iframe/remote), meminta FEN secara periodik, mengirim perintah autoplay, dan mengontrol klik (debugger atau backend lokal).
- `src/options/*` — UI pengaturan; `src/options/options.js` memuat halaman pengaturan dinamis.
- `src/util/ErrorLogger.js` — utilitas logging error (menyimpan ke `chrome.storage.local` atau `localStorage`).
- `lib/engine/*` — engine binaries: banyak versi Stockfish (JS/WASM), lc0, fairy-stockfish dan model NNUE/weights.
- `src/scripts/mephisto-clicker.py` — backend opsional (Flask + pyautogui) untuk melakukan klik/drag di host (localhost:8080).
- `src/scripts/remote-engine.py` — contoh server remote untuk analisis engine via HTTP (localhost:9090).

**Alur Data (ringkas)**
1. `popup.js` panggil `request_fen()` ke tab aktif via `chrome.tabs.sendMessage({queryfen:true})`.
2. `content-script.js` scrape DOM papan, buat string posisi (fen/pieces/moves), dan kirim ke popup dengan `chrome.runtime.sendMessage({ dom, orient, fenresponse:true })`.
3. `popup.js` parse posisi, update UI (`ChessBoard`) dan kirim posisi ke engine (Worker / WASM module / iframe (`lc0`) / remote HTTP).
4. Engine mengirim `info`/`bestmove` → `popup.js` memperbarui `last_eval` dan UI.
5. Jika `autoplay` aktif, `popup.js` kirim `{automove:true}` ke `content-script`.
6. `content-script` menerima `automove`, melakukan simulasi klik (menghitung koordinat) dan mengirim pesan `{click:true, x, y}` ke `popup.js`.
7. `popup.js` menjalankan klik nyata dengan salah satu metode:
   - `chrome.debugger` + `Input.dispatchMouseEvent` (perlu permission `debugger`), atau
   - POST ke backend lokal `http://localhost:8080/performClick` yang dijalankan oleh `mephisto-clicker.py`.

**Fallback & Feature-detection**
- Engine WASM dengan threads / SharedArrayBuffer dicoba terlebih dahulu; bila tidak tersedia, fallback ke worker JS (`stockfish-16-40/stockfish.js`).
- NNUE model di-load dinamis dan di-push ke engine via buffer API bila engine mendukung.
- `popup.js` dapat melakukan programmatic injection `chrome.scripting.executeScript` jika content-script tidak hadir.

**Risiko & Hal Penting**
- Autoplay/automation: penggunaan `chrome.debugger` dan backend `pyautogui` dapat disalahgunakan; waspadai kebijakan TOS situs target dan privasi.
- Localhost endpoints (`http://localhost:8080` dan `http://localhost:9090`) membuka surface tambahan; pastikan hanya dijalankan secara lokal dan aman.
- Scraping DOM sangat heuristik — rentan terhadap perubahan struktur situs (selector brittle).
- Engine WASM threads memerlukan cross-origin-isolation untuk performa maksimal; popup menyediakan fallback, tetapi pengalaman berbeda di berbagai browser/konfigurasi.
- Telemetry/error logs disimpan local — tidak mengirimkan data remote, tetapi perlu pertimbangan privasi dan ukuran penyimpanan.

**Rekomendasi singkat**
- Tambahkan catatan keamanan di README tentang risiko `autoplay`, `debugger`, dan backend lokal; instruksikan pengguna untuk menjalankan backend hanya bila memahami risikonya.
- Perkuat validasi pada komunikasi HTTP ke `localhost` (mis. cek response, timeouts, retry limits) dan dokumentasikan cara mematikan backend.
- Tambah test/integrasi selector untuk `content-script` (set kasus uji untuk Lichess/Chess.com) dan monitoring fallback jika selectors gagal.
- Pertimbangkan penguncian akses untuk automation (konfirmasi UI setiap kali autoplay akan melakukan klik), untuk mencegah penyalahgunaan.
- Tambahkan README singkat untuk developer: bagaimana menjalankan `mephisto-clicker.py` dan `remote-engine.py` serta contoh perintah.

**Langkah berikut (opsional yang bisa saya lakukan sekarang)**
- Buat `DEVELOPER.md` dengan instruksi menjalankan backend (`mephisto-clicker.py` dan `remote-engine.py`).
- Tambah checklist automated tests minimal untuk `content-script` selector (headless DOM snapshots + unit tests).

---
Dokumen dibuat: `ARCHITECTURE.md`.
