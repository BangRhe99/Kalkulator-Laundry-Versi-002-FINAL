/**
 * ============================================================================
 * MODUL: MASTER BIAYA — LISTRIK
 * ============================================================================
 * Fitur ini mengelola biaya listrik per cabang. BERBEDA dari Modul_BiayaGas
 * (multi-record per cabang), Listrik adalah SATU konfigurasi per cabang:
 * tarif (TDL) + tiga angka watt global (mesin cuci, mesin pengering, pompa
 * air). Disimpan di key "biayaListrik_<cabangId>" — cabangId LANGSUNG dipakai
 * sebagai bagian key (bukan id baru), karena relasinya 1:1 dengan cabang.
 *
 * DASAR RUMUS (baca sebelum mengubah computeBiayaListrikSummary_ /
 * computeListrikBarisMesin_ — ini inti logika fitur ini):
 *   1. Rp/load listrik suatu baris mesin = (watt_kategori × durasiMenit_baris_itu)
 *      / 1000 / 60 (jadi kWh) × TDL per kWh.
 *      Watt-nya SATU angka global per kategori (cuci/pengering), tapi durasinya
 *      dibaca PER BARIS dari profil cabang — jadi hasilnya berbeda per baris
 *      mesin walau watt sama, karena durasi load tiap jenis mesin bisa beda.
 *   2. Pompa air HANYA dialokasikan ke mesin cuci (bukan pengering), karena air
 *      dipakai saat proses cuci, bukan saat pengeringan.
 *      - Watt pompa per mesin = wattTotalPompa / totalUnitMesinCuci di cabang itu.
 *      - Lalu dikonversi ke Rp PER BARIS mesin cuci juga (pakai durasi baris itu),
 *        sehingga setiap baris mesin cuci punya dua komponen biaya terpisah dan
 *        transparan: "Rp/load listrik mesin itu sendiri" + "Rp/load beban pompa
 *        air yang dialokasikan ke mesin itu" — ditampilkan terpisah, BUKAN
 *        digabung diam-diam, supaya pemilik bisa melihat asal tiap angka.
 *   3. Jika totalUnitMesinCuci di cabang = 0, beban pompa per mesin = 0 (bukan
 *      error) — wajar kalau belum ada mesin cuci yang didaftarkan.
 *
 * DEPENDENSI FILE INI:
 *   - Util_Umum.gs         : toSafeString_, toNumber_, toInt_, clamp_,
 *                            round2_, errorResponse_, sumUnit_
 *   - Util_Penyimpanan.gs  : ensureDataSheet_, readKey_, writeKey_, deleteKeyRow_
 *   - Migrasi_Skema.gs     : ensureMigrated_
 *   - Modul_Cabang.gs      : sanitizeCabang_ (membaca profil cabang pemilik)
 *
 * DIPANGGIL OLEH FILE LAIN:
 *   - deleteBiayaListrikByCabang_ dipanggil dari Modul_Cabang.gs (deleteCabang),
 *     supaya tidak ada konfigurasi listrik "hantu" saat cabang induk dihapus.
 *
 * CATATAN PENTING UNTUK KATEGORI BIAYA BARU yang sifatnya 1:1 per cabang
 * (bukan multi-record seperti Gas): salin pola file ini (key "biayaXxx_<cabangId>",
 * fungsi getBiayaXxx + saveBiayaXxx upsert, TANPA daftar order karena tidak
 * perlu) ke file baru, jangan tambah field ke objek biayaListrik di sini.
 *
 * DAFTAR ISI (cari nama fungsi ini kalau butuh mengubah/memahami):
 *   SKEMA
 *     - defaultBiayaListrik_      -> bentuk default 1 konfigurasi listrik
 *   FUNGSI PUBLIK (dipanggil dari Index.html lewat google.script.run)
 *     - getBiayaListrik            -> konfigurasi + summary kalkulasi penuh
 *     - saveBiayaListrik           -> upsert konfigurasi (TIDAK ada create/update
 *                                      terpisah, karena relasinya 1:1 per cabang)
 *   FUNGSI INTERNAL (dipanggil modul lain, BUKAN dari frontend)
 *     - deleteBiayaListrikByCabang_ -> cascade delete saat cabang dihapus
 *   VALIDASI / SANITASI
 *     - sanitizeBiayaListrik_      -> bersihkan & lengkapi payload dari frontend
 *     - validateBiayaListrik_      -> tolak jika melanggar aturan bisnis
 *   KALKULASI
 *     - computeBiayaListrikSummary_  -> SUMBER KEBENARAN TUNGGAL, hitung SEMUA
 *                                        baris mesin cuci & pengering + alokasi pompa
 *     - computeListrikBarisMesin_    -> hitung SATU baris mesin (dipakai berulang
 *                                        oleh computeBiayaListrikSummary_)
 * ============================================================================
 */

