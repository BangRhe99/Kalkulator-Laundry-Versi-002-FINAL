/**
 * ============================================================================
 * MODUL: MASTER BIAYA — GAS LPG
 * ============================================================================
 * Fitur ini mengelola biaya gas LPG per cabang. BERBEDA dari Modul_BiayaListrik
 * (1 konfigurasi per cabang), Gas adalah MULTI-RECORD: satu cabang bisa punya
 * banyak "kartu" gas (misal beda ukuran tabung 3kg/12kg/50kg sekaligus, atau
 * beberapa harga supplier berbeda).
 *
 * Setiap record gas merujuk (dryerRefId) ke SATU baris mesinPengering milik
 * cabang yang sama, untuk menentukan durasi 1 load yang dipakai saat
 * mengonversi "estimasi pemakaian gas (jam)" menjadi "estimasi load".
 *
 * DEPENDENSI FILE INI:
 *   - Code.gs              : KEY_BIAYA_GAS_ORDER
 *   - Util_Umum.gs         : toSafeString_, toNumber_, clamp_, round2_,
 *                            errorResponse_, newId_
 *   - Util_Penyimpanan.gs  : ensureDataSheet_, readKey_, writeKey_,
 *                            deleteKeyRow_, readOrder_, writeOrder_,
 *                            appendToOrder_, removeFromOrder_
 *   - Migrasi_Skema.gs     : ensureMigrated_
 *   - Modul_Cabang.gs      : sanitizeCabang_ (membaca profil cabang pemilik)
 *
 * DIPANGGIL OLEH FILE LAIN:
 *   - deleteBiayaGasByCabang_ dipanggil dari Modul_Cabang.gs (deleteCabang),
 *     supaya tidak ada record gas "hantu" saat cabang induknya dihapus.
 *
 * CATATAN PENTING UNTUK KATEGORI BIAYA BARU (Air, Deterjen, dst):
 *   JANGAN tambahkan field baru ke objek biayaGas di file ini. Buat MODUL
 *   BARU yang sejajar — salin pola file ini (skema + CRUD + validasi +
 *   kalkulasi + deleteBiayaXxxByCabang_) ke file baru misal Modul_BiayaAir.gs.
 *   Ini supaya skema gas yang sudah berjalan tidak pernah perlu migrasi
 *   gara-gara kategori biaya lain berubah bentuk.
 *
 * DAFTAR ISI (cari nama fungsi ini kalau butuh mengubah/memahami):
 *   SKEMA
 *     - BIAYA_GAS_PRESET       -> preset kapasitas tabung (saran awal, bisa ditimpa)
 *     - defaultBiayaGas_       -> bentuk default 1 record biaya gas
 *     - listBiayaGasPreset     -> kirim preset ke frontend (dibungkus error handling)
 *   FUNGSI PUBLIK (dipanggil dari Index.html lewat google.script.run)
 *     - listBiayaGas            -> semua record gas milik 1 cabang + summary
 *     - getBiayaGas             -> satu record lengkap + summary
 *     - createBiayaGas          -> buat record baru
 *     - updateBiayaGas          -> ubah record yang sudah ada
 *     - deleteBiayaGas          -> hapus 1 record
 *   FUNGSI INTERNAL (dipanggil modul lain, BUKAN dari frontend)
 *     - deleteBiayaGasByCabang_ -> cascade delete saat cabang dihapus
 *   VALIDASI / SANITASI
 *     - sanitizeBiayaGas_       -> bersihkan & lengkapi payload dari frontend
 *     - validateBiayaGas_       -> tolak jika melanggar aturan bisnis
 *   KALKULASI
 *     - computeBiayaGasSummary_ -> SUMBER KEBENARAN TUNGGAL kalkulasi biaya gas
 *     - findMachineById_        -> cari 1 baris mesin dari array berdasar id
 *     - machineDisplayName_     -> label tampilan mesin (jenis + durasi)
 *                                  CATATAN: kalau modul biaya lain (mis. Listrik)
 *                                  butuh helper sejenis, JANGAN duplikasi —
 *                                  pindahkan machineDisplayName_ +
 *                                  JENIS_MESIN_LABEL_ ke Util_Umum.gs supaya
 *                                  dipakai bersama, baru hapus dari sini.
 * ============================================================================
 */

