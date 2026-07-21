/**
 * ============================================================================
 * MODUL: MASTER BIAYA — AIR
 * ============================================================================
 * Fitur ini mengelola biaya air per cabang. Mirip dengan Modul_BiayaListrik
 * (1 konfigurasi per cabang), Air adalah SATU konfigurasi per cabang:
 * sumber air (PDAM/Tangki/Sumur Bor) + input harga/kapasitas terkait.
 * Disimpan di key "biayaAir_<cabangId>" — cabangId LANGSUNG dipakai
 * sebagai bagian key, karena relasinya 1:1 dengan cabang.
 *
 * DASAR RUMUS (baca sebelum mengubah computeBiayaAirSummary_):
 *   1. PDAM / Meteran:
 *      - Input: hargaPerM3 (Rp), kebutuhanAirPerLoad (liter)
 *      - Rumus: m3PerLoad = kebutuhanAirPerLoad / 1000
 *      - biayaPerLoad = hargaPerM3 × m3PerLoad
 *   2. Tangki / Toren:
 *      - Input: hargaPerTangki (Rp), kapasitasTangkiLiter (liter), kebutuhanAirPerLoad (liter)
 *      - Rumus: biayaPerLiter = hargaPerTangki / kapasitasTangkiLiter
 *      - biayaPerLoad = biayaPerLiter × kebutuhanAirPerLoad
 *   3. Sumur Bor:
 *      - Biaya air ditetapkan Rp0 (beban operasional termasuk di listrik pompa)
 *      - Tampilkan info penjelasan ke user
 *
 * DEPENDENSI FILE INI:
 *   - Util_Umum.gs         : toSafeString_, toNumber_, clamp_, round2_, errorResponse_
 *   - Util_Penyimpanan.gs  : ensureDataSheet_, readKey_, writeKey_, deleteKeyRow_
 *   - Migrasi_Skema.gs     : ensureMigrated_
 *   - Modul_Cabang.gs      : sanitizeCabang_ (membaca profil cabang pemilik)
 *
 * DIPANGGIL OLEH FILE LAIN:
 *   - deleteBiayaAirByCabang_ dipanggil dari Modul_Cabang.gs (deleteCabang),
 *     supaya tidak ada konfigurasi air "hantu" saat cabang induk dihapus.
 *
 * CATATAN PENTING UNTUK KATEGORI BIAYA BARU yang sifatnya 1:1 per cabang
 * (bukan multi-record seperti Gas): salin pola file ini (key "biayaXxx_<cabangId>",
 * fungsi getBiayaXxx + saveBiayaXxx upsert, TANPA daftar order karena tidak
 * perlu) ke file baru, jangan tambah field ke objek biayaAir di sini.
 *
 * DAFTAR ISI (cari nama fungsi ini kalau butuh mengubah/memahami):
 *   SKEMA
 *     - defaultBiayaAir_          -> bentuk default 1 konfigurasi air
 *   FUNGSI PUBLIK (dipanggil dari Index.html lewat google.script.run)
 *     - getBiayaAir               -> konfigurasi + summary kalkulasi
 *     - saveBiayaAir              -> upsert konfigurasi (TIDAK ada create/update
 *                                    terpisah, karena relasinya 1:1 per cabang)
 *   FUNGSI INTERNAL (dipanggil modul lain, BUKAN dari frontend)
 *     - deleteBiayaAirByCabang_   -> cascade delete saat cabang dihapus
 *   VALIDASI / SANITASI
 *     - sanitizeBiayaAir_         -> bersihkan & lengkapi payload dari frontend
 *     - validateBiayaAir_         -> tolak jika melanggar aturan bisnis
 *   KALKULASI
 *     - computeBiayaAirSummary_   -> SUMBER KEBENARAN TUNGGAL kalkulasi biaya air
 * ============================================================================
 */

// ============================================================================
// SECTION: SKEMA / DEFAULT — MASTER BIAYA (AIR)
// ============================================================================