// ============================================================================
// SECTION: SKEMA / DEFAULT — MASTER BIAYA (LISTRIK)
// ============================================================================

function defaultBiayaListrik_() {
  return {
    cabangId: "",
    tdlPerKwh: 1700,
    wattMesinCuci: 0,
    wattMesinPengering: 0,
    wattPompaAir: 0,
    wattSetrikaListrik: 0,
    createdAt: null,
    updatedAt: null,
  };
}

// ============================================================================
// SECTION: FUNGSI PUBLIK — BIAYA LISTRIK (get + save, tanpa delete terpisah)
// ============================================================================
//
// Tidak ada createBiayaListrik/updateBiayaListrik terpisah seperti Gas, karena
// ini bukan daftar multi-record — cukup SATU fungsi "saveBiayaListrik" yang
// menulis-atau-menimpa konfigurasi cabang itu (upsert). Ini sengaja dibuat
// sederhana, karena tidak ada konsep "baris ke-2 konfigurasi listrik".

/**
 * [2026-07-13] Dibungkus withTenant_ (Code.gs) - argumen pertama SELALU
 * sessionToken, badan logic asli dipindah ke nama "_impl_".
 */
function getBiayaListrik(sessionToken, cabangId) {
  return withTenant_(sessionToken, function () { return getBiayaListrik_impl_(cabangId); });
}

/**
 * Mengambil konfigurasi listrik satu cabang + summary kalkulasi penuh
 * (per baris mesin cuci & pengering, plus alokasi pompa air).
 * Jika cabang belum pernah mengisi listrik, mengembalikan default (TDL 1700,
 * watt semua 0) — BUKAN error, supaya layar pertama kali dibuka tetap mulus.
 */
function getBiayaListrik_impl_(cabangId) {
  try {
    if (!cabangId || typeof cabangId !== "string") {
      return { ok: false, error: "ID cabang tidak valid.", stage: "getBiayaListrik:validate_cabang_id" };
    }
    ensureMigrated_();
    const sheet = ensureDataSheet_();

    const cabangRaw = readKey_(sheet, "cabang_" + cabangId);
    if (!cabangRaw) {
      return { ok: false, error: "Cabang tidak ditemukan. Mungkin sudah dihapus.", stage: "getBiayaListrik:lookup_cabang" };
    }
    const cabang = sanitizeCabang_(JSON.parse(cabangRaw));

    const raw = readKey_(sheet, "biayaListrik_" + cabangId);
    const record = raw
      ? sanitizeBiayaListrik_(JSON.parse(raw))
      : Object.assign(defaultBiayaListrik_(), { cabangId: cabangId });

    return {
      ok: true,
      data: {
        cabang: { id: cabang.id, namaLaundry: cabang.profil.namaLaundry, mesinCuci: cabang.mesinCuci, mesinPengering: cabang.mesinPengering, mesinSetrika: cabang.mesinSetrika, kategoriLayanan: cabang.kategoriLayanan },
        record: record,
        summary: computeBiayaListrikSummary_(record, cabang),
      },
    };
  } catch (err) {
    return errorResponse_(err, "getBiayaListrik");
  }
}

function saveBiayaListrik(sessionToken, cabangId, payload) {
  return withTenant_(sessionToken, function () { return saveBiayaListrik_impl_(cabangId, payload); });
}

/**
 * Upsert konfigurasi listrik satu cabang. Selalu menimpa record yang ada
 * (idempotent secara desain — tidak ada "create vs update" terpisah).
 */
