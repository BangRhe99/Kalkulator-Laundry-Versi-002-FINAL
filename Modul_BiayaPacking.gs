/**
 * ============================================================================
 * MODUL: MASTER BIAYA — PACKING (Plastik, Label, Dus, dll)
 * ============================================================================
 * Fitur ini mengelola biaya kemasan/packing per cabang. Seperti Modul_BiayaGas,
 * ini MULTI-RECORD: satu cabang bisa punya banyak item packing sekaligus
 * (Plastik HD, Label, Dus, dst - item bebas ditambah/dihapus,
 * bukan daftar tetap, karena tiap laundry pakai kombinasi berbeda).
 *
 * DASAR RUMUS (baca sebelum mengubah computeBiayaPackingSummary_):
 *   1. hargaPerLembar = hargaBeli / isiKemasan (Rp per lembar/pcs kemasan)
 *   2. biayaPerLoad = hargaPerLembar (asumsi 1 lembar dipakai per pemakaian)
 *   3. biayaPerKg = biayaPerLoad / kapKgPerLembar
 *      (kapKgPerLembar = kapasitas berapa Kg cucian yang bisa dibungkus oleh
 *      1 lembar packing ini - diisi manual oleh user di form, BUKAN hasil
 *      konversi satuan otomatis seperti Modul_BiayaChemical.gs)
 *
 * LAYANAN PACKING (khusus item "plastik" — nama mengandung kata "plastik",
 * mis. Plastik HD/PP/Jinjing/custom "Plastik satuan"):
 *   Outlet kategori Drop Off/Kiloan & Hybrid bisa saja pakai jenis plastik
 *   BERBEDA untuk kiloan reguler vs Bed Cover (mis. kiloan pakai HD+PP,
 *   Bed Cover pakai Jinjing). Field layananPacking (array ["kiloan",
 *   "bed_cover"]) menandai layanan mana yang memakai item plastik ini, supaya
 *   Modul_StrukturBiayaHPP.gs bisa menjumlah biaya packing PER LAYANAN,
 *   bukan rata semua item ke semua layanan. Item NON-plastik (Isolasi, dll)
 *   sengaja tidak dibedakan — selalu dihitung di semua layanan seperti biasa,
 *   lihat isPackingPlastikNama_.
 *
 * DEPENDENSI FILE INI:
 *   - Code.gs              : KEY_BIAYA_PACKING_ORDER
 *   - Util_Umum.gs         : toSafeString_, toNumber_, clamp_, round2_,
 *                            errorResponse_, newId_
 *   - Util_Penyimpanan.gs  : ensureDataSheet_, readKey_, writeKey_,
 *                            deleteKeyRow_, readOrder_, writeOrder_,
 *                            appendToOrder_, removeFromOrder_
 *   - Migrasi_Skema.gs     : ensureMigrated_
 *   - Modul_Cabang.gs      : sanitizeCabang_ (membaca profil cabang pemilik)
 *
 * DIPANGGIL OLEH FILE LAIN:
 *   - deleteBiayaPackingByCabang_ dipanggil dari Modul_Cabang.gs (deleteCabang),
 *     supaya tidak ada record packing "hantu" saat cabang induk dihapus.
 *   - isPackingPlastikNama_ dipanggil dari Modul_StrukturBiayaHPP.gs untuk
 *     menentukan item mana yang perlu dipecah per layanan.
 *
 * DAFTAR ISI:
 *   SKEMA
 *     - defaultBiayaPacking_       -> bentuk default 1 record item packing
 *   FUNGSI PUBLIK (dipanggil dari Index.html lewat google.script.run)
 *     - listBiayaPacking            -> semua item packing milik 1 cabang + total
 *     - getBiayaPacking             -> satu item lengkap + summary
 *     - createBiayaPacking          -> buat item baru
 *     - updateBiayaPacking          -> ubah item yang sudah ada
 *     - deleteBiayaPacking          -> hapus 1 item
 *   FUNGSI INTERNAL (dipanggil modul lain, BUKAN dari frontend)
 *     - deleteBiayaPackingByCabang_ -> cascade delete saat cabang dihapus
 *     - isPackingPlastikNama_       -> cek apakah item ini "plastik" atau bukan
 *   VALIDASI / SANITASI
 *     - sanitizeBiayaPacking_       -> bersihkan & lengkapi payload dari frontend
 *     - validateBiayaPacking_       -> tolak jika melanggar aturan bisnis
 *   KALKULASI
 *     - computeBiayaPackingSummary_ -> SUMBER KEBENARAN TUNGGAL kalkulasi biaya packing
 * ============================================================================
 */

