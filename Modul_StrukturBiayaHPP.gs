/**
 * ============================================================================
 * MODUL: STRUKTUR BIAYA HPP
 * ============================================================================
 * Fitur ini menghitung struktur Harga Pokok Produksi Self Service Laundry
 * berdasarkan data master biaya yang sudah ada:
 *
 * - Modul_BiayaAir.gs
 * - Modul_BiayaListrik.gs
 * - Modul_BiayaGas.gs
 * - Modul_BiayaNotaKasir.gs
 * - Modul_Cabang.gs
 *
 * PENTING:
 * - Modul ini TIDAK membuat tabel baru.
 * - Modul ini hanya membaca data master biaya existing.
 * - Frontend cukup memanggil 1 fungsi: getStrukturBiayaHPP(cabangId)
 * - Logic kalkulasi dipisah agar bisa dipakai ulang oleh fitur Analisa Biaya HPP.
 *
 * PUBLIC FUNCTION:
 * - getStrukturBiayaHPP(cabangId)
 * ============================================================================
 */

// ============================================================================
// SECTION: KONSTANTA
// ============================================================================

const STRUKTUR_HPP_UNIT_LABEL_ = "per load";

const STRUKTUR_HPP_SERVICE_KEYS_ = {
  CUCI_SAJA: "cuci_saja",
  KERING_SAJA: "kering_saja",
  CUCI_KERING: "cuci_kering",
};

// ============================================================================
// SECTION: PUBLIC FUNCTION
// ============================================================================

function getStrukturBiayaHPP(cabangId) {
  try {
    if (!cabangId || typeof cabangId !== "string") {
      return {
        ok: false,
        error: "ID cabang tidak valid.",
        stage: "getStrukturBiayaHPP:validate_cabang_id",
      };
    }

    const sources = getStrukturHPPSourceData_(cabangId);

    if (!sources.ok) {
      return sources;
    }

    const normalized = normalizeStrukturHPPInput_(sources.data);
    const validation = validateStrukturHPPData_(normalized);

    const layanan = buildSelfServiceHPPStructure_(normalized);

    return {
      ok: true,
      data: {
        cabang: normalized.cabang,
        satuan: STRUKTUR_HPP_UNIT_LABEL_,
        sumberAir: normalized.air.sumberAir,
        layanan: layanan,
        warnings: validation.warnings,
        meta: {
          generatedAt: new Date().toISOString(),
          konsepUsaha: "Self Service Laundry",
          note: "Biaya App Kasir & Nota pada HPP Cuci Kering hanya dihitung satu kali.",
        },
      },
    };
  } catch (err) {
    return strukturHPPErrorResponse_(err, "getStrukturBiayaHPP");
  }
}

// ============================================================================
// SECTION: DATA SERVICE
// ============================================================================

function getStrukturHPPSourceData_(cabangId) {
  try {
    const warnings = [];

    const cabang = getStrukturHPPCabang_(cabangId);
    if (!cabang) {
      return {
        ok: false,
        error: "Cabang tidak ditemukan. Silakan cek data Cabang & Lokasi.",
        stage: "getStrukturHPPSourceData_:lookup_cabang",
      };
    }

    const airResult = safeCallStrukturHPP_("getBiayaAir", function () {
      if (typeof getBiayaAir !== "function") {
        return {
          ok: false,
          error: "Fungsi getBiayaAir belum tersedia.",
          stage: "getStrukturHPPSourceData_:getBiayaAir_missing",
        };
      }
      return getBiayaAir(cabangId);
    });

    const listrikResult = safeCallStrukturHPP_("getBiayaListrik", function () {
      if (typeof getBiayaListrik !== "function") {
        return {
          ok: false,
          error: "Fungsi getBiayaListrik belum tersedia.",
          stage: "getStrukturHPPSourceData_:getBiayaListrik_missing",
        };
      }
      return getBiayaListrik(cabangId);
    });

    const gasResult = safeCallStrukturHPP_("listBiayaGas", function () {
      if (typeof listBiayaGas !== "function") {
        return {
          ok: false,
          error: "Fungsi listBiayaGas belum tersedia.",
          stage: "getStrukturHPPSourceData_:listBiayaGas_missing",
        };
      }
      return listBiayaGas(cabangId);
    });

    const notaKasirResult = safeCallStrukturHPP_("getBiayaNotaKasir", function () {
      if (typeof getBiayaNotaKasir !== "function") {
        return {
          ok: false,
          error: "Fungsi getBiayaNotaKasir belum tersedia.",
          stage: "getStrukturHPPSourceData_:getBiayaNotaKasir_missing",
        };
      }
      return getBiayaNotaKasir(cabangId);
    });

    if (!airResult.ok) warnings.push("Data biaya air belum lengkap atau belum bisa dibaca.");
    if (!listrikResult.ok) warnings.push("Data biaya listrik belum lengkap atau belum bisa dibaca.");
    if (!gasResult.ok) warnings.push("Data biaya gas belum lengkap atau belum bisa dibaca.");
    if (!notaKasirResult.ok) warnings.push("Data biaya App Kasir & Nota belum lengkap atau belum bisa dibaca.");

    return {
      ok: true,
      data: {
        cabang: cabang,
        air: airResult.ok ? airResult.data : null,
        listrik: listrikResult.ok ? listrikResult.data : null,
        gas: gasResult.ok ? gasResult.data : null,
        notaKasir: notaKasirResult.ok ? notaKasirResult.data : null,
        sourceWarnings: warnings,
      },
    };
  } catch (err) {
    return strukturHPPErrorResponse_(err, "getStrukturHPPSourceData_");
  }
}