function defaultBiayaAir_() {
  return {
    cabangId: "",
    sumberAir: "pdam",  // "pdam" | "tangki" | "sumur"
    hargaPerM3: 0,       // untuk PDAM
    hargaPerTangki: 0,   // untuk Tangki
    kapasitasTangkiLiter: 0, // untuk Tangki
    kebutuhanAirPerLoad: 0,  // umum untuk PDAM & Tangki
    kebutuhanAirSetrikaUapPerJam: 0, // liter/jam, hanya relevan untuk PDAM + ada setrika uap
    createdAt: null,
    updatedAt: null,
  };
}

// ============================================================================
// SECTION: FUNGSI PUBLIK — BIAYA AIR (get + save, tanpa delete terpisah)
// ============================================================================
//
// Tidak ada createBiayaAir/updateBiayaAir terpisah seperti Gas, karena
// ini bukan daftar multi-record — cukup SATU fungsi "saveBiayaAir" yang
// menulis-atau-menimpa konfigurasi cabang itu (upsert).

/**
 * [2026-07-13] Dibungkus withTenant_ (Code.gs) - argumen pertama SELALU
 * sessionToken, badan logic asli dipindah ke nama "_impl_".
 */
function getBiayaAir(sessionToken, cabangId) {
  return withTenant_(sessionToken, function () { return getBiayaAir_impl_(cabangId); });
}

/**
 * Mengambil konfigurasi air satu cabang + summary kalkulasi.
 * Jika cabang belum pernah mengisi air, mengembalikan default (PDAM, semua 0)
 * — BUKAN error, supaya layar pertama kali dibuka tetap mulus.
 */
function getBiayaAir_impl_(cabangId) {
  try {
    if (!cabangId || typeof cabangId !== "string") {
      return { ok: false, error: "ID cabang tidak valid.", stage: "getBiayaAir:validate_cabang_id" };
    }
    ensureMigrated_();
    const sheet = ensureDataSheet_();

    const cabangRaw = readKey_(sheet, "cabang_" + cabangId);
    if (!cabangRaw) {
      return { ok: false, error: "Cabang tidak ditemukan. Mungkin sudah dihapus.", stage: "getBiayaAir:lookup_cabang" };
    }
    const cabang = sanitizeCabang_(JSON.parse(cabangRaw));

    const raw = readKey_(sheet, "biayaAir_" + cabangId);
    const record = raw
      ? sanitizeBiayaAir_(JSON.parse(raw))
      : Object.assign(defaultBiayaAir_(), { cabangId: cabangId });

    return {
      ok: true,
      data: {
        cabang: { id: cabang.id, namaLaundry: cabang.profil.namaLaundry, mesinSetrika: cabang.mesinSetrika, kategoriLayanan: cabang.kategoriLayanan },
        record: record,
        summary: computeBiayaAirSummary_(record, cabang),
      },
    };
  } catch (err) {
    return errorResponse_(err, "getBiayaAir");
  }
}

function saveBiayaAir(sessionToken, cabangId, payload) {
  return withTenant_(sessionToken, function () { return saveBiayaAir_impl_(cabangId, payload); });
}

/**
 * Upsert konfigurasi air satu cabang. Selalu menimpa record yang ada
 * (idempotent secara desain — tidak ada "create vs update" terpisah).
 */
function saveBiayaAir_impl_(cabangId, payload) {
  try {
    if (!cabangId || typeof cabangId !== "string") {
      return { ok: false, error: "ID cabang tidak valid.", stage: "saveBiayaAir:validate_cabang_id" };
    }
    if (!payload || typeof payload !== "object") {
      return { ok: false, error: "Data yang dikirim tidak valid.", stage: "saveBiayaAir:validate_payload" };
    }
    ensureMigrated_();
    const sheet = ensureDataSheet_();

    const cabangRaw = readKey_(sheet, "cabang_" + cabangId);
    if (!cabangRaw) {
      return { ok: false, error: "Cabang tidak ditemukan. Mungkin sudah dihapus.", stage: "saveBiayaAir:lookup_cabang" };
    }
    const cabang = sanitizeCabang_(JSON.parse(cabangRaw));

    const existingRaw = readKey_(sheet, "biayaAir_" + cabangId);
    const existing = existingRaw ? JSON.parse(existingRaw) : null;

    const clean = sanitizeBiayaAir_(payload);
    clean.cabangId = cabangId;
    const now = new Date().toISOString();
    clean.createdAt = (existing && existing.createdAt) || now;
    clean.updatedAt = now;

    const validation = validateBiayaAir_(clean, cabang);
    if (!validation.valid) {
      return { ok: false, error: validation.message, stage: "saveBiayaAir:validate_business_rules" };
    }

    writeKey_(sheet, "biayaAir_" + cabangId, JSON.stringify(clean));

    firestoreSyncConfigDocAndRecompute_(cabangId, "air", clean); // best-effort, 1 HTTP call (non-fatal)

    return { ok: true, data: { record: clean, summary: computeBiayaAirSummary_(clean, cabang) } };
  } catch (err) {
    return errorResponse_(err, "saveBiayaAir");
  }
}