function saveBiayaListrik_impl_(cabangId, payload) {
  try {
    if (!cabangId || typeof cabangId !== "string") {
      return { ok: false, error: "ID cabang tidak valid.", stage: "saveBiayaListrik:validate_cabang_id" };
    }
    if (!payload || typeof payload !== "object") {
      return { ok: false, error: "Data yang dikirim tidak valid.", stage: "saveBiayaListrik:validate_payload" };
    }
    ensureMigrated_();
    const sheet = ensureDataSheet_();

    const cabangRaw = readKey_(sheet, "cabang_" + cabangId);
    if (!cabangRaw) {
      return { ok: false, error: "Cabang tidak ditemukan. Mungkin sudah dihapus.", stage: "saveBiayaListrik:lookup_cabang" };
    }
    const cabang = sanitizeCabang_(JSON.parse(cabangRaw));

    const existingRaw = readKey_(sheet, "biayaListrik_" + cabangId);
    const existing = existingRaw ? JSON.parse(existingRaw) : null;

    const clean = sanitizeBiayaListrik_(payload);
    clean.cabangId = cabangId;
    const now = new Date().toISOString();
    clean.createdAt = (existing && existing.createdAt) || now;
    clean.updatedAt = now;

    const validation = validateBiayaListrik_(clean);
    if (!validation.valid) {
      return { ok: false, error: validation.message, stage: "saveBiayaListrik:validate_business_rules" };
    }

    writeKey_(sheet, "biayaListrik_" + cabangId, JSON.stringify(clean));

    firestoreSyncConfigDocAndRecompute_(cabangId, "listrik", clean); // best-effort, 1 HTTP call (non-fatal)

    return { ok: true, data: { record: clean, summary: computeBiayaListrikSummary_(clean, cabang) } };
  } catch (err) {
    return errorResponse_(err, "saveBiayaListrik");
  }
}

/**
 * Dipanggil dari deleteCabang() (Modul_Cabang.gs) agar konfigurasi listrik
 * "hantu" milik cabang yang sudah dihapus tidak tertinggal di storage.
 */
// [2026-07-14 PERFORMA] Pakai _deleteKeyRowCore_ (TIDAK mengunci sendiri) -
// fungsi ini SELALU dipanggil dari dalam deleteCabang_impl_ (Modul_Cabang.gs)
// yang sudah memegang 1 kunci global utk seluruh cascade hapus cabang. JANGAN
// panggil fungsi ini standalone dari luar tanpa kunci aktif.
function deleteBiayaListrikByCabang_(sheet, cabangId) {
  _deleteKeyRowCore_(sheet, "biayaListrik_" + cabangId);
}

// ----------------------------------------------------------------------------
// VALIDASI / SANITASI — BIAYA LISTRIK
// ----------------------------------------------------------------------------

function sanitizeBiayaListrik_(input) {
  const base = defaultBiayaListrik_();
  const out = defaultBiayaListrik_();

  out.cabangId = toSafeString_(input && input.cabangId, "", 60);
  out.tdlPerKwh = clamp_(toNumber_(input && input.tdlPerKwh, base.tdlPerKwh), 0, 100000);
  out.wattMesinCuci = clamp_(toNumber_(input && input.wattMesinCuci, 0), 0, 100000);
  out.wattMesinPengering = clamp_(toNumber_(input && input.wattMesinPengering, 0), 0, 100000);
  out.wattPompaAir = clamp_(toNumber_(input && input.wattPompaAir, 0), 0, 100000);
  out.wattSetrikaListrik = clamp_(toNumber_(input && input.wattSetrikaListrik, 0), 0, 100000);

  out.createdAt = (input && input.createdAt) || null;
  out.updatedAt = (input && input.updatedAt) || null;

  return out;
}

function validateBiayaListrik_(data) {
  if (!data.cabangId) {
    return { valid: false, message: "Cabang belum ditentukan." };
  }
  if (data.tdlPerKwh <= 0) {
    return { valid: false, message: "Tarif Dasar Listrik (TDL) per kWh harus lebih dari 0." };
  }
  return { valid: true, message: "" };
}

