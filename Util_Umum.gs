/**
 * ============================================================================
 * UTIL UMUM — helper murni, TIDAK punya dependency ke file lain
 * ============================================================================
 *
 * ATURAN WAJIB UNTUK FILE INI (baca sebelum menambah apapun di sini):
 *   1. Setiap fungsi di file ini HARUS pure function: tidak membaca/menulis
 *      Spreadsheet, tidak memanggil fungsi dari Modul_*.gs atau Migrasi_*.gs.
 *      Kalau perlu akses Spreadsheet, fungsi itu HARUS pindah ke
 *      Util_Penyimpanan.gs, bukan ditambah di sini.
 *   2. Semua fungsi di sini dipakai oleh SEMUA Modul_*.gs lain (Cabang, Gas,
 *      Listrik, dan modul kategori biaya berikutnya). Mengubah perilaku salah
 *      satu fungsi di sini (misal toInt_ atau round2_) akan mengubah hasil
 *      kalkulasi di SEMUA modul sekaligus — ubah dengan sangat hati-hati,
 *      idealnya hanya menambah fungsi baru, jangan mengubah fungsi lama.
 *   3. Apps Script TIDAK menjamin urutan parse antar file (lihat dokumentasi
 *      resmi), tapi karena semua fungsi di sini hanya dipanggil dari DALAM
 *      body fungsi lain (bukan di top-level scope), urutan file tidak masalah
 *      — JANGAN tambahkan kode yang berjalan di top-level (di luar fungsi)
 *      ke file ini, supaya sifat aman-urutan ini tetap terjaga.
 *
 * DAFTAR ISI (cari nama fungsi ini kalau butuh mengubah/memahami):
 *   - newId_              -> generate id unik dengan prefix penanda asal data
 *   - sumUnit_            -> total jumlahUnit dari array baris mesin
 *   - toNumber_           -> konversi ke Number dengan fallback aman
 *   - toInt_              -> konversi ke integer (dibulatkan) dengan fallback
 *   - toSafeString_       -> trim + batasi panjang string, fallback jika kosong
 *   - clamp_              -> kunci angka dalam rentang [min, max]
 *   - round2_             -> bulatkan ke 2 desimal (standar tampilan Rupiah)
 *   - errorResponse_      -> bentuk SERAGAM { ok:false, error, stage } + log
 * ============================================================================
 */

/**
 * prefix membedakan asal id saat debugging log (mis. "c_..." cabang,
 * "g_..." biaya gas) tanpa mengubah cara id dipakai sebagai key.
 */
function newId_(prefix) {
  const p = prefix || "x";
  return p + "_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 100000).toString(36);
}

function sumUnit_(rows) {
  let total = 0;
  for (let i = 0; i < rows.length; i++) total += toInt_(rows[i].jumlahUnit, 0);
  return total;
}

function toNumber_(val, fallback) {
  const n = Number(val);
  return isFinite(n) ? n : fallback;
}

function toInt_(val, fallback) {
  const n = Math.round(Number(val));
  return isFinite(n) ? n : fallback;
}

function toSafeString_(val, fallback, maxLen) {
  if (typeof val !== "string") return fallback;
  const trimmed = val.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.substring(0, maxLen || 200);
}

function clamp_(val, min, max) {
  const n = toNumber_(val, min);
  return Math.min(Math.max(n, min), max);
}

function round2_(val) {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

/**
 * errorResponse_ adalah SATU-SATUNYA cara fungsi publik (dipanggil dari
 * frontend) boleh mengembalikan error. "stage" WAJIB unik & deskriptif per
 * titik gagal — lihat pola "namaFungsi:tahapGagal" di semua Modul_*.gs,
 * supaya saat debugging, tinggal cari literal stage itu di seluruh project.
 */
function errorResponse_(err, stage) {
  const message = (err && err.message) ? err.message : String(err);
  Logger.log("ERROR @ " + stage + ": " + message);
  return { ok: false, error: message, stage: stage };
}
