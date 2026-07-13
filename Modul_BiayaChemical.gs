/**
 * ============================================================================
 * MODUL: MASTER BIAYA — CHEMICAL (Deterjen, Softener, Parfum, Pelicin, dll)
 * ============================================================================
 * Fitur ini mengelola biaya bahan kimia cuci per cabang. Seperti Modul_BiayaGas,
 * ini MULTI-RECORD: satu cabang bisa punya banyak item chemical sekaligus
 * (Deterjen, Softener, Parfum, Pelicin, dst — item bebas ditambah/dihapus,
 * bukan daftar tetap, karena tiap laundry pakai kombinasi berbeda).
 *
 * DASAR RUMUS (baca sebelum mengubah computeBiayaChemicalSummary_):
 *   1. isiKemasan dikonversi ke satuan dasar lewat CHEMICAL_KONVERSI_DASAR_
 *      (Liter/ml -> ml, Kg/gram -> gram), supaya harga kemasan yang ditulis
 *      per Liter tetap bisa dibandingkan dengan takaran yang ditulis dalam ml.
 *   2. hargaPerUnit = hargaBeli / isiKemasanDasar (Rp per ml atau per gram)
 *   3. Record WAJIB merujuk (cuciRefId) ke SATU baris mesinCuci milik cabang
 *      yang sama, untuk tahu kapasitas maksimal (kg) satu kali load.
 *   4. biayaPerLoad = (takaranPerKg * kapasitasKg mesin acuan) * hargaPerUnit
 *   5. biayaPerKg   = biayaPerLoad / kapasitasKg mesin acuan
 *      (Catatan: biayaPerKg secara aljabar = takaranPerKg * hargaPerUnit,
 *      sama seperti rumus lama sebelum ada mesin acuan — tapi sekarang
 *      cuciRefId wajib diisi supaya angka "Biaya Chemical Per Load" bisa
 *      ditampilkan ke user.)
 *
 * DEPENDENSI FILE INI:
 *   - Code.gs              : KEY_BIAYA_CHEMICAL_ORDER
 *   - Util_Umum.gs         : toSafeString_, toNumber_, clamp_, round2_,
 *                            errorResponse_, newId_
 *   - Util_Penyimpanan.gs  : ensureDataSheet_, readKey_, writeKey_,
 *                            deleteKeyRow_, readOrder_, writeOrder_,
 *                            appendToOrder_, removeFromOrder_
 *   - Migrasi_Skema.gs     : ensureMigrated_
 *   - Modul_Cabang.gs      : sanitizeCabang_ (membaca profil cabang pemilik)
 *   - Modul_BiayaGas.gs    : findMachineById_, JENIS_MESIN_LABEL_ (dipakai
 *                            bersama utk cari & label baris mesinCuci acuan —
 *                            JANGAN duplikasi, file ini sengaja tidak
 *                            mendeklarasikan ulang keduanya)
 *
 * DIPANGGIL OLEH FILE LAIN:
 *   - deleteBiayaChemicalByCabang_ dipanggil dari Modul_Cabang.gs (deleteCabang),
 *     supaya tidak ada record chemical "hantu" saat cabang induk dihapus.
 *
 * DAFTAR ISI:
 *   SKEMA
 *     - defaultBiayaChemical_       -> bentuk default 1 record item chemical
 *   FUNGSI PUBLIK (dipanggil dari Index.html lewat google.script.run)
 *     - listBiayaChemical            -> semua item chemical milik 1 cabang + total
 *     - getBiayaChemical             -> satu item lengkap + summary
 *     - createBiayaChemical          -> buat item baru
 *     - updateBiayaChemical          -> ubah item yang sudah ada
 *     - deleteBiayaChemical          -> hapus 1 item
 *   FUNGSI INTERNAL (dipanggil modul lain, BUKAN dari frontend)
 *     - deleteBiayaChemicalByCabang_ -> cascade delete saat cabang dihapus
 *   VALIDASI / SANITASI
 *     - sanitizeBiayaChemical_       -> bersihkan & lengkapi payload dari frontend
 *     - validateBiayaChemical_       -> tolak jika melanggar aturan bisnis
 *   KALKULASI
 *     - computeBiayaChemicalSummary_ -> SUMBER KEBENARAN TUNGGAL kalkulasi biaya chemical
 * ============================================================================
 */