// ============================================================================
// SECTION: SKEMA / DEFAULT — MASTER BIAYA (GAS LPG)
// ============================================================================
//
// PRESET KAPASITAS TABUNG (ditampilkan sebagai saran cepat di frontend, TIDAK
// mengikat — kapasitasKg & estimasiPemakaianJam tetap bebas diubah user,
// termasuk untuk ukuran tabung yang tidak ada di preset ini):
//   3 Kg    -> estimasi 8 jam
//   5.5 Kg  -> estimasi 14.4 jam
//   12 Kg   -> estimasi 32 jam
//   50 Kg   -> estimasi 132 jam

const BIAYA_GAS_PRESET = [
  { kapasitasKg: 3, label: "3 Kg", estimasiJam: 8 },
  { kapasitasKg: 5.5, label: "5,5 Kg", estimasiJam: 14.4 },
  { kapasitasKg: 12, label: "12 Kg", estimasiJam: 32 },
  { kapasitasKg: 50, label: "50 Kg", estimasiJam: 132 },
];

function defaultBiayaGas_() {
  return {
    id: "",
    cabangId: "",
    dryerRefId: "",
    setrikaRefId: "",
    kapasitasLabel: "",
    kapasitasKg: 0,
    hargaPerTabung: 0,
    estimasiPemakaianJam: 0,
    createdAt: null,
    updatedAt: null,
  };
}

/**
 * Daftar preset kapasitas tabung, dipanggil frontend untuk mengisi pilihan
 * cepat. Dikembalikan lewat fungsi (bukan dibaca langsung sebagai konstanta)
 * supaya pola pemanggilan dari frontend tetap konsisten lewat google.script.run
 * dan tetap dibungkus error handling yang sama.
 */
function listBiayaGasPreset() {
  try {
    return { ok: true, data: BIAYA_GAS_PRESET };
  } catch (err) {
    return errorResponse_(err, "listBiayaGasPreset");
  }
}

// ============================================================================
// SECTION: FUNGSI PUBLIK — CRUD MASTER BIAYA GAS
// ============================================================================

/**
 * Daftar semua record biaya gas milik SATU cabang, sudah termasuk summary
 * kalkulasi (konversi menit, estimasi load, biaya per jam/menit/load).
 */
function listBiayaGas(cabangId) {
  try {
    if (!cabangId || typeof cabangId !== "string") {
      return { ok: false, error: "ID cabang tidak valid.", stage: "listBiayaGas:validate_cabang_id" };
    }
    ensureMigrated_();
    const sheet = ensureDataSheet_();

    const cabangRaw = readKey_(sheet, "cabang_" + cabangId);
    if (!cabangRaw) {
      return { ok: false, error: "Cabang tidak ditemukan. Mungkin sudah dihapus.", stage: "listBiayaGas:lookup_cabang" };
    }
    const cabang = sanitizeCabang_(JSON.parse(cabangRaw));

    const order = readOrder_(sheet, KEY_BIAYA_GAS_ORDER);
    const items = [];
    for (let i = 0; i < order.length; i++) {
      const raw = readKey_(sheet, "biayaGas_" + order[i]);
      if (!raw) continue;
      const record = sanitizeBiayaGas_(JSON.parse(raw));
      if (record.cabangId !== cabangId) continue;
      items.push({
        record: record,
        summary: computeBiayaGasSummary_(record, cabang),
      });
    }
    return {
      ok: true,
      data: {
        cabang: {
          id: cabang.id,
          namaLaundry: cabang.profil.namaLaundry,
          mesinPengering: cabang.mesinPengering,
          mesinSetrika: cabang.mesinSetrika,
          kategoriLayanan: cabang.kategoriLayanan,
        },
        items: items,
      },
    };
  } catch (err) {
    return errorResponse_(err, "listBiayaGas");
  }
}

