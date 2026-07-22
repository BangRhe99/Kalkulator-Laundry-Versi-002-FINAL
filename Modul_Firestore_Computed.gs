/**
 * ============================================================================
 * MODUL: LAYER COMPUTED FIRESTORE (Fase 4 -- "hitung saat SIMPAN, baca sekali")
 * ============================================================================
 * Ini inti percepatan migrasi Firestore. Prinsip: hasil kalkulasi HPP
 * TIDAK dihitung ulang tiap layar dibuka (mahal di Firestore karena tiap baca
 * = 1 HTTP round-trip), melainkan dihitung SEKALI saat data biaya berubah,
 * lalu disimpan ("denormalisasi") ke field `computed.hpp` pada dokumen Cabang.
 * Baca berikutnya cukup 1 GET, bukan fan-out 7 sumber.
 *
 * tenantId Firestore = ID spreadsheet tenant aktif (activeDataSpreadsheetId_,
 * Util_Penyimpanan.gs) -- unik & stabil per tenant, tersedia otomatis di dalam
 * withTenant_ (Code.gs) maupun konteks pemilik (spreadsheet Master).
 *
 * SUMBER KEBENARAN kalkulasi TETAP getStrukturBiayaHPP_impl_
 * (Modul_StrukturBiayaHPP.gs) -- TIDAK diduplikasi di sini. Modul ini hanya
 * memindahkan KAPAN & KE MANA hasilnya disimpan.
 *
 * CATATAN AMAN: recomputeCabangSummary_ BEST-EFFORT (dibungkus try/catch,
 * TIDAK PERNAH melempar). Jadi kalau nanti dipanggil dari fungsi simpan
 * (saveBiayaAir dkk), kegagalan Firestore (jaringan/kuota) TIDAK menggagalkan
 * penyimpanan ke Sheets yang merupakan sumber kebenaran saat ini.
 * ============================================================================
 */

function firestoreCabangDocPath_(tenantId, cabangId) {
  return "tenants/" + tenantId + "/cabang/" + cabangId;
}

// ============================================================================
// [READ-FIRST FIRESTORE, 2026-07-21] Helper generik dipakai SEMUA modul untuk
// membalik urutan baca: coba Firestore DULU (lebih cepat), kalau tidak ada/
// gagal (data lama yang belum ke-migrasi, Firestore sedang bermasalah, dst)
// otomatis kembalikan null -- pemanggil WAJIB fallback ke Sheets seperti
// biasa. TIDAK PERNAH throw. Ini yang membuat flip ini rendah risiko: Sheets
// TETAP ditulis (dual-write tidak dicabut) dan TETAP jadi jaring pengaman.
// ============================================================================

function firestoreTryGetPath_(relPath) {
  try {
    return firestoreGet_(relPath);
  } catch (err) {
    console.warn("firestoreTryGetPath_(" + relPath + ") gagal, fallback Sheets: " + err);
    return null;
  }
}

function firestoreTryListPath_(parentPath, collectionId) {
  try {
    return firestoreListCollection_(parentPath, collectionId);
  } catch (err) {
    console.warn("firestoreTryListPath_(" + parentPath + "/" + collectionId + ") gagal, fallback Sheets: " + err);
    return null;
  }
}

/**
 * Cache per-eksekusi (reset tiap request baru, sama seperti _dataSheetCache_
 * di Util_Penyimpanan.gs) -- WAJIB, karena isBedCoverAktif_/isHPPLayananAktif_
 * dipanggil sampai 7x per satu hitung HPP (1x bed cover + 6x layanan lain).
 * Tanpa cache ini, flip ke Firestore akan jadi 7 HTTP call per hitung HPP --
 * regresi fan-out yang sama seperti yang sudah kita hindari di tempat lain.
 */
let _hppTogglesFirestoreCache_ = {};

function getHppTogglesDocCached_(cabangId) {
  if (Object.prototype.hasOwnProperty.call(_hppTogglesFirestoreCache_, cabangId)) {
    return _hppTogglesFirestoreCache_[cabangId];
  }
  let doc = null;
  const tenantId = activeDataSpreadsheetId_();
  if (tenantId) {
    doc = firestoreTryGetPath_(firestoreCabangDocPath_(tenantId, cabangId) + "/config/hppToggles");
  }
  _hppTogglesFirestoreCache_[cabangId] = doc;
  return doc;
}

/**
 * [2026-07-22 - PERFORMA DASHBOARD] Cache per-eksekusi 1 GET dokumen Cabang
 * dibagi SEMUA fast-reader ringkasan Dashboard (HPP/MasterBiaya/HargaLayanan/
 * FixedCost/BEP/PotensiOmset) - tanpa ini, buka Dashboard 1 cabang jadi 6 GET
 * terpisah (1 per ringkasan) walau cache-nya "hangat". Diukur nyata sebelum
 * perbaikan ini: 78 panggilan Firestore/64 detik utk buka 1 cabang (5 dari 6
 * ringkasan belum pakai pola computed sama sekali + fan-out silang antar
 * fungsi - BEP manggil ulang FixedCost&HargaLayanan penuh, PotensiOmset
 * manggil ulang SELURUH BEP lagi). Reset otomatis tiap eksekusi baru.
 */
let _dashboardComputedDocCache_ = {};