// ============================================================================
// SECTION: SKEMA / DEFAULT — MASTER BIAYA (PACKING)
// ============================================================================

const PACKING_SATUAN_VALID_ = ["pack", "kg"];
const PACKING_LAYANAN_VALID_ = ["kiloan", "bed_cover"];

function defaultBiayaPacking_() {
  return {
    id: "",
    cabangId: "",
    nama: "",
    hargaBeli: 0,
    isiKemasan: 0,
    satuanKemasan: "",
    ukuranPanjang: 0,
    ukuranLebar: 0,
    kapKgPerLembar: 0,
    kapPerOrderan: 0,
    layananPacking: ["kiloan", "bed_cover"],
    createdAt: null,
    updatedAt: null,
  };
}

/**
 * isPackingPlastikNama_: true kalau nama item mengandung kata "plastik"
 * (case-insensitive) — mencakup Plastik HD/PP/Jinjing bawaan maupun item
 * custom seperti "Plastik satuan". Item lain (Isolasi, Label, Dus, dll)
 * TIDAK dianggap plastik, jadi tidak ikut dipecah per layanan.
 */
function isPackingPlastikNama_(nama) {
  return String(nama || "").trim().toLowerCase().indexOf("plastik") >= 0;
}

/**
 * isPackingJinjingBedCoverLocked_: true kalau item ini namanya PERSIS
 * "Plastik Jinjing" (bukan sekadar mengandung kata plastik) DAN dicentang
 * untuk layanan Bed Cover. Dalam kondisi ini, Kap Kg Per Lembar TIDAK dipakai
 * sebagai basis hitung — asumsinya 1 lembar Jinjing = 1 Bed Cover (pcs),
 * bukan takaran per Kg cucian seperti Plastik HD/PP biasa. Biaya per Kg jadi
 * tidak relevan; yang dipakai cukup Biaya Packing Per Load (harga per lembar).
 */
function isPackingJinjingBedCoverLocked_(record) {
  const nama = String(record && record.nama || "").trim().toLowerCase();
  const layanan = Array.isArray(record && record.layananPacking) ? record.layananPacking : [];
  return nama === "plastik jinjing" && layanan.indexOf("bed_cover") >= 0;
}

/**
 * isPackingIsolasiNama_: true kalau nama item persis "Isolasi". Item ini
 * dijual per ROLL (bukan per kemasan/isi seperti plastik), jadi Isi per
 * Kemasan & Satuan tidak dipakai. Basis hitungnya beda total dari item
 * packing lain, lihat computeBiayaPackingSummary_.
 */
function isPackingIsolasiNama_(nama) {
  return String(nama || "").trim().toLowerCase() === "isolasi";
}

// ============================================================================
// SECTION: FUNGSI PUBLIK — CRUD MASTER BIAYA PACKING
// ============================================================================

/**
 * [2026-07-13] Dibungkus withTenant_ (Code.gs) - argumen pertama SELALU
 * sessionToken, badan logic asli dipindah ke nama "_impl_".
 */
function listBiayaPacking(sessionToken, cabangId) {
  return withTenant_(sessionToken, function () { return listBiayaPacking_impl_(cabangId); });
}

/**
 * Daftar semua item packing milik SATU cabang, sudah termasuk summary
 * kalkulasi per item DAN total biaya packing per Kg (dijumlah semua item).
 */
function listBiayaPacking_impl_(cabangId) {
  try {
    if (!cabangId || typeof cabangId !== "string") {
      return { ok: false, error: "ID cabang tidak valid.", stage: "listBiayaPacking:validate_cabang_id" };
    }
    ensureMigrated_();
    const sheet = ensureDataSheet_();

    const cabangRaw = readKey_(sheet, "cabang_" + cabangId);
    if (!cabangRaw) {
      return { ok: false, error: "Cabang tidak ditemukan. Mungkin sudah dihapus.", stage: "listBiayaPacking:lookup_cabang" };
    }
    const cabang = sanitizeCabang_(JSON.parse(cabangRaw));

    const order = readOrder_(sheet, KEY_BIAYA_PACKING_ORDER);
    const items = [];
    let totalBiayaPerKg = 0;
    for (let i = 0; i < order.length; i++) {
      const raw = readKey_(sheet, "biayaPacking_" + order[i]);
      if (!raw) continue;
      const record = sanitizeBiayaPacking_(JSON.parse(raw));
      if (record.cabangId !== cabangId) continue;
      const summary = computeBiayaPackingSummary_(record);
      items.push({ record: record, summary: summary });
      totalBiayaPerKg += summary.biayaPerKg;
    }
    return {
      ok: true,
      data: {
        cabang: { id: cabang.id, namaLaundry: cabang.profil.namaLaundry },
        items: items,
        totalBiayaPerKg: round2_(totalBiayaPerKg),
      },
    };
  } catch (err) {
    return errorResponse_(err, "listBiayaPacking");
  }
}

