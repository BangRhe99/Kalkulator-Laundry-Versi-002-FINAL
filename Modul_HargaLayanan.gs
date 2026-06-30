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

function getHargaLayanan(cabangId) {
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
    const layanan = buildHargaLayananItems_(kategoriFinal, hppMap, stored.hargaJual || {});

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

function saveHargaLayanan(cabangId, payload) {
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

    const cleanPayload = sanitizeHargaLayananPayload_(payload);
    const sheet = ensureDataSheet_();

    const record = {
      cabangId: cleanCabangId,
      hargaJual: cleanPayload.hargaJual,
      updatedAt: new Date().toISOString(),
    };

    writeKey_(sheet, getHargaLayananKey_(cleanCabangId), JSON.stringify(record));

    return getHargaLayanan(cleanCabangId);
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
    const sheet = ensureDataSheet_();
    const raw = readKey_(sheet, getHargaLayananKey_(cabangId));
    if (!raw) {
      return { cabangId: cabangId, hargaJual: {}, updatedAt: "" };
    }

    const parsed = JSON.parse(raw);
    return {
      cabangId: parsed && parsed.cabangId ? String(parsed.cabangId) : cabangId,
      hargaJual: parsed && parsed.hargaJual && typeof parsed.hargaJual === "object" ? parsed.hargaJual : {},
      updatedAt: parsed && parsed.updatedAt ? String(parsed.updatedAt) : "",
    };
  } catch (err) {
    return { cabangId: cabangId, hargaJual: {}, updatedAt: "" };
  }
}

function getHargaLayananCabang_(cabangId) {
  try {
    if (typeof getCabang === "function") {
      const res = getCabang(cabangId);
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
    if (typeof getStrukturBiayaHPP !== "function") {
      return {
        ok: false,
        error: "Fungsi getStrukturBiayaHPP belum tersedia.",
        stage: "readHargaLayananHPP_:missing_getStrukturBiayaHPP",
      };
    }
    return getStrukturBiayaHPP(cabangId);
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

function getHargaLayananDefinitions_(kategori) {
  if (kategori === "self_service") {
    return [
      {
        key: "cuci_saja",
        title: "Cuci Saja",
        hppSourceKey: "cuci_saja",
        unitLabel: "per load",
      },
      {
        key: "kering_saja",
        title: "Kering Saja",
        hppSourceKey: "kering_saja",
        unitLabel: "per load",
      },
      {
        key: "cuci_kering",
        title: "Cuci Kering",
        hppSourceKey: "cuci_kering",
        unitLabel: "per load",
      },
    ];
  }

  return [
    {
      key: "cuci_saja",
      title: "Cuci Saja",
      hppSourceKey: "cuci_saja",
      unitLabel: "per kg",
    },
    {
      key: "cuci_kering_lipat",
      title: "Cuci Kering Lipat",
      hppSourceKey: "cuci_kering",
      unitLabel: "per kg",
    },
    {
      key: "cuci_kering_setrika",
      title: "Cuci Kering Setrika",
      hppSourceKey: "cuci_kering",
      unitLabel: "per kg",
    },
    {
      key: "setrika_saja",
      title: "Setrika Saja",
      hppSourceKey: "setrika_saja",
      unitLabel: "per kg",
    },
    {
      key: "bed_cover",
      title: "Bed Cover",
      hppSourceKey: "bed_cover",
      unitLabel: "per item",
    },
  ];
}

function buildHargaLayananItems_(kategori, hppMap, storedHargaJual) {
  const defs = getHargaLayananDefinitions_(kategori);
  const items = [];

  defs.forEach(function (def) {
    const hppItem = hppMap[def.hppSourceKey] || null;
    const hpp = hppItem ? toNumber_(hppItem.total, 0) : 0;
    const hargaJual = Math.max(0, toNumber_(storedHargaJual[def.key], 0));
    const margin = round2_(hargaJual - hpp);
    const marginPercent = hargaJual > 0 ? round2_((margin / hargaJual) * 100) : 0;

    items.push({
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
    });
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

function sanitizeHargaLayananPayload_(payload) {
  const input = payload && typeof payload === "object" ? payload : {};
  const hargaJualInput = input.hargaJual && typeof input.hargaJual === "object" ? input.hargaJual : {};
  const hargaJual = {};
  const allowedKeys = [
    "cuci_saja",
    "kering_saja",
    "cuci_kering",
    "cuci_kering_lipat",
    "cuci_kering_setrika",
    "setrika_saja",
    "bed_cover",
  ];

  allowedKeys.forEach(function (key) {
    hargaJual[key] = Math.max(0, round2_(toNumber_(hargaJualInput[key], 0)));
  });

  return { hargaJual: hargaJual };
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