function getStrukturHPPCabang_(cabangId) {
  try {
    if (typeof getCabang === "function") {
      const res = getCabang(cabangId);
      if (res && res.ok && res.data && res.data.cabang) {
        const cabang = res.data.cabang;
        return {
          id: cabang.id || cabangId,
          namaLaundry: cabang.profil && cabang.profil.namaLaundry ? String(cabang.profil.namaLaundry) : "",
          mesinCuci: Array.isArray(cabang.mesinCuci) ? cabang.mesinCuci : [],
          mesinPengering: Array.isArray(cabang.mesinPengering) ? cabang.mesinPengering : [],
        };
      }
    }

    if (typeof ensureDataSheet_ === "function" && typeof readKey_ === "function" && typeof sanitizeCabang_ === "function") {
      const sheet = ensureDataSheet_();
      const raw = readKey_(sheet, "cabang_" + cabangId);

      if (raw) {
        const cabang = sanitizeCabang_(JSON.parse(raw));
        return {
          id: cabang.id || cabangId,
          namaLaundry: cabang.profil && cabang.profil.namaLaundry ? String(cabang.profil.namaLaundry) : "",
          mesinCuci: Array.isArray(cabang.mesinCuci) ? cabang.mesinCuci : [],
          mesinPengering: Array.isArray(cabang.mesinPengering) ? cabang.mesinPengering : [],
        };
      }
    }

    return {
      id: cabangId,
      namaLaundry: "",
      mesinCuci: [],
      mesinPengering: [],
    };
  } catch (err) {
    console.warn("[StrukturHPP] Gagal membaca cabang:", err);
    return {
      id: cabangId,
      namaLaundry: "",
      mesinCuci: [],
      mesinPengering: [],
    };
  }
}

// ============================================================================
// SECTION: NORMALIZE
// ============================================================================

