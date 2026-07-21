/**
 * ============================================================================
 * MODUL: BIAYA TETAP OUTLET (FIXED COST)
 * ============================================================================
 * Fitur ini mengelola biaya tetap bulanan per outlet/cabang.
 *
 * Sumber data profil operasional:
 * - Modul_Cabang.gs melalui getCabang(cabangId)
 * - Data mesin cuci dan pengering TIDAK dibuat ulang di modul ini.
 * - Modul ini hanya menyimpan input fixed cost dan input depresiasi per mesin.
 *
 * PUBLIC FUNCTIONS:
 * - listBiayaTetapOutletSummaries()
 * - getBiayaTetapOutlet(cabangId)
 * - saveBiayaTetapOutlet(cabangId, payload)
 * - deleteBiayaTetapOutlet(cabangId)
 * - testBiayaTetapOutlet()
 * ============================================================================
 */

const BIAYA_TETAP_SHEET_NAME_ = "BiayaTetapOutlet";

const BIAYA_TETAP_HEADERS_ = [
  "id",
  "cabangId",
  "sewaPerTahun",
  "internetPerBulan",
  "perawatanPerBulan",
  "gajiRowsJson",
  "depresiasiRowsJson",
  "operasionalLainRowsJson",
  "createdAt",
  "updatedAt"
];

// ============================================================================
// SECTION: PUBLIC FUNCTIONS
// ============================================================================

// [2026-07-13] 4 fungsi publik di bawah ini dibungkus withTenant_ (Code.gs) -
// argumen pertama SELALU sessionToken, badan logic asli dipindah ke nama
// "_impl_". Pemanggilan silang antar fungsi publik di file ini (mis.
// getBiayaTetapCabang_ -> getCabang) diarahkan ke versi "_impl_" krn sudah
// berjalan DI DALAM withTenant_ yang sama (tidak punya/butuh sessionToken lagi).
function listBiayaTetapOutletSummaries(sessionToken) {
  return withTenant_(sessionToken, function () { return listBiayaTetapOutletSummaries_impl_(); });
}

/**
 * Mengambil daftar outlet beserta rangkuman fixed cost.
 * Dipakai untuk menampilkan total biaya tetap langsung di halaman depan
 * tanpa membuka form input satu per satu.
 */
function listBiayaTetapOutletSummaries_impl_() {
  try {
    if (typeof listCabang_impl_ !== "function") {
      return {
        ok: false,
        error: "Fungsi listCabang belum tersedia.",
        stage: "listBiayaTetapOutletSummaries:listCabang_missing"
      };
    }

    const cabangRes = listCabang_impl_();
    if (!cabangRes || !cabangRes.ok) {
      return {
        ok: false,
        error: cabangRes && cabangRes.error ? cabangRes.error : "Gagal membaca daftar cabang.",
        stage: cabangRes && cabangRes.stage ? cabangRes.stage : "listBiayaTetapOutletSummaries:listCabang"
      };
    }

    const cabangRows = Array.isArray(cabangRes.data) ? cabangRes.data : [];
    const sheet = getBiayaTetapSheet_();
    const recordMap = getBiayaTetapRecordMapByCabangId_(sheet);

    const rows = cabangRows.map(function (item) {
      const cabangId = item && item.id ? String(item.id) : "";
      const cabang = getBiayaTetapCabang_(cabangId);
      const safeCabang = cabang && cabang.id ? cabang : {
        id: cabangId,
        namaLaundry: item && item.namaLaundry ? String(item.namaLaundry) : "",
        mesinCuci: [],
        mesinPengering: [],
        mesinSetrika: []
      };

      let record;
      let hasData = false;

      if (recordMap[cabangId]) {
        record = normalizeBiayaTetapRecord_(recordMap[cabangId], cabangId, safeCabang);
        hasData = true;
      } else {
        record = defaultBiayaTetapRecord_(cabangId, safeCabang);
      }

      record.depresiasiRows = syncDepresiasiRowsWithProfil_(record.depresiasiRows, safeCabang);

      return {
        cabang: {
          id: safeCabang.id || cabangId,
          namaLaundry: safeCabang.namaLaundry || ""
        },
        hasData: hasData,
        updatedAt: record.updatedAt || null,
        summary: computeBiayaTetapSummary_(record),
        warnings: validateBiayaTetapWarnings_(record, safeCabang)
      };
    });

    return {
      ok: true,
      data: rows
    };
  } catch (err) {
    return biayaTetapErrorResponse_(err, "listBiayaTetapOutletSummaries");
  }
}

