/**
 * ============================================================================
 * MODUL: CABANG & LOKASI
 * ============================================================================
 * Fitur ini mengelola profil operasional tiap outlet/cabang: nama, jam buka-
 * tutup, daftar mesin cuci & pengering, kategori layanan, dan okupansi.
 * Inilah data INDUK yang dipakai semua Modul_Biaya*.gs lain (Gas, Listrik,
 * dst) untuk membaca durasi mesin per baris saat menghitung biaya per load.
 *
 * DEPENDENSI FILE INI (harus sudah ada di project, urutan parse tidak masalah
 * karena Apps Script berbagi satu global scope — lihat catatan di Code.gs):
 *   - Code.gs              : KEY_CABANG_ORDER
 *   - Util_Umum.gs         : toSafeString_, toNumber_, toInt_, clamp_,
 *                            round2_, errorResponse_, newId_, sumUnit_
 *   - Util_Penyimpanan.gs  : ensureDataSheet_, readKey_, writeKey_,
 *                            deleteKeyRow_, readOrder_, appendToOrder_,
 *                            removeFromOrder_
 *   - Migrasi_Skema.gs     : ensureMigrated_
 *   - Modul_BiayaGas.gs        : deleteBiayaGasByCabang_ (dipanggil saat hapus cabang)
 *   - Modul_BiayaListrik.gs    : deleteBiayaListrikByCabang_ (dipanggil saat hapus cabang)
 *   - Modul_BiayaAir.gs        : deleteBiayaAirByCabang_ (dipanggil saat hapus cabang)
 *
 * DIPANGGIL OLEH FILE LAIN:
 *   - defaultCabang_, sanitizeCabang_, toMachineArray_, computeSummary_
 *     dipanggil dari Migrasi_Skema.gs (migrateV1ToV2_) dan dari
 *     Modul_BiayaGas.gs / Modul_BiayaListrik.gs (untuk membaca profil cabang).
 *
 * DAFTAR ISI (cari nama fungsi ini kalau butuh mengubah/memahami):
 *   SKEMA
 *     - defaultCabang_         -> bentuk default 1 objek cabang
 *     - defaultMachineRow_     -> bentuk default 1 baris mesin (cuci/pengering)
 *   FUNGSI PUBLIK (dipanggil dari Index.html lewat google.script.run)
 *     - listCabang             -> daftar ringkas semua cabang + summary
 *     - getCabang               -> satu cabang lengkap + summary
 *     - createCabang            -> buat cabang baru
 *     - updateCabang            -> ubah cabang yang sudah ada
 *     - deleteCabang            -> hapus cabang (+ cascade hapus data biaya terkait)
 *   VALIDASI / SANITASI
 *     - sanitizeCabang_         -> bersihkan & lengkapi payload dari frontend
 *     - toMachineArray_         -> sanitasi array baris mesin
 *     - validateCabang_         -> tolak jika melanggar aturan bisnis
 *   KALKULASI (satuan LOAD, bukan kg)
 *     - computeSummary_         -> SUMBER KEBENARAN TUNGGAL kalkulasi kapasitas
 *     - computeDurasiOperasional_ -> selisih jam tutup-buka dalam menit
 *     - computeGroupLoad_       -> kalkulasi load maksimal & load/hari per grup mesin
 * ============================================================================
 */

// ============================================================================
// SECTION: SKEMA / DEFAULT — CABANG
// ============================================================================

function defaultCabang_() {
  return {
    id: "",
    profil: {
      namaLaundry: "",
      jamBukaMenit: 8 * 60,
      jamTutupMenit: 21 * 60,
    },
    mesinCuci: [],
    mesinPengering: [],
    kategoriLayanan: "self_service",
    okupansi: {
      cuciPersen: 70,
      keringPersen: 70,
    },
    createdAt: null,
    updatedAt: null,
  };
}

function defaultMachineRow_() {
  return {
    id: "",
    jenis: "",
    kapasitasKg: 0,
    durasiMenit: 0,
    jumlahUnit: 1,
  };
}

// ============================================================================
// SECTION: FUNGSI PUBLIK — CRUD CABANG
// ============================================================================

