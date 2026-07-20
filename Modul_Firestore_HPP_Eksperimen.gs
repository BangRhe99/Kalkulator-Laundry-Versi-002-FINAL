/**
 * ============================================================================
 * MODUL: EKSPERIMEN MIGRASI HPP KE FIRESTORE (Fase 2-4, ruang lingkup: HPP saja)
 * ============================================================================
 * File ini SENGAJA terpisah dari alur produksi (Code.gs / withTenant_ / web
 * app). Semua fungsi di sini dijalankan MANUAL dari Apps Script editor oleh
 * pemilik project untuk membuktikan pipa migrasi bekerja -- BUKAN dipanggil
 * dari frontend/google.script.run. Tidak ada satupun user asli yang
 * terdampak selama file ini belum di-wire ke fungsi publik manapun.
 *
 * ALUR (jalankan berurutan lewat testFirestoreHPPRoundtrip_):
 *   1. firestoreMigrateCabangConfig_(cabangId)
 *      -> salin data mentah 1 cabang (dari Sheets, sumber yang MASIH aktif
 *         sekarang) ke struktur Firestore: dokumen Cabang + config 1:1
 *         (air, listrik, notaKasir) + subkoleksi multi-record (gas,
 *         chemical, packing). Lihat §4-6 di dokumen arsitektur.
 *   2. firestoreSnapshotHPP_(cabangId)
 *      -> panggil getStrukturBiayaHPP_impl_ YANG SUDAH ADA (sumber
 *         kebenaran kalkulasi HPP asli, TIDAK diduplikasi di sini) lalu
 *         simpan hasilnya ke field `computed.hpp` pada dokumen Cabang di
 *         Firestore. Ini pola inti Fase 4: hitung saat SIMPAN, bukan saat
 *         BACA.
 *   3. firestoreReadCabangWithHPP_(cabangId)
 *      -> baca balik dari Firestore (1 GET, bukan 7 pemanggilan fungsi) --
 *         inilah bentuk baca yang akan dipakai StrukturHPP/Dashboard
 *         SETELAH Fase 4 selesai untuk semua modul, menggantikan fan-out
 *         getStrukturHPPSourceData_ yang sekarang.
 * ============================================================================
 */

/**
 * ID tenant sementara untuk eksperimen manual. SETELAH Fase 1 (migrasi
 * akun/auth) berjalan, ini diganti tenantId asli (UUID) dari dokumen
 * accounts/{email} -- lihat §3 dokumen arsitektur. Untuk sekarang, semua
 * eksperimen HPP disimpan di bawah satu tenant palsu supaya tidak
 * bentrok/tercampur dengan struktur produksi apapun.
 */
function firestoreTenantIdForTest_() {
  return "test-tenant";
}

function firestoreCabangPath_(cabangId) {
  return "tenants/" + firestoreTenantIdForTest_() + "/cabang/" + cabangId;
}

/**
 * Migrasi 1 cabang (dibaca dari spreadsheet Sheets yang sedang aktif/bound
 * di eksekusi ini -- sama seperti yang dipakai fungsi produksi sekarang)
 * ke struktur Firestore baru.
 */
function firestoreMigrateCabangConfig_(cabangId) {
  var cabangRes = getCabang_impl_(cabangId);
  if (!cabangRes.ok) throw new Error("getCabang gagal: " + cabangRes.error);
  var cabang = cabangRes.data.cabang;

  var path = firestoreCabangPath_(cabangId);
  firestoreSet_(path, {
    profil: cabang.profil,
    mesinCuci: cabang.mesinCuci,
    mesinPengering: cabang.mesinPengering,
    mesinSetrika: cabang.mesinSetrika,
    kategoriLayanan: cabang.kategoriLayanan,
    okupansi: cabang.okupansi,
    createdAt: cabang.createdAt,
    updatedAt: cabang.updatedAt,
  });

  var airRes = getBiayaAir_impl_(cabangId);
  if (airRes.ok) firestoreSet_(path + "/config/air", airRes.data.record);

  var listrikRes = getBiayaListrik_impl_(cabangId);
  if (listrikRes.ok) firestoreSet_(path + "/config/listrik", listrikRes.data.record);

  var notaRes = getBiayaNotaKasir_impl_(cabangId);
  if (notaRes.ok) firestoreSet_(path + "/config/notaKasir", notaRes.data.record);

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

  Logger.log("Migrasi cabang %s ke Firestore selesai: %s", cabangId, path);
  return { ok: true, path: path };
}