function getBiayaTetapOutlet(sessionToken, cabangId) {
  return withTenant_(sessionToken, function () { return getBiayaTetapOutlet_impl_(cabangId); });
}

function getBiayaTetapOutlet_impl_(cabangId) {
  try {
    if (!cabangId || typeof cabangId !== "string") {
      return {
        ok: false,
        error: "ID cabang tidak valid.",
        stage: "getBiayaTetapOutlet:validate_cabang_id"
      };
    }

    const cabang = getBiayaTetapCabang_(cabangId);
    if (!cabang || !cabang.id) {
      return {
        ok: false,
        error: "Cabang tidak ditemukan. Silakan cek menu Cabang & Lokasi.",
        stage: "getBiayaTetapOutlet:lookup_cabang"
      };
    }

    const sheet = getBiayaTetapSheet_();
    const rowIndex = findBiayaTetapRowFast_(sheet, cabangId);

    let record;
    if (rowIndex > 0) {
      const values = sheet.getRange(rowIndex, 1, 1, BIAYA_TETAP_HEADERS_.length).getValues()[0];
      record = normalizeBiayaTetapRecord_(rowArrayToBiayaTetapObject_(values), cabangId, cabang);
    } else {
      record = defaultBiayaTetapRecord_(cabangId, cabang);
    }

    record.depresiasiRows = syncDepresiasiRowsWithProfil_(record.depresiasiRows, cabang);

    return {
      ok: true,
      data: {
        cabang: {
          id: cabang.id,
          namaLaundry: cabang.namaLaundry || "",
          mesinCuci: cabang.mesinCuci || [],
          mesinPengering: cabang.mesinPengering || [],
          mesinSetrika: cabang.mesinSetrika || []
        },
        record: record,
        summary: computeBiayaTetapSummary_(record),
        warnings: validateBiayaTetapWarnings_(record, cabang)
      }
    };
  } catch (err) {
    return biayaTetapErrorResponse_(err, "getBiayaTetapOutlet");
  }
}

function saveBiayaTetapOutlet(sessionToken, cabangId, payload) {
  return withTenant_(sessionToken, function () { return saveBiayaTetapOutlet_impl_(cabangId, payload); });
}

function saveBiayaTetapOutlet_impl_(cabangId, payload) {
  try {
    if (!cabangId || typeof cabangId !== "string") {
      return {
        ok: false,
        error: "ID cabang tidak valid.",
        stage: "saveBiayaTetapOutlet:validate_cabang_id"
      };
    }

    if (!payload || typeof payload !== "object") {
      return {
        ok: false,
        error: "Data biaya tetap tidak valid.",
        stage: "saveBiayaTetapOutlet:validate_payload"
      };
    }

    const cabang = getBiayaTetapCabang_(cabangId);
    if (!cabang || !cabang.id) {
      return {
        ok: false,
        error: "Cabang tidak ditemukan. Silakan cek menu Cabang & Lokasi.",
        stage: "saveBiayaTetapOutlet:lookup_cabang"
      };
    }

    // [2026-07-13] Sheet ini TIDAK lewat Util_Penyimpanan.gs, jadi
    // baca-cek-tulisnya dikunci manual (sama alasannya dgn saveBiayaNotaKasir).
    const tetapResult = _withDataLock_(function () {
      const sheet = getBiayaTetapSheet_();
      const rowIndex = findBiayaTetapRowFast_(sheet, cabangId);

      let existingRecord = null;
      if (rowIndex > 0) {
        const existingValues = sheet.getRange(rowIndex, 1, 1, BIAYA_TETAP_HEADERS_.length).getValues()[0];
        existingRecord = normalizeBiayaTetapRecord_(rowArrayToBiayaTetapObject_(existingValues), cabangId, cabang);
      }

      const normalized = normalizeBiayaTetapRecord_(payload, cabangId, cabang);
      normalized.depresiasiRows = syncDepresiasiRowsWithProfil_(normalized.depresiasiRows, cabang);

      const validation = validateBiayaTetapRecord_(normalized);
      if (!validation.valid) {
        return {
          ok: false,
          error: validation.message,
          stage: "saveBiayaTetapOutlet:validate_business_rules"
        };
      }

      const now = new Date().toISOString();
      normalized.id = existingRecord && existingRecord.id ? existingRecord.id : (normalized.id || biayaTetapNewId_("fc"));
      normalized.createdAt = existingRecord && existingRecord.createdAt ? existingRecord.createdAt : now;
      normalized.updatedAt = now;

      const row = buildBiayaTetapRow_(normalized);

      if (rowIndex > 0) {
        sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
      } else {
        sheet.appendRow(row);
      }

      return {
        ok: true,
        data: {
          cabang: {
            id: cabang.id,
            namaLaundry: cabang.namaLaundry || "",
            mesinCuci: cabang.mesinCuci || [],
            mesinPengering: cabang.mesinPengering || []
          },
          record: normalized,
          summary: computeBiayaTetapSummary_(normalized),
          warnings: validateBiayaTetapWarnings_(normalized, cabang)
        }
      };
    });
    // best-effort DI LUAR lock (supaya HTTP Firestore tidak menahan kunci global)
    if (tetapResult && tetapResult.ok) {
      firestoreSyncConfigDoc_(cabangId, "tetapOutlet", tetapResult.data.record);
      refreshFirestoreForCabang_(cabangId);
    }
    return tetapResult;
  } catch (err) {
    return biayaTetapErrorResponse_(err, "saveBiayaTetapOutlet");
  }
}