// ============================================================================
// SECTION: SKEMA / DEFAULT — MASTER BIAYA (CHEMICAL)
// ============================================================================

const CHEMICAL_KONVERSI_DASAR_ = { liter: 1000, kg: 1000, gram: 1, ml: 1 };
const CHEMICAL_SATUAN_DASAR_LABEL_ = { liter: "ml", ml: "ml", kg: "gram", gram: "gram" };

function defaultBiayaChemical_() {
  return {
    id: "",
    cabangId: "",
    nama: "",
    tipeDeterjen: "",
    hargaBeli: 0,
    isiKemasan: 0,
    satuanKemasan: "",
    takaranPerKg: 0,
    cuciRefId: "",
    createdAt: null,
    updatedAt: null,
  };
}

// ============================================================================
// SECTION: FUNGSI PUBLIK — CRUD MASTER BIAYA CHEMICAL
// ============================================================================

/**
 * [2026-07-13] Dibungkus withTenant_ (Code.gs) - argumen pertama SELALU
 * sessionToken, badan logic asli dipindah ke nama "_impl_".
 */
function listBiayaChemical(sessionToken, cabangId) {
  return withTenant_(sessionToken, function () { return listBiayaChemical_impl_(cabangId); });
}

/**
 * Daftar semua item chemical milik SATU cabang, sudah termasuk summary
 * kalkulasi per item DAN total biaya chemical per Kg (dijumlah semua item).
 */
function listBiayaChemical_impl_(cabangId) {
  try {
    if (!cabangId || typeof cabangId !== "string") {
      return { ok: false, error: "ID cabang tidak valid.", stage: "listBiayaChemical:validate_cabang_id" };
    }
    ensureMigrated_();
    const sheet = ensureDataSheet_();

    const cabangRaw = readKey_(sheet, "cabang_" + cabangId);
    if (!cabangRaw) {
      return { ok: false, error: "Cabang tidak ditemukan. Mungkin sudah dihapus.", stage: "listBiayaChemical:lookup_cabang" };
    }
    const cabang = sanitizeCabang_(JSON.parse(cabangRaw));

    const order = readOrder_(sheet, KEY_BIAYA_CHEMICAL_ORDER);
    const items = [];
    let totalBiayaPerKg = 0;
    for (let i = 0; i < order.length; i++) {
      const raw = readKey_(sheet, "biayaChemical_" + order[i]);
      if (!raw) continue;
      const record = sanitizeBiayaChemical_(JSON.parse(raw));
      if (record.cabangId !== cabangId) continue;
      const summary = computeBiayaChemicalSummary_(record, cabang);
      items.push({ record: record, summary: summary });
      totalBiayaPerKg += summary.biayaPerKg;
    }
    return {
      ok: true,
      data: {
        cabang: {
          id: cabang.id,
          namaLaundry: cabang.profil.namaLaundry,
          mesinCuci: cabang.mesinCuci,
        },
        items: items,
        totalBiayaPerKg: round2_(totalBiayaPerKg),
      },
    };
  } catch (err) {
    return errorResponse_(err, "listBiayaChemical");
  }
}

function getBiayaChemical(sessionToken, id) {
  return withTenant_(sessionToken, function () { return getBiayaChemical_impl_(id); });
}

/**
 * Mengambil satu item chemical lengkap + summary, untuk layar edit.
 */