function getBiayaPacking(sessionToken, id) {
  return withTenant_(sessionToken, function () { return getBiayaPacking_impl_(id); });
}

/**
 * Mengambil satu item packing lengkap + summary, untuk layar edit.
 */
function getBiayaPacking_impl_(id) {
  try {
    if (!id || typeof id !== "string") {
      return { ok: false, error: "ID item packing tidak valid.", stage: "getBiayaPacking:validate_id" };
    }
    ensureMigrated_();
    const sheet = ensureDataSheet_();
    const raw = readKey_(sheet, "biayaPacking_" + id);
    if (!raw) {
      return { ok: false, error: "Data packing tidak ditemukan. Mungkin sudah dihapus.", stage: "getBiayaPacking:lookup" };
    }
    const record = sanitizeBiayaPacking_(JSON.parse(raw));
    return { ok: true, data: { record: record, summary: computeBiayaPackingSummary_(record) } };
  } catch (err) {
    return errorResponse_(err, "getBiayaPacking");
  }
}

function createBiayaPacking(sessionToken, payload) {
  return withTenant_(sessionToken, function () { return createBiayaPacking_impl_(payload); });
}

/**
 * Membuat item packing baru untuk satu cabang.
 */
function createBiayaPacking_impl_(payload) {
  try {
    if (!payload || typeof payload !== "object") {
      return { ok: false, error: "Data yang dikirim tidak valid.", stage: "createBiayaPacking:validate_payload" };
    }
    ensureMigrated_();
    const sheet = ensureDataSheet_();

    const cabangId = toSafeString_(payload.cabangId, "", 60);
    const cabangRaw = cabangId ? readKey_(sheet, "cabang_" + cabangId) : null;
    if (!cabangRaw) {
      return { ok: false, error: "Cabang tujuan tidak ditemukan. Pilih cabang terlebih dahulu.", stage: "createBiayaPacking:lookup_cabang" };
    }

    const clean = sanitizeBiayaPacking_(payload);
    clean.id = newId_("pack");
    clean.cabangId = cabangId;
    const now = new Date().toISOString();
    clean.createdAt = now;
    clean.updatedAt = now;

    const validation = validateBiayaPacking_(clean);
    if (!validation.valid) {
      return { ok: false, error: validation.message, stage: "createBiayaPacking:validate_business_rules" };
    }

    writeKey_(sheet, "biayaPacking_" + clean.id, JSON.stringify(clean));
    appendToOrder_(sheet, KEY_BIAYA_PACKING_ORDER, clean.id);

    return { ok: true, data: { record: clean, summary: computeBiayaPackingSummary_(clean) } };
  } catch (err) {
    return errorResponse_(err, "createBiayaPacking");
  }
}

/**
 * Memperbarui item packing yang sudah ada. cabangId TIDAK BISA dipindah
 * lewat update (sama seperti Gas) — hapus & buat baru kalau perlu pindah cabang.
 */
function updateBiayaPacking(sessionToken, id, payload) {
  return withTenant_(sessionToken, function () { return updateBiayaPacking_impl_(id, payload); });
}