function deleteBiayaTetapOutlet(sessionToken, cabangId) {
  return withTenant_(sessionToken, function () { return deleteBiayaTetapOutlet_impl_(cabangId); });
}

function deleteBiayaTetapOutlet_impl_(cabangId) {
  try {
    if (!cabangId || typeof cabangId !== "string") {
      return {
        ok: false,
        error: "ID cabang tidak valid.",
        stage: "deleteBiayaTetapOutlet:validate_cabang_id"
      };
    }

    return _withDataLock_(function () {
      const sheet = getBiayaTetapSheet_();
      const rowIndex = findBiayaTetapRowFast_(sheet, cabangId);

      if (rowIndex > 0) {
        sheet.deleteRow(rowIndex);
      }

      return {
        ok: true,
        data: {
          deleted: rowIndex > 0,
          cabangId: cabangId
        }
      };
    });
  } catch (err) {
    return biayaTetapErrorResponse_(err, "deleteBiayaTetapOutlet");
  }
}

// ============================================================================
// SECTION: DEFAULT / NORMALIZE
// ============================================================================

function defaultBiayaTetapRecord_(cabangId, cabang) {
  return {
    id: "",
    cabangId: cabangId || "",
    sewaPerTahun: 0,
    internetPerBulan: 0,
    perawatanPerBulan: 50000,
    gajiRows: [],
    depresiasiRows: buildDefaultDepresiasiRows_(cabang),
    operasionalLainRows: [],
    createdAt: null,
    updatedAt: null
  };
}

function normalizeBiayaTetapRecord_(input, cabangId, cabang) {
  const base = defaultBiayaTetapRecord_(cabangId, cabang);
  const out = {};

  out.id = biayaTetapString_(pickBiayaTetapValue_(input, "id", base.id));
  out.cabangId = cabangId || biayaTetapString_(pickBiayaTetapValue_(input, "cabangId", base.cabangId));
  out.sewaPerTahun = biayaTetapClamp_(pickBiayaTetapValue_(input, "sewaPerTahun", base.sewaPerTahun), 0, 100000000000);
  out.internetPerBulan = biayaTetapClamp_(pickBiayaTetapValue_(input, "internetPerBulan", base.internetPerBulan), 0, 100000000000);
  out.perawatanPerBulan = biayaTetapClamp_(pickBiayaTetapValue_(input, "perawatanPerBulan", base.perawatanPerBulan), 0, 100000000000);

  out.gajiRows = normalizeBiayaTetapGajiRows_(
    pickBiayaTetapJsonOrValue_(input, "gajiRows", "gajiRowsJson", base.gajiRows)
  );

  out.depresiasiRows = normalizeBiayaTetapDepresiasiRows_(
    pickBiayaTetapJsonOrValue_(input, "depresiasiRows", "depresiasiRowsJson", base.depresiasiRows)
  );

  out.operasionalLainRows = normalizeBiayaTetapOtherRows_(
    pickBiayaTetapJsonOrValue_(input, "operasionalLainRows", "operasionalLainRowsJson", base.operasionalLainRows)
  );

  out.createdAt = pickBiayaTetapValue_(input, "createdAt", base.createdAt);
  out.updatedAt = pickBiayaTetapValue_(input, "updatedAt", base.updatedAt);

  return out;
}

