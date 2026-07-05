/**
 * ============================================================================
 * MODUL: MASTER BIAYA — PACKING (Plastik, Label, Dus, dll)
 * ============================================================================
 * Fitur ini mengelola biaya kemasan/packing per cabang. Seperti Modul_BiayaGas,
 * ini MULTI-RECORD: satu cabang bisa punya banyak item packing sekaligus
 * (Plastik HD, Label, Dus, dst — item bebas ditambah/dihapus,
 * bukan daftar tetap, karena tiap laundry pakai kombinasi berbeda).
 *
 * BEDA dari Gas: tidak ada acuan mesin (dryerRefId). Basis hitungannya murni
 * per Kg cucian, bukan per load — dipilih begitu karena fitur ini dipakai
 * outlet kategori Drop Off/Kiloan & Hybrid yang memang menagih customer per Kg.
 *
 * DASAR RUMUS (baca sebelum mengubah computeBiayaPackingSummary_):
 *   1. hargaPerUnit = hargaBeli / isiKemasan
 *      (Rp per satuan terkecil, mis. Rp per gram/ml/pcs)
 *   2. biayaPerKg = hargaPerUnit * takaranPerKg
 *      (takaranPerKg HARUS dalam satuan yang sama dengan isiKemasan — ini
 *      tanggung jawab user saat isi form, tidak ada konversi satuan otomatis)
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

function defaultBiayaPacking_() {
  return {
    id: "",
    cabangId: "",
    nama: "",
    hargaBeli: 0,
    isiKemasan: 0,
    satuanKemasan: "",
    takaranPerKg: 0,
    createdAt: null,
    updatedAt: null,
  };
}

// ============================================================================
// SECTION: FUNGSI PUBLIK — CRUD MASTER BIAYA CHEMICAL
// ============================================================================

/**
 * Daftar semua item packing milik SATU cabang, sudah termasuk summary
 * kalkulasi per item DAN total biaya packing per Kg (dijumlah semua item).
 */
function listBiayaPacking(cabangId) {
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

/**
 * Mengambil satu item packing lengkap + summary, untuk layar edit.
 */
function getBiayaPacking(id) {
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

/**
 * Membuat item packing baru untuk satu cabang.
 */
function createBiayaPacking(payload) {
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
function updateBiayaPacking(id, payload) {
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

/**
 * Menghapus satu item packing. Idempotent seperti deleteBiayaGas.
 */
function deleteBiayaPacking(id) {
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
// VALIDASI / SANITASI — MASTER BIAYA CHEMICAL
// ----------------------------------------------------------------------------

function sanitizeBiayaPacking_(input) {
  const out = defaultBiayaPacking_();

  out.id = toSafeString_(input && input.id, "", 60);
  out.cabangId = toSafeString_(input && input.cabangId, "", 60);
  out.nama = toSafeString_(input && input.nama, "", 60);
  out.hargaBeli = clamp_(toNumber_(input && input.hargaBeli, 0), 0, 100000000);
  out.isiKemasan = clamp_(toNumber_(input && input.isiKemasan, 0), 0, 1000000);
  out.satuanKemasan = toSafeString_(input && input.satuanKemasan, "", 20);
  out.takaranPerKg = clamp_(toNumber_(input && input.takaranPerKg, 0), 0, 100000);

  out.createdAt = (input && input.createdAt) || null;
  out.updatedAt = (input && input.updatedAt) || null;

  return out;
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
  if (data.isiKemasan <= 0) {
    return { valid: false, message: "Isi per kemasan harus lebih dari 0." };
  }
  if (data.satuanKemasan.length === 0) {
    return { valid: false, message: "Satuan kemasan belum diisi (contoh: gram, ml, pcs)." };
  }
  if (data.takaranPerKg <= 0) {
    return { valid: false, message: "Takaran pemakaian per Kg harus lebih dari 0." };
  }
  return { valid: true, message: "" };
}

// ============================================================================
// SECTION: KALKULASI MASTER BIAYA CHEMICAL
// ============================================================================
//
// computeBiayaPackingSummary_ adalah SUMBER KEBENARAN TUNGGAL untuk hitungan
// biaya packing. Frontend punya salinan identik untuk pratinjau real-time
// (lihat Index.html), tapi modul lain WAJIB panggil ini, jangan duplikasi rumus.
//
function computeBiayaPackingSummary_(record) {
  const hargaPerUnit = record.isiKemasan > 0
    ? round2_(record.hargaBeli / record.isiKemasan)
    : 0;
  const biayaPerKg = round2_(hargaPerUnit * record.takaranPerKg);

  return {
    hargaPerUnit: hargaPerUnit,
    biayaPerKg: biayaPerKg,
    statusValid: record.isiKemasan > 0 && record.takaranPerKg > 0,
  };
}
