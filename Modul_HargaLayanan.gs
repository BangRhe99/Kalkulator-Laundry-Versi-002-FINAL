/**
 * ============================================================================
 * MODUL: HARGA LAYANAN
 * ============================================================================
 * Fitur ini menyimpan harga jual layanan per cabang dan menghitung margin.
 *
 * Prinsip DEVELOPMENT_GUIDE.md:
 * - Backend menjadi service data dan calculation utama.
 * - UI hanya menampilkan, menerima input, dan meminta hasil ke backend.
 * - Tidak membuat logic HPP baru.
 * - HPP tetap dibaca dari Modul_StrukturBiayaHPP.js melalui getStrukturBiayaHPP.
 *
 * PUBLIC FUNCTION:
 * - getHargaLayanan(cabangId)
 * - saveHargaLayanan(cabangId, payload)
 * ============================================================================
 */

// Cache baca-sekali-per-eksekusi: getDashboardFullSummary() bisa memanggil
// getHargaLayanan(cabangId) yang SAMA sampai 4x dalam satu kali load
// Dashboard (lewat kartu Harga Layanan, BEP, dan Potensi Omset sendiri-
// sendiri), padahal fungsi ini murni baca data (tidak ada efek samping) dan
// hasilnya identik selama cabangId sama. Variabel global Apps Script reset
// otomatis tiap eksekusi google.script.run baru, jadi tidak ada risiko data
// basi lintas request -- pola sama seperti _dataSheetCache_ di
// Util_Penyimpanan.gs / _dashboardCabangRowsCache_ di Modul_Dashboard.gs.
let _hargaLayananCache_ = {};

// [2026-07-13] Dibungkus withTenant_ (Code.gs) - argumen pertama SELALU
// sessionToken. Badan cache-check yang tadinya di sini dipindah ke
// getHargaLayanan_impl_ (dipakai internal oleh modul lain spt
// Modul_Dashboard.gs, TANPA sessionToken, krn sudah berjalan di dalam
// withTenant_ yang sama).
function getHargaLayanan(sessionToken, cabangId) {
  return withTenant_(sessionToken, function () { return getHargaLayanan_impl_(cabangId); });
}

function getHargaLayanan_impl_(cabangId) {
  if (_hargaLayananCache_[cabangId]) return _hargaLayananCache_[cabangId];
  const result = getHargaLayanan_(cabangId);
  if (result && result.ok) _hargaLayananCache_[cabangId] = result;
  return result;
}