/**
 * Daftar semua cabang dalam bentuk ringkas (untuk Layar List), sudah termasuk
 * summary kalkulasi supaya kartu list bisa langsung menampilkan angka kunci
 * tanpa frontend perlu hitung ulang atau panggil getCabang per kartu.
 */
function listCabang() {
  try {
    ensureMigrated_();
    const sheet = ensureDataSheet_();
    const order = readOrder_(sheet, KEY_CABANG_ORDER);
    const items = [];
    for (let i = 0; i < order.length; i++) {
      const raw = readKey_(sheet, "cabang_" + order[i]);
      if (!raw) continue;
      const cabang = sanitizeCabang_(JSON.parse(raw));
      items.push({
        id: cabang.id,
        namaLaundry: cabang.profil.namaLaundry,
        jamBukaMenit: cabang.profil.jamBukaMenit,
        jamTutupMenit: cabang.profil.jamTutupMenit,
        kategoriLayanan: cabang.kategoriLayanan,
        totalUnitCuci: sumUnit_(cabang.mesinCuci),
        totalUnitPengering: sumUnit_(cabang.mesinPengering),
        updatedAt: cabang.updatedAt,
        summary: computeSummary_(cabang),
      });
    }
    return { ok: true, data: items };
  } catch (err) {
    return errorResponse_(err, "listCabang");
  }
}

/**
 * Mengambil satu cabang lengkap + summary kalkulasi, untuk Layar Ringkasan/Edit.
 */
function getCabang(id) {
  try {
    if (!id || typeof id !== "string") {
      return { ok: false, error: "ID cabang tidak valid.", stage: "getCabang:validate_id" };
    }
    ensureMigrated_();
    const sheet = ensureDataSheet_();
    const raw = readKey_(sheet, "cabang_" + id);
    if (!raw) {
      return { ok: false, error: "Cabang tidak ditemukan. Mungkin sudah dihapus.", stage: "getCabang:lookup" };
    }
    const cabang = sanitizeCabang_(JSON.parse(raw));
    return { ok: true, data: { cabang: cabang, summary: computeSummary_(cabang) } };
  } catch (err) {
    return errorResponse_(err, "getCabang");
  }
}

/**
 * Membuat cabang baru. Mengembalikan record lengkap (dengan id final dari server).
 */
function createCabang(payload) {
  try {
    if (!payload || typeof payload !== "object") {
      return { ok: false, error: "Data yang dikirim tidak valid.", stage: "createCabang:validate_payload" };
    }
    ensureMigrated_();

    const clean = sanitizeCabang_(payload);
    clean.id = newId_("c");
    const now = new Date().toISOString();
    clean.createdAt = now;
    clean.updatedAt = now;

    const validation = validateCabang_(clean);
    if (!validation.valid) {
      return { ok: false, error: validation.message, stage: "createCabang:validate_business_rules" };
    }

    const sheet = ensureDataSheet_();
    writeKey_(sheet, "cabang_" + clean.id, JSON.stringify(clean));
    appendToOrder_(sheet, KEY_CABANG_ORDER, clean.id);

    return { ok: true, data: { cabang: clean, summary: computeSummary_(clean) } };
  } catch (err) {
    return errorResponse_(err, "createCabang");
  }
}

/**
 * Memperbarui cabang yang sudah ada. id WAJIB sudah ada di storage,
 * jika tidak ditemukan akan ditolak (bukan diam-diam membuat baru),
 * supaya tidak ada cabang "hantu" akibat id yang typo/hilang.
 */
function updateCabang(id, payload) {
  try {
    if (!id || typeof id !== "string") {
      return { ok: false, error: "ID cabang tidak valid.", stage: "updateCabang:validate_id" };
    }
    if (!payload || typeof payload !== "object") {
      return { ok: false, error: "Data yang dikirim tidak valid.", stage: "updateCabang:validate_payload" };
    }
    ensureMigrated_();
    const sheet = ensureDataSheet_();
    const existingRaw = readKey_(sheet, "cabang_" + id);
    if (!existingRaw) {
      return { ok: false, error: "Cabang tidak ditemukan, kemungkinan sudah dihapus di tab lain.", stage: "updateCabang:lookup" };
    }
    const existing = JSON.parse(existingRaw);

    const clean = sanitizeCabang_(payload);
    clean.id = id;
    clean.createdAt = existing.createdAt || new Date().toISOString();
    clean.updatedAt = new Date().toISOString();

    const validation = validateCabang_(clean);
    if (!validation.valid) {
      return { ok: false, error: validation.message, stage: "updateCabang:validate_business_rules" };
    }

    writeKey_(sheet, "cabang_" + id, JSON.stringify(clean));
    return { ok: true, data: { cabang: clean, summary: computeSummary_(clean) } };
  } catch (err) {
    return errorResponse_(err, "updateCabang");
  }
}

