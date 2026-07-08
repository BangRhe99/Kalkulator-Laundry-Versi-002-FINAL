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
  CUCI_KERING_LIPAT: "cuci_kering_lipat",
  CUCI_KERING_SETRIKA: "cuci_kering_setrika",
  SETRIKA_SAJA: "setrika_saja",
  BED_COVER: "bed_cover",
};

const STRUKTUR_HPP_UNIT_LABEL_KG_ = "per kg";
const STRUKTUR_HPP_UNIT_LABEL_ITEM_ = "per item";

// Layanan kiloan/hybrid yang bisa diaktif/nonaktifkan dari kartu Struktur
// Biaya HPP. Default semua AKTIF - laundry sengaja mematikan kalau memang
// tidak melayani layanan tsb (mis. tidak melayani Cuci Saja).
const STRUKTUR_HPP_TOGGLABLE_KEYS_ = [
  STRUKTUR_HPP_SERVICE_KEYS_.CUCI_SAJA,
  STRUKTUR_HPP_SERVICE_KEYS_.CUCI_KERING_LIPAT,
  STRUKTUR_HPP_SERVICE_KEYS_.CUCI_KERING_SETRIKA,
  STRUKTUR_HPP_SERVICE_KEYS_.SETRIKA_SAJA,
  STRUKTUR_HPP_SERVICE_KEYS_.BED_COVER,
];