function updateBiayaPacking_impl_(id, payload) {
  try {
    if (!id || typeof id !== "string") {
      return { ok: false, error: "ID item packing tidak valid.", stage: "updateBiayaPacking:validate_id" };
    }
    if (!payload || typeof payload !== "object") {
      return { ok: false, error: "Data yang dikirim tidak valid.", stage: "updateBiayaPacking:validate_payload" };
    }
    ensureMigrated_();
    const sheet = ensureDataSheet_();

    const existingRaw = readKey_(sheet, "biayaPacking_" + id);
    if (!existingRaw) {
      return { ok: false, error: "Data packing tidak ditemukan, kemungkinan sudah dihapus di tab lain.", stage: "updateBiayaPacking:lookup" };
    }
    const existing = JSON.parse(existingRaw);

    const clean = sanitizeBiayaPacking_(payload);
    clean.id = id;
    clean.cabangId = existing.cabangId;
    clean.createdAt = existing.createdAt || new Date().toISOString();
    clean.updatedAt = new Date().toISOString();

    const validation = validateBiayaPacking_(clean);
    if (!validation.valid) {
      return { ok: false, error: validation.message, stage: "updateBiayaPacking:validate_business_rules" };
    }

    writeKey_(sheet, "biayaPacking_" + id, JSON.stringify(clean));
    return { ok: true, data: { record: clean, summary: computeBiayaPackingSummary_(clean) } };
  } catch (err) {
    return errorResponse_(err, "updateBiayaPacking");
  }
}

function deleteBiayaPacking(sessionToken, id) {
  return withTenant_(sessionToken, function () { return deleteBiayaPacking_impl_(id); });
}

/**
 * Menghapus satu item packing. Idempotent seperti deleteBiayaGas.
 */
function deleteBiayaPacking_impl_(id) {
  try {
    if (!id || typeof id !== "string") {
      return { ok: false, error: "ID item packing tidak valid.", stage: "deleteBiayaPacking:validate_id" };
    }
    ensureMigrated_();
    const sheet = ensureDataSheet_();
    deleteKeyRow_(sheet, "biayaPacking_" + id);
    removeFromOrder_(sheet, KEY_BIAYA_PACKING_ORDER, id);
    return { ok: true, data: { id: id } };
  } catch (err) {
    return errorResponse_(err, "deleteBiayaPacking");
  }
}

/**
 * Dipanggil dari deleteCabang() (Modul_Cabang.gs) agar tidak ada item packing
 * "hantu" yang menunjuk ke cabangId yang sudah tidak ada.
 */
function deleteBiayaPackingByCabang_(sheet, cabangId) {
  const order = readOrder_(sheet, KEY_BIAYA_PACKING_ORDER);
  const remaining = [];
  for (let i = 0; i < order.length; i++) {
    const recId = order[i];
    const raw = readKey_(sheet, "biayaPacking_" + recId);
    if (!raw) continue;
    let belongsToCabang = false;
    try {
      const rec = JSON.parse(raw);
      belongsToCabang = rec.cabangId === cabangId;
    } catch (e) {
      belongsToCabang = false;
    }
    if (belongsToCabang) {
      deleteKeyRow_(sheet, "biayaPacking_" + recId);
    } else {
      remaining.push(recId);
    }
  }
  writeOrder_(sheet, KEY_BIAYA_PACKING_ORDER, remaining);
}

// ----------------------------------------------------------------------------
// VALIDASI / SANITASI — MASTER BIAYA PACKING
// ----------------------------------------------------------------------------

function sanitizeBiayaPacking_(input) {
  const out = defaultBiayaPacking_();

  out.id = toSafeString_(input && input.id, "", 60);
  out.cabangId = toSafeString_(input && input.cabangId, "", 60);
  out.nama = toSafeString_(input && input.nama, "", 60);
  out.hargaBeli = clamp_(toNumber_(input && input.hargaBeli, 0), 0, 100000000);
  out.isiKemasan = clamp_(toNumber_(input && input.isiKemasan, 0), 0, 1000000);
  out.satuanKemasan = sanitizePackingSatuan_(input && input.satuanKemasan);
  out.ukuranPanjang = clamp_(toNumber_(input && input.ukuranPanjang, 0), 0, 10000);
  out.ukuranLebar = clamp_(toNumber_(input && input.ukuranLebar, 0), 0, 10000);
  out.kapKgPerLembar = clamp_(toNumber_(input && input.kapKgPerLembar, 0), 0, 10000);
  out.kapPerOrderan = clamp_(toNumber_(input && input.kapPerOrderan, 0), 0, 10000);
  out.layananPacking = sanitizePackingLayanan_(input && input.layananPacking);

  out.createdAt = (input && input.createdAt) || null;
  out.updatedAt = (input && input.updatedAt) || null;

  return out;
}