function getHargaLayanan_(cabangId) {
  try {
    const cleanCabangId = sanitizeHargaLayananCabangId_(cabangId);
    if (!cleanCabangId) {
      return {
        ok: false,
        error: "ID cabang tidak valid.",
        stage: "getHargaLayanan:validate_cabang_id",
      };
    }

    const cabang = getHargaLayananCabang_(cleanCabangId);
    if (!cabang) {
      return {
        ok: false,
        error: "Cabang tidak ditemukan. Silakan cek data Cabang & Lokasi.",
        stage: "getHargaLayanan:lookup_cabang",
      };
    }

    const stored = readHargaLayananRecord_(cleanCabangId);
    const hppResult = readHargaLayananHPP_(cleanCabangId);
    const hppMap = buildHargaLayananHPPMap_(hppResult);

    const kategoriLayanan = String(
      cabang.kategoriLayanan ||
      cabang.kategoriLaundry ||
      cabang.kategori ||
      ""
    ).toLowerCase();

    const kategoriFinal = normalizeHargaLayananKategori_(kategoriLayanan);

    // Layanan mana yang aktif/nonaktif mengikuti toggle di kartu Struktur
    // Biaya HPP (Modul_StrukturBiayaHPP.gs) - relevan utk drop_off/hybrid
    // DAN self_service (jasa_setrika cuma 1 layanan, tidak ada toggle).
    const aktifMap = {};
    if (kategoriFinal === "drop_off" || kategoriFinal === "hybrid" || kategoriFinal === "self_service") {
      STRUKTUR_HPP_TOGGLABLE_KEYS_.forEach(function (key) {
        aktifMap[key] = typeof isHPPLayananAktif_ === "function" ? isHPPLayananAktif_(cleanCabangId, key) : true;
      });
    }

    const konversi = hppResult && hppResult.ok && hppResult.data && hppResult.data.konversi
      ? hppResult.data.konversi
      : null;
    // Konteks rekomendasi harga jual Self Service (fixed cost per siklus mesin
    // + load/bulan) -- dipakai frontend utk cost-plus. Hanya Self Service yang
    // butuh (per load); kategori lain rekomendasinya sudah cukup dari HPP+min
    // order di sisi client. Aditif, tidak mengubah field/rumus lama.
    const recoContext = kategoriFinal === "self_service" ? buildSelfServiceRecoContext_(cleanCabangId) : null;
    // [2026-07-22] Layanan CUSTOM (Modul_StrukturBiayaHPP.gs, Firestore) --
    // otomatis ikut tampil di sini, HANYA yang aktif (nonaktif tetap
    // tersimpan tapi tidak dijual). hppMap sudah otomatis punya entri custom
    // ini juga (buildHargaLayananHPPMap_ generic, iterate layanan[] apa
    // adanya dari HPP yang SUDAH termasuk custom -- lihat getStrukturBiayaHPP_).
    const customLayananDefs = typeof listCustomLayananHPP_impl_ === "function"
      ? listCustomLayananHPP_impl_(cleanCabangId).filter(function (d) { return d.aktif !== false; })
      : [];
    const layanan = buildHargaLayananItems_(kategoriFinal, hppMap, stored.hargaJual || {}, aktifMap, konversi, stored.minimumOrderKg || {}, recoContext, customLayananDefs);

    return {
      ok: true,
      data: {
        cabang: {
          id: cleanCabangId,
          namaLaundry: cabang.namaLaundry || "",
          kategoriLayanan: kategoriFinal,
          kategoriLabel: getHargaLayananKategoriLabel_(kategoriFinal),
        },
        layanan: layanan,
        warnings: buildHargaLayananWarnings_(hppResult, layanan),
        meta: {
          note: "Margin bukan laba bersih. Margin belum dikurangi biaya tetap bulanan seperti sewa, gaji, internet, penyusutan mesin, perawatan, dan operasional rutin lainnya.",
          generatedAt: new Date().toISOString(),
        },
      },
    };
  } catch (err) {
    return errorResponse_(err, "getHargaLayanan");
  }
}

// Konteks rekomendasi harga jual Self Service: fixed cost per siklus mesin =
// total biaya tetap/bulan dibagi total load/bulan (loadCuci + loadKering).
// Alokasi "model A" (disepakati user): Cuci Saja & Kering Saja = 1 siklus,
// Cuci Kering = 2 siklus (pakai mesin cuci + pengering). Selalu kembalikan
// objek (tidak null) supaya kartu tetap dapat atribut walau data belum lengkap.
function buildSelfServiceRecoContext_(cabangId) {
  try {
    var totalFixed = 0;
    var hasFixed = false;
    if (typeof getDashboardFixedCostSummary_impl_ === "function") {
      var fc = getDashboardFixedCostSummary_impl_(cabangId);
      if (fc && fc.ok && fc.data) {
        totalFixed = toNumber_(fc.data.totalFixedCostPerBulan, 0);
        var frows = fc.data.rows;
        if (frows && frows.length) hasFixed = !!frows[0].hasData;
      }
    }
    var loadCuci = 0;
    var loadKering = 0;
    if (typeof getDashboardCabangSummary_impl_ === "function") {
      var cb = getDashboardCabangSummary_impl_(cabangId);
      if (cb && cb.ok && cb.data && cb.data.rows && cb.data.rows.length) {
        loadCuci = toNumber_(cb.data.rows[0].loadCuciPerBulan, 0);
        loadKering = toNumber_(cb.data.rows[0].loadKeringPerBulan, 0);
      }
    }
    var totalCycle = loadCuci + loadKering;
    var perCycle = totalCycle > 0 ? round2_(totalFixed / totalCycle) : 0;
    return {
      fixedCostPerCycle: perCycle,
      hasFixedData: hasFixed,
      loadCuciPerBulan: round2_(loadCuci),
      loadKeringPerBulan: round2_(loadKering),
      totalFixedCostPerBulan: round2_(totalFixed),
    };
  } catch (err) {
    return { fixedCostPerCycle: 0, hasFixedData: false, loadCuciPerBulan: 0, loadKeringPerBulan: 0, totalFixedCostPerBulan: 0 };
  }
}

