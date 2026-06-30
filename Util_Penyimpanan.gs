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
 * ============================================================================
 */

function ensureDataSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(DATA_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(DATA_SHEET_NAME);
    sheet.getRange("A1:B1").setValues([["key", "value"]]);
    sheet.hideSheet();
  }
  return sheet;
}

function readKey_(sheet, key) {
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === key) return values[i][1];
  }
  return null;
}

function writeKey_(sheet, key, value) {
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value]);
}

function deleteKeyRow_(sheet, key) {
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === key) {
      sheet.deleteRow(i + 1);
      return;
    }
  }
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
  const order = readOrder_(sheet, orderKey);
  if (order.indexOf(id) === -1) {
    order.push(id);
    writeOrder_(sheet, orderKey, order);
  }
}

function removeFromOrder_(sheet, orderKey, id) {
  const order = readOrder_(sheet, orderKey).filter(function (x) { return x !== id; });
  writeOrder_(sheet, orderKey, order);
}