/**
 * Dipanggil dari deleteCabang() (Modul_Cabang.gs) agar konfigurasi air
 * "hantu" milik cabang yang sudah dihapus tidak tertinggal di storage.
 */
// [2026-07-14 PERFORMA] Pakai _deleteKeyRowCore_ (TIDAK mengunci sendiri) -
// fungsi ini SELALU dipanggil dari dalam deleteCabang_impl_ (Modul_Cabang.gs)
// yang sudah memegang 1 kunci global utk seluruh cascade hapus cabang. JANGAN
// panggil fungsi ini standalone dari luar tanpa kunci aktif.
function deleteBiayaAirByCabang_(sheet, cabangId) {
  _deleteKeyRowCore_(sheet, "biayaAir_" + cabangId);
}

// ----------------------------------------------------------------------------
// VALIDASI / SANITASI — BIAYA AIR
// ----------------------------------------------------------------------------

function sanitizeBiayaAir_(input) {
  const base = defaultBiayaAir_();
  const out = defaultBiayaAir_();

  out.cabangId = toSafeString_(input && input.cabangId, "", 60);
  out.sumberAir = toSafeString_(input && input.sumberAir, base.sumberAir, 20);
  if (!["pdam", "tangki", "sumur"].includes(out.sumberAir)) {
    out.sumberAir = base.sumberAir;
  }

  out.hargaPerM3 = clamp_(toNumber_(input && input.hargaPerM3, 0), 0, 100000000);
  out.hargaPerTangki = clamp_(toNumber_(input && input.hargaPerTangki, 0), 0, 100000000);
  out.kapasitasTangkiLiter = clamp_(toNumber_(input && input.kapasitasTangkiLiter, 0), 0, 1000000);
  out.kebutuhanAirPerLoad = clamp_(toNumber_(input && input.kebutuhanAirPerLoad, 0), 0, 100000);
  out.kebutuhanAirSetrikaUapPerJam = clamp_(toNumber_(input && input.kebutuhanAirSetrikaUapPerJam, 0), 0, 100000);

  out.createdAt = (input && input.createdAt) || null;
  out.updatedAt = (input && input.updatedAt) || null;

  return out;
}

function validateBiayaAir_(data, cabang) {
  if (!data.cabangId) {
    return { valid: false, message: "Cabang belum ditentukan." };
  }
  if (!["pdam", "tangki", "sumur"].includes(data.sumberAir)) {
    return { valid: false, message: "Sumber air tidak valid." };
  }

  // [Jasa Setrika + Setrika Uap] "Kebutuhan air per load" sengaja
  // disembunyikan di form (Script_Fitur_BiayaAir.html) karena kategori ini
  // tidak punya mesin cuci - jangan wajibkan field yang memang tidak
  // ditampilkan ke user, supaya tidak gagal simpan "harus lebih dari 0"
  // untuk field yang tidak bisa mereka isi.
  const mesinSetrikaCabang_ = (cabang && cabang.mesinSetrika) || [];
  const adaSetrikaUapCabang_ = mesinSetrikaCabang_.some(function (m) { return m.jenis === "uap"; });
  const lewatiKebutuhanPerLoad_ = cabang && String(cabang.kategoriLayanan || "") === "jasa_setrika" && adaSetrikaUapCabang_;

  // Validasi per sumber air
  if (data.sumberAir === "pdam") {
    if (data.hargaPerM3 <= 0) {
      return { valid: false, message: "Harga per m³ PDAM harus lebih dari 0." };
    }
    if (!lewatiKebutuhanPerLoad_ && data.kebutuhanAirPerLoad <= 0) {
      return { valid: false, message: "Kebutuhan air per load harus lebih dari 0." };
    }
  } else if (data.sumberAir === "tangki") {
    if (data.hargaPerTangki <= 0) {
      return { valid: false, message: "Harga per tangki harus lebih dari 0." };
    }
    if (data.kapasitasTangkiLiter <= 0) {
      return { valid: false, message: "Kapasitas tangki harus lebih dari 0." };
    }
    if (data.kebutuhanAirPerLoad <= 0) {
      return { valid: false, message: "Kebutuhan air per load harus lebih dari 0." };
    }
  }
  // Sumur Bor tidak perlu validasi input (semua nilai boleh 0)

  return { valid: true, message: "" };
}