function saveHargaLayanan(sessionToken, cabangId, payload) {
  return withTenant_(sessionToken, function () { return saveHargaLayanan_impl_(cabangId, payload); });
}

function saveHargaLayanan_impl_(cabangId, payload) {
  try {
    const cleanCabangId = sanitizeHargaLayananCabangId_(cabangId);
    if (!cleanCabangId) {
      return {
        ok: false,
        error: "ID cabang tidak valid.",
        stage: "saveHargaLayanan:validate_cabang_id",
      };
    }

    const cabang = getHargaLayananCabang_(cleanCabangId);
    if (!cabang) {
      return {
        ok: false,
        error: "Cabang tidak ditemukan. Silakan cek data Cabang & Lokasi.",
        stage: "saveHargaLayanan:lookup_cabang",
      };
    }

    const customKeys = typeof listCustomLayananHPP_impl_ === "function"
      ? listCustomLayananHPP_impl_(cleanCabangId).map(function (d) { return d.key; })
      : [];
    const cleanPayload = sanitizeHargaLayananPayload_(payload, customKeys);
    const sheet = ensureDataSheet_();

    const record = {
      cabangId: cleanCabangId,
      hargaJual: cleanPayload.hargaJual,
      minimumOrderKg: cleanPayload.minimumOrderKg,
      updatedAt: new Date().toISOString(),
    };

    writeKey_(sheet, getHargaLayananKey_(cleanCabangId), JSON.stringify(record));

    firestoreSyncConfigDoc_(cleanCabangId, "hargaLayanan", record); // best-effort (non-fatal)
    // [2026-07-22] HargaLayanan/BEP/PotensiOmset (computed.*, Modul_Firestore_
    // Computed.gs) bergantung ke data ini - sebelumnya TIDAK PERNAH ter-
    // refresh saat harga jual disimpan (celah lama). recomputeCabangSummary_
    // best-effort (tidak pernah melempar).
    recomputeCabangSummary_(cleanCabangId, DASHBOARD_RECOMPUTE_HARGALAYANAN_GROUP_);

    return getHargaLayanan_impl_(cleanCabangId);
  } catch (err) {
    return errorResponse_(err, "saveHargaLayanan");
  }
}

/* ============================================================================
 * DATA SERVICE
 * ========================================================================== */

function getHargaLayananKey_(cabangId) {
  return "hargaLayanan_" + cabangId;
}

function sanitizeHargaLayananCabangId_(cabangId) {
  return typeof cabangId === "string" ? cabangId.trim() : "";
}