function normalizeStrukturHPPInput_(sources) {
  const cabang = sources.cabang || {
    id: "",
    namaLaundry: "",
    mesinCuci: [],
    mesinPengering: [],
  };

  const airRecord = sources.air && sources.air.record ? sources.air.record : {};
  const airSummary = sources.air && sources.air.summary ? sources.air.summary : {};

  const listrikSummary = sources.listrik && sources.listrik.summary ? sources.listrik.summary : {};
  const gasItems = sources.gas && Array.isArray(sources.gas.items) ? sources.gas.items : [];

  const notaKasirSummary =
    sources.notaKasir && sources.notaKasir.summary
      ? sources.notaKasir.summary
      : sources.notaKasir && sources.notaKasir.data && sources.notaKasir.data.summary
        ? sources.notaKasir.data.summary
        : {};

  const sumberAir = strukturHPPString_(airRecord.sumberAir || airSummary.sumberAir || "pdam").toLowerCase();

  let airPerLoad = strukturHPPNumber_(
    firstDefinedStrukturHPP_([
      airSummary.biayaPerLoad,
      airSummary.airPerLoad,
      airSummary.totalBiayaAirPerLoad,
      airRecord.biayaPerLoad,
    ]),
    0
  );

  // Aturan khusus: sumber air sumur membuat komponen air = Rp0.
  // Beban operasional sumur tetap ditangkap lewat listrik pompa.
  if (sumberAir === "sumur") {
    airPerLoad = 0;
  }

  const listrikCuci = Array.isArray(listrikSummary.cuci) ? listrikSummary.cuci : [];
  const listrikPengering = Array.isArray(listrikSummary.pengering) ? listrikSummary.pengering : [];

  const listrikWasherPerLoad = getWeightedMachineCost_(listrikCuci, "rpListrikPerLoad");
  const listrikPompaPerLoad = getWeightedMachineCost_(listrikCuci, "rpPompaPerLoad");
  const listrikDryerPerLoad = getWeightedMachineCost_(listrikPengering, "rpListrikPerLoad");

  const gasPerLoad = getWeightedGasCost_(gasItems, cabang.mesinPengering);

  const notaKasirPerLoad = strukturHPPNumber_(
    firstDefinedStrukturHPP_([
      notaKasirSummary.totalBiayaNotaKasirPerLoad,
      notaKasirSummary.biayaNotaKasirPerLoad,
      notaKasirSummary.biayaNotaPerLoad,
    ]),
    0
  );

  return {
    cabang: {
      id: cabang.id || "",
      namaLaundry: cabang.namaLaundry || "",
      mesinCuci: Array.isArray(cabang.mesinCuci) ? cabang.mesinCuci : [],
      mesinPengering: Array.isArray(cabang.mesinPengering) ? cabang.mesinPengering : [],
    },
    air: {
      sumberAir: sumberAir,
      biayaPerLoad: strukturHPPRound2_(airPerLoad),
    },
    listrik: {
      washerPerLoad: strukturHPPRound2_(listrikWasherPerLoad),
      pompaPerLoad: strukturHPPRound2_(listrikPompaPerLoad),
      dryerPerLoad: strukturHPPRound2_(listrikDryerPerLoad),
    },
    gas: {
      biayaPerLoad: strukturHPPRound2_(gasPerLoad),
    },
    notaKasir: {
      biayaPerLoad: strukturHPPRound2_(notaKasirPerLoad),
    },
    sourceWarnings: Array.isArray(sources.sourceWarnings) ? sources.sourceWarnings : [],
  };
}

function validateStrukturHPPData_(normalized) {
  const warnings = [];

  if (!normalized.cabang || !normalized.cabang.id) {
    warnings.push("Cabang belum terbaca dengan benar.");
  }

  if (!normalized.cabang.namaLaundry) {
    warnings.push("Nama laundry belum diisi di profil cabang.");
  }

  if (normalized.air.sumberAir === "sumur") {
    warnings.push("Sumber air sumur: komponen Air per load otomatis Rp0. Biaya yang tetap dihitung adalah listrik pompa.");
  }

  if (normalized.air.sumberAir !== "sumur" && normalized.air.biayaPerLoad <= 0) {
    warnings.push("Biaya air per load masih Rp0. Cek data biaya air di Master Biaya.");
  }

  if (normalized.listrik.washerPerLoad <= 0) {
    warnings.push("Listrik Washer per load masih Rp0. Cek watt mesin cuci, TDL, dan durasi mesin cuci.");
  }

  if (normalized.listrik.pompaPerLoad <= 0) {
    warnings.push("Listrik Pompa per load masih Rp0. Jika memakai pompa, cek watt pompa dan jumlah mesin cuci.");
  }

  if (normalized.listrik.dryerPerLoad <= 0) {
    warnings.push("Listrik Dryer per load masih Rp0. Cek watt dryer, TDL, dan durasi mesin pengering.");
  }

  if (normalized.gas.biayaPerLoad <= 0) {
    warnings.push("Gas LPG per load masih Rp0. Cek data gas dan mesin pengering acuan.");
  }

  if (normalized.notaKasir.biayaPerLoad <= 0) {
    warnings.push("Biaya App Kasir & Nota masih Rp0. Cek modul biaya nota/kasir.");
  }

  if (normalized.sourceWarnings && normalized.sourceWarnings.length) {
    for (let i = 0; i < normalized.sourceWarnings.length; i++) {
      warnings.push(normalized.sourceWarnings[i]);
    }
  }

  return {
    valid: true,
    warnings: uniqueStrukturHPPArray_(warnings),
  };
}

// ============================================================================
// SECTION: CALCULATION ENGINE
// ============================================================================

