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

/**
 * Hitung ulang HPP satu cabang (via jalur Sheets yang sudah ada & terbukti)
 * lalu simpan ke field `computed.hpp` dokumen Cabang di Firestore.
 * updateMask ["computed"] -> hanya field computed yang ditimpa, field lain
 * (profil/mesin dari fase migrasi lain) tidak tersentuh.
 * BEST-EFFORT: tidak pernah melempar; kembalikan {ok:false,...} kalau gagal.
 */
function recomputeCabangSummary_(cabangId) {
  try {
    if (!cabangId || typeof cabangId !== "string") {
      return { ok: false, error: "cabangId tidak valid" };
    }
    const tenantId = activeDataSpreadsheetId_();
    if (!tenantId) return { ok: false, error: "tenantId (spreadsheet aktif) tidak ditemukan" };

    // Buang cache HPP per-eksekusi supaya dihitung ULANG dari data terbaru
    // (penting kalau dipanggil tepat setelah save dalam eksekusi yang sama).
    if (typeof _strukturBiayaHPPCache_ !== "undefined" && _strukturBiayaHPPCache_ && _strukturBiayaHPPCache_[cabangId]) {
      delete _strukturBiayaHPPCache_[cabangId];
    }

    const hppRes = getStrukturBiayaHPP_impl_(cabangId);
    if (!hppRes || !hppRes.ok) {
      return { ok: false, error: (hppRes && hppRes.error) || "getStrukturBiayaHPP gagal" };
    }

    firestoreSet_(
      firestoreCabangDocPath_(tenantId, cabangId),
      { computed: { hpp: hppRes.data, computedAt: new Date() } },
      ["computed"]
    );
    return { ok: true, tenantId: tenantId, cabangId: cabangId };
  } catch (err) {
    console.warn("recomputeCabangSummary_ gagal (non-fatal) utk " + cabangId + ": " + err);
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * Baca HPP CEPAT: 1 GET dari Firestore (computed.hpp). Kalau belum ada
 * (cabang belum pernah di-recompute), fallback hitung dari Sheets SEKALIGUS
 * memicu recompute supaya baca berikutnya sudah cepat. `_source` menandai
 * dari mana hasilnya, berguna saat verifikasi.
 */
function getStrukturBiayaHPPFast_(cabangId) {
  try {
    const tenantId = activeDataSpreadsheetId_();
    if (tenantId) {
      const doc = firestoreGet_(firestoreCabangDocPath_(tenantId, cabangId));
      if (doc && doc.computed && doc.computed.hpp) {
        return { ok: true, data: doc.computed.hpp, _source: "firestore", _computedAt: doc.computed.computedAt || null };
      }
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
      layananAktif[key] = isHPPLayananAktif_(cabangId, key);
    });
    const bepMixRaw = readKey_(ensureDataSheet_(), "bepMix_" + cabangId);
    let bepMix = null;
    if (bepMixRaw) {
      try { bepMix = JSON.parse(bepMixRaw).mix || null; } catch (e) { bepMix = null; }
    }
    firestoreSet_(firestoreCabangDocPath_(tenantId, cabangId) + "/config/hppToggles", {
      bedCoverAktif: isBedCoverAktif_(cabangId),
      layananAktif: layananAktif,
      bepMix: bepMix || {},
    });
  } catch (err) {
    console.warn("firestoreSyncHppToggles_ gagal (non-fatal): " + err);
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