function getBiayaChemical_impl_(id) {
  try {
    if (!id || typeof id !== "string") {
      return { ok: false, error: "ID item chemical tidak valid.", stage: "getBiayaChemical:validate_id" };
    }
    ensureMigrated_();
    const sheet = ensureDataSheet_();
    const raw = readKey_(sheet, "biayaChemical_" + id);
    if (!raw) {
      return { ok: false, error: "Data chemical tidak ditemukan. Mungkin sudah dihapus.", stage: "getBiayaChemical:lookup" };
    }
    const record = sanitizeBiayaChemical_(JSON.parse(raw));

    const cabangRaw = readKey_(sheet, "cabang_" + record.cabangId);
    if (!cabangRaw) {
      return { ok: false, error: "Cabang pemilik data ini sudah tidak ada.", stage: "getBiayaChemical:lookup_cabang" };
    }
    const cabang = sanitizeCabang_(JSON.parse(cabangRaw));

    return { ok: true, data: { record: record, summary: computeBiayaChemicalSummary_(record, cabang) } };
  } catch (err) {
    return errorResponse_(err, "getBiayaChemical");
  }
}

function createBiayaChemical(sessionToken, payload) {
  return withTenant_(sessionToken, function () { return createBiayaChemical_impl_(payload); });
}

/**
 * Membuat item chemical baru untuk satu cabang.
 */
function createBiayaChemical_impl_(payload) {
  try {
    if (!payload || typeof payload !== "object") {
      return { ok: false, error: "Data yang dikirim tidak valid.", stage: "createBiayaChemical:validate_payload" };
    }
    ensureMigrated_();
    const sheet = ensureDataSheet_();

    const cabangId = toSafeString_(payload.cabangId, "", 60);
    const cabangRaw = cabangId ? readKey_(sheet, "cabang_" + cabangId) : null;
    if (!cabangRaw) {
      return { ok: false, error: "Cabang tujuan tidak ditemukan. Pilih cabang terlebih dahulu.", stage: "createBiayaChemical:lookup_cabang" };
    }
    const cabang = sanitizeCabang_(JSON.parse(cabangRaw));

    const clean = sanitizeBiayaChemical_(payload);
    clean.id = newId_("chem");
    clean.cabangId = cabangId;
    const now = new Date().toISOString();
    clean.createdAt = now;
    clean.updatedAt = now;

    const validation = validateBiayaChemical_(clean, cabang);
    if (!validation.valid) {
      return { ok: false, error: validation.message, stage: "createBiayaChemical:validate_business_rules" };
    }

    writeKey_(sheet, "biayaChemical_" + clean.id, JSON.stringify(clean));
    appendToOrder_(sheet, KEY_BIAYA_CHEMICAL_ORDER, clean.id);

    return { ok: true, data: { record: clean, summary: computeBiayaChemicalSummary_(clean, cabang) } };
  } catch (err) {
    return errorResponse_(err, "createBiayaChemical");
  }
}

/**
 * Memperbarui item chemical yang sudah ada. cabangId TIDAK BISA dipindah
 * lewat update (sama seperti Gas) — hapus & buat baru kalau perlu pindah cabang.
 */
function updateBiayaChemical(sessionToken, id, payload) {
  return withTenant_(sessionToken, function () { return updateBiayaChemical_impl_(id, payload); });
}

function updateBiayaChemical_impl_(id, payload) {
  try {
    if (!id || typeof id !== "string") {
      return { ok: false, error: "ID item chemical tidak valid.", stage: "updateBiayaChemical:validate_id" };
    }
    if (!payload || typeof payload !== "object") {
      return { ok: false, error: "Data yang dikirim tidak valid.", stage: "updateBiayaChemical:validate_payload" };
    }
    ensureMigrated_();
    const sheet = ensureDataSheet_();

    const existingRaw = readKey_(sheet, "biayaChemical_" + id);
    if (!existingRaw) {
      return { ok: false, error: "Data chemical tidak ditemukan, kemungkinan sudah dihapus di tab lain.", stage: "updateBiayaChemical:lookup" };
    }
    const existing = JSON.parse(existingRaw);

    const cabangRaw = readKey_(sheet, "cabang_" + existing.cabangId);
    if (!cabangRaw) {
      return { ok: false, error: "Cabang pemilik data ini sudah tidak ada.", stage: "updateBiayaChemical:lookup_cabang" };
    }
    const cabang = sanitizeCabang_(JSON.parse(cabangRaw));

    const clean = sanitizeBiayaChemical_(payload);
    clean.id = id;
    clean.cabangId = existing.cabangId;
    clean.createdAt = existing.createdAt || new Date().toISOString();
    clean.updatedAt = new Date().toISOString();

    const validation = validateBiayaChemical_(clean, cabang);
    if (!validation.valid) {
      return { ok: false, error: validation.message, stage: "updateBiayaChemical:validate_business_rules" };
    }

    writeKey_(sheet, "biayaChemical_" + id, JSON.stringify(clean));
    return { ok: true, data: { record: clean, summary: computeBiayaChemicalSummary_(clean, cabang) } };
  } catch (err) {
    return errorResponse_(err, "updateBiayaChemical");
  }
}

