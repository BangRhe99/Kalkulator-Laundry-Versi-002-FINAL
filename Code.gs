/**
 * ============================================================================
 * KALKULATOR LAUNDRY â€” DATA OPERASIONAL (multi-cabang)
 * Code.gs â€” ENTRY POINT & KONSTANTA SKEMA GLOBAL â€” Schema v4
 * ============================================================================
 *
 * FILE INI SENGAJA DIBUAT SANGAT RINGKAS. Tugasnya hanya dua:
 *   1. doGet() â€” satu-satunya pintu masuk web app, merender Index.html.
 *   2. Konstanta skema (SCHEMA_VERSION, DATA_SHEET_NAME, KEY_xxx) yang
 *      dipakai SEMUA file lain di project ini.
 * Semua logika fitur (CRUD, kalkulasi, validasi) ada di file Modul_*.gs.
 * Semua logika upgrade versi data ada di Migrasi_Skema.gs.
 *
 * ===========================================================================
 * PETA PROJECT â€” baca ini dulu sebelum mencari/menambah apapun:
 *
 *   Code.gs                 (file ini) entry point + konstanta skema
 *   Util_Umum.gs            helper murni: sanitasi angka/string, id, rounding,
 *                           bentuk error seragam. TIDAK menyentuh Spreadsheet.
 *   Util_Penyimpanan.gs     SATU-SATUNYA file yang boleh memanggil
 *                           SpreadsheetApp. Sheet "_data_operasional"
 *                           dipakai sebagai key-value store.
 *   Migrasi_Skema.gs        riwayat & logika upgrade versi skema data.
 *   Modul_Cabang.gs         fitur "Cabang & Lokasi": profil outlet, mesin
 *                           cuci/pengering, kalkulasi kapasitas (load/hari).
 *                           Ini DATA INDUK yang dibaca semua Modul_Biaya*.gs.
 *   Modul_BiayaGas.gs       fitur "Master Biaya > Gas": multi-record per
 *                           cabang, kalkulasi estimasi load & biaya per load.
 *   Modul_BiayaListrik.gs   fitur "Master Biaya > Listrik": satu konfigurasi
 *                           per cabang, kalkulasi Rp/load per baris mesin +
 *                           alokasi pompa air.
 *
 * CARA MENCARI SESUATU DI PROJECT INI:
 *   - "Saya mau ubah cara hitung kapasitas mesin cuci/pengering"
 *       -> Modul_Cabang.gs, cari computeSummary_ / computeGroupLoad_
 *   - "Saya mau ubah rumus biaya gas"
 *       -> Modul_BiayaGas.gs, cari computeBiayaGasSummary_
 *   - "Saya mau ubah rumus biaya listrik / pompa air"
 *       -> Modul_BiayaListrik.gs, cari computeBiayaListrikSummary_ atau
 *          computeListrikBarisMesin_
 *   - "Ada error dari frontend, stage-nya 'createBiayaGas:validate_payload'"
 *       -> nama stage SELALU "namaFungsi:tahapGagal" -> cari namaFungsi-nya
 *          (createBiayaGas) di Modul_BiayaGas.gs
 *   - "Saya mau tambah kategori biaya baru (Air, Deterjen, dst)"
 *       -> baca catatan "CATATAN PENTING UNTUK KATEGORI BIAYA BARU" di
 *          Modul_BiayaGas.gs (kalau multi-record) atau Modul_BiayaListrik.gs
 *          (kalau satu konfigurasi per cabang), lalu buat file baru
 *          Modul_BiayaXxx.gs yang meniru pola itu. JANGAN tambah field baru
 *          ke objek biayaGas atau biayaListrik yang sudah ada.
 *   - "Saya mau tambah migrasi skema baru (v5)"
 *       -> Migrasi_Skema.gs, baca catatan "CARA MENAMBAH MIGRASI BARU"
 *
 * ATURAN WAJIB UNTUK SEMUA FILE Modul_*.gs (konsisten di seluruh project):
 *   - Setiap fungsi publik (dipanggil dari frontend lewat google.script.run)
 *     WAJIB dibungkus try-catch, dan WAJIB mengembalikan bentuk seragam:
 *       sukses -> { ok: true, data: ... }
 *       gagal  -> { ok: false, error: "pesan jelas", stage: "namaFungsi:tahap" }
 *     TIDAK PERNAH throw mentah ke frontend.
 *   - VALIDASI dua lapis: sanitize (bersihkan/lengkapi diam-diam) DULU, lalu
 *     validate (tolak dengan pesan jelas jika melanggar aturan bisnis).
 *   - Kalkulasi (computeXxx_) adalah SUMBER KEBENARAN TUNGGAL. Frontend boleh
 *     punya salinan identik untuk pratinjau instan, tapi modul backend lain
 *     WAJIB memanggil fungsi compute yang sama, JANGAN duplikasi rumus.
 *
 * RIWAYAT SKEMA (detail lengkap tiap versi ada di Migrasi_Skema.gs):
 *   v1 â€” satu set data operasional per Sheet (tidak ada konsep "cabang").
 *   v2 â€” multi-cabang, satuan kapasitas LOAD (bukan kg).
 *   v3 â€” Master Biaya: Gas LPG.
 *   v4 â€” Master Biaya: Listrik.
 *
 * CATATAN TEKNIS Apps Script (penting dipahami sebelum menambah file baru):
 *   Semua file .gs dalam project ini berbagi SATU global scope yang sama.
 *   Fungsi di file manapun bisa memanggil fungsi di file lain tanpa import,
 *   dan urutan parse antar file TIDAK menjamin urutan tertentu. Ini AMAN
 *   selama (seperti pola di seluruh project ini) semua pemanggilan terjadi
 *   DI DALAM BODY FUNGSI (saat runtime), bukan di top-level scope file.
 *   JANGAN PERNAH menjalankan kode atau memanggil fungsi lain di luar fungsi
 *   (di top-level file), karena itu satu-satunya kondisi yang bisa rusak
 *   akibat urutan parse antar file yang tidak terjamin.
 * ===========================================================================
 */

