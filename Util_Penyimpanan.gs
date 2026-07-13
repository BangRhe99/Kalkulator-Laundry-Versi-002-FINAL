/**
 * ============================================================================
 * UTIL PENYIMPANAN — Sheet "_data_operasional" sebagai key-value store
 * ============================================================================
 *
 * ATURAN WAJIB UNTUK FILE INI:
 *   1. INI SATU-SATUNYA FILE yang boleh memanggil SpreadsheetApp secara
 *      langsung. Semua Modul_*.gs dan Migrasi_*.gs WAJIB lewat fungsi di
 *      file ini untuk baca/tulis data — JANGAN panggil SpreadsheetApp
 *      langsung dari file lain. Ini supaya kalau suatu hari penyimpanan
 *      diganti (misal pindah ke PropertiesService atau database eksternal),
 *      HANYA file ini yang perlu diubah.
 *   2. Pola penyimpanan: SATU baris per KEY (bukan satu JSON raksasa berisi
 *      semua data). Setiap baris = [key, value]. Ini dipilih supaya update
 *      SATU record (misal 1 cabang) tidak perlu menulis ulang record lain
 *      -> mengurangi risiko race condition / data korup saat banyak cabang.
 *   3. DATA_SHEET_NAME (nama sheet tersembunyi) didefinisikan di Code.gs,
 *      bukan di sini — karena itu konstanta skema inti yang harus selalu
 *      ada sejak file pertama diparse. File ini hanya MEMAKAI konstanta itu.
 *
 * DAFTAR ISI (cari nama fungsi ini kalau butuh mengubah/memahami):
 *   - ensureDataSheet_   -> ambil/buat sheet tersembunyi "_data_operasional"
 *   - readKey_           -> baca 1 value berdasarkan key (null jika tidak ada)
 *   - writeKey_          -> tulis/timpa 1 value berdasarkan key (upsert)
 *   - deleteKeyRow_      -> hapus 1 baris berdasarkan key
 *   - readOrder_         -> baca array urutan id (generik, untuk daftar apapun)
 *   - writeOrder_        -> tulis array urutan id
 *   - appendToOrder_     -> tambah 1 id ke akhir array urutan (kalau belum ada)
 *   - removeFromOrder_   -> hapus 1 id dari array urutan
 *
 * CATATAN UNTUK KATEGORI BIAYA / FITUR BARU DI MASA DEPAN:
 *   Kalau fitur barumu butuh "daftar urutan id" (seperti Gas, bukan seperti
 *   Listrik yang 1:1 per cabang), JANGAN buat fungsi order baru — reuse
 *   readOrder_/writeOrder_/appendToOrder_/removeFromOrder_ yang sudah generik
 *   ini, cukup definisikan KEY_xxx_ORDER baru di Code.gs.
 *
 * [2026-07-13] MULTI-TENANT: ensureDataSheet_() sekarang membaca dari
 * _activeDataSpreadsheet_ (variabel modul-global di-set oleh withTenant_ di
 * Code.gs sebelum fungsi backend manapun jalan), bukan selalu
 * SpreadsheetApp.getActiveSpreadsheet(). Fallback ke getActiveSpreadsheet()
 * kalau belum di-set (dipakai Modul_Auth.gs utk baca/tulis akun & sesi yang
 * SELALU di Master, terlepas dari tenant mana yang login). Semua fungsi
 * publik client-callable WAJIB lewat withTenant_ dulu (lihat Code.gs) supaya
 * _activeDataSpreadsheet_ terisi benar sebelum menyentuh data.
 *
 * [2026-07-13] LOCKING: writeKey_/deleteKeyRow_/appendToOrder_/
 * removeFromOrder_ dibungkus LockService.getScriptLock() utk SELURUH siklus
 * baca-putuskan-tulis (bukan cuma baris terakhir), supaya 2 penyimpanan
 * bersamaan tidak menghasilkan baris/urutan ganda (race condition).
 * ============================================================================
 */

// Diisi withTenant_ (Code.gs) sebelum fungsi client-callable manapun jalan -
// menunjuk spreadsheet data milik tenant yang sedang login. Kosong (null)
// berarti belum di-set -> ensureDataSheet_() jatuh ke spreadsheet Master
// (dipakai Modul_Auth.gs, yang datanya SELALU di Master terlepas dari tenant).
var _activeDataSpreadsheet_ = null;