/**
 * Menghapus satu cabang. Idempotent: menghapus id yang sudah tidak ada
 * dianggap sukses (bukan error), karena hasil akhirnya sama: cabang itu tidak ada.
 *
 * Catatan: turut menghapus SEMUA record Master Biaya milik cabang ini
 * (saat ini: biaya gas, listrik, dan air), supaya tidak ada record
 * biaya "hantu" yang cabangId-nya sudah tidak ada.
 * Lihat deleteBiayaGasByCabang_ (Modul_BiayaGas.gs),
 * deleteBiayaListrikByCabang_ (Modul_BiayaListrik.gs), dan
 * deleteBiayaAirByCabang_ (Modul_BiayaAir.gs).
 *
 * PENTING kalau menambah kategori biaya baru (Deterjen, dst): tambahkan
 * juga pemanggilan deleteBiayaXxxByCabang_ di sini, atau data biaya kategori
 * itu akan "nyangkut" tanpa cabang pemilik saat cabang dihapus.
 */
function deleteCabang(id) {
  try {
    if (!id || typeof id !== "string") {
      return { ok: false, error: "ID cabang tidak valid.", stage: "deleteCabang:validate_id" };
    }
    ensureMigrated_();
    const sheet = ensureDataSheet_();
    deleteKeyRow_(sheet, "cabang_" + id);
    removeFromOrder_(sheet, KEY_CABANG_ORDER, id);
    deleteBiayaGasByCabang_(sheet, id);
    deleteBiayaListrikByCabang_(sheet, id);
    deleteBiayaAirByCabang_(sheet, id);
    return { ok: true, data: { id: id } };
  } catch (err) {
    return errorResponse_(err, "deleteCabang");
  }
}

// ----------------------------------------------------------------------------
// VALIDASI / SANITASI — CABANG
// ----------------------------------------------------------------------------

function sanitizeCabang_(input) {
  const base = defaultCabang_();
  const out = defaultCabang_();

  out.id = toSafeString_(input && input.id, "", 60);

  const p = (input && input.profil) || {};
  out.profil.namaLaundry = toSafeString_(p.namaLaundry, base.profil.namaLaundry, 100);
  out.profil.jamBukaMenit = clamp_(toInt_(p.jamBukaMenit, base.profil.jamBukaMenit), 0, 1439);
  out.profil.jamTutupMenit = clamp_(toInt_(p.jamTutupMenit, base.profil.jamTutupMenit), 0, 1439);

  out.mesinCuci = toMachineArray_(input && input.mesinCuci);
  out.mesinPengering = toMachineArray_(input && input.mesinPengering);

  const allowedKategori = ["self_service", "drop_off", "hybrid"];
  out.kategoriLayanan = allowedKategori.indexOf(input && input.kategoriLayanan) >= 0
    ? input.kategoriLayanan
    : base.kategoriLayanan;

  const ok = (input && input.okupansi) || {};
  out.okupansi.cuciPersen = clamp_(toNumber_(ok.cuciPersen, base.okupansi.cuciPersen), 0, 100);
  out.okupansi.keringPersen = clamp_(toNumber_(ok.keringPersen, base.okupansi.keringPersen), 0, 100);

  out.createdAt = (input && input.createdAt) || null;
  out.updatedAt = (input && input.updatedAt) || null;

  return out;
}