const SCHEMA_VERSION = 4;
const DATA_SHEET_NAME = "_data_operasional";
const KEY_META = "meta";
const KEY_CABANG_ORDER = "cabang_order";
const KEY_BIAYA_GAS_ORDER = "biayaGas_order";
const KEY_BIAYA_CHEMICAL_ORDER = "biayaChemical_order";
const KEY_BIAYA_PACKING_ORDER = "biayaPacking_order";
const KEY_LEGACY_V1 = "operasional_v1";

// ----------------------------------------------------------------------------
// MULTI-TENANT SESSION GUARD
// ----------------------------------------------------------------------------
// [2026-07-13] SEMUA fungsi backend yang dipanggil client (google.script.run)
// WAJIB dibungkus withTenant_ ini SEBAGAI LAPISAN PALING LUAR, argumen
// pertamanya SELALU sessionToken. withTenant_ memvalidasi sesi (resolveSession_
// di Modul_Auth.gs), lalu mengarahkan SEMUA baca/tulis data (lewat
// Util_Penyimpanan.gs) ke spreadsheet milik tenant yang login - BUKAN selalu
// spreadsheet yang di-bind ke script ini. Kalau sesi tidak valid/kadaluarsa,
// fn TIDAK dijalankan sama sekali, langsung balas {ok:false, error:"UNAUTHORIZED"}
// supaya frontend tahu harus login ulang (lihat callServer_/cachedServerRead_
// di Script_Shared_Util.html).
//
// Pola pemakaian di tiap Modul_*.gs (badan logic asli dipindah ke *_impl_,
// TIDAK diubah sama sekali):
//   function createCabang(sessionToken, payload) {
//     return withTenant_(sessionToken, function () {
//       return createCabang_impl_(payload);
//     });
//   }
function withTenant_(sessionToken, fn) {
  try {
    const session = resolveSession_(sessionToken);
    if (!session) {
      return { ok: false, error: "Sesi login tidak valid atau sudah kadaluarsa. Silakan login ulang.", stage: "withTenant_:invalid_session", code: "UNAUTHORIZED" };
    }
    if (!session.tenantSpreadsheetId) {
      return { ok: false, error: "Akun ini belum punya data tersendiri. Hubungi admin.", stage: "withTenant_:missing_tenant_spreadsheet" };
    }

    // [SELF-HEAL 2026-07-14] Sesi menyimpan tenantSpreadsheetId SAAT DIBUAT
    // (createSession_) - kalau ID itu ternyata tidak bisa dibuka oleh user
    // ini (kasus nyata: sesi dibuat saat akun masih menunjuk spreadsheet
    // salah milik Drive admin), JANGAN lempar error mentah Google ("Anda
    // tidak memiliki izin...") ke layar. Matikan sesi rusak ini & balas
    // UNAUTHORIZED supaya client memaksa login ulang - loginUser yang baru
    // (Modul_Auth.gs) akan memverifikasi/memperbaiki tenant dengan benar
    // sebagai user itu sendiri, lalu membuat sesi baru yang sehat.
    let ss;
    try {
      ss = SpreadsheetApp.openById(session.tenantSpreadsheetId);
    } catch (openErr) {
      try {
        deleteKeyRow_(ensureDataSheet_(), authKeySession_(String(sessionToken || "").trim()));
      } catch (cleanupErr) {}
      return { ok: false, error: "Sesi login perlu diperbarui. Silakan login ulang.", stage: "withTenant_:stale_tenant_session", code: "UNAUTHORIZED" };
    }

    setActiveDataSpreadsheet_(ss);
    return fn();
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err), stage: "withTenant_:exception" };
  } finally {
    setActiveDataSpreadsheet_(null);
  }
}

// ----------------------------------------------------------------------------
// ENTRY POINT WEB APP
// ----------------------------------------------------------------------------