/**
 * Hitung HPP lewat jalur Sheets yang SUDAH ADA dan SUDAH TERBUKTI BENAR
 * (getStrukturBiayaHPP_impl_ -- tidak diduplikasi/ditulis ulang di sini),
 * lalu simpan hasilnya ke field `computed.hpp` pada dokumen Cabang di
 * Firestore. updateMaskFields=["computed"] supaya field lain (profil,
 * mesinCuci, dst hasil langkah migrasi sebelumnya) TIDAK ikut tertimpa.
 */
function firestoreSnapshotHPP_(cabangId) {
  var hppRes = getStrukturBiayaHPP_impl_(cabangId);
  if (!hppRes.ok) throw new Error("getStrukturBiayaHPP gagal: " + hppRes.error);

  var path = firestoreCabangPath_(cabangId);
  firestoreSet_(path, {
    computed: {
      hpp: hppRes.data,
      computedAt: new Date(),
    },
  }, ["computed"]);

  Logger.log("Snapshot HPP tersimpan di Firestore: %s (field computed)", path);
  return hppRes.data;
}

/**
 * Baca balik SELURUH dokumen cabang dari Firestore (1 GET) -- termasuk
 * computed.hpp yang barusan disimpan. Ini bentuk baca yang akan dipakai
 * StrukturHPP/Dashboard setelah Fase 4 (bandingkan dengan getStrukturBiayaHPP_impl_
 * yang sekarang melakukan 7 pemanggilan fungsi terpisah).
 */
function firestoreReadCabangWithHPP_(cabangId) {
  var path = firestoreCabangPath_(cabangId);
  return firestoreGet_(path);
}

/**
 * JALANKAN INI dari Apps Script editor untuk tes end-to-end. Ganti nilai
 * cabangId di bawah dengan id cabang ASLI milikmu -- jalankan
 * listCabangIdsForTest_() dulu kalau belum tahu id-nya (lihat Logger,
 * View > Logs / Executions setelah run).
 */
function testFirestoreHPPRoundtrip_() {
  var cabangId = "GANTI_DENGAN_CABANG_ID_ASLI";

  Logger.log("1. Migrasi konfigurasi cabang ke Firestore...");
  firestoreMigrateCabangConfig_(cabangId);

  Logger.log("2. Hitung HPP (jalur Sheets asli) & simpan snapshot ke Firestore...");
  var hppAsli = firestoreSnapshotHPP_(cabangId);

  Logger.log("3. Baca balik dari Firestore (1 GET saja)...");
  var dariFirestore = firestoreReadCabangWithHPP_(cabangId);

  Logger.log("=== HPP dari Sheets (sumber asli) ===");
  Logger.log(JSON.stringify(hppAsli));
  Logger.log("=== Hasil baca balik dari Firestore ===");
  Logger.log(JSON.stringify(dariFirestore.computed.hpp));
  Logger.log("Kalau kedua blok di atas sama persis, pipa migrasi HPP sudah benar.");
}

/** Helper: lihat semua cabangId yang kamu punya, supaya gampang isi testFirestoreHPPRoundtrip_. */
function listCabangIdsForTest_() {
  var res = listCabang_impl_();
  if (!res.ok) throw new Error(res.error);
  var ringkas = res.data.map(function (c) { return { id: c.id, nama: c.namaLaundry }; });
  Logger.log(JSON.stringify(ringkas, null, 2));
  return ringkas;
}