function normalizeBiayaTetapGajiRows_(rows) {
  rows = Array.isArray(rows) ? rows : [];
  return rows.map(function (row, index) {
    row = row || {};
    return {
      id: biayaTetapString_(row.id) || biayaTetapNewId_("gaji"),
      nama: biayaTetapString_(row.nama) || "Karyawan " + (index + 1),
      jabatan: biayaTetapString_(row.jabatan),
      gajiPerBulan: biayaTetapClamp_(row.gajiPerBulan, 0, 100000000000)
    };
  });
}

function normalizeBiayaTetapDepresiasiRows_(rows) {
  rows = Array.isArray(rows) ? rows : [];
  return rows.map(function (row) {
    row = row || {};
    return {
      key: biayaTetapString_(row.key) || biayaTetapNewId_("mesin"),
      group: biayaTetapString_(row.group),
      machineRefId: biayaTetapString_(row.machineRefId),
      namaMesin: biayaTetapString_(row.namaMesin),
      jenisMesin: biayaTetapString_(row.jenisMesin),
      jumlahUnit: biayaTetapClamp_(row.jumlahUnit, 0, 1000000),
      hargaBeliPerUnit: biayaTetapClamp_(row.hargaBeliPerUnit, 0, 100000000000),
      nilaiResiduPerUnit: biayaTetapClamp_(row.nilaiResiduPerUnit, 0, 100000000000),
      masaAusTahun: biayaTetapClamp_(row.masaAusTahun, 0, 1000),
      isFromProfil: row.isFromProfil === false ? false : true
    };
  });
}

function normalizeBiayaTetapOtherRows_(rows) {
  rows = Array.isArray(rows) ? rows : [];
  return rows.map(function (row, index) {
    row = row || {};
    return {
      id: biayaTetapString_(row.id) || biayaTetapNewId_("lain"),
      nama: biayaTetapString_(row.nama) || "Biaya lain " + (index + 1),
      nominalPerBulan: biayaTetapClamp_(row.nominalPerBulan, 0, 100000000000),
      catatan: biayaTetapString_(row.catatan)
    };
  });
}

// ============================================================================
// SECTION: DEPRESIASI DARI PROFIL OPERASIONAL
// ============================================================================

function buildDefaultDepresiasiRows_(cabang) {
  const rows = [];
  cabang = cabang || {};
  appendDepresiasiRowsFromMachines_(rows, cabang.mesinCuci || [], "washer");
  appendDepresiasiRowsFromMachines_(rows, cabang.mesinPengering || [], "dryer");
  // [2026-07-13] Mesin setrika (kategori Jasa Setrika tidak punya mesinCuci/
  // mesinPengering sama sekali) - dulu tidak pernah disertakan di sini, jadi
  // depresiasinya tidak pernah bisa dihitung/tampil untuk kategori ini.
  appendDepresiasiRowsFromMachines_(rows, cabang.mesinSetrika || [], "setrika");
  return rows;
}

function syncDepresiasiRowsWithProfil_(existingRows, cabang) {
  existingRows = normalizeBiayaTetapDepresiasiRows_(existingRows);
  const existingMap = {};

  existingRows.forEach(function (row) {
    if (row.key) existingMap[row.key] = row;
  });

  const freshRows = buildDefaultDepresiasiRows_(cabang);

  return freshRows.map(function (fresh) {
    const old = existingMap[fresh.key];
    if (!old) return fresh;

    return {
      key: fresh.key,
      group: fresh.group,
      machineRefId: fresh.machineRefId,
      namaMesin: fresh.namaMesin,
      jenisMesin: fresh.jenisMesin,
      jumlahUnit: fresh.jumlahUnit,
      hargaBeliPerUnit: old.hargaBeliPerUnit || 0,
      nilaiResiduPerUnit: old.nilaiResiduPerUnit || 0,
      masaAusTahun: old.masaAusTahun || 0,
      isFromProfil: true
    };
  });
}