function sanitizePackingSatuan_(val) {
  const v = toSafeString_(val, "", 20).toLowerCase();
  return PACKING_SATUAN_VALID_.indexOf(v) >= 0 ? v : "";
}

/**
 * sanitizePackingLayanan_: record LAMA (belum punya field ini sama sekali,
 * val === undefined) dianggap "dipakai di semua layanan" supaya perilaku
 * lama (rata semua item) tidak berubah tiba-tiba tanpa user menyentuhnya.
 * Kalau val berupa array (termasuk array kosong hasil user uncheck semua),
 * dihormati apa adanya.
 */
function sanitizePackingLayanan_(val) {
  if (!Array.isArray(val)) return ["kiloan", "bed_cover"];
  return val.filter(function (v) { return PACKING_LAYANAN_VALID_.indexOf(v) >= 0; });
}

function validateBiayaPacking_(data) {
  if (!data.cabangId) {
    return { valid: false, message: "Cabang belum ditentukan." };
  }
  if (data.nama.length === 0) {
    return { valid: false, message: "Nama item packing belum diisi (contoh: Plastik HD, Label, Dus)." };
  }
  if (data.hargaBeli <= 0) {
    return { valid: false, message: "Harga beli per kemasan harus lebih dari 0." };
  }

  if (isPackingIsolasiNama_(data.nama)) {
    if (data.kapKgPerLembar <= 0) {
      return { valid: false, message: "Kap Kg Per Roll harus lebih dari 0." };
    }
    if (data.kapPerOrderan <= 0) {
      return { valid: false, message: "Kap Per Orderan harus lebih dari 0." };
    }
    return { valid: true, message: "" };
  }

  if (data.isiKemasan <= 0) {
    return { valid: false, message: "Isi per kemasan harus lebih dari 0." };
  }
  if (data.satuanKemasan.length === 0) {
    return { valid: false, message: "Satuan kemasan belum dipilih (Pack atau Kg)." };
  }
  if (!isPackingJinjingBedCoverLocked_(data) && data.kapKgPerLembar <= 0) {
    return { valid: false, message: "Kap Kg Per Lembar harus lebih dari 0." };
  }
  return { valid: true, message: "" };
}

// ============================================================================
// SECTION: KALKULASI MASTER BIAYA PACKING
// ============================================================================
//
// computeBiayaPackingSummary_ adalah SUMBER KEBENARAN TUNGGAL untuk hitungan
// biaya packing PER ITEM. Frontend punya salinan identik untuk pratinjau
// real-time (lihat Index.html), tapi modul lain WAJIB panggil ini, jangan
// duplikasi rumus. Pemecahan biaya PER LAYANAN (kiloan vs bed cover) ada di
// Modul_StrukturBiayaHPP.gs (sumStrukturHPPPackingBiayaPerKg_), bukan di sini,
// karena itu murni soal agregasi lintas-item, bukan kalkulasi 1 item.
//
function computeBiayaPackingSummary_(record) {
  if (isPackingIsolasiNama_(record.nama)) {
    const biayaPerLoadIsolasi = record.kapKgPerLembar > 0
      ? round2_(record.hargaBeli / record.kapKgPerLembar)
      : 0;
    const biayaPerKgIsolasi = record.kapPerOrderan > 0
      ? round2_(biayaPerLoadIsolasi / record.kapPerOrderan)
      : 0;

    return {
      hargaPerUnit: biayaPerLoadIsolasi,
      biayaPerLoad: biayaPerLoadIsolasi,
      biayaPerKg: biayaPerKgIsolasi,
      kapKgLocked: false,
      statusValid: record.kapKgPerLembar > 0 && record.kapPerOrderan > 0,
    };
  }

  const hargaPerLembar = record.isiKemasan > 0
    ? round2_(record.hargaBeli / record.isiKemasan)
    : 0;
  const biayaPerLoad = hargaPerLembar;
  const kapKgLocked = isPackingJinjingBedCoverLocked_(record);
  const biayaPerKg = (!kapKgLocked && record.kapKgPerLembar > 0)
    ? round2_(biayaPerLoad / record.kapKgPerLembar)
    : 0;

  return {
    hargaPerUnit: hargaPerLembar,
    biayaPerLoad: biayaPerLoad,
    biayaPerKg: biayaPerKg,
    kapKgLocked: kapKgLocked,
    statusValid: record.isiKemasan > 0 && (kapKgLocked || record.kapKgPerLembar > 0),
  };
}