function deleteBiayaChemical(sessionToken, id) {
  return withTenant_(sessionToken, function () { return deleteBiayaChemical_impl_(id); });
}

/**
 * Menghapus satu item chemical. Idempotent seperti deleteBiayaGas.
 */
function deleteBiayaChemical_impl_(id) {
  try {
    if (!id || typeof id !== "string") {
      return { ok: false, error: "ID item chemical tidak valid.", stage: "deleteBiayaChemical:validate_id" };
    }
    ensureMigrated_();
    const sheet = ensureDataSheet_();
    deleteKeyRow_(sheet, "biayaChemical_" + id);
    removeFromOrder_(sheet, KEY_BIAYA_CHEMICAL_ORDER, id);
    return { ok: true, data: { id: id } };
  } catch (err) {
    return errorResponse_(err, "deleteBiayaChemical");
  }
}

/**
 * Dipanggil dari deleteCabang() (Modul_Cabang.gs) agar tidak ada item chemical
 * "hantu" yang menunjuk ke cabangId yang sudah tidak ada.
 */
function deleteBiayaChemicalByCabang_(sheet, cabangId) {
  const order = readOrder_(sheet, KEY_BIAYA_CHEMICAL_ORDER);
  const remaining = [];
  for (let i = 0; i < order.length; i++) {
    const recId = order[i];
    const raw = readKey_(sheet, "biayaChemical_" + recId);
    if (!raw) continue;
    let belongsToCabang = false;
    try {
      const rec = JSON.parse(raw);
      belongsToCabang = rec.cabangId === cabangId;
    } catch (e) {
      belongsToCabang = false;
    }
    if (belongsToCabang) {
      deleteKeyRow_(sheet, "biayaChemical_" + recId);
    } else {
      remaining.push(recId);
    }
  }
  writeOrder_(sheet, KEY_BIAYA_CHEMICAL_ORDER, remaining);
}

// ----------------------------------------------------------------------------
// VALIDASI / SANITASI — MASTER BIAYA CHEMICAL
// ----------------------------------------------------------------------------

function sanitizeBiayaChemical_(input) {
  const out = defaultBiayaChemical_();

  out.id = toSafeString_(input && input.id, "", 60);
  out.cabangId = toSafeString_(input && input.cabangId, "", 60);
  out.nama = toSafeString_(input && input.nama, "", 60);
  out.tipeDeterjen = sanitizeTipeDeterjen_(input && input.tipeDeterjen);
  out.hargaBeli = clamp_(toNumber_(input && input.hargaBeli, 0), 0, 100000000);
  out.isiKemasan = clamp_(toNumber_(input && input.isiKemasan, 0), 0, 1000000);
  out.satuanKemasan = sanitizeSatuanKemasan_(input && input.satuanKemasan);
  out.takaranPerKg = clamp_(toNumber_(input && input.takaranPerKg, 0), 0, 100000);
  out.cuciRefId = toSafeString_(input && input.cuciRefId, "", 60);

  out.createdAt = (input && input.createdAt) || null;
  out.updatedAt = (input && input.updatedAt) || null;

  return out;
}