// ============================================================================
// SECTION: KALKULASI MASTER BIAYA LISTRIK
// ============================================================================
//
// computeBiayaListrikSummary_ adalah SUMBER KEBENARAN TUNGGAL untuk hitungan
// biaya listrik. Frontend punya salinan identik untuk pratinjau real-time
// (lihat Index.html), tapi modul lain WAJIB panggil ini, jangan duplikasi rumus.
//
function computeBiayaListrikSummary_(record, cabang) {
  const tdl = toNumber_(record.tdlPerKwh, 0);
  const totalUnitCuci = sumUnit_(cabang.mesinCuci);

  const wattPompaPerMesinCuci = (totalUnitCuci > 0)
    ? round2_(record.wattPompaAir / totalUnitCuci)
    : 0;

  const cuciRincian = (cabang.mesinCuci || []).map(function (m) {
    return computeListrikBarisMesin_(m, record.wattMesinCuci, wattPompaPerMesinCuci, tdl);
  });

  const pengeringRincian = (cabang.mesinPengering || []).map(function (m) {
    return computeListrikBarisMesin_(m, record.wattMesinPengering, 0, tdl);
  });

  const setrikaRincian = (cabang.mesinSetrika || [])
    .filter(function (m) { return m.jenis === "listrik"; })
    .map(function (m) {
      return computeListrikSetrikaBaris_(m, record.wattSetrikaListrik, tdl);
    });

  return {
    totalUnitMesinCuci: totalUnitCuci,
    wattPompaPerMesinCuci: wattPompaPerMesinCuci,
    cuci: cuciRincian,
    pengering: pengeringRincian,
    setrika: setrikaRincian,
  };
}

/**
 * computeListrikSetrikaBaris_ menghitung biaya listrik SATU baris mesin setrika
 * listrik. BEDA dari cuci/pengering: basisnya PER JAM (bukan per load), karena
 * kapasitas setrika memang dicatat per jam (kapasitasKgPerJam), bukan per siklus.
 * Baris bertipe "uap" tidak dihitung sama sekali di sini (difilter di pemanggil),
 * karena setrika uap tidak punya komponen biaya listrik.
 */
function computeListrikSetrikaBaris_(m, wattSetrika, tdlPerKwh) {
  const watt = toNumber_(wattSetrika, 0);
  const kwhPerJam = watt > 0 ? watt / 1000 : 0;
  const rpListrikPerJam = round2_(kwhPerJam * tdlPerKwh);

  return {
    machineId: m.id,
    jenis: m.jenis,
    jumlahUnit: toInt_(m.jumlahUnit, 0),
    kapasitasKgPerJam: toNumber_(m.kapasitasKgPerJam, 0),
    rpListrikPerJam: rpListrikPerJam,
    statusValid: watt > 0,
  };
}

/**
 * computeListrikBarisMesin_ menghitung satu baris mesin (cuci ATAU pengering):
 *   - rpListrikPerLoad: biaya listrik murni mesin itu sendiri.
 *   - rpPompaPerLoad: biaya listrik akibat ALOKASI pompa air (0 untuk pengering,
 *     karena pompa air hanya dialokasikan ke mesin cuci — lihat dokumentasi di atas).
 *   - rpTotalPerLoad: jumlah keduanya, angka inilah yang dipakai untuk
 *     perbandingan/laporan biaya listrik total per load.
 * Kedua komponen TETAP dikembalikan terpisah (bukan hanya total), supaya
 * frontend bisa menampilkan rinciannya secara transparan.
 */
function computeListrikBarisMesin_(m, wattKategori, wattPompaPerMesin, tdlPerKwh) {
  const durasiMenit = toNumber_(m.durasiMenit, 0);

  const kwhListrik = (wattKategori > 0 && durasiMenit > 0) ? (wattKategori * durasiMenit) / 1000 / 60 : 0;
  const rpListrikPerLoad = round2_(kwhListrik * tdlPerKwh);

  const kwhPompa = (wattPompaPerMesin > 0 && durasiMenit > 0) ? (wattPompaPerMesin * durasiMenit) / 1000 / 60 : 0;
  const rpPompaPerLoad = round2_(kwhPompa * tdlPerKwh);

  return {
    machineId: m.id,
    jenis: m.jenis,
    durasiMenit: durasiMenit,
    jumlahUnit: toInt_(m.jumlahUnit, 0),
    rpListrikPerLoad: rpListrikPerLoad,
    rpPompaPerLoad: rpPompaPerLoad,
    rpTotalPerLoad: round2_(rpListrikPerLoad + rpPompaPerLoad),
    statusValid: durasiMenit > 0,
  };
}