function appendDepresiasiRowsFromMachines_(rows, machines, group) {
  if (!Array.isArray(machines)) return;

  machines.forEach(function (m, index) {
    m = m || {};
    const machineId = biayaTetapString_(m.id) || (group + "_" + index);
    const key = group + ":" + machineId;
    const jenis = normalizeJenisMesinTetap_(m.jenis, group);
    const durasi = biayaTetapNumber_(m.durasiMenit, 0);
    const kapasitasKgPerJam = biayaTetapNumber_(m.kapasitasKgPerJam, 0);
    const jumlahUnit = biayaTetapClamp_(m.jumlahUnit, 0, 1000000);

    rows.push({
      key: key,
      group: group,
      machineRefId: machineId,
      namaMesin: buildNamaMesinTetap_(group, jenis, durasi, index, kapasitasKgPerJam),
      jenisMesin: jenis,
      jumlahUnit: jumlahUnit,
      hargaBeliPerUnit: 0,
      nilaiResiduPerUnit: 0,
      masaAusTahun: 0,
      isFromProfil: true
    });
  });
}

// [2026-07-13] group "setrika" ditambah - mesin setrika tidak punya
// durasiMenit (bukan basis per-load), pakai kapasitasKgPerJam sbg info di
// nama baris.
function buildNamaMesinTetap_(group, jenis, durasiMenit, index, kapasitasKgPerJam) {
  if (group === "setrika") {
    const kapasitasText = kapasitasKgPerJam > 0 ? " · " + kapasitasKgPerJam + " kg/jam" : "";
    return "Setrika " + (index + 1) + " · " + jenis + kapasitasText;
  }
  const prefix = group === "dryer" ? "Dryer" : "Washer";
  const durasiText = durasiMenit > 0 ? " · " + durasiMenit + " menit" : "";
  return prefix + " " + (index + 1) + " · " + jenis + durasiText;
}

function normalizeJenisMesinTetap_(jenis, group) {
  const v = biayaTetapString_(jenis).toLowerCase();

  if (group === "setrika") {
    if (v === "listrik") return "Listrik";
    if (v === "uap") return "Uap";
    return v ? titleCaseBiayaTetap_(v) : "Setrika";
  }

  if (group === "dryer") {
    if (v === "konversi" || v === "conversion") return "Konversi";
    if (v === "komersial" || v === "commercial") return "Commercial";
    return v ? titleCaseBiayaTetap_(v) : "Dryer";
  }

  if (v === "rumah_tangga" || v === "home" || v === "home_use") return "Home";
  if (v === "komersial" || v === "commercial") return "Commercial";
  return v ? titleCaseBiayaTetap_(v.replace(/_/g, " ")) : "Washer";
}

// ============================================================================
// SECTION: CALCULATION
// ============================================================================

function computeBiayaTetapSummary_(record) {
  record = record || defaultBiayaTetapRecord_("");

  const sewaPerBulan = biayaTetapRound2_(biayaTetapNumber_(record.sewaPerTahun, 0) / 12);

  const totalGaji = sumBiayaTetap_(record.gajiRows, "gajiPerBulan");
  const totalInternet = biayaTetapRound2_(record.internetPerBulan);
  const totalDepresiasi = computeTotalDepresiasiBulanan_(record.depresiasiRows);
  const totalPerawatan = biayaTetapRound2_(record.perawatanPerBulan);
  const totalLainnya = sumBiayaTetap_(record.operasionalLainRows, "nominalPerBulan");

  const components = [
    { key: "sewa", label: "Sewa Outlet", amount: sewaPerBulan },
    { key: "gaji", label: "Gaji Karyawan", amount: totalGaji },
    { key: "internet", label: "Internet", amount: totalInternet },
    { key: "depresiasi", label: "Penyusutan Mesin", amount: totalDepresiasi },
    { key: "perawatan", label: "Biaya Perawatan", amount: totalPerawatan },
    { key: "lainnya", label: "Operasional Lainnya", amount: totalLainnya }
  ];

  const totalPerBulan = biayaTetapRound2_(components.reduce(function (sum, item) {
    return sum + biayaTetapNumber_(item.amount, 0);
  }, 0));

  applyBiayaTetapPercentages_(components, totalPerBulan);

  return {
    sewaPerBulan: sewaPerBulan,
    totalGajiPerBulan: totalGaji,
    totalInternetPerBulan: totalInternet,
    totalDepresiasiPerBulan: totalDepresiasi,
    totalPerawatanPerBulan: totalPerawatan,
    totalOperasionalLainPerBulan: totalLainnya,
    totalPerBulan: totalPerBulan,
    totalPerHari: biayaTetapRound2_(totalPerBulan / 30),
    components: components,
    depresiasiRows: computeDepresiasiRowsSummary_(record.depresiasiRows)
  };
}