function sanitizeTipeDeterjen_(val) {
  const v = toSafeString_(val, "", 20).toLowerCase();
  return ["cair", "bubuk", "sachet"].indexOf(v) >= 0 ? v : "";
}

function sanitizeSatuanKemasan_(val) {
  const v = toSafeString_(val, "", 20).toLowerCase();
  return CHEMICAL_KONVERSI_DASAR_.hasOwnProperty(v) ? v : "";
}

function validateBiayaChemical_(data, cabang) {
  if (!data.cabangId) {
    return { valid: false, message: "Cabang belum ditentukan." };
  }
  if (data.nama.length === 0) {
    return { valid: false, message: "Nama item chemical belum diisi (contoh: Deterjen, Softener, Parfum)." };
  }
  if (data.hargaBeli <= 0) {
    return { valid: false, message: "Harga beli per kemasan harus lebih dari 0." };
  }
  if (data.isiKemasan <= 0) {
    return { valid: false, message: "Isi per kemasan harus lebih dari 0." };
  }
  if (data.satuanKemasan.length === 0) {
    return { valid: false, message: "Satuan kemasan belum dipilih (Liter, Kg, gr, atau ml)." };
  }
  if (data.takaranPerKg <= 0) {
    return { valid: false, message: "Takaran pemakaian per Kg harus lebih dari 0." };
  }
  if (!data.cuciRefId) {
    return { valid: false, message: "Pilih mesin cuci acuan untuk hitungan Biaya Chemical Per Load." };
  }
  const cuciExists = (cabang.mesinCuci || []).some(function (m) { return m.id === data.cuciRefId; });
  if (!cuciExists) {
    return { valid: false, message: "Mesin cuci acuan tidak ditemukan di profil cabang ini. Mungkin baris mesin itu sudah dihapus — pilih ulang acuannya." };
  }
  return { valid: true, message: "" };
}

// ============================================================================
// SECTION: KALKULASI MASTER BIAYA CHEMICAL
// ============================================================================
//
// computeBiayaChemicalSummary_ adalah SUMBER KEBENARAN TUNGGAL untuk hitungan
// biaya chemical. Frontend punya salinan identik untuk pratinjau real-time
// (lihat Index.html), tapi modul lain WAJIB panggil ini, jangan duplikasi rumus.
//
function computeBiayaChemicalSummary_(record, cabang) {
  const faktorKonversi = CHEMICAL_KONVERSI_DASAR_[record.satuanKemasan] || 0;
  const isiKemasanDasar = record.isiKemasan * faktorKonversi;
  const hargaPerUnit = isiKemasanDasar > 0
    ? round2_(record.hargaBeli / isiKemasanDasar)
    : 0;

  const cuci = findMachineById_(cabang.mesinCuci, record.cuciRefId);
  const kapasitasKgCuci = cuci ? toNumber_(cuci.kapasitasKg, 0) : 0;

  const pemakaianPerLoadDasar = round2_(record.takaranPerKg * kapasitasKgCuci);
  const biayaPerLoad = round2_(pemakaianPerLoadDasar * hargaPerUnit);
  const biayaPerKg = kapasitasKgCuci > 0 ? round2_(biayaPerLoad / kapasitasKgCuci) : 0;

  return {
    hargaPerUnit: hargaPerUnit,
    satuanDasar: CHEMICAL_SATUAN_DASAR_LABEL_[record.satuanKemasan] || "",
    cuciRefNama: cuci ? chemicalCuciDisplayName_(cuci) : "(mesin tidak ditemukan)",
    kapasitasKgCuci: kapasitasKgCuci,
    biayaPerLoad: biayaPerLoad,
    biayaPerKg: biayaPerKg,
    statusValid: isiKemasanDasar > 0 && record.takaranPerKg > 0 && kapasitasKgCuci > 0,
  };
}

function chemicalCuciDisplayName_(m) {
  const jenis = JENIS_MESIN_LABEL_[m.jenis] || "Mesin Cuci";
  return jenis + " · " + (m.kapasitasKg || 0) + " Kg";
}