function dashboardGetComputedDoc_(cabangId) {
  if (Object.prototype.hasOwnProperty.call(_dashboardComputedDocCache_, cabangId)) {
    return _dashboardComputedDocCache_[cabangId];
  }
  let doc = null;
  try {
    const tenantId = activeDataSpreadsheetId_();
    if (tenantId) doc = firestoreGet_(firestoreCabangDocPath_(tenantId, cabangId));
  } catch (err) {
    console.warn("dashboardGetComputedDoc_(" + cabangId + ") gagal: " + err);
    doc = null;
  }
  _dashboardComputedDocCache_[cabangId] = doc;
  return doc;
}

/**
 * [2026-07-22 - FIX REGRESI SIMPAN, tahap 2] Isi cache dokumen per-eksekusi
 * (dashboardGetComputedDoc_) DENGAN NILAI SEGAR begitu 1 field selesai
 * dihitung ulang di recomputeCabangSummary_/buildComputedWriteSpec_ --
 * SEBELUM ditulis ke Firestore (yang baru terjadi di akhir batch).
 * WAJIB: supaya BEP/PotensiOmset (yang dihitung ulang dalam BATCH SIMPAN
 * YANG SAMA, mis. titik simpan HargaLayanan) membaca versi BARU field yang
 * baru saja ikut dihitung ulang, BUKAN versi lama dari Firestore -- kalau
 * tidak, BEP bisa memakai harga jual/HPP LAMA walau HargaLayanan baru saja
 * disimpan pada request yang sama. Field yang TIDAK ikut di-recompute pada
 * batch ini (mis. fixedCost saat simpan Air) TETAP terbaca dari cache
 * Firestore lama, yang memang masih akurat (tidak terpengaruh perubahan).
 */
function dashboardPrimeComputedCache_(cabangId, field, value) {
  const existing = _dashboardComputedDocCache_[cabangId];
  const base = (existing && typeof existing === "object") ? existing : {};
  const computed = (base.computed && typeof base.computed === "object") ? base.computed : {};
  computed[field] = value;
  base.computed = computed;
  _dashboardComputedDocCache_[cabangId] = base;
}

/**
 * [2026-07-22] Semua 6 field `computed.*` yang ada. Dipakai sbg default
 * kalau caller tidak menentukan `fields` (mis. backfill massal/self-heal) --
 * konteks itu tidak tahu dependency spesifik, jadi aman hitung semuanya.
 */
const DASHBOARD_ALL_COMPUTED_FIELDS_ = ["hpp", "masterBiaya", "hargaLayanan", "fixedCost", "bep", "potensiOmset"];

/**
 * [2026-07-22] Grup dependency per titik simpan -- fixedCost HANYA
 * bergantung ke Biaya Tetap Outlet, TIDAK ke Gas/Chemical/Packing/Air/
 * Listrik/NotaKasir/HargaLayanan/toggle HPP, jadi titik simpan itu tidak
 * perlu ikut menghitung ulang fixedCost (ini akar regresi 45,5 detik).
 */
const DASHBOARD_RECOMPUTE_HPP_GROUP_ = ["hpp", "masterBiaya", "hargaLayanan", "bep", "potensiOmset"];
const DASHBOARD_RECOMPUTE_FIXEDCOST_GROUP_ = ["fixedCost", "bep", "potensiOmset"];
const DASHBOARD_RECOMPUTE_HARGALAYANAN_GROUP_ = ["hargaLayanan", "bep", "potensiOmset"];
const DASHBOARD_RECOMPUTE_BEPMIX_GROUP_ = ["bep", "potensiOmset"];

/**
 * [2026-07-22] Fungsi `_impl_` sumber tiap field computed (dipakai
 * recomputeCabangSummary_ & buildComputedWriteSpec_ supaya tidak duplikat).
 */
const DASHBOARD_COMPUTED_SOURCE_FNS_ = {
  masterBiaya: function (cabangId) { return getDashboardMasterBiayaSummary_impl_(cabangId); },
  hargaLayanan: function (cabangId) { return getDashboardHargaLayananSummary_impl_(cabangId); },
  fixedCost: function (cabangId) { return getDashboardFixedCostSummary_impl_(cabangId); },
  bep: function (cabangId) { return getDashboardBEPSummary_impl_(cabangId); },
  potensiOmset: function (cabangId) { return getDashboardPotensiOmsetSummary_impl_(cabangId); },
};

/**
 * Hitung ulang HANYA field `computed.xxx` yang diminta (`fields`, default
 * SEMUA 6) satu cabang, lalu simpan dgn updateMask GRANULAR per-field
 * ("computed.hpp", "computed.masterBiaya", dst - BUKAN blanket "computed")
 * supaya field lain yg TIDAK dihitung ulang (mis. simpan Air tidak perlu
 * hitung ulang fixedCost) tetap UTUH, tidak ketimpa/terhapus.
 * [2026-07-22 - FIX REGRESI SIMPAN] Sebelumnya versi ini SELALU hitung
 * SEMUA 6 ringkasan pada TIAP titik simpan (mask blanket "computed") --
 * diukur nyata: 1x simpan Air jadi 45,5 DETIK (harusnya ~1-2 detik) karena
 * ikut menghitung ulang FixedCost/BEP/PotensiOmset yang TIDAK terpengaruh
 * data Air sama sekali. Sekarang tiap titik simpan kirim `fields` spesifik
 * sesuai dependency data yang benar-benar berubah.
 * Semua sumber `_impl_` TETAP baca dari Sheets (kebenaran asli) - modul ini
 * HANYA memindahkan KAPAN & KE MANA hasilnya disimpan, TIDAK menduplikasi
 * rumus/logika bisnis apa pun.
 * BEST-EFFORT: tidak pernah melempar; kembalikan {ok:false,...} kalau gagal.
 */