function readHargaLayananRecord_(cabangId) {
  try {
    // [FIRESTORE-FIRST, minim risiko] fallback Sheets kalau tidak ada/gagal.
    const tenantId = typeof activeDataSpreadsheetId_ === "function" ? activeDataSpreadsheetId_() : null;
    if (tenantId) {
      const doc = firestoreTryGetPath_(firestoreCabangDocPath_(tenantId, cabangId) + "/config/hargaLayanan");
      if (doc) {
        return {
          cabangId: doc.cabangId ? String(doc.cabangId) : cabangId,
          hargaJual: doc.hargaJual && typeof doc.hargaJual === "object" ? doc.hargaJual : {},
          minimumOrderKg: doc.minimumOrderKg && typeof doc.minimumOrderKg === "object" ? doc.minimumOrderKg : {},
          updatedAt: doc.updatedAt ? String(doc.updatedAt) : "",
        };
      }
    }

    const sheet = ensureDataSheet_();
    const raw = readKey_(sheet, getHargaLayananKey_(cabangId));
    if (!raw) {
      return { cabangId: cabangId, hargaJual: {}, minimumOrderKg: {}, updatedAt: "" };
    }

    const parsed = JSON.parse(raw);
    return {
      cabangId: parsed && parsed.cabangId ? String(parsed.cabangId) : cabangId,
      hargaJual: parsed && parsed.hargaJual && typeof parsed.hargaJual === "object" ? parsed.hargaJual : {},
      minimumOrderKg: parsed && parsed.minimumOrderKg && typeof parsed.minimumOrderKg === "object" ? parsed.minimumOrderKg : {},
      updatedAt: parsed && parsed.updatedAt ? String(parsed.updatedAt) : "",
    };
  } catch (err) {
    return { cabangId: cabangId, hargaJual: {}, minimumOrderKg: {}, updatedAt: "" };
  }
}

function getHargaLayananCabang_(cabangId) {
  try {
    if (typeof getCabang_impl_ === "function") {
      const res = getCabang_impl_(cabangId);
      if (res && res.ok && res.data && res.data.cabang) {
        const c = res.data.cabang;
        const profil = c.profil || {};
        return {
          id: cabangId,
          namaLaundry: profil.namaLaundry || c.namaLaundry || "",
          kategoriLayanan: profil.kategoriLayanan || c.kategoriLayanan || c.kategoriLaundry || "",
        };
      }
    }

    const sheet = ensureDataSheet_();
    const raw = readKey_(sheet, "cabang_" + cabangId);
    if (!raw) return null;

    const cabang = JSON.parse(raw);
    const profil = cabang.profil || {};
    return {
      id: cabangId,
      namaLaundry: profil.namaLaundry || cabang.namaLaundry || "",
      kategoriLayanan: profil.kategoriLayanan || cabang.kategoriLayanan || cabang.kategoriLaundry || "",
    };
  } catch (err) {
    return null;
  }
}

function readHargaLayananHPP_(cabangId) {
  try {
    // [2026-07-21 FIRESTORE] Baca via cache Firestore (fallback otomatis ke
    // Sheets kalau computed belum ada) -- konsisten dengan layar HPP & Dashboard.
    if (typeof getStrukturBiayaHPPFast_ !== "function") {
      return {
        ok: false,
        error: "Fungsi getStrukturBiayaHPPFast_ belum tersedia.",
        stage: "readHargaLayananHPP_:missing_getStrukturBiayaHPP",
      };
    }
    return getStrukturBiayaHPPFast_(cabangId);
  } catch (err) {
    return errorResponse_(err, "readHargaLayananHPP_");
  }
}

/* ============================================================================
 * NORMALIZE & CALCULATION
 * ========================================================================== */

function normalizeHargaLayananKategori_(kategori) {
  const k = String(kategori || "").toLowerCase();

  if (k === "self_service" || k === "self service" || k === "self-service") {
    return "self_service";
  }

  if (k === "hybrid") {
    return "hybrid";
  }

  if (k === "jasa_setrika" || k === "jasa setrika") {
    return "jasa_setrika";
  }

  if (
    k === "drop_off" ||
    k === "drop off" ||
    k === "drop-off" ||
    k === "kiloan" ||
    k === "drop_off_kiloan" ||
    k === "drop off / kiloan"
  ) {
    return "drop_off";
  }

  return "drop_off";
}

function getHargaLayananKategoriLabel_(kategori) {
  if (kategori === "self_service") return "Self Service";
  if (kategori === "hybrid") return "Hybrid";
  if (kategori === "jasa_setrika") return "Jasa Setrika";
  return "Drop Off / Kiloan";
}