function buildSelfServiceHPPStructure_(normalized) {
  const appNota = normalized.notaKasir.biayaPerLoad;

  const cuciSaja = calculateHPPService_(
    STRUKTUR_HPP_SERVICE_KEYS_.CUCI_SAJA,
    "HPP Cuci Saja",
    [
      {
        key: "air",
        label: "Air per load",
        amount: normalized.air.biayaPerLoad,
        note: normalized.air.sumberAir === "sumur" ? "Sumber air sumur: biaya air otomatis Rp0." : "",
      },
      {
        key: "listrik_washer",
        label: "Listrik Washer per load",
        amount: normalized.listrik.washerPerLoad,
        note: "",
      },
      {
        key: "listrik_pompa",
        label: "Listrik Pompa per load",
        amount: normalized.listrik.pompaPerLoad,
        note: "",
      },
      {
        key: "app_nota",
        label: "Biaya App Kasir & Nota",
        amount: appNota,
        note: "",
      },
    ]
  );

  const keringSaja = calculateHPPService_(
    STRUKTUR_HPP_SERVICE_KEYS_.KERING_SAJA,
    "HPP Kering Saja",
    [
      {
        key: "listrik_dryer",
        label: "Listrik Dryer per load",
        amount: normalized.listrik.dryerPerLoad,
        note: "",
      },
      {
        key: "gas_lpg",
        label: "Gas LPG per load",
        amount: normalized.gas.biayaPerLoad,
        note: "",
      },
      {
        key: "app_nota",
        label: "Biaya App Kasir & Nota",
        amount: appNota,
        note: "",
      },
    ]
  );

  // HPP Cuci Kering adalah gabungan semua komponen cuci + kering,
  // tetapi biaya App Kasir & Nota hanya dihitung SATU KALI.
  const cuciKering = calculateHPPService_(
    STRUKTUR_HPP_SERVICE_KEYS_.CUCI_KERING,
    "HPP Cuci Kering",
    [
      {
        key: "air",
        label: "Air per load",
        amount: normalized.air.biayaPerLoad,
        note: normalized.air.sumberAir === "sumur" ? "Sumber air sumur: biaya air otomatis Rp0." : "",
      },
      {
        key: "listrik_washer",
        label: "Listrik Washer per load",
        amount: normalized.listrik.washerPerLoad,
        note: "",
      },
      {
        key: "listrik_pompa",
        label: "Listrik Pompa per load",
        amount: normalized.listrik.pompaPerLoad,
        note: "",
      },
      {
        key: "listrik_dryer",
        label: "Listrik Dryer per load",
        amount: normalized.listrik.dryerPerLoad,
        note: "",
      },
      {
        key: "gas_lpg",
        label: "Gas LPG per load",
        amount: normalized.gas.biayaPerLoad,
        note: "",
      },
      {
        key: "app_nota",
        label: "Biaya App Kasir & Nota",
        amount: appNota,
        note: "Dihitung satu kali, tidak dobel.",
      },
    ]
  );

  return [cuciSaja, keringSaja, cuciKering];
}

function calculateHPPService_(key, title, components) {
  const cleanComponents = [];

  for (let i = 0; i < components.length; i++) {
    const item = components[i] || {};
    cleanComponents.push({
      key: item.key || "component_" + i,
      label: item.label || "Komponen biaya",
      amount: strukturHPPRound2_(item.amount),
      percent: 0,
      note: item.note || "",
    });
  }

  // Rumus total HPP = penjumlahan seluruh nominal komponen.
  const total = strukturHPPRound2_(
    cleanComponents.reduce(function (sum, item) {
      return sum + strukturHPPNumber_(item.amount, 0);
    }, 0)
  );

  // Rumus persentase = nominal komponen / total HPP × 100.
  calculateComponentPercentages_(cleanComponents, total);

  return {
    key: key,
    title: title,
    total: total,
    unitLabel: STRUKTUR_HPP_UNIT_LABEL_,
    components: cleanComponents,
  };
}

