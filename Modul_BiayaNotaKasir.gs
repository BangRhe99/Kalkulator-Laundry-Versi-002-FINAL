/**
 * ====================================================================
 * MODUL: MASTER BIAYA â€” NOTA & KASIR
 * ====================================================================
 * Fitur ini mengelola satu konfigurasi biaya nota/kasir per cabang.
 * Disimpan di sheet terpisah "BiayaNotaKasir" dengan satu baris per cabang.
 *
 * DEPENDENSI:
 *   - Util_Umum.gs         : toSafeString_, toNumber_, clamp_, round2_,
 *                            newId_, errorResponse_
 *   - Util_Penyimpanan.gs  : tidak dipakai, karena modul ini menyimpan di
 *                            sheet khusus sendiri sesuai requirement.
 *   - Migrasi_Skema.gs     : ensureMigrated_
 *   - Modul_Cabang.gs      : getCabang() jika tersedia untuk nama laundry
 * ====================================================================
 */

// ============================================================================
// SECTION: SKEMA / DEFAULT â€” MASTER BIAYA (NOTA & KASIR)
// ============================================================================

function defaultBiayaNotaKasirRecord_(cabangId) {
  return {
    id: "",
    cabangId: cabangId || "",
    sistemNotaKasir: "aplikasi_kasir_thermal", // aplikasi_kasir_thermal | nota_manual_ncr
    metodeBiayaAplikasi: "biaya_langsung_per_transaksi", // biaya_langsung_per_transaksi | biaya_bulanan_dibagi_transaksi | gratis_tanpa_biaya_admin
    biayaPerTransaksi: 155,
    biayaBulananAplikasi: 0,
    estimasiTransaksiPerBulan: 0,
    hargaPerRoll: 1500,
    transaksiPerRoll: 30,
    hargaSatuanAwalNota: 30000,
    jumlahLembarNota: 150,
    notaPerTransaksi: 3,
    createdAt: null,
    updatedAt: null,
  };
}

// Global headers constant to avoid repeated allocations
const BIAYA_NOTA_KASIR_HEADERS_ = [
  "id",
  "cabangId",
  "sistemNotaKasir",
  "metodeBiayaAplikasi",
  "biayaPerTransaksi",
  "biayaBulananAplikasi",
  "estimasiTransaksiPerBulan",
  "hargaPerRoll",
  "transaksiPerRoll",
  "hargaSatuanAwalNota",
  "jumlahLembarNota",
  "notaPerTransaksi",
  "createdAt",
  "updatedAt",
];

function rowArrayToBiayaNotaKasirObject_(values) {
  const obj = {};
  for (let i = 0; i < BIAYA_NOTA_KASIR_HEADERS_.length; i++) {
    obj[BIAYA_NOTA_KASIR_HEADERS_[i]] = values[i];
  }
  return obj;
}

function notaKasirErrorResponse_(err, stage) {
  if (typeof errorResponse_ === "function") return errorResponse_(err, stage);
  return { ok: false, error: err && err.message ? err.message : String(err), stage: stage || "notaKasir:unknown" };
}

// ============================================================================
// SECTION: STORAGE SHEET HELPERS
// ============================================================================

function getBiayaNotaKasirSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("BiayaNotaKasir");
  if (!sheet) {
    sheet = ss.insertSheet("BiayaNotaKasir");
    sheet.getRange(1, 1, 1, BIAYA_NOTA_KASIR_HEADERS_.length).setValues([BIAYA_NOTA_KASIR_HEADERS_]);
  }
  return sheet;
}

function findBiayaNotaKasirRow_(sheet, cabangId) {
  // Legacy (slow) implementation retained for compatibility.
  const values = sheet.getDataRange().getValues();
  const header = values[0] || [];
  const cabangIdIndex = header.indexOf("cabangId");
  if (cabangIdIndex === -1) return -1;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][cabangIdIndex]) === cabangId) {
      return i + 1;
    }
  }
  return -1;
}

// Faster row finder that only reads the cabangId column
function findBiayaNotaKasirRowFast_(sheet, cabangId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const values = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  const target = String(cabangId);
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]) === target) {
      return i + 2;
    }
  }
  return -1;
}