/**
 * Mengambil satu record biaya gas lengkap + summary, untuk layar edit.
 */
function getBiayaGas(id) {
  try {
    if (!id || typeof id !== "string") {
      return { ok: false, error: "ID record biaya gas tidak valid.", stage: "getBiayaGas:validate_id" };
    }
    ensureMigrated_();
    const sheet = ensureDataSheet_();
    const raw = readKey_(sheet, "biayaGas_" + id);
    if (!raw) {
      return { ok: false, error: "Data biaya gas tidak ditemukan. Mungkin sudah dihapus.", stage: "getBiayaGas:lookup" };
    }
    const record = sanitizeBiayaGas_(JSON.parse(raw));

    const cabangRaw = readKey_(sheet, "cabang_" + record.cabangId);
    if (!cabangRaw) {
      return { ok: false, error: "Cabang pemilik data ini sudah tidak ada.", stage: "getBiayaGas:lookup_cabang" };
    }
    const cabang = sanitizeCabang_(JSON.parse(cabangRaw));

    return { ok: true, data: { record: record, summary: computeBiayaGasSummary_(record, cabang) } };
  } catch (err) {
    return errorResponse_(err, "getBiayaGas");
  }
}

/**
 * Membuat record biaya gas baru untuk satu cabang.
 */
function createBiayaGas(payload) {
  try {
    if (!payload || typeof payload !== "object") {
      return { ok: false, error: "Data yang dikirim tidak valid.", stage: "createBiayaGas:validate_payload" };
    }
    ensureMigrated_();
    const sheet = ensureDataSheet_();

    const cabangId = toSafeString_(payload.cabangId, "", 60);
    const cabangRaw = cabangId ? readKey_(sheet, "cabang_" + cabangId) : null;
    if (!cabangRaw) {
      return { ok: false, error: "Cabang tujuan tidak ditemukan. Pilih cabang terlebih dahulu.", stage: "createBiayaGas:lookup_cabang" };
    }
    const cabang = sanitizeCabang_(JSON.parse(cabangRaw));

    const clean = sanitizeBiayaGas_(payload);
    clean.id = newId_("g");
    clean.cabangId = cabangId;
    const now = new Date().toISOString();
    clean.createdAt = now;
    clean.updatedAt = now;

    const validation = validateBiayaGas_(clean, cabang);
    if (!validation.valid) {
      return { ok: false, error: validation.message, stage: "createBiayaGas:validate_business_rules" };
    }

    writeKey_(sheet, "biayaGas_" + clean.id, JSON.stringify(clean));
    appendToOrder_(sheet, KEY_BIAYA_GAS_ORDER, clean.id);

    return { ok: true, data: { record: clean, summary: computeBiayaGasSummary_(clean, cabang) } };
  } catch (err) {
    return errorResponse_(err, "createBiayaGas");
  }
}

/**
 * Memperbarui record biaya gas yang sudah ada. id WAJIB sudah ada di storage.
 * cabangId TIDAK BISA dipindah lewat update (cabangId pada payload diabaikan);
 * kalau user perlu memindahkan record ke cabang lain, hapus & buat baru —
 * ini sengaja dibuat ketat supaya tidak ada record biaya "pindah outlet"
 * secara tidak sengaja akibat payload yang salah kirim.
 */