function buildHargaLayananHPPMap_(hppResult) {
  const map = {};

  if (!hppResult || !hppResult.ok || !hppResult.data || !Array.isArray(hppResult.data.layanan)) {
    return map;
  }

  hppResult.data.layanan.forEach(function (item) {
    if (!item || !item.key) return;

    const key = String(item.key);
    const total = toNumber_(item.total, 0);

    map[key] = {
      key: key,
      title: item.title || "",
      total: round2_(total),
      unitLabel: item.unitLabel || "per load",
    };
  });

  return map;
}

function getHargaLayananDefinitions_(kategori, aktifMap, customLayananDefs) {
  const customDefs = (Array.isArray(customLayananDefs) ? customLayananDefs : []).map(function (d) {
    return { key: d.key, title: d.title, hppSourceKey: d.key, unitLabel: d.unitLabel || (kategori === "self_service" ? "per load" : "per kg"), isCustom: true };
  });

  if (kategori === "self_service") {
    // Layanan mana yang tampil mengikuti toggle aktif di kartu Struktur
    // Biaya HPP (aktifMap) - sama seperti drop_off/hybrid, supaya laundry
    // yang mematikan mis. "Kering Saja" otomatis tidak lagi punya baris
    // harga di Harga Layanan (dan tidak ikut BEP/Potensi Omset).
    const aktif = aktifMap || {};
    const defs = [];
    if (aktif.cuci_saja !== false) {
      defs.push({ key: "cuci_saja", title: "Cuci Saja", hppSourceKey: "cuci_saja", unitLabel: "per load" });
    }
    if (aktif.kering_saja !== false) {
      defs.push({ key: "kering_saja", title: "Kering Saja", hppSourceKey: "kering_saja", unitLabel: "per load" });
    }
    if (aktif.cuci_kering !== false) {
      defs.push({ key: "cuci_kering", title: "Cuci Kering", hppSourceKey: "cuci_kering", unitLabel: "per load" });
    }
    return defs.concat(customDefs);
  }

  if (kategori === "jasa_setrika") {
    return [
      {
        key: "setrika_saja",
        title: "Setrika Saja",
        hppSourceKey: "setrika_saja",
        unitLabel: "per kg",
      },
    ].concat(customDefs);
  }

  // drop_off/hybrid: layanan mana yang tampil mengikuti toggle aktif di
  // kartu Struktur Biaya HPP (aktifMap), bukan lagi daftar tetap - laundry
  // yang mematikan mis. "Cuci Saja" di sana otomatis tidak lagi punya baris
  // harga di Harga Layanan.
  const aktif = aktifMap || {};
  const defs = [];

  if (aktif.cuci_saja !== false) {
    defs.push({ key: "cuci_saja", title: "Cuci Saja", hppSourceKey: "cuci_saja", unitLabel: "per kg" });
  }
  if (aktif.cuci_kering_lipat !== false) {
    defs.push({ key: "cuci_kering_lipat", title: "Cuci Kering Lipat", hppSourceKey: "cuci_kering_lipat", unitLabel: "per kg" });
  }
  if (aktif.cuci_kering_setrika !== false) {
    defs.push({ key: "cuci_kering_setrika", title: "Cuci Kering Setrika", hppSourceKey: "cuci_kering_setrika", unitLabel: "per kg" });
  }
  if (aktif.setrika_saja !== false) {
    defs.push({ key: "setrika_saja", title: "Setrika Saja", hppSourceKey: "setrika_saja", unitLabel: "per kg" });
  }
  if (aktif.bed_cover !== false) {
    defs.push({ key: "bed_cover", title: "Bed Cover", hppSourceKey: "bed_cover", unitLabel: "per item" });
  }

  return defs.concat(customDefs);
}

