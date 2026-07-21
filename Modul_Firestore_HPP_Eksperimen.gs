/**
 * ============================================================================
 * MODUL: MIGRASI DATA MENTAH KE FIRESTORE (Fase 2-3)
 * ============================================================================
 * File ini SENGAJA terpisah dari alur produksi (Code.gs / withTenant_ / web
 * app). Fungsi di sini dipanggil dari endpoint diagnostik (Code.gs) atau
 * manual dari editor -- BUKAN dari frontend/google.script.run. Tidak ada
 * satupun user asli yang terdampak (Sheets tetap sumber kebenaran; ini cuma
 * MENYALIN data mentah ke Firestore sebagai cermin/mirror).
 *
 * migrateCabangFullConfig_(cabangId): salin SEMUA data mentah 1 cabang dari
 * Sheets ke struktur Firestore §4-6 dokumen arsitektur:
 *   - dokumen Cabang (profil, mesin, kategori, okupansi)
 *   - config/air, config/listrik, config/notaKasir, config/tetapOutlet,
 *     config/hargaLayanan, config/hppToggles (gabungan bedCoverAktif + 6
 *     toggle layanan + bepMix -- dulu 8 baris terpisah, sekarang 1 dokumen)
 *   - subkoleksi gas/, chemical/, packing/
 *
 * tenantId = ID spreadsheet tenant AKTIF (activeDataSpreadsheetId_,
 * Util_Penyimpanan.gs) -- SAMA dengan yang dipakai Modul_Firestore_Computed.gs,
 * supaya dokumen Cabang yang sudah berisi field `computed.hpp` (dari fase
 * sebelumnya) ditambahi data mentah di path YANG SAMA, bukan path terpisah.
 * ============================================================================
 */

function migrateCabangFullConfig_(cabangId) {
  var tenantId = activeDataSpreadsheetId_();
  if (!tenantId) throw new Error("tenantId (spreadsheet aktif) tidak ditemukan.");
  var path = firestoreCabangDocPath_(tenantId, cabangId);

  var cabangRes = getCabang_impl_(cabangId);
  if (!cabangRes.ok) throw new Error("getCabang gagal: " + cabangRes.error);
  var cabang = cabangRes.data.cabang;

  // updateMask ["profil","mesinCuci",...] -- TIDAK menimpa field `computed`
  // yang mungkin sudah ada di dokumen ini dari fase recompute sebelumnya.
  firestoreSet_(path, {
    profil: cabang.profil,
    mesinCuci: cabang.mesinCuci,
    mesinPengering: cabang.mesinPengering,
    mesinSetrika: cabang.mesinSetrika,
    kategoriLayanan: cabang.kategoriLayanan,
    okupansi: cabang.okupansi,
    createdAt: cabang.createdAt,
    updatedAt: cabang.updatedAt,
  }, ["profil", "mesinCuci", "mesinPengering", "mesinSetrika", "kategoriLayanan", "okupansi", "createdAt", "updatedAt"]);

  var airRes = getBiayaAir_impl_(cabangId);
  if (airRes.ok) firestoreSet_(path + "/config/air", airRes.data.record);

  var listrikRes = getBiayaListrik_impl_(cabangId);
  if (listrikRes.ok) firestoreSet_(path + "/config/listrik", listrikRes.data.record);

  var notaRes = getBiayaNotaKasir_impl_(cabangId);
  if (notaRes.ok) firestoreSet_(path + "/config/notaKasir", notaRes.data.record);

  // BiayaTetapOutlet: 1:1 per cabang, TIDAK lewat Util_Penyimpanan.gs (sheet
  // dedicated) -- lihat catatan arsitektur §5. Tidak memengaruhi HPP per-load
  // (hanya fixed cost/BEP), tapi tetap perlu dicerminkan sebagai data mentah.
  if (typeof getBiayaTetapOutlet_impl_ === "function") {
    var tetapRes = getBiayaTetapOutlet_impl_(cabangId);
    if (tetapRes.ok) firestoreSet_(path + "/config/tetapOutlet", tetapRes.data.record);
  }

  // Ambil record MENTAH (hargaJual/minimumOrderKg saja), bukan hasil olahan
  // getHargaLayanan_impl_ (itu sudah gabung dengan HPP+status, bukan config murni).
  var hargaRecord = readHargaLayananRecord_(cabangId);
  firestoreSet_(path + "/config/hargaLayanan", hargaRecord);

  // Gabungan toggle (bedCoverAktif + 6x hppLayananAktif + bepMix) jadi 1
  // dokumen -- dulu 8 baris key-value terpisah di Sheets.
  var layananAktif = {};
  STRUKTUR_HPP_TOGGLABLE_KEYS_.forEach(function (key) {
    if (key === STRUKTUR_HPP_SERVICE_KEYS_.BED_COVER) return; // disimpan terpisah di bawah (bedCoverAktif)
    layananAktif[key] = isHPPLayananAktif_(cabangId, key);
  });
  var bepMixRaw = readKey_(ensureDataSheet_(), "bepMix_" + cabangId);
  var bepMix = null;
  if (bepMixRaw) {
    try { bepMix = JSON.parse(bepMixRaw).mix || null; } catch (e) { bepMix = null; }
  }
  firestoreSet_(path + "/config/hppToggles", {
    bedCoverAktif: isBedCoverAktif_(cabangId),
    layananAktif: layananAktif,
    bepMix: bepMix || {},
  });

  var gasRes = listBiayaGas_impl_(cabangId);
  if (gasRes.ok) {
    gasRes.data.items.forEach(function (item) {
      firestoreSet_(path + "/gas/" + item.record.id, item.record);
    });
  }

  var chemRes = listBiayaChemical_impl_(cabangId);
  if (chemRes.ok) {
    chemRes.data.items.forEach(function (item) {
      firestoreSet_(path + "/chemical/" + item.record.id, item.record);
    });
  }

  var packRes = listBiayaPacking_impl_(cabangId);
  if (packRes.ok) {
    packRes.data.items.forEach(function (item) {
      firestoreSet_(path + "/packing/" + item.record.id, item.record);
    });
  }

  return { ok: true, path: path };
}

/**
 * Backfill data mentah utk SEMUA cabang milik tenant aktif. Dipakai dari
 * migrateAllTenantsFullData_ (Modul_Firestore_Computed.gs).
 */
function migrateAllCabangFullConfig_() {
  var listRes = listCabang_impl_();
  if (!listRes || !listRes.ok) return { ok: false, error: (listRes && listRes.error) || "listCabang gagal" };

  var hasil = [];
  for (var i = 0; i < listRes.data.length; i++) {
    var c = listRes.data[i];
    try {
      migrateCabangFullConfig_(c.id);
      hasil.push({ id: c.id, nama: c.namaLaundry, ok: true });
    } catch (err) {
      hasil.push({ id: c.id, nama: c.namaLaundry, ok: false, error: err && err.message ? err.message : String(err) });
    }
  }
  return { ok: true, total: hasil.length, hasil: hasil };
}

/** Helper: lihat semua cabangId yang kamu punya di tenant AKTIF saat ini. */
function listCabangIdsForTest_() {
  var res = listCabang_impl_();
  if (!res.ok) throw new Error(res.error);
  var ringkas = res.data.map(function (c) { return { id: c.id, nama: c.namaLaundry }; });
  return ringkas;
}