function updateBiayaGas(id, payload) {
  try {
    if (!id || typeof id !== "string") {
      return { ok: false, error: "ID record biaya gas tidak valid.", stage: "updateBiayaGas:validate_id" };
    }
    if (!payload || typeof payload !== "object") {
      return { ok: false, error: "Data yang dikirim tidak valid.", stage: "updateBiayaGas:validate_payload" };
    }
    ensureMigrated_();
    const sheet = ensureDataSheet_();

    const existingRaw = readKey_(sheet, "biayaGas_" + id);
    if (!existingRaw) {
      return { ok: false, error: "Data biaya gas tidak ditemukan, kemungkinan sudah dihapus di tab lain.", stage: "updateBiayaGas:lookup" };
    }
    const existing = JSON.parse(existingRaw);

    const cabangRaw = readKey_(sheet, "cabang_" + existing.cabangId);
    if (!cabangRaw) {
      return { ok: false, error: "Cabang pemilik data ini sudah tidak ada.", stage: "updateBiayaGas:lookup_cabang" };
    }
    const cabang = sanitizeCabang_(JSON.parse(cabangRaw));

    const clean = sanitizeBiayaGas_(payload);
    clean.id = id;
    clean.cabangId = existing.cabangId;
    clean.createdAt = existing.createdAt || new Date().toISOString();
    clean.updatedAt = new Date().toISOString();

    const validation = validateBiayaGas_(clean, cabang);
    if (!validation.valid) {
      return { ok: false, error: validation.message, stage: "updateBiayaGas:validate_business_rules" };
    }

    writeKey_(sheet, "biayaGas_" + id, JSON.stringify(clean));
    return { ok: true, data: { record: clean, summary: computeBiayaGasSummary_(clean, cabang) } };
  } catch (err) {
    return errorResponse_(err, "updateBiayaGas");
  }
}

/**
 * Menghapus satu record biaya gas. Idempotent seperti deleteCabang.
 */
function deleteBiayaGas(id) {
  try {
    if (!id || typeof id !== "string") {
      return { ok: false, error: "ID record biaya gas tidak valid.", stage: "deleteBiayaGas:validate_id" };
    }
    ensureMigrated_();
    const sheet = ensureDataSheet_();
    deleteKeyRow_(sheet, "biayaGas_" + id);
    removeFromOrder_(sheet, KEY_BIAYA_GAS_ORDER, id);
    return { ok: true, data: { id: id } };
  } catch (err) {
    return errorResponse_(err, "deleteBiayaGas");
  }
}

/**
 * Dipanggil dari deleteCabang() (Modul_Cabang.gs) agar tidak ada record biaya
 * gas "hantu" yang menunjuk ke cabangId yang sudah tidak ada.
 */
function deleteBiayaGasByCabang_(sheet, cabangId) {
  const order = readOrder_(sheet, KEY_BIAYA_GAS_ORDER);
  const remaining = [];
  for (let i = 0; i < order.length; i++) {
    const recId = order[i];
    const raw = readKey_(sheet, "biayaGas_" + recId);
    if (!raw) continue;
    let belongsToCabang = false;
    try {
      const rec = JSON.parse(raw);
      belongsToCabang = rec.cabangId === cabangId;
    } catch (e) {
      belongsToCabang = false;
    }
    if (belongsToCabang) {
      deleteKeyRow_(sheet, "biayaGas_" + recId);
    } else {
      remaining.push(recId);
    }
  }
  writeOrder_(sheet, KEY_BIAYA_GAS_ORDER, remaining);
}

// ----------------------------------------------------------------------------
// VALIDASI / SANITASI — MASTER BIAYA GAS
// ----------------------------------------------------------------------------