function buildHargaLayananItems_(kategori, hppMap, storedHargaJual, aktifMap, konversi, storedMinimumOrderKg, recoContext, customLayananDefs) {
  const defs = getHargaLayananDefinitions_(kategori, aktifMap, customLayananDefs);
  const items = [];
  const kapasitasKgPerLoad = toNumber_(konversi && konversi.kapasitasKgPerLoad, 0);
  const setrikaKapasitasKgPerJam = toNumber_(konversi && konversi.setrikaKapasitasKgPerJam, 0);
  const minimumOrderKgMap = storedMinimumOrderKg && typeof storedMinimumOrderKg === "object" ? storedMinimumOrderKg : {};

  defs.forEach(function (def) {
    const hppItem = hppMap[def.hppSourceKey] || null;
    const hpp = hppItem ? toNumber_(hppItem.total, 0) : 0;
    const hargaJual = Math.max(0, toNumber_(storedHargaJual[def.key], 0));
    const margin = round2_(hargaJual - hpp);
    const marginPercent = hargaJual > 0 ? round2_((margin / hargaJual) * 100) : 0;

    const item = {
      key: def.key,
      title: def.title,
      unitLabel: def.unitLabel,
      hpp: round2_(hpp),
      hargaJual: round2_(hargaJual),
      margin: margin,
      marginPercent: marginPercent,
      status: getHargaLayananMarginStatus_(margin, marginPercent),
      statusLabel: getHargaLayananMarginStatusLabel_(margin, marginPercent),
      note: "Margin bukan laba bersih",
      hppReady: !!hppItem && hpp > 0,
    };

    // Kiloan (drop_off/hybrid, KECUALI Bed Cover yang basisnya per item):
    // HPP sumbernya sudah PER LOAD (lihat buildKiloanHPPStructure_ di
    // Modul_StrukturBiayaHPP.gs), sedang Harga Jual disimpan PER KG - jadi
    // dirincikan dua basis sekaligus (Per Load & Per Kg) supaya jelas apple-
    // to-apple, dikonversi lewat kapasitasKgPerLoad mesin cuci.
    if ((kategori === "drop_off" || kategori === "hybrid") && def.key !== "bed_cover") {
      const hppPerLoad = hpp;
      const hargaJualPerKg = hargaJual;
      const hargaJualPerLoad = round2_(hargaJualPerKg * kapasitasKgPerLoad);
      const hppPerKg = kapasitasKgPerLoad > 0 ? round2_(hppPerLoad / kapasitasKgPerLoad) : 0;
      const marginPerLoad = round2_(hargaJualPerLoad - hppPerLoad);
      const marginPercentPerLoad = hargaJualPerLoad > 0 ? round2_((marginPerLoad / hargaJualPerLoad) * 100) : 0;
      const marginPerKg = round2_(hargaJualPerKg - hppPerKg);
      const marginPercentPerKg = hargaJualPerKg > 0 ? round2_((marginPerKg / hargaJualPerKg) * 100) : 0;

      item.hargaJualPerKg = round2_(hargaJualPerKg);
      item.hppPerLoad = round2_(hppPerLoad);
      item.marginPerLoad = marginPerLoad;
      item.marginPercentPerLoad = marginPercentPerLoad;
      item.hppPerKg = round2_(hppPerKg);
      item.marginPerKg = marginPerKg;
      item.marginPercentPerKg = marginPercentPerKg;
      // Kapasitas kg mesin cuci per 1x load - dipakai frontend utk simulasi
      // "order minimal X Kg" (idealnya order = kapasitas 1x jalan mesin,
      // supaya HPP Per Load benar-benar tertutup, bukan cuma dari 1 Kg saja).
      item.kapasitasKgPerLoad = round2_(kapasitasKgPerLoad);

      // Field utama (hpp/margin/marginPercent/status) dipakai jadi badge &
      // progress bar ringkasan (sebelum di-klik buka detail) - HARUS basis
      // per Kg (apple-to-apple dgn Harga Jual yg juga per Kg), bukan per
      // Load, supaya tidak menyesatkan. hpp/margin/marginPercent asli (per
      // Load vs per Kg tercampur) sengaja ditimpa di sini.
      item.hpp = round2_(hppPerKg);
      item.margin = marginPerKg;
      item.marginPercent = marginPercentPerKg;
      item.status = getHargaLayananMarginStatus_(marginPerKg, marginPercentPerKg);
      item.statusLabel = getHargaLayananMarginStatusLabel_(marginPerKg, marginPercentPerKg);
    }

    // [2026-07-13] Jasa Setrika: HPP sumbernya sekarang sudah PER LOAD/PER
    // JAM LANGSUNG (lihat buildJasaSetrikaHPPStructure_ di Modul_StrukturBiayaHPP.gs,
    // basis HPP kategori ini diubah dari per Kg jadi per Load) - JANGAN
    // dikalikan kapasitas kg/jam lagi (dulu begitu waktu HPP masih per Kg,
    // sekarang jadi dobel hitung). Pola disamakan persis dengan blok Kiloan
    // di atas: hpp APA ADANYA = per siklus, hppPerKg didapat dari MEMBAGI
    // (bukan mengalikan) dengan kapasitas, cuma untuk info tambahan.
    if (kategori === "jasa_setrika") {
      const hppPerJam = hpp;
      const hargaJualPerKg = hargaJual;
      const hppPerKg = setrikaKapasitasKgPerJam > 0 ? round2_(hppPerJam / setrikaKapasitasKgPerJam) : 0;
      const marginPerJam = round2_(hargaJualPerKg * setrikaKapasitasKgPerJam - hppPerJam);
      const hargaJualPerJamAcuan_ = round2_(hargaJualPerKg * setrikaKapasitasKgPerJam);
      const marginPercentPerJam = hargaJualPerJamAcuan_ > 0 ? round2_((marginPerJam / hargaJualPerJamAcuan_) * 100) : 0;
      const marginPerKg = round2_(hargaJualPerKg - hppPerKg);
      const marginPercentPerKg = hargaJualPerKg > 0 ? round2_((marginPerKg / hargaJualPerKg) * 100) : 0;

      item.hargaJualPerKg = round2_(hargaJualPerKg);
      item.hppPerJam = round2_(hppPerJam);
      item.marginPerJam = marginPerJam;
      item.marginPercentPerJam = marginPercentPerJam;
      item.hppPerKg = hppPerKg;
      item.marginPerKg = marginPerKg;
      item.marginPercentPerKg = marginPercentPerKg;
      // Kapasitas kg mesin setrika per 1 jam - dipakai frontend utk simulasi
      // "order minimal X Kg per jam", supaya HPP Per Jam benar-benar tertutup.
      item.setrikaKapasitasKgPerJam = round2_(setrikaKapasitasKgPerJam);
    }

    // Minimum Order (Kg) -- diisi manual oleh user (beda dari kapasitasKgPerLoad
    // yang otomatis dari mesin), dipakai utk hitung margin card utama:
    // margin = (hargaJual per Kg x minimumOrderKg) - HPP per siklus (per
    // Load/Jam, BUKAN per Kg). Cuma berlaku utk layanan berbasis per Kg
    // (kiloan non-Bed Cover & Jasa Setrika) -- Self Service & Bed Cover sudah
    // per Load/per item langsung, tidak butuh perkalian ini.
    if (def.unitLabel === "per kg" && (item.hppPerLoad !== undefined || item.hppPerJam !== undefined)) {
      const minimumOrderKg = Math.max(0, toNumber_(minimumOrderKgMap[def.key], 0));
      item.minimumOrderKg = round2_(minimumOrderKg);

      if (minimumOrderKg > 0) {
        const hppPerSiklus = item.hppPerLoad !== undefined ? item.hppPerLoad : item.hppPerJam;
        const omzetMinimumOrder = round2_(hargaJual * minimumOrderKg);
        const marginMinimumOrder = round2_(omzetMinimumOrder - hppPerSiklus);
        const marginPercentMinimumOrder = omzetMinimumOrder > 0 ? round2_((marginMinimumOrder / omzetMinimumOrder) * 100) : 0;

        item.omzetMinimumOrder = omzetMinimumOrder;
        item.marginMinimumOrder = marginMinimumOrder;
        item.marginPercentMinimumOrder = marginPercentMinimumOrder;

        // Margin card utama (dipakai badge status & progress bar) ditimpa
        // pakai hasil kali minimum order ini -- inilah margin yang benar-
        // benar dibayar pelanggan dalam satu transaksi, bukan cuma per Kg.
        item.margin = marginMinimumOrder;
        item.marginPercent = marginPercentMinimumOrder;
        item.status = getHargaLayananMarginStatus_(marginMinimumOrder, marginPercentMinimumOrder);
        item.statusLabel = getHargaLayananMarginStatusLabel_(marginMinimumOrder, marginPercentMinimumOrder);
      }
    }

    // Self Service: sematkan konteks cost-plus (fixed cost per siklus mesin +
    // apakah biaya tetap sudah diisi) supaya frontend bisa rekomendasi harga
    // jual per load. Aditif -- tidak menyentuh margin/status yang sudah ada.
    if (kategori === "self_service" && recoContext) {
      item.fixedCostPerCycle = round2_(toNumber_(recoContext.fixedCostPerCycle, 0));
      item.hasFixedData = !!recoContext.hasFixedData;
    }

    items.push(item);
  });

  return items;
}