function computeTotalDepresiasiBulanan_(rows) {
  return biayaTetapRound2_(computeDepresiasiRowsSummary_(rows).reduce(function (sum, row) {
    return sum + biayaTetapNumber_(row.depresiasiPerBulanTotal, 0);
  }, 0));
}

function computeDepresiasiRowsSummary_(rows) {
  rows = Array.isArray(rows) ? rows : [];

  return rows.map(function (row) {
    row = row || {};
    const jumlahUnit = biayaTetapNumber_(row.jumlahUnit, 0);
    const hargaBeli = biayaTetapNumber_(row.hargaBeliPerUnit, 0);
    const residu = biayaTetapNumber_(row.nilaiResiduPerUnit, 0);
    const masaTahun = biayaTetapNumber_(row.masaAusTahun, 0);

    // Rumus depresiasi per bulan per unit:
    // (Harga beli - nilai residu) / masa aus tahun / 12 bulan.
    const depresiasiPerUnit = masaTahun > 0
      ? biayaTetapRound2_(Math.max(0, hargaBeli - residu) / masaTahun / 12)
      : 0;

    return {
      key: row.key || "",
      group: row.group || "",
      machineRefId: row.machineRefId || "",
      namaMesin: row.namaMesin || "Mesin",
      jenisMesin: row.jenisMesin || "-",
      jumlahUnit: jumlahUnit,
      hargaBeliPerUnit: hargaBeli,
      nilaiResiduPerUnit: residu,
      masaAusTahun: masaTahun,
      depresiasiPerBulanPerUnit: depresiasiPerUnit,
      depresiasiPerBulanTotal: biayaTetapRound2_(depresiasiPerUnit * jumlahUnit)
    };
  });
}

function applyBiayaTetapPercentages_(components, total) {
  if (!Array.isArray(components) || !components.length) return components;

  if (total <= 0) {
    components.forEach(function (item) { item.percent = 0; });
    return components;
  }

  let sumPercent = 0;
  let lastPositiveIndex = -1;

  components.forEach(function (item, index) {
    const amount = biayaTetapNumber_(item.amount, 0);
    item.percent = amount > 0 ? biayaTetapRound2_((amount / total) * 100) : 0;
    sumPercent += item.percent;
    if (amount > 0) lastPositiveIndex = index;
  });

  if (lastPositiveIndex >= 0) {
    const diff = biayaTetapRound2_(100 - sumPercent);
    components[lastPositiveIndex].percent = biayaTetapRound2_(components[lastPositiveIndex].percent + diff);
  }

  return components;
}

// ============================================================================
// SECTION: VALIDATION / WARNINGS
// ============================================================================

function validateBiayaTetapRecord_(record) {
  if (!record || typeof record !== "object") {
    return { valid: false, message: "Data biaya tetap tidak valid." };
  }

  if (!record.cabangId) {
    return { valid: false, message: "Cabang belum ditentukan." };
  }

  return { valid: true, message: "" };
}

function validateBiayaTetapWarnings_(record, cabang) {
  const warnings = [];

  if (!record.sewaPerTahun) warnings.push("Sewa outlet per tahun belum diisi.");
  if (!record.gajiRows || !record.gajiRows.length) warnings.push("Data gaji karyawan belum diisi.");
  if (!record.internetPerBulan) warnings.push("Biaya internet per bulan belum diisi.");
  if (!record.perawatanPerBulan) warnings.push("Biaya perawatan masih Rp0. Untuk awal buka bisa isi contoh Rp50.000/bulan.");

  const mesinCuci = cabang && Array.isArray(cabang.mesinCuci) ? cabang.mesinCuci : [];
  const mesinPengering = cabang && Array.isArray(cabang.mesinPengering) ? cabang.mesinPengering : [];
  const mesinSetrika = cabang && Array.isArray(cabang.mesinSetrika) ? cabang.mesinSetrika : [];
  if (!mesinCuci.length && !mesinPengering.length && !mesinSetrika.length) warnings.push("Data mesin di Profil Operasional belum tersedia, sehingga depresiasi mesin belum bisa dihitung lengkap.");

  const depresiasiRows = Array.isArray(record.depresiasiRows) ? record.depresiasiRows : [];
  const incompleteDep = depresiasiRows.some(function (row) {
    return biayaTetapNumber_(row.hargaBeliPerUnit, 0) <= 0 || biayaTetapNumber_(row.masaAusTahun, 0) <= 0;
  });
  if (depresiasiRows.length && incompleteDep) warnings.push("Sebagian data penyusutan mesin belum lengkap. Isi harga beli, nilai residu, dan masa aus untuk hasil depresiasi yang akurat.");

  return uniqueBiayaTetapArray_(warnings);
}