function calculateComponentPercentages_(components, total) {
  if (!Array.isArray(components) || !components.length) return components;

  if (total <= 0) {
    for (let i = 0; i < components.length; i++) {
      components[i].percent = 0;
    }
    return components;
  }

  let percentSum = 0;
  let lastPositiveIndex = -1;

  for (let i = 0; i < components.length; i++) {
    const amount = strukturHPPNumber_(components[i].amount, 0);
    const percent = amount > 0 ? strukturHPPRound2_((amount / total) * 100) : 0;

    components[i].percent = percent;
    percentSum += percent;

    if (amount > 0) {
      lastPositiveIndex = i;
    }
  }

  // Koreksi pembulatan agar total persentase tampil 100%.
  if (lastPositiveIndex >= 0) {
    const diff = strukturHPPRound2_(100 - percentSum);
    components[lastPositiveIndex].percent = strukturHPPRound2_(components[lastPositiveIndex].percent + diff);

    if (components[lastPositiveIndex].percent < 0) {
      components[lastPositiveIndex].percent = 0;
    }
  }

  return components;
}

// ============================================================================
// SECTION: AGGREGATION HELPERS
// ============================================================================

function getWeightedMachineCost_(rows, fieldName) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  let totalWeighted = 0;
  let totalWeight = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    const amount = strukturHPPNumber_(row[fieldName], 0);
    const unit = Math.max(1, strukturHPPNumber_(row.jumlahUnit, 1));

    if (amount > 0) {
      totalWeighted += amount * unit;
      totalWeight += unit;
    }
  }

  if (totalWeight <= 0) return 0;

  return strukturHPPRound2_(totalWeighted / totalWeight);
}

function getWeightedGasCost_(items, mesinPengering) {
  if (!Array.isArray(items) || items.length === 0) return 0;

  let totalWeighted = 0;
  let totalWeight = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i] || {};
    const record = item.record || {};
    const summary = item.summary || {};

    const amount = strukturHPPNumber_(
      firstDefinedStrukturHPP_([
        summary.biayaPerLoad,
        summary.gasPerLoad,
        summary.totalBiayaGasPerLoad,
      ]),
      0
    );

    if (amount <= 0) continue;

    const dryer = findStrukturHPPMachineById_(mesinPengering, record.dryerRefId);
    const unit = dryer ? Math.max(1, strukturHPPNumber_(dryer.jumlahUnit, 1)) : 1;

    totalWeighted += amount * unit;
    totalWeight += unit;
  }

  if (totalWeight <= 0) return 0;

  return strukturHPPRound2_(totalWeighted / totalWeight);
}

function findStrukturHPPMachineById_(rows, id) {
  if (!Array.isArray(rows) || !id) return null;

  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i].id === id) return rows[i];
  }

  return null;
}

// ============================================================================
// SECTION: SHARED LOCAL HELPERS
// ============================================================================

function safeCallStrukturHPP_(label, fn) {
  try {
    const result = fn();

    if (!result || result.ok === false) {
      return {
        ok: false,
        error: result && result.error ? result.error : "Gagal membaca " + label + ".",
        stage: result && result.stage ? result.stage : "safeCallStrukturHPP_:" + label,
        data: null,
      };
    }

    return {
      ok: true,
      data: result.data || result,
    };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : String(err),
      stage: "safeCallStrukturHPP_:" + label,
      data: null,
    };
  }
}

function firstDefinedStrukturHPP_(values) {
  if (!Array.isArray(values)) return undefined;

  for (let i = 0; i < values.length; i++) {
    if (values[i] !== undefined && values[i] !== null && values[i] !== "") {
      return values[i];
    }
  }

  return undefined;
}

function strukturHPPNumber_(value, fallback) {
  const fb = fallback || 0;

  if (value === null || value === undefined || value === "") return fb;

  if (typeof value === "number") {
    return isFinite(value) ? value : fb;
  }

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

function strukturHPPString_(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function strukturHPPRound2_(value) {
  const num = strukturHPPNumber_(value, 0);
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

function uniqueStrukturHPPArray_(arr) {
  const out = [];
  const seen = {};

  if (!Array.isArray(arr)) return out;

  for (let i = 0; i < arr.length; i++) {
    const text = strukturHPPString_(arr[i]);
    if (!text) continue;

    if (!seen[text]) {
      seen[text] = true;
      out.push(text);
    }
  }

  return out;
}

function strukturHPPErrorResponse_(err, stage) {
  if (typeof errorResponse_ === "function") {
    return errorResponse_(err, stage);
  }

  return {
    ok: false,
    error: err && err.message ? err.message : String(err),
    stage: stage || "strukturHPP:unknown",
  };
}

// ============================================================================
// SECTION: TEST MANUAL
// ============================================================================

function testStrukturBiayaHPP() {
  const cabangId = "test-cabang";
  const result = getStrukturBiayaHPP(cabangId);
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}