// ============================================================================
// SECTION: KALKULASI MASTER BIAYA AIR
// ============================================================================
//
// computeBiayaAirSummary_ adalah SUMBER KEBENARAN TUNGGAL untuk hitungan
// biaya air. Frontend punya salinan identik untuk pratinjau real-time
// (lihat Index.html), tapi modul lain WAJIB panggil ini, jangan duplikasi rumus.
//
function computeBiayaAirSummary_(record, cabang) {
  const sumberAir = toSafeString_(record.sumberAir, "pdam", 20);
  let biayaPerLoad = 0;
  let infoText = "";
  let konversiPerLiter = 0;
  let adaSetrikaUap = false;
  let biayaAirSetrikaUapPerJam = 0;

  if (sumberAir === "pdam") {
    // PDAM: hargaPerM3 × (kebutuhanAirPerLoad / 1000)
    const hargaPerM3 = toNumber_(record.hargaPerM3, 0);
    const kebutuhanLiter = toNumber_(record.kebutuhanAirPerLoad, 0);
    const m3PerLoad = kebutuhanLiter / 1000;
    biayaPerLoad = round2_(hargaPerM3 * m3PerLoad);
    konversiPerLiter = round2_(hargaPerM3 / 1000);

    const mesinSetrika = (cabang && cabang.mesinSetrika) || [];
    adaSetrikaUap = mesinSetrika.some(function (m) { return m.jenis === "uap"; });
    if (adaSetrikaUap) {
      const literPerJam = toNumber_(record.kebutuhanAirSetrikaUapPerJam, 0);
      biayaAirSetrikaUapPerJam = round2_(konversiPerLiter * literPerJam);
    }
  } else if (sumberAir === "tangki") {
    // Tangki: (hargaPerTangki / kapasitasLiter) × kebutuhanAirPerLoad
    const hargaPerTangki = toNumber_(record.hargaPerTangki, 0);
    const kapasitasLiter = toNumber_(record.kapasitasTangkiLiter, 0);
    const kebutuhanLiter = toNumber_(record.kebutuhanAirPerLoad, 0);
    const biayaPerLiter = (kapasitasLiter > 0) ? hargaPerTangki / kapasitasLiter : 0;
    biayaPerLoad = round2_(biayaPerLiter * kebutuhanLiter);
    konversiPerLiter = round2_(biayaPerLiter);
  } else if (sumberAir === "sumur") {
    // Sumur Bor: selalu Rp0
    biayaPerLoad = 0;
    infoText = "Biaya air ditetapkan Rp0. Beban operasional sumur sudah dihitung otomatis pada konsumsi listrik Pompa Air di Tab Listrik.";
  }

  return {
    sumberAir: sumberAir,
    biayaPerLoad: Math.max(0, biayaPerLoad), // jangan biarkan negative
    infoText: infoText,
    statusValid: biayaPerLoad >= 0,
    konversiPerLiter: konversiPerLiter,
    adaSetrikaUap: adaSetrikaUap,
    biayaAirSetrikaUapPerJam: biayaAirSetrikaUapPerJam,
  };
}