// ============================================================================
// SECTION: SHEET STORAGE
// ============================================================================

function getBiayaTetapSheet_() {
  // [2026-07-13] MULTI-TENANT: lihat komentar sama di getBiayaNotaKasirSheet_
  // (Modul_BiayaNotaKasir.gs).
  const ss = _activeDataSpreadsheet_ || SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error("Spreadsheet aktif tidak ditemukan.");

  let sheet = ss.getSheetByName(BIAYA_TETAP_SHEET_NAME_);
  if (!sheet) {
    sheet = ss.insertSheet(BIAYA_TETAP_SHEET_NAME_);
    sheet.getRange(1, 1, 1, BIAYA_TETAP_HEADERS_.length).setValues([BIAYA_TETAP_HEADERS_]);
    rapikanTampilanSheetAktif_(sheet);
  } else {
    ensureBiayaTetapHeaders_(sheet);
  }

  return sheet;
}

function ensureBiayaTetapHeaders_(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), BIAYA_TETAP_HEADERS_.length);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, BIAYA_TETAP_HEADERS_.length).setValues([BIAYA_TETAP_HEADERS_]);
    sheet.setFrozenRows(1);
    return;
  }

  const currentHeaders = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  let shouldRewrite = false;

  for (let i = 0; i < BIAYA_TETAP_HEADERS_.length; i++) {
    if (currentHeaders[i] !== BIAYA_TETAP_HEADERS_[i]) {
      shouldRewrite = true;
      break;
    }
  }

  if (shouldRewrite) {
    sheet.getRange(1, 1, 1, BIAYA_TETAP_HEADERS_.length).setValues([BIAYA_TETAP_HEADERS_]);
    sheet.setFrozenRows(1);
  }
}

function findBiayaTetapRowFast_(sheet, cabangId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;

  const values = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  const target = String(cabangId || "");

  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0] || "") === target) return i + 2;
  }

  return -1;
}

function getBiayaTetapRecordMapByCabangId_(sheet) {
  const map = {};
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return map;

  const values = sheet.getRange(2, 1, lastRow - 1, BIAYA_TETAP_HEADERS_.length).getValues();
  for (let i = 0; i < values.length; i++) {
    const obj = rowArrayToBiayaTetapObject_(values[i]);
    const cabangId = obj && obj.cabangId ? String(obj.cabangId) : "";
    if (cabangId) map[cabangId] = obj;
  }
  return map;
}

function rowArrayToBiayaTetapObject_(values) {
  const obj = {};
  for (let i = 0; i < BIAYA_TETAP_HEADERS_.length; i++) {
    obj[BIAYA_TETAP_HEADERS_[i]] = values[i];
  }
  return obj;
}

function buildBiayaTetapRow_(record) {
  return [
    record.id,
    record.cabangId,
    record.sewaPerTahun,
    record.internetPerBulan,
    record.perawatanPerBulan,
    JSON.stringify(record.gajiRows || []),
    JSON.stringify(record.depresiasiRows || []),
    JSON.stringify(record.operasionalLainRows || []),
    record.createdAt,
    record.updatedAt
  ];
}

// ============================================================================
// SECTION: CABANG / PROFIL OPERASIONAL
// ============================================================================