function getHargaLayananMarginStatus_(margin, marginPercent) {
  if (margin < 0) return "rugi";
  if (margin === 0) return "impas";
  if (marginPercent > 0 && marginPercent < 20) return "tipis";
  return "aman";
}

function getHargaLayananMarginStatusLabel_(margin, marginPercent) {
  if (margin < 0) return "Rugi";
  if (margin === 0) return "Impas";
  if (marginPercent > 0 && marginPercent < 20) return "Tipis";
  return "Aman";
}

function sanitizeHargaLayananPayload_(payload, extraAllowedKeys) {
  const input = payload && typeof payload === "object" ? payload : {};
  const hargaJualInput = input.hargaJual && typeof input.hargaJual === "object" ? input.hargaJual : {};
  const minimumOrderKgInput = input.minimumOrderKg && typeof input.minimumOrderKg === "object" ? input.minimumOrderKg : {};
  const hargaJual = {};
  const minimumOrderKg = {};
  // [2026-07-22] extraAllowedKeys = key layanan CUSTOM milik cabang ini
  // (Modul_StrukturBiayaHPP.gs, Firestore) - tanpa ini hargaJual/minimumOrderKg
  // utk layanan custom akan DIBUANG diam-diam (celah yg sama seperti allowedKeys
  // lama, cuma diperluas per-cabang, bukan dibuka bebas ke key apa pun).
  const allowedKeys = [
    "cuci_saja",
    "kering_saja",
    "cuci_kering",
    "cuci_kering_lipat",
    "cuci_kering_setrika",
    "setrika_saja",
    "bed_cover",
  ].concat(Array.isArray(extraAllowedKeys) ? extraAllowedKeys : []);

  allowedKeys.forEach(function (key) {
    hargaJual[key] = Math.max(0, round2_(toNumber_(hargaJualInput[key], 0)));
    minimumOrderKg[key] = Math.max(0, round2_(toNumber_(minimumOrderKgInput[key], 0)));
  });

  return { hargaJual: hargaJual, minimumOrderKg: minimumOrderKg };
}

function buildHargaLayananWarnings_(hppResult, layanan) {
  const warnings = [];

  if (!hppResult || !hppResult.ok) {
    warnings.push("Lengkapi Struktur Biaya HPP terlebih dahulu agar margin layanan bisa dihitung.");
  }

  if (hppResult && hppResult.ok && hppResult.data && Array.isArray(hppResult.data.warnings)) {
    hppResult.data.warnings.forEach(function (msg) {
      if (msg) warnings.push(msg);
    });
  }

  layanan.forEach(function (item) {
    if (!item.hppReady) {
      warnings.push("HPP " + item.title + " belum tersedia. Margin layanan ini sementara dihitung dari HPP Rp0.");
    }
  });

  return uniqueHargaLayananArray_(warnings);
}

function uniqueHargaLayananArray_(arr) {
  const seen = {};
  const out = [];

  arr.forEach(function (item) {
    const text = String(item || "").trim();
    if (!text || seen[text]) return;
    seen[text] = true;
    out.push(text);
  });

  return out;
}