function doGet(e) {
  const diag = handleFirestoreDiagnostic_(e);
  if (diag) return diag;

  return HtmlService
    .createTemplateFromFile("Index")
    .evaluate()
    .setTitle("Kalkulator Laundry")
    .addMetaTag(
      "viewport",
      "width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover"
    )
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * [SEMENTARA -- HAPUS SETELAH MIGRASI SEMUA TENANT SELESAI DIVERIFIKASI]
 * Editor Apps Script sempat tidak bisa dipakai utk jalankan fungsi manual,
 * jadi operasi migrasi/diagnostik Firestore dijalankan lewat HTTP (query
 * param) sebagai gantinya. Dikunci token acak supaya tidak bisa dipanggil
 * orang lain. TIDAK menyentuh withTenant_/sesi user manapun.
 * Ruang lingkup dipersempit ke operasi migrasi yg masih relevan (bukan lagi
 * debug per-langkah spt fase pembuktian awal) - lihat project_migrasi_firestore
 * di memori untuk daftar lengkap yang perlu dihapus nanti.
 */
function handleFirestoreDiagnostic_(e) {
  const params = (e && e.parameter) || {};
  const token = params.firestoreDiag;
  if (!token) return null;
  if (token !== "172f236702e084579016d5fabd8e8ea598af2a070b59a307") return null;

  let payload;
  try {
    const action = params.action || "testConnection";
    if (action === "testConnection") {
      payload = { ok: true, action: action, result: testFirestoreConnection_() };
    } else if (action === "listCabang") {
      payload = { ok: true, action: action, result: listCabangIdsForTest_() };
    } else if (action === "recomputeAll") {
      payload = { ok: true, action: action, result: recomputeAllCabang_() };
    } else if (action === "migrateAllTenants") {
      payload = { ok: true, action: action, result: migrateAllTenantsToFirestore_() };
    } else if (action === "migrateAllTenantsFullData") {
      payload = { ok: true, action: action, result: migrateAllTenantsFullData_() };
    } else if (action === "migrateOneCabangFull") {
      const cabangId = params.cabangId;
      if (!cabangId) throw new Error("Parameter cabangId wajib diisi (?cabangId=...).");
      payload = { ok: true, action: action, result: migrateCabangFullConfig_(cabangId) };
    } else if (action === "verifyCabangFull") {
      const cabangId = params.cabangId;
      if (!cabangId) throw new Error("Parameter cabangId wajib diisi (?cabangId=...).");
      const tenantId = activeDataSpreadsheetId_();
      const path = firestoreCabangDocPath_(tenantId, cabangId);
      const doc = firestoreGet_(path);
      const configDocs = {
        air: firestoreGet_(path + "/config/air"),
        listrik: firestoreGet_(path + "/config/listrik"),
        notaKasir: firestoreGet_(path + "/config/notaKasir"),
        tetapOutlet: firestoreGet_(path + "/config/tetapOutlet"),
        hargaLayanan: firestoreGet_(path + "/config/hargaLayanan"),
        hppToggles: firestoreGet_(path + "/config/hppToggles"),
      };
      const subCounts = {
        gas: firestoreListCollection_(path, "gas").length,
        chemical: firestoreListCollection_(path, "chemical").length,
        packing: firestoreListCollection_(path, "packing").length,
      };
      payload = { ok: true, action: action, cabangId: cabangId, hasComputed: !!(doc && doc.computed), hasProfil: !!(doc && doc.profil), configDocsFound: Object.keys(configDocs).filter(function (k) { return !!configDocs[k]; }), subCounts: subCounts };
    } else {
      throw new Error("action tidak dikenal: " + action);
    }
  } catch (err) {
    payload = { ok: false, error: err && err.message ? err.message : String(err) };
  }

  return ContentService
    .createTextOutput(JSON.stringify(payload, null, 2))
    .setMimeType(ContentService.MimeType.JSON);
}

function include(filename) {
  var cleanName = String(filename || "").trim();

  if (!cleanName) {
    throw new Error("include(filename) gagal: nama file kosong.");
  }

  if (cleanName.indexOf("/") !== -1 || cleanName.indexOf("\\") !== -1) {
    throw new Error(
      "include(filename) gagal: nama file tidak boleh memakai path folder. File: " +
      cleanName
    );
  }

  if (/\.html$/i.test(cleanName)) {
    throw new Error(
      "include(filename) gagal: panggil tanpa ekstensi .html. Gunakan include('" +
      cleanName.replace(/\.html$/i, "") +
      "')."
    );
  }

  try {
    return HtmlService
      .createHtmlOutputFromFile(cleanName)
      .getContent();
  } catch (err) {
    throw new Error(
      "include('" + cleanName + "') gagal. Pastikan file " +
      cleanName +
      ".html sudah ada di Apps Script. Detail: " +
      (err && err.message ? err.message : String(err))
    );
  }
}