function sanitizeBiayaGas_(input) {
  const base = defaultBiayaGas_();
  const out = defaultBiayaGas_();

  out.id = toSafeString_(input && input.id, "", 60);
  out.cabangId = toSafeString_(input && input.cabangId, "", 60);
  out.dryerRefId = toSafeString_(input && input.dryerRefId, "", 60);
  out.setrikaRefId = toSafeString_(input && input.setrikaRefId, "", 60);
  out.kapasitasLabel = toSafeString_(input && input.kapasitasLabel, base.kapasitasLabel, 40);
  out.kapasitasKg = clamp_(toNumber_(input && input.kapasitasKg, 0), 0, 1000);
  out.hargaPerTabung = clamp_(toNumber_(input && input.hargaPerTabung, 0), 0, 100000000);
  out.estimasiPemakaianJam = clamp_(toNumber_(input && input.estimasiPemakaianJam, 0), 0, 2000);

  out.createdAt = (input && input.createdAt) || null;
  out.updatedAt = (input && input.updatedAt) || null;

  return out;
}

function validateBiayaGas_(data, cabang) {
  if (!data.cabangId) {
    return { valid: false, message: "Cabang belum ditentukan." };
  }
  if (data.kapasitasLabel.length === 0) {
    return { valid: false, message: "Kapasitas tabung gas belum diisi." };
  }
  if (data.kapasitasKg <= 0) {
    return { valid: false, message: "Kapasitas (Kg) harus lebih dari 0." };
  }
  if (data.hargaPerTabung <= 0) {
    return { valid: false, message: "Harga per tabung harus lebih dari 0." };
  }
  if (data.estimasiPemakaianJam <= 0) {
    return { valid: false, message: "Estimasi pemakaian (jam) harus lebih dari 0." };
  }

  // Satu tabung gas bisa dipakai bareng untuk Dryer DAN Setrika Uap sekaligus
  // (bukan pilihan eksklusif) - acuan mana yang WAJIB diisi mengikuti mesin
  // apa saja yang ada di Profil Outlet cabang ini.
  const hasDryer = (cabang.mesinPengering || []).length > 0;
  const setrikaUapList = (cabang.mesinSetrika || []).filter(function (m) { return m.jenis === "uap"; });
  const hasSetrikaUap = setrikaUapList.length > 0;

  if (hasDryer) {
    if (!data.dryerRefId) {
      return { valid: false, message: "Pilih mesin pengering acuan untuk konversi load." };
    }
    const dryerExists = (cabang.mesinPengering || []).some(function (m) { return m.id === data.dryerRefId; });
    if (!dryerExists) {
      return { valid: false, message: "Mesin pengering acuan tidak ditemukan di profil cabang ini. Mungkin baris mesin itu sudah dihapus — pilih ulang acuannya." };
    }
  }

  if (hasSetrikaUap) {
    if (!data.setrikaRefId) {
      return { valid: false, message: "Pilih mesin setrika (uap) acuan untuk hitungan per jam." };
    }
    const setrikaExists = setrikaUapList.some(function (m) { return m.id === data.setrikaRefId; });
    if (!setrikaExists) {
      return { valid: false, message: "Mesin setrika uap acuan tidak ditemukan di profil cabang ini. Mungkin baris mesin itu sudah dihapus atau bukan jenis uap — pilih ulang acuannya." };
    }
  }

  if (!hasDryer && !hasSetrikaUap) {
    return { valid: false, message: "Profil cabang belum punya mesin pengering maupun mesin setrika uap. Lengkapi Profil Outlet dulu sebelum menambah data gas." };
  }

  return { valid: true, message: "" };
}