function recomputeCabangSummary_(cabangId, fields) {
  try {
    if (!cabangId || typeof cabangId !== "string") {
      return { ok: false, error: "cabangId tidak valid" };
    }
    const tenantId = activeDataSpreadsheetId_();
    if (!tenantId) return { ok: false, error: "tenantId (spreadsheet aktif) tidak ditemukan" };
    const wanted = (fields && fields.length) ? fields : DASHBOARD_ALL_COMPUTED_FIELDS_;

    // [PENTING] Pastikan cache dokumen per-eksekusi sudah DI-FETCH (dari
    // Firestore, data NYATA) SEBELUM mulai priming field-per-field di bawah.
    // Tanpa ini, dashboardPrimeComputedCache_ bisa "meracuni" cache dgn
    // objek PARSIAL sebelum GET asli terjadi -- dashboardGetComputedDoc_
    // lihat cabangId sudah "ada" di cache (walau isinya cuma field yg baru
    // di-prime) & TIDAK PERNAH fetch field lain yg sudah ada di Firestore
    // (mis. fixedCost) -- Fast_ reader field itu jadi selalu miss & balik
    // hitung LIVE (mahal), padahal harusnya cukup baca cache.
    dashboardGetComputedDoc_(cabangId);

    // Buang cache HPP per-eksekusi supaya dihitung ULANG dari data terbaru
    // (penting kalau dipanggil tepat setelah save dalam eksekusi yang sama).
    if (typeof _strukturBiayaHPPCache_ !== "undefined" && _strukturBiayaHPPCache_ && _strukturBiayaHPPCache_[cabangId]) {
      delete _strukturBiayaHPPCache_[cabangId];
    }

    const computed = { computedAt: new Date() };
    const maskFields = ["computed.computedAt"];

    if (wanted.indexOf("hpp") !== -1) {
      const hppRes = getStrukturBiayaHPP_impl_(cabangId);
      if (!hppRes || !hppRes.ok) {
        return { ok: false, error: (hppRes && hppRes.error) || "getStrukturBiayaHPP gagal" };
      }
      computed.hpp = hppRes.data;
      maskFields.push("computed.hpp");
      dashboardPrimeComputedCache_(cabangId, "hpp", hppRes.data);
    }

    // [2026-07-22] Ringkasan Dashboard lain - reuse fungsi _impl_ yang SUDAH
    // ADA & sudah dipakai jalur baca lama (tidak ada logika baru di sini).
    // Masing-masing dibungkus try/catch sendiri supaya 1 ringkasan gagal
    // tidak menggagalkan yang lain - field yang gagal cukup TIDAK disimpan,
    // fast-reader-nya otomatis fallback live seperti biasa utk field itu saja.
    // Urutan `wanted` SENGAJA dependency-first (masterBiaya/hargaLayanan/
    // fixedCost sebelum bep, bep sebelum potensiOmset) supaya begitu BEP
    // dihitung, dashboardPrimeComputedCache_ dari langkah sebelumnya sudah
    // ke-isi & terbaca oleh Fast_ reader yang dipanggil BEP/PotensiOmset
    // secara internal (lihat getDashboardBEPSummary_impl_).
    wanted.forEach(function (field) {
      if (field === "hpp" || !DASHBOARD_COMPUTED_SOURCE_FNS_[field]) return;
      try {
        const res = DASHBOARD_COMPUTED_SOURCE_FNS_[field](cabangId);
        if (res && res.ok) {
          computed[field] = res.data;
          maskFields.push("computed." + field);
          dashboardPrimeComputedCache_(cabangId, field, res.data);
        }
      } catch (extraErr) {
        console.warn("recomputeCabangSummary_ (" + field + ") gagal utk " + cabangId + ": " + extraErr);
      }
    });

    firestoreSet_(
      firestoreCabangDocPath_(tenantId, cabangId),
      { computed: computed },
      maskFields
    );
    // Cache per-eksekusi SUDAH di-prime field-per-field di atas (SEBELUM
    // write ini) via dashboardPrimeComputedCache_ -- TIDAK dibuang di sini
    // (beda dari versi sebelumnya) supaya baca berikutnya di eksekusi yang
    // SAMA tidak perlu 1 GET Firestore lagi (datanya sudah identik dgn yang
    // baru saja ditulis).
    dashboardPrimeComputedCache_(cabangId, "computedAt", computed.computedAt);
    return { ok: true, tenantId: tenantId, cabangId: cabangId };
  } catch (err) {
    console.warn("recomputeCabangSummary_ gagal (non-fatal) utk " + cabangId + ": " + err);
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * Baca HPP CEPAT: 1 GET dari Firestore (computed.hpp, dibagi via
 * dashboardGetComputedDoc_). Kalau belum ada (cabang belum pernah di-
 * recompute), fallback hitung dari Sheets SEKALIGUS memicu recompute supaya
 * baca berikutnya sudah cepat. `_source` menandai dari mana hasilnya,
 * berguna saat verifikasi.
 */
function getStrukturBiayaHPPFast_(cabangId) {
  try {
    const doc = dashboardGetComputedDoc_(cabangId);
    if (doc && doc.computed && doc.computed.hpp) {
      return { ok: true, data: doc.computed.hpp, _source: "firestore", _computedAt: doc.computed.computedAt || null };
    }
  } catch (err) {
    console.warn("getStrukturBiayaHPPFast_ Firestore gagal, fallback Sheets: " + err);
  }
  const res = getStrukturBiayaHPP_impl_(cabangId);
  try { recomputeCabangSummary_(cabangId); } catch (e) {}
  if (res && res.ok) res._source = "sheets_fallback";
  return res;
}

/**
 * [2026-07-22] 5 fast-reader ringkasan Dashboard lain - pola SAMA PERSIS
 * dgn getStrukturBiayaHPPFast_ di atas: baca `computed.xxx` (via cache
 * dokumen bersama dashboardGetComputedDoc_), fallback ke `_impl_` LIVE +
 * self-heal (recomputeCabangSummary_) kalau cache kosong/gagal.
 */
function dashboardFastReader_(cabangId, computedField, implFn) {
  try {
    const doc = dashboardGetComputedDoc_(cabangId);
    if (doc && doc.computed && doc.computed[computedField]) {
      return { ok: true, data: doc.computed[computedField], _source: "firestore" };
    }
  } catch (err) {
    console.warn("dashboardFastReader_(" + computedField + ") Firestore gagal, fallback Sheets: " + err);
  }
  const res = implFn(cabangId);
  try { recomputeCabangSummary_(cabangId); } catch (e) {}
  if (res && res.ok) res._source = "sheets_fallback";
  return res;
}

function getDashboardMasterBiayaSummaryFast_(cabangId) {
  return dashboardFastReader_(cabangId, "masterBiaya", getDashboardMasterBiayaSummary_impl_);
}
function getDashboardHargaLayananSummaryFast_(cabangId) {
  return dashboardFastReader_(cabangId, "hargaLayanan", getDashboardHargaLayananSummary_impl_);
}
function getDashboardFixedCostSummaryFast_(cabangId) {
  return dashboardFastReader_(cabangId, "fixedCost", getDashboardFixedCostSummary_impl_);
}
function getDashboardBEPSummaryFast_(cabangId) {
  return dashboardFastReader_(cabangId, "bep", getDashboardBEPSummary_impl_);
}
function getDashboardPotensiOmsetSummaryFast_(cabangId) {
  return dashboardFastReader_(cabangId, "potensiOmset", getDashboardPotensiOmsetSummary_impl_);
}

/**
 * [DUAL-WRITE RINGAN, 2026-07-21 -- REVISI setelah diukur] Versi PERTAMA
 * fungsi ini memanggil migrateCabangFullConfig_ (nulis ULANG SEMUA config +
 * semua item gas/chemical/packing) di SETIAP simpan -- diukur 12 DETIK per
 * simpan (15+ HTTP call berurutan ke Firestore). Itu regresi besar, BUKAN
 * percepatan. Diganti total: sekarang cuma menyentuh DOKUMEN YANG BENAR-BENAR
 * BERUBAH (lihat firestoreSyncConfigDoc_/firestoreSyncSubItem_/
 * firestoreSyncCabangProfil_/firestoreSyncHppToggles_ di bawah) + 1 write
 * recompute HPP -- total 2 HTTP call per simpan (~0.5-1 detik), BUKAN 15+.
 *
 * refreshFirestoreForCabang_ TETAP ADA (dipanggil dari titik yang TIDAK tahu
 * field spesifik mana yang berubah, mis. delete Gas/Chemical/Packing) --
 * TAPI sekarang cuma memanggil recomputeCabangSummary_ (murah), TIDAK LAGI
 * migrateCabangFullConfig_ yang mahal. Sinkron dokumen spesifik dilakukan
 * oleh firestoreSyncXxx_ di titik simpannya masing-masing.
 */
function refreshFirestoreForCabang_(cabangId) {
  return recomputeCabangSummary_(cabangId);
}

/** Sinkron 1 dokumen config 1:1 (air/listrik/notaKasir/tetapOutlet/hargaLayanan). BEST-EFFORT. */
function firestoreSyncConfigDoc_(cabangId, docName, record) {
  try {
    const tenantId = activeDataSpreadsheetId_();
    if (!tenantId) return;
    firestoreSet_(firestoreCabangDocPath_(tenantId, cabangId) + "/config/" + docName, record);
  } catch (err) {
    console.warn("firestoreSyncConfigDoc_(" + docName + ") gagal (non-fatal): " + err);
  }
}

/** Sinkron 1 item subkoleksi (gas/chemical/packing) setelah create/update. BEST-EFFORT. */
function firestoreSyncSubItem_(cabangId, subcollection, record) {
  try {
    const tenantId = activeDataSpreadsheetId_();
    if (!tenantId || !record || !record.id) return;
    firestoreSet_(firestoreCabangDocPath_(tenantId, cabangId) + "/" + subcollection + "/" + record.id, record);
  } catch (err) {
    console.warn("firestoreSyncSubItem_(" + subcollection + ") gagal (non-fatal): " + err);
  }
}

/** Sinkron field profil dokumen Cabang (bukan config/computed). BEST-EFFORT. */
function firestoreSyncCabangProfil_(cabangId, cabang) {
  try {
    const tenantId = activeDataSpreadsheetId_();
    if (!tenantId) return;
    firestoreSet_(firestoreCabangDocPath_(tenantId, cabangId), {
      profil: cabang.profil,
      mesinCuci: cabang.mesinCuci,
      mesinPengering: cabang.mesinPengering,
      mesinSetrika: cabang.mesinSetrika,
      kategoriLayanan: cabang.kategoriLayanan,
      okupansi: cabang.okupansi,
      createdAt: cabang.createdAt,
      updatedAt: cabang.updatedAt,
    }, ["profil", "mesinCuci", "mesinPengering", "mesinSetrika", "kategoriLayanan", "okupansi", "createdAt", "updatedAt"]);
  } catch (err) {
    console.warn("firestoreSyncCabangProfil_ gagal (non-fatal): " + err);
  }
}

/**
 * Sinkron config/hppToggles (gabungan bedCoverAktif + 6 toggle layanan +
 * bepMix dari 3 sumber Sheets berbeda) -- dipanggil dari setBedCoverAktif_impl_
 * / setHPPLayananAktif_impl_ / saveBepServiceMix_impl_ karena ketiganya
 * berbagi SATU dokumen Firestore yang sama. Baca ulang dari Sheets murah
 * (bukan Firestore), cuma 1 Firestore WRITE di akhir. BEST-EFFORT.
 */
function firestoreSyncHppToggles_(cabangId) {
  try {
    const tenantId = activeDataSpreadsheetId_();
    if (!tenantId) return;
    const layananAktif = {};
    STRUKTUR_HPP_TOGGLABLE_KEYS_.forEach(function (key) {
      if (key === STRUKTUR_HPP_SERVICE_KEYS_.BED_COVER) return;
      layananAktif[key] = isHPPLayananAktifSheetsOnly_(cabangId, key);
    });
    const bepMixRaw = readKey_(ensureDataSheet_(), "bepMix_" + cabangId);
    let bepMix = null;
    if (bepMixRaw) {
      try { bepMix = JSON.parse(bepMixRaw).mix || null; } catch (e) { bepMix = null; }
    }
    firestoreSet_(firestoreCabangDocPath_(tenantId, cabangId) + "/config/hppToggles", {
      bedCoverAktif: isBedCoverAktifSheetsOnly_(cabangId),
      layananAktif: layananAktif,
      bepMix: bepMix || {},
    });
  } catch (err) {
    console.warn("firestoreSyncHppToggles_ gagal (non-fatal): " + err);
  }
}

// ============================================================================
// [OPTIMASI BATCH, 2026-07-21] Versi gabungan di atas -- setiap titik simpan
// yang butuh SYNC 1 dokumen + RECOMPUTE HPP (2 write ke dokumen berbeda)
// digabung jadi SATU HTTP call lewat firestoreCommit_ (bukan 2 firestoreSet_
// berurutan). Diukur: turun ~1 detik/simpan dibanding 2 panggilan terpisah.
// ============================================================================

/**
 * [2026-07-22] Versi BATCHED dari recomputeCabangSummary_ - dipakai SEMUA
 * helper `...AndRecompute_` di bawah supaya recompute-nya digabung jadi 1
 * HTTP call bareng write config/sub-item-nya, BUKAN write terpisah.
 * `fields` (default SEMUA 6) menentukan field `computed.xxx` mana yang
 * DIHITUNG ULANG & ditulis (updateMask GRANULAR per-field, bukan blanket
 * "computed") -- field lain yang TIDAK diminta tetap UTUH di Firestore.
 * [2026-07-22 - FIX REGRESI SIMPAN] Sebelumnya SELALU hitung ke-6 ringkasan
 * pada TIAP titik simpan -- diukur: 1x simpan Air jadi 45,5 DETIK karena
 * ikut menghitung ulang FixedCost/BEP/PotensiOmset yg tidak terpengaruh data
 * Air. Sekarang tiap caller kirim `fields` sesuai dependency data yg benar2
 * berubah (mis. simpan Air/Gas/Chemical dst TIDAK perlu hitung ulang
 * fixedCost, karena FixedCost cuma bergantung ke Biaya Tetap Outlet).
 */
function buildComputedWriteSpec_(tenantId, cabangId, fields) {
  const wanted = (fields && fields.length) ? fields : DASHBOARD_ALL_COMPUTED_FIELDS_;
  // [PENTING] Sama seperti recomputeCabangSummary_ -- pastikan cache dokumen
  // per-eksekusi sudah DI-FETCH NYATA sebelum priming field-per-field,
  // supaya field yg TIDAK ikut di-recompute batch ini (mis. fixedCost saat
  // simpan Air) tetap kebaca dari Firestore, bukan selalu "miss".
  dashboardGetComputedDoc_(cabangId);
  if (typeof _strukturBiayaHPPCache_ !== "undefined" && _strukturBiayaHPPCache_ && _strukturBiayaHPPCache_[cabangId]) {
    delete _strukturBiayaHPPCache_[cabangId];
  }

  const computed = { computedAt: new Date() };
  const maskFields = ["computed.computedAt"];

  if (wanted.indexOf("hpp") !== -1) {
    const hppRes = getStrukturBiayaHPP_impl_(cabangId);
    if (!hppRes || !hppRes.ok) return null;
    computed.hpp = hppRes.data;
    maskFields.push("computed.hpp");
    dashboardPrimeComputedCache_(cabangId, "hpp", hppRes.data);
  }

  // Urutan `wanted` SENGAJA dependency-first -- lihat catatan sama di
  // recomputeCabangSummary_ (dashboardPrimeComputedCache_ di bawah supaya
  // BEP/PotensiOmset baca versi SEGAR field yg baru dihitung di batch INI,
  // bukan versi lama dari Firestore).
  wanted.forEach(function (field) {
    if (field === "hpp" || !DASHBOARD_COMPUTED_SOURCE_FNS_[field]) return;
    try {
      const res = DASHBOARD_COMPUTED_SOURCE_FNS_[field](cabangId);
      if (res && res.ok) {
        computed[field] = res.data;
        maskFields.push("computed." + field);
        dashboardPrimeComputedCache_(cabangId, field, res.data);
      }
    } catch (extraErr) {
      console.warn("buildComputedWriteSpec_ (" + field + ") gagal utk " + cabangId + ": " + extraErr);
    }
  });

  dashboardPrimeComputedCache_(cabangId, "computedAt", computed.computedAt);

  return {
    relPath: firestoreCabangDocPath_(tenantId, cabangId),
    data: { computed: computed },
    updateMaskFields: maskFields,
  };
}

/** Sinkron 1 dokumen config 1:1 + recompute HPP, DIGABUNG jadi 1 HTTP call. BEST-EFFORT. */
function firestoreSyncConfigDocAndRecompute_(cabangId, docName, record, fields) {
  try {
    const tenantId = activeDataSpreadsheetId_();
    if (!tenantId) return;
    const writeSpecs = [{ relPath: firestoreCabangDocPath_(tenantId, cabangId) + "/config/" + docName, data: record }];
    const computedSpec = buildComputedWriteSpec_(tenantId, cabangId, fields);
    if (computedSpec) writeSpecs.push(computedSpec);
    firestoreCommit_(writeSpecs);
  } catch (err) {
    console.warn("firestoreSyncConfigDocAndRecompute_(" + docName + ") gagal (non-fatal): " + err);
  }
}

/** Sinkron 1 item subkoleksi (gas/chemical/packing) + recompute HPP, DIGABUNG. BEST-EFFORT. */
function firestoreSyncSubItemAndRecompute_(cabangId, subcollection, record, fields) {
  try {
    const tenantId = activeDataSpreadsheetId_();
    if (!tenantId || !record || !record.id) return;
    const writeSpecs = [{ relPath: firestoreCabangDocPath_(tenantId, cabangId) + "/" + subcollection + "/" + record.id, data: record }];
    const computedSpec = buildComputedWriteSpec_(tenantId, cabangId, fields);
    if (computedSpec) writeSpecs.push(computedSpec);
    firestoreCommit_(writeSpecs);
  } catch (err) {
    console.warn("firestoreSyncSubItemAndRecompute_(" + subcollection + ") gagal (non-fatal): " + err);
  }
}

/** Hapus 1 item subkoleksi + recompute HPP, DIGABUNG (delete + update dlm 1 commit). BEST-EFFORT. */
function firestoreDeleteSubDocAndRecompute_(cabangId, subcollection, itemId, fields) {
  try {
    const tenantId = activeDataSpreadsheetId_();
    if (!tenantId || !cabangId || !itemId) return;
    const writeSpecs = [{ deletePath: firestoreCabangDocPath_(tenantId, cabangId) + "/" + subcollection + "/" + itemId }];
    const computedSpec = buildComputedWriteSpec_(tenantId, cabangId, fields);
    if (computedSpec) writeSpecs.push(computedSpec);
    firestoreCommit_(writeSpecs);
  } catch (err) {
    console.warn("firestoreDeleteSubDocAndRecompute_(" + subcollection + ") gagal (non-fatal): " + err);
  }
}

/**
 * Sinkron profil Cabang + recompute HPP -- KEDUANYA menyentuh dokumen Cabang
 * yang SAMA, jadi cukup 1 PATCH biasa (bukan perlu :commit sama sekali,
 * lebih murah lagi dari kasus lain yg beda dokumen). BEST-EFFORT.
 */
function firestoreSyncCabangProfilAndRecompute_(cabangId, cabang) {
  try {
    const tenantId = activeDataSpreadsheetId_();
    if (!tenantId) return;
    if (typeof _strukturBiayaHPPCache_ !== "undefined" && _strukturBiayaHPPCache_ && _strukturBiayaHPPCache_[cabangId]) {
      delete _strukturBiayaHPPCache_[cabangId];
    }
    const hppRes = getStrukturBiayaHPP_impl_(cabangId);
    const data = {
      profil: cabang.profil,
      mesinCuci: cabang.mesinCuci,
      mesinPengering: cabang.mesinPengering,
      mesinSetrika: cabang.mesinSetrika,
      kategoriLayanan: cabang.kategoriLayanan,
      okupansi: cabang.okupansi,
      createdAt: cabang.createdAt,
      updatedAt: cabang.updatedAt,
    };
    const maskFields = ["profil", "mesinCuci", "mesinPengering", "mesinSetrika", "kategoriLayanan", "okupansi", "createdAt", "updatedAt"];
    if (hppRes && hppRes.ok) {
      data.computed = { hpp: hppRes.data, computedAt: new Date() };
      // Mask GRANULAR ("computed.hpp"/"computed.computedAt"), BUKAN blanket
      // "computed" -- profil cabang cuma memengaruhi HPP, mask blanket akan
      // menghapus computed.masterBiaya/hargaLayanan/fixedCost/bep/
      // potensiOmset yang sudah ada (celah yang baru ketahuan saat
      // memperluas pola computed ke 5 ringkasan lain, 2026-07-22).
      maskFields.push("computed.hpp", "computed.computedAt");
    }
    firestoreSet_(firestoreCabangDocPath_(tenantId, cabangId), data, maskFields);
    if (Object.prototype.hasOwnProperty.call(_dashboardComputedDocCache_, cabangId)) {
      delete _dashboardComputedDocCache_[cabangId];
    }
  } catch (err) {
    console.warn("firestoreSyncCabangProfilAndRecompute_ gagal (non-fatal): " + err);
  }
}

/** Sinkron config/hppToggles + recompute HPP, DIGABUNG jadi 1 HTTP call. BEST-EFFORT. */
function firestoreSyncHppTogglesAndRecompute_(cabangId, fields) {
  try {
    const tenantId = activeDataSpreadsheetId_();
    if (!tenantId) return;
    const layananAktif = {};
    STRUKTUR_HPP_TOGGLABLE_KEYS_.forEach(function (key) {
      if (key === STRUKTUR_HPP_SERVICE_KEYS_.BED_COVER) return;
      layananAktif[key] = isHPPLayananAktifSheetsOnly_(cabangId, key);
    });
    const bepMixRaw = readKey_(ensureDataSheet_(), "bepMix_" + cabangId);
    let bepMix = null;
    if (bepMixRaw) {
      try { bepMix = JSON.parse(bepMixRaw).mix || null; } catch (e) { bepMix = null; }
    }
    const freshToggles = { bedCoverAktif: isBedCoverAktifSheetsOnly_(cabangId), layananAktif: layananAktif, bepMix: bepMix || {} };

    // [KRITIS] Isi cache per-eksekusi DENGAN NILAI SEGAR ini SEBELUM
    // buildComputedWriteSpec_ (yang lewat getStrukturBiayaHPP_impl_ bisa
    // memanggil isHPPLayananAktif_/isBedCoverAktif_ versi Firestore-first).
    // Tanpa ini, HPP yang dihitung ulang bisa memakai toggle LAMA (Firestore
    // belum ter-update saat baris ini jalan, commit-nya baru terjadi di
    // bawah) -- computed.hpp jadi tidak sinkron dengan toggle yang baru
    // saja disimpan pada commit yang SAMA.
    _hppTogglesFirestoreCache_[cabangId] = freshToggles;

    const writeSpecs = [{
      relPath: firestoreCabangDocPath_(tenantId, cabangId) + "/config/hppToggles",
      data: freshToggles,
    }];
    const computedSpec = buildComputedWriteSpec_(tenantId, cabangId, fields);
    if (computedSpec) writeSpecs.push(computedSpec);
    firestoreCommit_(writeSpecs);
  } catch (err) {
    console.warn("firestoreSyncHppTogglesAndRecompute_ gagal (non-fatal): " + err);
  }
}

/**
 * Hapus 1 dokumen di subkoleksi (gas/chemical/packing) cabang tertentu --
 * dipanggil SEBELUM refreshFirestoreForCabang_ saat user menghapus 1 item,
 * karena migrateCabangFullConfig_ hanya menimpa/menambah item yang MASIH
 * ADA di Sheets, tidak pernah menghapus item Firestore yang sudah tidak ada
 * lagi sumbernya. BEST-EFFORT.
 */
function firestoreDeleteSubDoc_(cabangId, subcollection, itemId) {
  try {
    const tenantId = activeDataSpreadsheetId_();
    if (!tenantId || !cabangId || !itemId) return;
    firestoreDeleteDoc_(firestoreCabangDocPath_(tenantId, cabangId) + "/" + subcollection + "/" + itemId);
  } catch (err) {
    console.warn("firestoreDeleteSubDoc_ gagal (non-fatal): " + err);
  }
}

/**
 * Hapus dokumen Cabang di Firestore SECARA PENUH (dipanggil saat cabang
 * dihapus di Sheets): dokumen utama + semua config/* + semua item di
 * subkoleksi gas/chemical/packing. BEST-EFFORT -- Firestore memang tidak
 * otomatis menghapus subkoleksi saat dokumen induk dihapus (beda dari
 * folder biasa), jadi harus eksplisit satu-satu di sini.
 */
function deleteCabangComputed_(cabangId) {
  try {
    const tenantId = activeDataSpreadsheetId_();
    if (!tenantId || !cabangId) return;
    const path = firestoreCabangDocPath_(tenantId, cabangId);

    ["air", "listrik", "notaKasir", "tetapOutlet", "hargaLayanan", "hppToggles"].forEach(function (name) {
      try { firestoreDeleteDoc_(path + "/config/" + name); } catch (e) {}
    });
    ["gas", "chemical", "packing"].forEach(function (sub) {
      try {
        firestoreListCollection_(path, sub).forEach(function (item) {
          const id = item && item._path ? item._path.split("/").pop() : null;
          if (id) firestoreDeleteDoc_(path + "/" + sub + "/" + id);
        });
      } catch (e) {}
    });

    firestoreDeleteDoc_(path);
  } catch (err) {
    console.warn("deleteCabangComputed_ gagal (non-fatal): " + err);
  }
}

/**
 * Backfill LINTAS-TENANT: baca semua akun terdaftar dari spreadsheet Master
 * (authUser_ prefix, Modul_Auth.gs), lalu untuk tiap akun yang punya
 * tenantSpreadsheetId, buka spreadsheet tenant itu dan recompute SEMUA
 * cabangnya. Dipakai SEKALI untuk migrasi awal seluruh basis pengguna
 * (bukan cuma akun pemilik). Read-only terhadap Sheets (cuma
 * recomputeAllCabang_ per tenant, yang cuma menulis field `computed` di
 * Firestore) -- tidak mengubah data Sheets tenant manapun.
 *
 * PENTING: dijalankan dari konteks Master (bound spreadsheet), BUKAN di
 * dalam withTenant_ tenant manapun -- karena perlu baca daftar SEMUA akun.
 * Set & reset _activeDataSpreadsheet_ manual per tenant, dibungkus
 * try/finally supaya satu tenant gagal tidak menghentikan/mengacaukan
 * konteks tenant berikutnya.
 */
function migrateAllTenantsToFirestore_() {
  const masterSheet = ensureDataSheet_(); // _activeDataSpreadsheet_ null di sini -> jatuh ke bound (Master)
  const accountRows = readKeysByPrefix_(masterSheet, "authUser_");

  const hasil = [];
  for (let i = 0; i < accountRows.length; i++) {
    let user;
    try { user = JSON.parse(accountRows[i].value); } catch (e) { continue; }
    if (!user || !user.tenantSpreadsheetId) {
      hasil.push({ email: user && user.email, ok: false, error: "Belum punya tenantSpreadsheetId (akun belum lengkap)" });
      continue;
    }

    try {
      const tenantSs = SpreadsheetApp.openById(user.tenantSpreadsheetId);
      setActiveDataSpreadsheet_(tenantSs);
      try {
        const r = recomputeAllCabang_();
        hasil.push({ email: user.email, tenantId: user.tenantSpreadsheetId, ok: !!(r && r.ok), totalCabang: r && r.total, detail: r && r.hasil, error: r && r.error });
      } finally {
        setActiveDataSpreadsheet_(null); // WAJIB direset sebelum lanjut ke tenant berikutnya
      }
    } catch (err) {
      setActiveDataSpreadsheet_(null);
      hasil.push({ email: user.email, tenantId: user.tenantSpreadsheetId, ok: false, error: err && err.message ? err.message : String(err) });
    }
  }

  return {
    ok: true,
    totalAkun: accountRows.length,
    totalTenantSukses: hasil.filter(function (h) { return h.ok; }).length,
    totalTenantGagal: hasil.filter(function (h) { return !h.ok; }).length,
    hasil: hasil,
  };
}

/**
 * Backfill LINTAS-TENANT data MENTAH (bukan cuma computed.hpp) -- sama pola
 * dengan migrateAllTenantsToFirestore_, tapi memanggil
 * migrateAllCabangFullConfig_ (Modul_Firestore_HPP_Eksperimen.gs) per tenant:
 * salin profil cabang + config air/listrik/notaKasir/tetapOutlet/hargaLayanan/
 * hppToggles + subkoleksi gas/chemical/packing. Read-only thd Sheets (cuma
 * MENYALIN, tidak mengubah/menghapus apapun di Sheets tenant manapun).
 */
function migrateAllTenantsFullData_() {
  const masterSheet = ensureDataSheet_();
  const accountRows = readKeysByPrefix_(masterSheet, "authUser_");

  const hasil = [];
  for (let i = 0; i < accountRows.length; i++) {
    let user;
    try { user = JSON.parse(accountRows[i].value); } catch (e) { continue; }
    if (!user || !user.tenantSpreadsheetId) {
      hasil.push({ email: user && user.email, ok: false, error: "Belum punya tenantSpreadsheetId (akun belum lengkap)" });
      continue;
    }

    try {
      const tenantSs = SpreadsheetApp.openById(user.tenantSpreadsheetId);
      setActiveDataSpreadsheet_(tenantSs);
      try {
        const r = migrateAllCabangFullConfig_();
        hasil.push({ email: user.email, tenantId: user.tenantSpreadsheetId, ok: !!(r && r.ok), totalCabang: r && r.total, detail: r && r.hasil, error: r && r.error });
      } finally {
        setActiveDataSpreadsheet_(null);
      }
    } catch (err) {
      setActiveDataSpreadsheet_(null);
      hasil.push({ email: user.email, tenantId: user.tenantSpreadsheetId, ok: false, error: err && err.message ? err.message : String(err) });
    }
  }

  return {
    ok: true,
    totalAkun: accountRows.length,
    totalTenantSukses: hasil.filter(function (h) { return h.ok; }).length,
    totalTenantGagal: hasil.filter(function (h) { return !h.ok; }).length,
    hasil: hasil,
  };
}

/**
 * Backfill: recompute SEMUA cabang milik tenant aktif. Dipakai sekali saat
 * migrasi awal (mengisi computed.hpp untuk semua cabang yang sudah ada),
 * atau dari endpoint diagnostik. Return ringkasan per cabang.
 */
function recomputeAllCabang_() {
  const listRes = listCabang_impl_();
  if (!listRes || !listRes.ok) {
    return { ok: false, error: (listRes && listRes.error) || "listCabang gagal" };
  }
  const hasil = [];
  for (let i = 0; i < listRes.data.length; i++) {
    const c = listRes.data[i];
    const r = recomputeCabangSummary_(c.id);
    hasil.push({ id: c.id, nama: c.namaLaundry, ok: r.ok, error: r.error || null });
  }
  return { ok: true, tenantId: activeDataSpreadsheetId_(), total: hasil.length, hasil: hasil };
}