function getBiayaTetapCabang_(cabangId) {
  try {
    if (typeof getCabang_impl_ === "function") {
      const res = getCabang_impl_(cabangId);
      if (res && res.ok && res.data && res.data.cabang) {
        return normalizeCabangForBiayaTetap_(res.data.cabang, cabangId);
      }
    }

    return {
      id: cabangId,
      namaLaundry: "",
      mesinCuci: [],
      mesinPengering: [],
      mesinSetrika: []
    };
  } catch (err) {
    console.warn("[BiayaTetapOutlet] Gagal membaca cabang:", err);
    return {
      id: cabangId,
      namaLaundry: "",
      mesinCuci: [],
      mesinPengering: [],
      mesinSetrika: []
    };
  }
}

function normalizeCabangForBiayaTetap_(cabang, cabangId) {
  cabang = cabang || {};
  const profil = cabang.profil || {};

  return {
    id: cabang.id || cabangId,
    namaLaundry: profil.namaLaundry ? String(profil.namaLaundry) : "",
    mesinCuci: Array.isArray(cabang.mesinCuci) ? cabang.mesinCuci : [],
    mesinPengering: Array.isArray(cabang.mesinPengering) ? cabang.mesinPengering : [],
    mesinSetrika: Array.isArray(cabang.mesinSetrika) ? cabang.mesinSetrika : []
  };
}

// ============================================================================
// SECTION: LOCAL HELPERS
// ============================================================================

function pickBiayaTetapValue_(input, key, fallback) {
  if (!input || typeof input !== "object") return fallback;
  if (input[key] === undefined || input[key] === null || input[key] === "") return fallback;
  return input[key];
}

function pickBiayaTetapJsonOrValue_(input, valueKey, jsonKey, fallback) {
  if (!input || typeof input !== "object") return fallback;

  if (Array.isArray(input[valueKey])) return input[valueKey];

  const raw = input[jsonKey];
  if (raw === undefined || raw === null || raw === "") return fallback;

  if (Array.isArray(raw)) return raw;

  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed : fallback;
  } catch (err) {
    console.warn("[BiayaTetapOutlet] JSON parse gagal untuk " + jsonKey + ":", err);
    return fallback;
  }
}

function biayaTetapNumber_(value, fallback) {
  const fb = fallback || 0;
  if (value === null || value === undefined || value === "") return fb;

  if (typeof value === "number") return isFinite(value) ? value : fb;

  let text = String(value).trim();
  text = text.replace(/[^\d,.-]/g, "");

  if (text.indexOf(",") > -1 && text.indexOf(".") > -1) {
    text = text.replace(/\./g, "").replace(",", ".");
  } else if (text.indexOf(",") > -1) {
    text = text.replace(",", ".");
  }

  const num = Number(text);
  return isFinite(num) ? num : fb;
}

function biayaTetapClamp_(value, min, max) {
  const num = biayaTetapNumber_(value, 0);
  if (num < min) return min;
  if (num > max) return max;
  return num;
}

function biayaTetapRound2_(value) {
  const num = biayaTetapNumber_(value, 0);
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

function biayaTetapString_(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function biayaTetapNewId_(prefix) {
  return (prefix || "id") + "_" + new Date().getTime() + "_" + Math.random().toString(36).slice(2, 8);
}

function sumBiayaTetap_(rows, fieldName) {
  rows = Array.isArray(rows) ? rows : [];
  return biayaTetapRound2_(rows.reduce(function (sum, row) {
    return sum + biayaTetapNumber_(row && row[fieldName], 0);
  }, 0));
}

function uniqueBiayaTetapArray_(arr) {
  const out = [];
  const seen = {};
  arr = Array.isArray(arr) ? arr : [];

  arr.forEach(function (item) {
    const text = biayaTetapString_(item);
    if (!text || seen[text]) return;
    seen[text] = true;
    out.push(text);
  });

  return out;
}

function titleCaseBiayaTetap_(text) {
  text = biayaTetapString_(text);
  if (!text) return "";
  return text.split(" ").map(function (part) {
    return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
  }).join(" ");
}

function biayaTetapErrorResponse_(err, stage) {
  if (typeof errorResponse_ === "function") return errorResponse_(err, stage);

  return {
    ok: false,
    error: err && err.message ? err.message : String(err),
    stage: stage || "biayaTetapOutlet:unknown"
  };
}

// ============================================================================
// SECTION: TEST MANUAL
// ============================================================================

function testBiayaTetapOutlet() {
  const cabangId = "test-cabang";
  const result = getBiayaTetapOutlet_impl_(cabangId);
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