function setActiveDataSpreadsheet_(ss) {
  _activeDataSpreadsheet_ = ss || null;
}

function ensureDataSheet_() {
  const ss = _activeDataSpreadsheet_ || SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(DATA_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(DATA_SHEET_NAME);
    sheet.getRange("A1:B1").setValues([["key", "value"]]);
    sheet.hideSheet();
  }
  return sheet;
}

function _withDataLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throw new Error("Sistem sedang sibuk memproses permintaan lain, coba simpan lagi sebentar.");
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// Cache baca-sekali-per-eksekusi: sebelumnya readKey_/writeKey_/deleteKeyRow_
// masing-masing memanggil getDataRange().getValues() SENDIRI-SENDIRI, padahal
// dalam satu eksekusi (misal 1 pemuatan Dashboard) fungsi ini bisa terpanggil
// puluhan kali berantai (listCabang -> getCabang per baris -> dst). Cache ini
// hidup HANYA selama satu eksekusi google.script.run (variabel global Apps
// Script reset tiap eksekusi baru), jadi aman dari data basi lintas request.
let _dataSheetCache_ = null;

function _getSheetCacheKey_(sheet) {
  return sheet.getSheetId ? String(sheet.getSheetId()) : sheet.getName();
}

function _loadSheetCache_(sheet) {
  const cacheKey = _getSheetCacheKey_(sheet);
  if (_dataSheetCache_ && _dataSheetCache_.sheetKey === cacheKey) {
    return _dataSheetCache_;
  }
  const values = sheet.getDataRange().getValues();
  _dataSheetCache_ = { sheetKey: cacheKey, rows: values.slice(1) };
  return _dataSheetCache_;
}

function readKey_(sheet, key) {
  const cache = _loadSheetCache_(sheet);
  for (let i = 0; i < cache.rows.length; i++) {
    if (cache.rows[i][0] === key) return cache.rows[i][1];
  }
  return null;
}

function _writeKeyCore_(sheet, key, value) {
  const cache = _loadSheetCache_(sheet);
  for (let i = 0; i < cache.rows.length; i++) {
    if (cache.rows[i][0] === key) {
      sheet.getRange(i + 2, 2).setValue(value);
      cache.rows[i][1] = value;
      return;
    }
  }
  sheet.appendRow([key, value]);
  cache.rows.push([key, value]);
}

function writeKey_(sheet, key, value) {
  return _withDataLock_(function () { return _writeKeyCore_(sheet, key, value); });
}

function deleteKeyRow_(sheet, key) {
  return _withDataLock_(function () {
    const cache = _loadSheetCache_(sheet);
    for (let i = 0; i < cache.rows.length; i++) {
      if (cache.rows[i][0] === key) {
        sheet.deleteRow(i + 2);
        cache.rows.splice(i, 1);
        return;
      }
    }
  });
}

/**
 * readOrder_ / writeOrder_ / appendToOrder_ / removeFromOrder_ generik untuk
 * key apapun (dipakai oleh cabang_order maupun biayaGas_order), supaya pola
 * "daftar urutan id" tidak perlu diduplikasi per jenis data.
 */
function readOrder_(sheet, orderKey) {
  const raw = readKey_(sheet, orderKey);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function writeOrder_(sheet, orderKey, order) {
  writeKey_(sheet, orderKey, JSON.stringify(order));
}

function appendToOrder_(sheet, orderKey, id) {
  // Seluruh baca-putuskan-tulis dikunci sekaligus (bukan nested lock ke
  // writeKey_) supaya 2 appendToOrder_ bersamaan tidak saling menimpa hasil
  // satu sama lain (lost update pada array urutan).
  return _withDataLock_(function () {
    const order = readOrder_(sheet, orderKey);
    if (order.indexOf(id) === -1) {
      order.push(id);
      _writeKeyCore_(sheet, orderKey, JSON.stringify(order));
    }
  });
}

function removeFromOrder_(sheet, orderKey, id) {
  return _withDataLock_(function () {
    const order = readOrder_(sheet, orderKey).filter(function (x) { return x !== id; });
    _writeKeyCore_(sheet, orderKey, JSON.stringify(order));
  });
}