const STRUKTUR_HPP_KILOAN_TOGGLE_TITLES_ = [
  { key: STRUKTUR_HPP_SERVICE_KEYS_.CUCI_SAJA, title: "HPP Cuci Saja" },
  { key: STRUKTUR_HPP_SERVICE_KEYS_.CUCI_KERING_LIPAT, title: "HPP Cuci Kering Lipat" },
  { key: STRUKTUR_HPP_SERVICE_KEYS_.CUCI_KERING_SETRIKA, title: "HPP Cuci Kering Setrika" },
  { key: STRUKTUR_HPP_SERVICE_KEYS_.SETRIKA_SAJA, title: "HPP Setrika Saja" },
  { key: STRUKTUR_HPP_SERVICE_KEYS_.BED_COVER, title: "HPP Bed Cover" },
];

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

    const kategori = normalized.cabang.kategoriLayanan;
    const bedCoverAktif = isBedCoverAktif_(cabangId);

    let layanan;
    let konsepUsaha;
    let note;
    let serviceToggles = [];

    if (kategori === "jasa_setrika") {
      layanan = buildJasaSetrikaHPPStructure_(normalized);
      konsepUsaha = "Jasa Setrika";
      note = "HPP Setrika Saja dihitung dari biaya Setrika (listrik/uap) dan App Kasir & Nota.";
    } else if (kategori === "drop_off" || kategori === "hybrid") {
      const serviceAktifMap = {};
      STRUKTUR_HPP_KILOAN_TOGGLE_TITLES_.forEach(function (item) {
        serviceAktifMap[item.key] = isHPPLayananAktif_(cabangId, item.key);
      });
      layanan = buildKiloanHPPStructure_(normalized, serviceAktifMap);
      konsepUsaha = kategori === "hybrid" ? "Hybrid" : "Drop Off / Kiloan";
      note = "Semua HPP dihitung per load: biaya mesin (air/listrik/gas/nota) dari master biaya sudah per load, Chemical & Packing (per Kg) dikonversi ke per load memakai kapasitas kg mesin cuci, Setrika (per jam) dikonversi lewat kap kg per jam lalu ke per load.";
      serviceToggles = STRUKTUR_HPP_KILOAN_TOGGLE_TITLES_.map(function (item) {
        return { key: item.key, title: item.title, aktif: serviceAktifMap[item.key] };
      });
    } else {
      layanan = buildSelfServiceHPPStructure_(normalized);
      konsepUsaha = "Self Service Laundry";
      note = "Biaya App Kasir & Nota pada HPP Cuci Kering hanya dihitung satu kali.";
    }

    return {
      ok: true,
      data: {
        cabang: normalized.cabang,
        satuan: STRUKTUR_HPP_UNIT_LABEL_,
        sumberAir: normalized.air.sumberAir,
        layanan: layanan,
        bedCoverAktif: bedCoverAktif,
        serviceToggles: serviceToggles,
        warnings: validation.warnings,
        meta: {
          generatedAt: new Date().toISOString(),
          konsepUsaha: konsepUsaha,
          note: note,
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

    // Chemical & Packing (Deterjen/Softener/Parfum/Packing) HANYA dipakai
    // untuk kategori kiloan (drop_off/hybrid) & jasa_setrika. Tetap dibaca di
    // sini secara umum (aman untuk Self Service karena tidak dipakai di
    // buildSelfServiceHPPStructure_).
    const chemicalResult = safeCallStrukturHPP_("listBiayaChemical", function () {
      if (typeof listBiayaChemical !== "function") {
        return {
          ok: false,
          error: "Fungsi listBiayaChemical belum tersedia.",
          stage: "getStrukturHPPSourceData_:listBiayaChemical_missing",
        };
      }
      return listBiayaChemical(cabangId);
    });

    const packingResult = safeCallStrukturHPP_("listBiayaPacking", function () {
      if (typeof listBiayaPacking !== "function") {
        return {
          ok: false,
          error: "Fungsi listBiayaPacking belum tersedia.",
          stage: "getStrukturHPPSourceData_:listBiayaPacking_missing",
        };
      }
      return listBiayaPacking(cabangId);
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
        chemical: chemicalResult.ok ? chemicalResult.data : null,
        packing: packingResult.ok ? packingResult.data : null,
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
        const profil = cabang.profil || {};
        return {
          id: cabang.id || cabangId,
          namaLaundry: profil.namaLaundry ? String(profil.namaLaundry) : "",
          mesinCuci: Array.isArray(cabang.mesinCuci) ? cabang.mesinCuci : [],
          mesinPengering: Array.isArray(cabang.mesinPengering) ? cabang.mesinPengering : [],
          mesinSetrika: Array.isArray(cabang.mesinSetrika) ? cabang.mesinSetrika : [],
          kategoriLayanan: String(cabang.kategoriLayanan || profil.kategoriLayanan || "self_service").toLowerCase(),
        };
      }
    }

    if (typeof ensureDataSheet_ === "function" && typeof readKey_ === "function" && typeof sanitizeCabang_ === "function") {
      const sheet = ensureDataSheet_();
      const raw = readKey_(sheet, "cabang_" + cabangId);

      if (raw) {
        const cabang = sanitizeCabang_(JSON.parse(raw));
        const profil = cabang.profil || {};
        return {
          id: cabang.id || cabangId,
          namaLaundry: profil.namaLaundry ? String(profil.namaLaundry) : "",
          mesinCuci: Array.isArray(cabang.mesinCuci) ? cabang.mesinCuci : [],
          mesinPengering: Array.isArray(cabang.mesinPengering) ? cabang.mesinPengering : [],
          mesinSetrika: Array.isArray(cabang.mesinSetrika) ? cabang.mesinSetrika : [],
          kategoriLayanan: String(cabang.kategoriLayanan || profil.kategoriLayanan || "self_service").toLowerCase(),
        };
      }
    }

    return {
      id: cabangId,
      namaLaundry: "",
      mesinCuci: [],
      mesinPengering: [],
      mesinSetrika: [],
      kategoriLayanan: "self_service",
    };
  } catch (err) {
    console.warn("[StrukturHPP] Gagal membaca cabang:", err);
    return {
      id: cabangId,
      namaLaundry: "",
      mesinCuci: [],
      mesinPengering: [],
      mesinSetrika: [],
      kategoriLayanan: "self_service",
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

  // ==========================================================================
  // Data tambahan khusus kategori kiloan (drop_off/hybrid) & jasa_setrika:
  // kapasitas kg per load (acuan konversi per-load -> per-kg), chemical
  // (Deterjen/Softener/Parfum by name), packing (total), dan setrika listrik.
  // Tidak berdampak ke Self Service (field-field ini tidak dipakai di
  // buildSelfServiceHPPStructure_).
  // ==========================================================================
  const kapasitasKgPerLoad = getWeightedMachineCost_(cabang.mesinCuci, "kapasitasKg");

  const chemicalItems = sources.chemical && Array.isArray(sources.chemical.items) ? sources.chemical.items : [];
  const packingItems = sources.packing && Array.isArray(sources.packing.items) ? sources.packing.items : [];
  const packingPerKgKiloan = sumStrukturHPPPackingBiayaPerKg_(packingItems, "kiloan");
  const packingBedCoverSums = sumStrukturHPPPackingForBedCover_(packingItems);

  const listrikSetrikaRows = Array.isArray(listrikSummary.setrika) ? listrikSummary.setrika : [];
  const setrikaRpPerJam = getWeightedMachineCost_(listrikSetrikaRows, "rpListrikPerJam");
  const setrikaKapasitasKgPerJam = getWeightedMachineCost_(listrikSetrikaRows, "kapasitasKgPerJam");
  const adaMesinSetrika = Array.isArray(cabang.mesinSetrika) && cabang.mesinSetrika.length > 0;

  return {
    cabang: {
      id: cabang.id || "",
      namaLaundry: cabang.namaLaundry || "",
      mesinCuci: Array.isArray(cabang.mesinCuci) ? cabang.mesinCuci : [],
      mesinPengering: Array.isArray(cabang.mesinPengering) ? cabang.mesinPengering : [],
      mesinSetrika: Array.isArray(cabang.mesinSetrika) ? cabang.mesinSetrika : [],
      kategoriLayanan: cabang.kategoriLayanan || "self_service",
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
    kiloan: {
      kapasitasKgPerLoad: strukturHPPRound2_(kapasitasKgPerLoad),
      deterjenPerKg: strukturHPPRound2_(findStrukturHPPChemicalBiayaPerKg_(chemicalItems, "Deterjen")),
      softenerPerKg: strukturHPPRound2_(findStrukturHPPChemicalBiayaPerKg_(chemicalItems, "Softener")),
      parfumPerKg: strukturHPPRound2_(findStrukturHPPChemicalBiayaPerKg_(chemicalItems, "Parfum")),
      packingPerKgKiloan: strukturHPPRound2_(packingPerKgKiloan),
      packingItemsKiloan: listStrukturHPPPackingItemsPerKg_(packingItems, "kiloan"),
      packingPerKgBedCoverConverted: strukturHPPRound2_(packingBedCoverSums.perKgConverted),
      packingPerLoadBedCoverDirect: strukturHPPRound2_(packingBedCoverSums.perLoadDirect),
      setrikaRpPerJam: strukturHPPRound2_(setrikaRpPerJam),
      setrikaKapasitasKgPerJam: strukturHPPRound2_(setrikaKapasitasKgPerJam),
      adaMesinSetrika: adaMesinSetrika,
    },
    sourceWarnings: Array.isArray(sources.sourceWarnings) ? sources.sourceWarnings : [],
  };
}

/**
 * sumStrukturHPPPackingBiayaPerKg_: jumlah biayaPerKg semua item packing yang
 * berlaku untuk 1 layanan tertentu ("kiloan" atau "bed_cover"). Item NON-
 * plastik (Isolasi, dll — lihat isPackingPlastikNama_ di Modul_BiayaPacking.gs)
 * SELALU ikut dihitung di semua layanan (perilaku lama, tidak dibedakan).
 * Item plastik hanya ikut kalau layananPacking-nya mencantumkan layananKey ini.
 */
function sumStrukturHPPPackingBiayaPerKg_(items, layananKey) {
  if (!Array.isArray(items)) return 0;
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    const entry = items[i] || {};
    const record = entry.record || {};
    const summary = entry.summary || {};
    const isPlastik = typeof isPackingPlastikNama_ === "function"
      ? isPackingPlastikNama_(record.nama)
      : false;
    const layananArr = Array.isArray(record.layananPacking) ? record.layananPacking : ["kiloan", "bed_cover"];
    const included = !isPlastik || layananArr.indexOf(layananKey) >= 0;
    if (included) total += strukturHPPNumber_(summary.biayaPerKg, 0);
  }
  return total;
}

/**
 * listStrukturHPPPackingItemsPerKg_: sama seperti sumStrukturHPPPackingBiayaPerKg_
 * tapi mengembalikan daftar per item (nama + biayaPerKg), dipakai untuk
 * menampilkan rincian Packing satu per satu (mis. Plastik PP, Plastik HD,
 * Isolasi) di HPP Cuci Saja alih-alih satu baris "Packing" gabungan.
 */
function listStrukturHPPPackingItemsPerKg_(items, layananKey) {
  if (!Array.isArray(items)) return [];
  const list = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i] || {};
    const record = entry.record || {};
    const summary = entry.summary || {};
    const isPlastik = typeof isPackingPlastikNama_ === "function"
      ? isPackingPlastikNama_(record.nama)
      : false;
    const layananArr = Array.isArray(record.layananPacking) ? record.layananPacking : ["kiloan", "bed_cover"];
    const included = !isPlastik || layananArr.indexOf(layananKey) >= 0;
    if (!included) continue;
    list.push({
      nama: record.nama || "Packing",
      biayaPerKg: strukturHPPRound2_(strukturHPPNumber_(summary.biayaPerKg, 0)),
    });
  }
  return list;
}

function strukturHPPSlug_(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "item";
}

/**
 * sumStrukturHPPPackingForBedCover_: khusus utk layanan Bed Cover, item
 * plastik yang DIKUNCI (isPackingJinjingBedCoverLocked_ true — nama persis
 * "Plastik Jinjing" + dicentang Bed Cover) TIDAK dikonversi lewat Kap Kg Per
 * Lembar, karena asumsinya 1 lembar = 1 Bed Cover (bukan takaran per Kg
 * cucian). Biayanya diambil langsung dari biayaPerLoad (harga per lembar),
 * dijumlah terpisah (perLoadDirect) dari item bed-cover lain yang masih pakai
 * basis per-Kg biasa (perKgConverted, nanti dikonversi ke per-load di
 * buildBedCoverHPPService_ pakai kapasitasKgPerLoad seperti sebelumnya).
 */
function sumStrukturHPPPackingForBedCover_(items) {
  let perKgConverted = 0;
  let perLoadDirect = 0;
  if (!Array.isArray(items)) return { perKgConverted: perKgConverted, perLoadDirect: perLoadDirect };

  for (let i = 0; i < items.length; i++) {
    const entry = items[i] || {};
    const record = entry.record || {};
    const summary = entry.summary || {};
    const isPlastik = typeof isPackingPlastikNama_ === "function"
      ? isPackingPlastikNama_(record.nama)
      : false;
    const layananArr = Array.isArray(record.layananPacking) ? record.layananPacking : ["kiloan", "bed_cover"];
    const included = !isPlastik || layananArr.indexOf("bed_cover") >= 0;
    if (!included) continue;

    const isLocked = typeof isPackingJinjingBedCoverLocked_ === "function"
      ? isPackingJinjingBedCoverLocked_(record)
      : false;
    if (isLocked) {
      perLoadDirect += strukturHPPNumber_(summary.biayaPerLoad, 0);
    } else {
      perKgConverted += strukturHPPNumber_(summary.biayaPerKg, 0);
    }
  }
  return { perKgConverted: perKgConverted, perLoadDirect: perLoadDirect };
}

function findStrukturHPPChemicalBiayaPerKg_(items, nama) {
  if (!Array.isArray(items) || !nama) return 0;
  const target = String(nama).trim().toLowerCase();

  for (let i = 0; i < items.length; i++) {
    const entry = items[i] || {};
    const record = entry.record || {};
    const summary = entry.summary || {};
    const entryNama = String(record.nama || "").trim().toLowerCase();

    if (entryNama === target) {
      return strukturHPPNumber_(summary.biayaPerKg, 0);
    }
  }

  return 0;
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

  const kategori = normalized.cabang.kategoriLayanan;
  if (kategori === "drop_off" || kategori === "hybrid" || kategori === "jasa_setrika") {
    if (kategori !== "jasa_setrika" && normalized.kiloan.kapasitasKgPerLoad <= 0) {
      warnings.push("Kapasitas kg mesin cuci belum diisi. HPP per Kg belum bisa dihitung, cek Profil Outlet.");
    }
    if (!normalized.kiloan.adaMesinSetrika) {
      warnings.push("Belum ada mesin setrika di Profil Outlet. HPP Setrika Saja masih Rp0.");
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

/**
 * buildKiloanHPPStructure_: 5 layanan untuk kategori Drop Off/Kiloan & Hybrid.
 * Semua ditampilkan dalam basis PER LOAD (bukan per Kg), sama seperti Bed
 * Cover: basis mesin (air/listrik/gas/nota) sudah per load dari master biaya
 * jadi dipakai langsung tanpa dibagi. Chemical & Packing (per Kg dari
 * Modul_BiayaChemical.gs/Modul_BiayaPacking.gs) dikonversi ke per load dengan
 * dikali kapasitasKgPerLoad. Setrika sumbernya Rp per jam - dikonversi ke per
 * Kg dulu (Rp per jam / kap kg per jam), baru dikali kapasitasKgPerLoad supaya
 * ikut basis per load yang sama dengan komponen lain.
 */
function buildKiloanHPPStructure_(normalized, serviceAktifMap) {
  const aktifMap = serviceAktifMap || {};
  const kg = normalized.kiloan.kapasitasKgPerLoad;
  const toPerLoad = function (perKgValue) {
    return strukturHPPRound2_(perKgValue * kg);
  };
  const kgNote = kg <= 0 ? "Kapasitas kg mesin cuci belum diisi." : "";

  const airPerLoad = normalized.air.biayaPerLoad;
  const washerPerLoad = normalized.listrik.washerPerLoad;
  const pompaPerLoad = normalized.listrik.pompaPerLoad;
  const dryerPerLoad = normalized.listrik.dryerPerLoad;
  const gasPerLoad = normalized.gas.biayaPerLoad;
  const appNotaPerLoad = normalized.notaKasir.biayaPerLoad;

  const deterjenPerLoad = toPerLoad(normalized.kiloan.deterjenPerKg);
  const softenerPerLoad = toPerLoad(normalized.kiloan.softenerPerKg);
  const packingPerLoad = toPerLoad(normalized.kiloan.packingPerKgKiloan);
  const setrikaPerLoad = toPerLoad(getStrukturHPPSetrikaPerKg_(normalized));
  const setrikaNote = normalized.kiloan.adaMesinSetrika ? "" : "Belum ada mesin setrika di Profil Outlet.";

  // Khusus HPP Cuci Saja: Packing diwakili "Plastik HD" saja (baris gabungan
  // "Packing" dihapus, item packing lain di luar Plastik HD tidak dihitung di
  // sini).
  const packingItemsKiloan = Array.isArray(normalized.kiloan.packingItemsKiloan) ? normalized.kiloan.packingItemsKiloan : [];
  const packingHdItems = packingItemsKiloan.filter(function (item) {
    return strukturHPPSlug_(item.nama) === "plastik_hd";
  });
  const packingComponentsCuciSaja = packingHdItems.map(function (item, idx) {
    return {
      key: "packing_plastik_hd_" + idx,
      label: item.nama,
      amount: toPerLoad(item.biayaPerKg),
      note: "",
    };
  });

  const cuciSaja = calculateHPPService_(
    STRUKTUR_HPP_SERVICE_KEYS_.CUCI_SAJA,
    "HPP Cuci Saja",
    [
      { key: "air", label: "Air per Load", amount: airPerLoad, note: "" },
      { key: "listrik_washer", label: "Listrik Washer per Load", amount: washerPerLoad, note: "" },
      { key: "listrik_pompa", label: "Listrik Pompa per Load", amount: pompaPerLoad, note: "" },
      { key: "app_nota", label: "Biaya App Kasir & Nota per Load", amount: appNotaPerLoad, note: "" },
      { key: "deterjen", label: "Deterjen per Load", amount: deterjenPerLoad, note: kgNote },
      { key: "softener", label: "Softener per Load", amount: softenerPerLoad, note: "" },
    ].concat(packingComponentsCuciSaja),
    STRUKTUR_HPP_UNIT_LABEL_
  );

  const cuciKeringLipat = calculateHPPService_(
    STRUKTUR_HPP_SERVICE_KEYS_.CUCI_KERING_LIPAT,
    "HPP Cuci Kering Lipat",
    [
      { key: "air", label: "Air per Load", amount: airPerLoad, note: "" },
      { key: "listrik_washer", label: "Listrik Washer per Load", amount: washerPerLoad, note: "" },
      { key: "listrik_pompa", label: "Listrik Pompa per Load", amount: pompaPerLoad, note: "" },
      { key: "listrik_dryer", label: "Listrik Dryer per Load", amount: dryerPerLoad, note: "" },
      { key: "gas_lpg", label: "Gas LPG per Load", amount: gasPerLoad, note: "" },
      { key: "app_nota", label: "Biaya App Kasir & Nota per Load", amount: appNotaPerLoad, note: "" },
      { key: "deterjen", label: "Deterjen per Load", amount: deterjenPerLoad, note: kgNote },
      { key: "softener", label: "Softener per Load", amount: softenerPerLoad, note: "" },
      { key: "packing", label: "Packing per Load", amount: packingPerLoad, note: "" },
    ],
    STRUKTUR_HPP_UNIT_LABEL_
  );

  const cuciKeringSetrika = calculateHPPService_(
    STRUKTUR_HPP_SERVICE_KEYS_.CUCI_KERING_SETRIKA,
    "HPP Cuci Kering Setrika",
    [
      { key: "air", label: "Air per Load", amount: airPerLoad, note: "" },
      { key: "listrik_washer", label: "Listrik Washer per Load", amount: washerPerLoad, note: "" },
      { key: "listrik_pompa", label: "Listrik Pompa per Load", amount: pompaPerLoad, note: "" },
      { key: "listrik_dryer", label: "Listrik Dryer per Load", amount: dryerPerLoad, note: "" },
      { key: "gas_lpg", label: "Gas LPG per Load", amount: gasPerLoad, note: "" },
      { key: "setrika", label: "Setrika per Load", amount: setrikaPerLoad, note: setrikaNote },
      { key: "app_nota", label: "Biaya App Kasir & Nota per Load", amount: appNotaPerLoad, note: "" },
      { key: "deterjen", label: "Deterjen per Load", amount: deterjenPerLoad, note: kgNote },
      { key: "softener", label: "Softener per Load", amount: softenerPerLoad, note: "" },
      { key: "packing", label: "Packing per Load", amount: packingPerLoad, note: "" },
    ],
    STRUKTUR_HPP_UNIT_LABEL_
  );

  const setrikaSaja = calculateHPPService_(
    STRUKTUR_HPP_SERVICE_KEYS_.SETRIKA_SAJA,
    "HPP Setrika Saja",
    [
      { key: "setrika", label: "Setrika per Load", amount: setrikaPerLoad, note: setrikaNote },
      { key: "app_nota", label: "Biaya App Kasir & Nota per Load", amount: appNotaPerLoad, note: kgNote },
    ],
    STRUKTUR_HPP_UNIT_LABEL_
  );

  const layanan = [];
  if (aktifMap[STRUKTUR_HPP_SERVICE_KEYS_.CUCI_SAJA] !== false) layanan.push(cuciSaja);
  if (aktifMap[STRUKTUR_HPP_SERVICE_KEYS_.CUCI_KERING_LIPAT] !== false) layanan.push(cuciKeringLipat);
  if (aktifMap[STRUKTUR_HPP_SERVICE_KEYS_.CUCI_KERING_SETRIKA] !== false) layanan.push(cuciKeringSetrika);
  if (aktifMap[STRUKTUR_HPP_SERVICE_KEYS_.SETRIKA_SAJA] !== false) layanan.push(setrikaSaja);

  if (aktifMap[STRUKTUR_HPP_SERVICE_KEYS_.BED_COVER]) {
    layanan.push(buildBedCoverHPPService_(normalized));
  }

  return layanan;
}

/**
 * buildJasaSetrikaHPPStructure_: kategori Jasa Setrika hanya punya 1 layanan,
 * HPP Setrika Saja (biaya setrika + App Kasir & Nota, per Kg).
 */
function buildJasaSetrikaHPPStructure_(normalized) {
  const notaPerKg = getStrukturHPPNotaPerKg_(normalized);
  const setrikaPerKg = getStrukturHPPSetrikaPerKg_(normalized);

  const setrikaSaja = calculateHPPService_(
    STRUKTUR_HPP_SERVICE_KEYS_.SETRIKA_SAJA,
    "HPP Setrika Saja",
    [
      { key: "setrika", label: "Setrika per Kg", amount: setrikaPerKg, note: normalized.kiloan.adaMesinSetrika ? "" : "Belum ada mesin setrika di Profil Outlet." },
      { key: "app_nota", label: "Biaya App Kasir & Nota per Kg", amount: notaPerKg, note: normalized.kiloan.kapasitasKgPerLoad <= 0 ? "Belum bisa dikonversi ke per Kg (kapasitas kg mesin cuci belum diisi)." : "" },
    ],
    STRUKTUR_HPP_UNIT_LABEL_KG_
  );

  return [setrikaSaja];
}

/**
 * buildBedCoverHPPService_: dihitung PER ITEM (1 Bed Cover = 1 load penuh,
 * sesuai keputusan user), BUKAN per Kg. HPP Cuci & HPP Kering diambil dari
 * komponen mesin per load (tanpa nota, supaya nota tidak dobel dihitung).
 * Chemical & Packing (aslinya per Kg) dikonversi ke per load dengan dikali
 * kapasitasKgPerLoad.
 */
function buildBedCoverHPPService_(normalized) {
  const kg = normalized.kiloan.kapasitasKgPerLoad;
  const toPerLoad = function (perKgValue) {
    return strukturHPPRound2_(perKgValue * kg);
  };

  const hppCuciPerLoad = normalized.air.biayaPerLoad + normalized.listrik.washerPerLoad + normalized.listrik.pompaPerLoad;
  const hppKeringPerLoad = normalized.listrik.dryerPerLoad + normalized.gas.biayaPerLoad;

  return calculateHPPService_(
    STRUKTUR_HPP_SERVICE_KEYS_.BED_COVER,
    "HPP Bed Cover",
    [
      { key: "app_nota", label: "Biaya App Kasir & Nota", amount: normalized.notaKasir.biayaPerLoad, note: "" },
      { key: "hpp_cuci", label: "HPP Cuci", amount: strukturHPPRound2_(hppCuciPerLoad), note: "" },
      { key: "hpp_kering", label: "HPP Kering", amount: strukturHPPRound2_(hppKeringPerLoad), note: "" },
      { key: "deterjen", label: "Deterjen", amount: toPerLoad(normalized.kiloan.deterjenPerKg), note: kg <= 0 ? "Kapasitas kg mesin cuci belum diisi." : "" },
      { key: "softener", label: "Softener", amount: toPerLoad(normalized.kiloan.softenerPerKg), note: "" },
      { key: "parfum", label: "Parfum", amount: toPerLoad(normalized.kiloan.parfumPerKg), note: "" },
      { key: "packing", label: "Packing", amount: strukturHPPRound2_(toPerLoad(normalized.kiloan.packingPerKgBedCoverConverted) + normalized.kiloan.packingPerLoadBedCoverDirect), note: "" },
    ],
    STRUKTUR_HPP_UNIT_LABEL_ITEM_
  );
}

function getStrukturHPPSetrikaPerKg_(normalized) {
  const rpPerJam = normalized.kiloan.setrikaRpPerJam;
  const kgPerJam = normalized.kiloan.setrikaKapasitasKgPerJam;
  return kgPerJam > 0 ? strukturHPPRound2_(rpPerJam / kgPerJam) : 0;
}

function getStrukturHPPNotaPerKg_(normalized) {
  const kg = normalized.kiloan.kapasitasKgPerLoad;
  return kg > 0 ? strukturHPPRound2_(normalized.notaKasir.biayaPerLoad / kg) : 0;
}

/**
 * Toggle aktif/nonaktif "HPP Bed Cover" per cabang. Default AKTIF (tampil)
 * kalau belum pernah diset - laundry harus sengaja mematikan kalau memang
 * tidak melayani Bed Cover. Dipakai bersama oleh Modul_HargaLayanan.gs supaya
 * Harga Layanan ikut menyesuaikan.
 */
function getBedCoverToggleKey_(cabangId) {
  return "bedCoverAktif_" + cabangId;
}

function isBedCoverAktif_(cabangId) {
  try {
    const sheet = ensureDataSheet_();
    const raw = readKey_(sheet, getBedCoverToggleKey_(cabangId));
    if (!raw) return true;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.aktif === "boolean" ? parsed.aktif : true;
  } catch (err) {
    return true;
  }
}

function setBedCoverAktif(cabangId, aktif) {
  try {
    const cleanId = typeof cabangId === "string" ? cabangId.trim() : "";
    if (!cleanId) {
      return { ok: false, error: "ID cabang tidak valid.", stage: "setBedCoverAktif:validate_cabang_id" };
    }

    const sheet = ensureDataSheet_();
    writeKey_(sheet, getBedCoverToggleKey_(cleanId), JSON.stringify({
      aktif: !!aktif,
      updatedAt: new Date().toISOString(),
    }));

    return { ok: true, data: { cabangId: cleanId, aktif: !!aktif } };
  } catch (err) {
    return strukturHPPErrorResponse_(err, "setBedCoverAktif");
  }
}

/**
 * Toggle aktif/nonaktif generik utk layanan HPP kiloan (Cuci Saja, Cuci
 * Kering Lipat, Cuci Kering Setrika, Setrika Saja) di kartu Struktur Biaya
 * HPP. Default semua AKTIF - laundry sengaja mematikan kalau memang tidak
 * melayani layanan tsb (mis. tidak melayani Cuci Saja). Bed Cover tetap
 * memakai penyimpanan lama (getBedCoverToggleKey_) supaya data existing tidak
 * hilang.
 */
function getHPPLayananToggleKey_(cabangId, serviceKey) {
  return "hppLayananAktif_" + serviceKey + "_" + cabangId;
}

function isHPPLayananAktif_(cabangId, serviceKey) {
  if (serviceKey === STRUKTUR_HPP_SERVICE_KEYS_.BED_COVER) {
    return isBedCoverAktif_(cabangId);
  }
  try {
    const sheet = ensureDataSheet_();
    const raw = readKey_(sheet, getHPPLayananToggleKey_(cabangId, serviceKey));
    if (!raw) return true;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.aktif === "boolean" ? parsed.aktif : true;
  } catch (err) {
    return true;
  }
}

function setHPPLayananAktif(cabangId, serviceKey, aktif) {
  try {
    const cleanId = typeof cabangId === "string" ? cabangId.trim() : "";
    if (!cleanId) {
      return { ok: false, error: "ID cabang tidak valid.", stage: "setHPPLayananAktif:validate_cabang_id" };
    }
    if (STRUKTUR_HPP_TOGGLABLE_KEYS_.indexOf(serviceKey) === -1) {
      return { ok: false, error: "Layanan tidak dikenali.", stage: "setHPPLayananAktif:validate_service_key" };
    }
    if (serviceKey === STRUKTUR_HPP_SERVICE_KEYS_.BED_COVER) {
      return setBedCoverAktif(cleanId, aktif);
    }

    const sheet = ensureDataSheet_();
    writeKey_(sheet, getHPPLayananToggleKey_(cleanId, serviceKey), JSON.stringify({
      aktif: !!aktif,
      updatedAt: new Date().toISOString(),
    }));

    return { ok: true, data: { cabangId: cleanId, serviceKey: serviceKey, aktif: !!aktif } };
  } catch (err) {
    return strukturHPPErrorResponse_(err, "setHPPLayananAktif");
  }
}

function calculateHPPService_(key, title, components, unitLabelOverride) {
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

  // Rumus total HPP = penjumlahan nominal komponen YANG SUDAH DIBULATKAN ke
  // Rupiah bulat (sama seperti angka yang tampil di tiap baris di layar),
  // supaya total selalu pas dengan penjumlahan manual dari angka yang
  // terlihat - bukan dari nilai desimal (2 angka di belakang koma) sebelum
  // dibulatkan, yang bisa selisih 1 rupiah karena pembulatan bertingkat.
  const total = cleanComponents.reduce(function (sum, item) {
    return sum + Math.round(strukturHPPNumber_(item.amount, 0));
  }, 0);

  // Rumus persentase = nominal komponen / total HPP × 100.
  calculateComponentPercentages_(cleanComponents, total);

  return {
    key: key,
    title: title,
    total: total,
    unitLabel: unitLabelOverride || STRUKTUR_HPP_UNIT_LABEL_,
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