function buildBiayaNotaKasirRow_(record) {
  return [
    record.id,
    record.cabangId,
    record.sistemNotaKasir,
    record.metodeBiayaAplikasi,
    record.biayaPerTransaksi,
    record.biayaBulananAplikasi,
    record.estimasiTransaksiPerBulan,
    record.hargaPerRoll,
    record.transaksiPerRoll,
    record.hargaSatuanAwalNota,
    record.jumlahLembarNota,
    record.notaPerTransaksi,
    record.createdAt,
    record.updatedAt,
  ];
}

function parseBiayaNotaKasirRecord_(row) {
  return {
    id: String(row.id || ""),
    cabangId: String(row.cabangId || ""),
    sistemNotaKasir: String(row.sistemNotaKasir || ""),
    metodeBiayaAplikasi: String(row.metodeBiayaAplikasi || ""),
    biayaPerTransaksi: toNumber_(row.biayaPerTransaksi, 0),
    biayaBulananAplikasi: toNumber_(row.biayaBulananAplikasi, 0),
    estimasiTransaksiPerBulan: toNumber_(row.estimasiTransaksiPerBulan, 0),
    hargaPerRoll: toNumber_(row.hargaPerRoll, 0),
    transaksiPerRoll: toNumber_(row.transaksiPerRoll, 0),
    hargaSatuanAwalNota: toNumber_(row.hargaSatuanAwalNota, 0),
    jumlahLembarNota: toNumber_(row.jumlahLembarNota, 0),
    notaPerTransaksi: toNumber_(row.notaPerTransaksi, 0),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

function getCabangInfo_(cabangId) {
  if (!cabangId || typeof cabangId !== "string") {
    return { id: "", namaLaundry: "" };
  }
  if (typeof getCabang === "function") {
    try {
      const res = getCabang(cabangId);
      if (res && res.ok && res.data && res.data.cabang) {
        const cabang = res.data.cabang;
        const namaLaundry = cabang.profil && cabang.profil.namaLaundry ? String(cabang.profil.namaLaundry) : "";
        return { id: cabangId, namaLaundry: namaLaundry };
      }
    } catch (e) {
      // fallback silent
    }
  }
  return { id: cabangId, namaLaundry: "" };
}

// ============================================================================
// SECTION: PUBLIC FUNCTIONS â€” getBiayaNotaKasir / saveBiayaNotaKasir
// ============================================================================

function getBiayaNotaKasir(cabangId) {
  try {
    if (!cabangId || typeof cabangId !== "string") {
      return { ok: false, error: "ID cabang tidak valid.", stage: "getBiayaNotaKasir:validate_cabang_id" };
    }

    if (typeof ensureMigrated_ === "function") {
      try {
        ensureMigrated_();
      } catch (e) {
        console.warn("[NotaKasir] ensureMigrated_ gagal, melanjutkan tanpa migrasi:", e);
      }
    }

    const cabang = getCabangInfo_(cabangId);
    const sheet = getBiayaNotaKasirSheet_();
    const rowIndex = findBiayaNotaKasirRowFast_(sheet, cabangId);

    let record;
    if (rowIndex > 0) {
      const values = sheet.getRange(rowIndex, 1, 1, BIAYA_NOTA_KASIR_HEADERS_.length).getValues()[0];
      const rowObject = rowArrayToBiayaNotaKasirObject_(values);
      record = normalizeBiayaNotaKasirRecord_(rowObject, cabangId);
    } else {
      record = defaultBiayaNotaKasirRecord_(cabangId);
    }

    return {
      ok: true,
      data: {
        cabang: { id: cabang.id, namaLaundry: cabang.namaLaundry },
        record: record,
        summary: computeBiayaNotaKasirSummary_(record),
      },
    };
  } catch (err) {
    return notaKasirErrorResponse_(err, "getBiayaNotaKasir");
  }
}

function saveBiayaNotaKasir(cabangId, payload) {
  try {
    if (!cabangId || typeof cabangId !== "string") {
      return { ok: false, error: "ID cabang tidak valid.", stage: "saveBiayaNotaKasir:validate_cabang_id" };
    }
    if (!payload || typeof payload !== "object") {
      return { ok: false, error: "Data yang dikirim tidak valid.", stage: "saveBiayaNotaKasir:validate_payload" };
    }

    const sheet = getBiayaNotaKasirSheet_();
    const rowIndex = findBiayaNotaKasirRowFast_(sheet, cabangId);

    let existingRecord = null;
    if (rowIndex > 0) {
      const existingValues = sheet.getRange(rowIndex, 1, 1, BIAYA_NOTA_KASIR_HEADERS_.length).getValues()[0];
      existingRecord = parseBiayaNotaKasirRecord_(rowArrayToBiayaNotaKasirObject_(existingValues));
    }

    const normalized = normalizeBiayaNotaKasirRecord_(payload, cabangId);
    normalized.id = existingRecord && existingRecord.id ? existingRecord.id : (normalized.id || newId_("n"));
    const now = new Date().toISOString();
    normalized.createdAt = existingRecord && existingRecord.createdAt ? existingRecord.createdAt : now;
    normalized.updatedAt = now;

    const validation = validateBiayaNotaKasir_(normalized);
    if (!validation.valid) {
      return { ok: false, error: validation.message, stage: "saveBiayaNotaKasir:validate_business_rules" };
    }

    const row = buildBiayaNotaKasirRow_(normalized);
    if (rowIndex > 0) {
      sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
    } else {
      sheet.appendRow(row);
    }

    return {
      ok: true,
      data: {
        record: normalized,
        summary: computeBiayaNotaKasirSummary_(normalized),
      },
    };
  } catch (err) {
    return notaKasirErrorResponse_(err, "saveBiayaNotaKasir");
  }
}

function normalizeBiayaNotaKasirRecord_(input, cabangId) {
  const base = defaultBiayaNotaKasirRecord_(cabangId);
  const out = defaultBiayaNotaKasirRecord_(cabangId);

  out.id = toSafeString_(input && input.id, base.id, 80);
  out.cabangId = cabangId;

  out.sistemNotaKasir = toSafeString_(input && input.sistemNotaKasir, base.sistemNotaKasir, 40);
  if (!["aplikasi_kasir_thermal", "nota_manual_ncr"].includes(out.sistemNotaKasir)) {
    out.sistemNotaKasir = base.sistemNotaKasir;
  }

  out.metodeBiayaAplikasi = toSafeString_(input && input.metodeBiayaAplikasi, base.metodeBiayaAplikasi, 40);
  if (!["biaya_langsung_per_transaksi", "biaya_bulanan_dibagi_transaksi", "gratis_tanpa_biaya_admin"].includes(out.metodeBiayaAplikasi)) {
    out.metodeBiayaAplikasi = base.metodeBiayaAplikasi;
  }

  if (out.sistemNotaKasir === "nota_manual_ncr") {
    out.metodeBiayaAplikasi = "gratis_tanpa_biaya_admin";
  }

  out.biayaPerTransaksi = clamp_(toNumber_(input && input.biayaPerTransaksi, base.biayaPerTransaksi), 0, 100000000);
  out.biayaBulananAplikasi = clamp_(toNumber_(input && input.biayaBulananAplikasi, base.biayaBulananAplikasi), 0, 100000000);
  out.estimasiTransaksiPerBulan = clamp_(toNumber_(input && input.estimasiTransaksiPerBulan, base.estimasiTransaksiPerBulan), 0, 100000000);
  out.hargaPerRoll = clamp_(toNumber_(input && input.hargaPerRoll, base.hargaPerRoll), 0, 100000000);
  out.transaksiPerRoll = clamp_(toNumber_(input && input.transaksiPerRoll, base.transaksiPerRoll), 0, 100000000);
  out.hargaSatuanAwalNota = clamp_(toNumber_(input && input.hargaSatuanAwalNota, base.hargaSatuanAwalNota), 0, 100000000);
  out.jumlahLembarNota = clamp_(toNumber_(input && input.jumlahLembarNota, base.jumlahLembarNota), 0, 100000000);
  out.notaPerTransaksi = clamp_(toNumber_(input && input.notaPerTransaksi, base.notaPerTransaksi), 0, 100000000);

  out.createdAt = (input && input.createdAt) || base.createdAt;
  out.updatedAt = (input && input.updatedAt) || base.updatedAt;

  return out;
}

function validateBiayaNotaKasir_(data) {
  if (!data.cabangId) {
    return { valid: false, message: "Cabang belum ditentukan." };
  }
  if (!["aplikasi_kasir_thermal", "nota_manual_ncr"].includes(data.sistemNotaKasir)) {
    return { valid: false, message: "Sistem nota/kasir tidak valid." };
  }
  if (data.sistemNotaKasir === "aplikasi_kasir_thermal" &&
      !["biaya_langsung_per_transaksi", "biaya_bulanan_dibagi_transaksi", "gratis_tanpa_biaya_admin"].includes(data.metodeBiayaAplikasi)) {
    return { valid: false, message: "Metode biaya aplikasi tidak valid." };
  }
  return { valid: true, message: "" };
}

// ============================================================================
// SECTION: KALKULASI â€” BIAYA NOTA & KASIR
// ============================================================================

function computeBiayaNotaKasirSummary_(record) {
  record = record || defaultBiayaNotaKasirRecord_(record && record.cabangId);

  const sistem = record.sistemNotaKasir || "aplikasi_kasir_thermal";
  const metode = record.metodeBiayaAplikasi || "biaya_langsung_per_transaksi";

  let biayaAplikasiPerLoad = 0;
  let biayaNotaPerLoad = 0;
  let hargaNotaPerLembar = 0;
  let biayaNotaPerTransaksi = 0;
  let totalBiayaNotaKasirPerLoad = 0;
  let warning = "";
  let statusValid = true;

  if (sistem === "aplikasi_kasir_thermal") {
    if (metode === "biaya_langsung_per_transaksi") {
      biayaAplikasiPerLoad = round2_(toNumber_(record.biayaPerTransaksi, 0));
      if (biayaAplikasiPerLoad < 0) biayaAplikasiPerLoad = 0;
    } else if (metode === "biaya_bulanan_dibagi_transaksi") {
      const biayaBulanan = toNumber_(record.biayaBulananAplikasi, 0);
      const trxBulanan = toNumber_(record.estimasiTransaksiPerBulan, 0);
      if (trxBulanan > 0) {
        biayaAplikasiPerLoad = round2_(biayaBulanan / trxBulanan);
      } else {
        biayaAplikasiPerLoad = 0;
        warning = "Estimasi transaksi bulanan harus diisi lebih dari 0 untuk menghitung biaya aplikasi.";
        statusValid = false;
      }
    } else {
      biayaAplikasiPerLoad = 0;
    }

    const hargaRoll = toNumber_(record.hargaPerRoll, 0);
    const transaksiRoll = toNumber_(record.transaksiPerRoll, 0);
    if (transaksiRoll > 0) {
      biayaNotaPerLoad = round2_(hargaRoll / transaksiRoll);
    } else {
      biayaNotaPerLoad = 0;
      if (!warning) {
        warning = "Transaksi per roll harus diisi lebih dari 0 untuk menghitung biaya nota thermal.";
      }
      statusValid = false;
    }

    totalBiayaNotaKasirPerLoad = round2_(biayaAplikasiPerLoad + biayaNotaPerLoad);
  }

  if (sistem === "nota_manual_ncr") {
    const hargaAwal = toNumber_(record.hargaSatuanAwalNota, 0);
    const jumlahLembar = toNumber_(record.jumlahLembarNota, 0);
    const notaPerTransaksi = toNumber_(record.notaPerTransaksi, 0);

    if (jumlahLembar > 0) {
      hargaNotaPerLembar = round2_(hargaAwal / jumlahLembar);
    } else {
      hargaNotaPerLembar = 0;
      warning = "Jumlah lembar nota harus diisi lebih dari 0 untuk menghitung harga per lembar.";
      statusValid = false;
    }

    biayaNotaPerTransaksi = round2_(hargaNotaPerLembar * notaPerTransaksi);
    biayaAplikasiPerLoad = 0;
    biayaNotaPerLoad = biayaNotaPerTransaksi;
    totalBiayaNotaKasirPerLoad = biayaNotaPerTransaksi;

    if (notaPerTransaksi <= 0) {
      if (!warning) {
        warning = "Nota per transaksi harus diisi lebih dari 0 untuk menghitung biaya nota.";
      }
      statusValid = false;
    }
  }

  return {
    sistemNotaKasir: sistem,
    metodeBiayaAplikasi: metode,
    biayaAplikasiPerLoad: round2_(biayaAplikasiPerLoad),
    biayaNotaPerLoad: round2_(biayaNotaPerLoad),
    hargaNotaPerLembar: round2_(hargaNotaPerLembar),
    biayaNotaPerTransaksi: round2_(biayaNotaPerTransaksi),
    totalBiayaNotaKasirPerLoad: round2_(totalBiayaNotaKasirPerLoad),
    statusValid: statusValid,
    warning: warning,
  };
}