// ============================================================================
// SECTION: KALKULASI MASTER BIAYA GAS
// ============================================================================
//
// computeBiayaGasSummary_ adalah SUMBER KEBENARAN TUNGGAL untuk hitungan biaya
// gas. Frontend punya salinan logika identik untuk pratinjau real-time
// (lihat Index.html), tapi modul lain WAJIB panggil ini, jangan duplikasi rumus.
//
// DASAR RUMUS "Estimasi Load Pemakaian" (penting — baca sebelum mengubah):
//   Load di sini menjawab "1 tabung gas cukup untuk berapa kali siklus
//   dryer acuan?". Ini murni rasio (total menit nyala gas) / (durasi 1 load
//   dryer acuan). TIDAK dibagi lagi dengan jumlah unit dryer di cabang,
//   karena gas dipakai oleh satu jalur pemanas yang menyala bergantian per
//   siklus, bukan dibagi rata ke seluruh unit fisik secara bersamaan.
//   Jumlah unit dryer baru relevan untuk arah hitungan SEBALIKNYA (mis.
//   "berapa tabung/hari dibutuhkan untuk menutup total kapasitas load semua
//   unit dryer") — itu di luar lingkup kartu ini, jadi belum dihitung di sini.
//
function computeBiayaGasSummary_(record, cabang) {
  const konversiMenit = round2_(record.estimasiPemakaianJam * 60);
  const biayaPerJam = (record.estimasiPemakaianJam > 0)
    ? round2_(record.hargaPerTabung / record.estimasiPemakaianJam)
    : 0;
  const biayaPerMenit = round2_(biayaPerJam / 60);

  // Satu tabung gas yang sama dipakai bareng untuk Dryer DAN Setrika Uap -
  // bukan pilihan eksklusif. Dryer dikonversi ke PER LOAD (pakai durasi 1
  // siklus dryer acuan), Setrika Uap basisnya murni PER JAM (sama seperti
  // listrik setrika di Modul_BiayaListrik.gs, tidak punya siklus/durasi load
  // seperti dryer) - nilainya sama dengan biayaPerJam di atas.
  const dryer = findMachineById_(cabang.mesinPengering, record.dryerRefId);
  const durasiLoadMenit = dryer ? toNumber_(dryer.durasiMenit, 0) : 0;

  const estimasiLoadPemakaian = (durasiLoadMenit > 0)
    ? round2_(konversiMenit / durasiLoadMenit)
    : 0;

  const biayaPerLoad = (estimasiLoadPemakaian > 0)
    ? round2_(record.hargaPerTabung / estimasiLoadPemakaian)
    : 0;

  const setrika = findMachineById_(cabang.mesinSetrika, record.setrikaRefId);
  const biayaGasSetrikaPerJam = setrika ? biayaPerJam : 0;

  return {
    dryerRefNama: dryer ? machineDisplayName_(dryer) : (record.dryerRefId ? "(mesin tidak ditemukan)" : ""),
    dryerRefDurasiMenit: durasiLoadMenit,
    setrikaRefNama: setrika ? setrikaDisplayName_(setrika) : (record.setrikaRefId ? "(mesin tidak ditemukan)" : ""),
    konversiMenit: konversiMenit,
    estimasiLoadPemakaian: estimasiLoadPemakaian,
    biayaPerJam: biayaPerJam,
    biayaPerMenit: biayaPerMenit,
    biayaPerLoad: biayaPerLoad,
    biayaGasSetrikaPerJam: biayaGasSetrikaPerJam,
    statusValidDryer: !!dryer && biayaPerLoad > 0,
    statusValidSetrika: !!setrika && biayaGasSetrikaPerJam > 0,
  };
}

function findMachineById_(rows, id) {
  if (!Array.isArray(rows) || !id) return null;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].id === id) return rows[i];
  }
  return null;
}

const JENIS_MESIN_LABEL_ = {
  rumah_tangga: "Rumah tangga",
  konversi: "Konversi",
  komersial: "Komersial",
};

function machineDisplayName_(m) {
  const jenis = JENIS_MESIN_LABEL_[m.jenis] || "Mesin";
  return jenis + " · " + (m.durasiMenit || 0) + " mnt";
}

const JENIS_SETRIKA_LABEL_ = {
  listrik: "Setrika Listrik",
  uap: "Setrika Uap",
};

function setrikaDisplayName_(m) {
  const jenis = JENIS_SETRIKA_LABEL_[m.jenis] || "Setrika";
  return jenis + " · " + (m.kapasitasKgPerJam || 0) + " kg/jam";
}