function toMachineArray_(arr) {
  if (!Array.isArray(arr)) return [];
  const cleaned = [];
  for (let i = 0; i < arr.length; i++) {
    const row = arr[i] || {};
    const safe = defaultMachineRow_();
    safe.id = toSafeString_(row.id, "m_" + i + "_" + Date.now().toString(36), 60) || ("m_" + i);
    safe.jenis = toSafeString_(row.jenis, "", 60);
    safe.kapasitasKg = clamp_(toNumber_(row.kapasitasKg, 0), 0, 1000);
    safe.durasiMenit = clamp_(toNumber_(row.durasiMenit, 0), 0, 1440);
    safe.jumlahUnit = clamp_(toInt_(row.jumlahUnit, 1), 0, 500);
    cleaned.push(safe);
  }
  return cleaned;
}

function validateCabang_(data) {
  if (data.profil.namaLaundry.length === 0) {
    return { valid: false, message: "Nama laundry belum diisi." };
  }
  if (data.profil.jamBukaMenit === data.profil.jamTutupMenit) {
    return { valid: false, message: "Jam buka dan jam tutup tidak boleh sama." };
  }
  for (let i = 0; i < data.mesinCuci.length; i++) {
    const m = data.mesinCuci[i];
    if (m.jumlahUnit > 0 && (m.kapasitasKg <= 0 || m.durasiMenit <= 0)) {
      return { valid: false, message: "Baris mesin cuci #" + (i + 1) + " perlu kapasitas dan durasi lebih dari 0." };
    }
  }
  for (let i = 0; i < data.mesinPengering.length; i++) {
    const m = data.mesinPengering[i];
    if (m.jumlahUnit > 0 && (m.kapasitasKg <= 0 || m.durasiMenit <= 0)) {
      return { valid: false, message: "Baris mesin pengering #" + (i + 1) + " perlu kapasitas dan durasi lebih dari 0." };
    }
  }
  return { valid: true, message: "" };
}

// ============================================================================
// SECTION: KALKULASI CABANG — satuan LOAD (bukan kg)
// ============================================================================

/**
 * computeSummary_ adalah SUMBER KEBENARAN TUNGGAL untuk hitungan kapasitas cabang.
 * Frontend punya salinan logika identik untuk respons instan (lihat Index.html),
 * tapi modul backend lain WAJIB panggil ini, jangan menduplikasi rumus.
 *
 * Basis hitungan: LOAD = satu siklus cuci/kering penuh, terlepas dari kg.
 * Asumsi: 1 unit mesin hanya bisa menjalankan 1 load pada satu waktu (tidak paralel).
 */
function computeSummary_(cabang) {
  const totalMenit = computeDurasiOperasional_(cabang.profil.jamBukaMenit, cabang.profil.jamTutupMenit);

  return {
    totalMenitPerHari: totalMenit,
    totalJamPerHari: round2_(totalMenit / 60),
    cuci: computeGroupLoad_(cabang.mesinCuci, totalMenit, cabang.okupansi.cuciPersen),
    kering: computeGroupLoad_(cabang.mesinPengering, totalMenit, cabang.okupansi.keringPersen),
  };
}

function computeDurasiOperasional_(bukaMenit, tutupMenit) {
  let total = toInt_(tutupMenit, 0) - toInt_(bukaMenit, 0);
  if (total < 0) total += 24 * 60;
  return total;
}

function computeGroupLoad_(rows, totalMenitPerHari, okupansiPersen) {
  let totalUnit = 0;
  let maksimalLoadPerHari = 0;

  for (let i = 0; i < rows.length; i++) {
    const m = rows[i];
    const unit = toInt_(m.jumlahUnit, 0);
    totalUnit += unit;
    if (m.durasiMenit > 0 && unit > 0 && totalMenitPerHari > 0) {
      const loadPerUnitPerHari = totalMenitPerHari / m.durasiMenit;
      maksimalLoadPerHari += loadPerUnitPerHari * unit;
    }
  }

  const okupansiFraksi = clamp_(okupansiPersen, 0, 100) / 100;
  const loadPerHari = maksimalLoadPerHari * okupansiFraksi;

  return {
    totalUnit: totalUnit,
    loadMaksimalPerHari: round2_(maksimalLoadPerHari),
    loadPerHari: round2_(loadPerHari),
    loadPerMinggu: round2_(loadPerHari * 7),
    loadPerBulan: round2_(loadPerHari * 30),
  };
}
