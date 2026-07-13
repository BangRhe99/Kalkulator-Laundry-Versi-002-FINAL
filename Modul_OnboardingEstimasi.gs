/**
 * ============================================================================
 * MODUL: ONBOARDING ESTIMASI CEPAT
 * ============================================================================
 * Fitur "Template Estimasi": user baru pilih 1 dari 4 kategori bisnis lalu
 * isi 3 input (sewa, gaji, harga gas per tabung) - sistem KLONING salah satu
 * dari 4 outlet template milik admin (dibuat manual lewat Profil Outlet +
 * Master Biaya + Harga Layanan + Biaya Tetap Outlet biasa, nama PERSIS harus
 * cocok dgn ONBOARDING_TEMPLATE_NAMES_ di bawah) jadi outlet PERTAMA milik
 * user itu - SEMUA data template disalin (mesin, listrik, air, chemical,
 * packing, harga jual), cuma sewa/gaji/gas diganti input user. Outlet hasil
 * kloning ini SUNGGUHAN (bisa terus diedit user spt outlet biasa), bukan
 * cuma angka sekali-lihat.
 *
 * CARA BACA DATA TEMPLATE ADMIN:
 * Template disimpan di spreadsheet TENANT ADMIN (AUTH_ADMIN_EMAIL_,
 * Modul_Auth.gs) - BUKAN di tenant user yang sedang login. Modul ini SATU-
 * SATUNYA tempat yang boleh baca-tulis LINTAS TENANT (buka spreadsheet lain
 * secara eksplisit), semua modul lain tetap terbatas ke tenant sendiri lewat
 * withTenant_/_activeDataSpreadsheet_ seperti biasa.
 * ============================================================================
 */

var ONBOARDING_TEMPLATE_NAMES_ = {
  jasa_setrika: "Master Jasa Setrika",
  self_service: "Master Self Service",
  hybrid: "Master Hybrid",
  drop_off: "Master Dropoff/Kiloan",
};

var ONBOARDING_CATEGORY_TITLES_ = {
  jasa_setrika: "Jasa Setrika",
  self_service: "Self Service",
  hybrid: "Hybrid",
  drop_off: "Drop Off / Kiloan",
};

function getOnboardingCategories(sessionToken) {
  return withTenant_(sessionToken, function () {
    return {
      ok: true,
      data: {
        categories: Object.keys(ONBOARDING_TEMPLATE_NAMES_).map(function (key) {
          return { key: key, title: ONBOARDING_CATEGORY_TITLES_[key] };
        }),
      },
    };
  });
}

/**
 * getMasterSheetDirect_: sheet "_data_operasional" milik spreadsheet Master
 * (container-bound script ini) SELALU, terlepas dari tenant siapa yang
 * sedang login - BEDA dari ensureDataSheet_() yang ikut _activeDataSpreadsheet_.
 * Dipakai HANYA untuk cari tenantSpreadsheetId milik admin.
 */
function getMasterSheetDirect_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(DATA_SHEET_NAME);
}

function getAdminTenantSpreadsheet_() {
  var masterSheet = getMasterSheetDirect_();
  var raw = readKey_(masterSheet, authKeyUser_(AUTH_ADMIN_EMAIL_));
  if (!raw) {
    throw new Error("Akun admin belum terdaftar - template belum bisa dipakai.");
  }
  var adminUser = JSON.parse(raw);
  if (!adminUser.tenantSpreadsheetId) {
    throw new Error("Akun admin belum tersambung ke data tenant.");
  }
  return SpreadsheetApp.openById(adminUser.tenantSpreadsheetId);
}

/**
 * findTemplateCabangByName_: scan semua "cabang_<id>" di sheet admin, cari
 * yang namaLaundry-nya PERSIS sama (case-sensitive, sesuai instruksi ke user
 * saat isi template). Balikin objek cabang APA ADANYA (belum di-sanitize)
 * supaya field/id mesin ikut apa adanya saat dikloning.
 */
function findTemplateCabangByName_(adminSheet, exactName) {
  var rows = readKeysByPrefix_(adminSheet, "cabang_");
  for (var i = 0; i < rows.length; i++) {
    var parsed;
    try { parsed = JSON.parse(rows[i].value); } catch (e) { continue; }
    var nama = parsed && parsed.profil ? parsed.profil.namaLaundry : "";
    if (String(nama || "").trim() === exactName) return parsed;
  }
  return null;
}

function cloneOnboardingTemplate(sessionToken, kategoriKey, sewaPerTahun, gajiPerBulan, hargaGasPerTabung) {
  return withTenant_(sessionToken, function () {
    return cloneOnboardingTemplate_impl_(kategoriKey, sewaPerTahun, gajiPerBulan, hargaGasPerTabung);
  });
}

function cloneOnboardingTemplate_impl_(kategoriKey, sewaPerTahun, gajiPerBulan, hargaGasPerTabung) {
  try {
    var templateName = ONBOARDING_TEMPLATE_NAMES_[kategoriKey];
    if (!templateName) {
      return { ok: false, error: "Kategori tidak dikenali.", stage: "cloneOnboardingTemplate:validate_kategori" };
    }

    var adminSs = getAdminTenantSpreadsheet_();
    var adminSheet = adminSs.getSheetByName(DATA_SHEET_NAME);
    if (!adminSheet) {
      return { ok: false, error: "Data template admin belum siap.", stage: "cloneOnboardingTemplate:missing_admin_sheet" };
    }

    var templateCabang = findTemplateCabangByName_(adminSheet, templateName);
    if (!templateCabang || !templateCabang.id) {
      return { ok: false, error: "Template \"" + templateName + "\" belum dibuat admin di Profil Outlet.", stage: "cloneOnboardingTemplate:template_not_found" };
    }
    var templateId = templateCabang.id;

    // 1) Cabang - salin apa adanya (mesin & id-nya ikut, cuma nama & id
    // cabang yang diganti). createCabang_impl_ generate id baru sendiri.
    var cabangPayload = JSON.parse(JSON.stringify(templateCabang));
    delete cabangPayload.id;
    var cabangRes = createCabang_impl_(cabangPayload);
    if (!cabangRes || !cabangRes.ok) return cabangRes;
    var newCabangId = cabangRes.data.cabang.id;

    // 2) Gas (multi-record) - harga per tabung DIGANTI input user, sisanya
    // (kapasitas, acuan mesin dryer/setrika) ikut template.
    readKeysByPrefix_(adminSheet, "biayaGas_").forEach(function (row) {
      var rec;
      try { rec = JSON.parse(row.value); } catch (e) { return; }
      if (rec.cabangId !== templateId) return;
      var payload = JSON.parse(JSON.stringify(rec));
      delete payload.id;
      payload.cabangId = newCabangId;
      payload.hargaPerTabung = Math.max(0, Number(hargaGasPerTabung) || 0);
      createBiayaGas_impl_(payload);
    });

    // 3) Listrik (1 konfigurasi per cabang)
    var listrikRaw = readKey_(adminSheet, "biayaListrik_" + templateId);
    if (listrikRaw) {
      saveBiayaListrik_impl_(newCabangId, JSON.parse(listrikRaw));
    }

    // 4) Air (1 konfigurasi per cabang)
    var airRaw = readKey_(adminSheet, "biayaAir_" + templateId);
    if (airRaw) {
      saveBiayaAir_impl_(newCabangId, JSON.parse(airRaw));
    }

    // 5) Chemical (multi-record, apa adanya - takaran per Kg tidak
    // dipengaruhi input user)
    readKeysByPrefix_(adminSheet, "biayaChemical_").forEach(function (row) {
      var rec;
      try { rec = JSON.parse(row.value); } catch (e) { return; }
      if (rec.cabangId !== templateId) return;
      var payload = JSON.parse(JSON.stringify(rec));
      delete payload.id;
      payload.cabangId = newCabangId;
      createBiayaChemical_impl_(payload);
    });

    // 6) Packing (multi-record)
    readKeysByPrefix_(adminSheet, "biayaPacking_").forEach(function (row) {
      var rec;
      try { rec = JSON.parse(row.value); } catch (e) { return; }
      if (rec.cabangId !== templateId) return;
      var payload = JSON.parse(JSON.stringify(rec));
      delete payload.id;
      payload.cabangId = newCabangId;
      createBiayaPacking_impl_(payload);
    });

    // 7) Nota/Kasir (sheet sendiri, 1 baris per cabang)
    var adminNotaSheet = adminSs.getSheetByName("BiayaNotaKasir");
    if (adminNotaSheet) {
      var notaRowIndex = findBiayaNotaKasirRowFast_(adminNotaSheet, templateId);
      if (notaRowIndex > 0) {
        var notaValues = adminNotaSheet.getRange(notaRowIndex, 1, 1, BIAYA_NOTA_KASIR_HEADERS_.length).getValues()[0];
        var notaObj = rowArrayToBiayaNotaKasirObject_(notaValues);
        saveBiayaNotaKasir_impl_(newCabangId, notaObj);
      }
    }

    // 8) Harga Layanan (1 konfigurasi per cabang)
    var hargaRaw = readKey_(adminSheet, "hargaLayanan_" + templateId);
    if (hargaRaw) {
      var hargaObj = JSON.parse(hargaRaw);
      saveHargaLayanan_impl_(newCabangId, {
        hargaJual: hargaObj.hargaJual || {},
        minimumOrderKg: hargaObj.minimumOrderKg || {},
      });
    }

    // 9) Biaya Tetap Outlet (sheet sendiri) - sewa & gaji DIGANTI input user
    // (inilah inti "Estimasi Cepat"). Internet/perawatan/operasional lain
    // ikut template. Depresiasi mesin ikut template APA ADANYA (harga beli/
    // residu/masa aus per baris) - machineRefId-nya cocok krn id mesin
    // dipertahankan saat kloning cabang di langkah 1, jadi tetap nyambung ke
    // mesin outlet baru ini tanpa perlu dipetakan ulang.
    var fcPayload = {
      sewaPerTahun: Math.max(0, Number(sewaPerTahun) || 0),
      gajiRows: [{ id: "onb_gaji_1", nama: "Karyawan", jabatan: "", gajiPerBulan: Math.max(0, Number(gajiPerBulan) || 0) }],
      internetPerBulan: 0,
      perawatanPerBulan: 0,
      operasionalLainRows: [],
      depresiasiRows: [],
    };
    var adminFcSheet = adminSs.getSheetByName(BIAYA_TETAP_SHEET_NAME_);
    if (adminFcSheet) {
      var fcRowIndex = findBiayaTetapRowFast_(adminFcSheet, templateId);
      if (fcRowIndex > 0) {
        var fcValues = adminFcSheet.getRange(fcRowIndex, 1, 1, BIAYA_TETAP_HEADERS_.length).getValues()[0];
        var fcObj = rowArrayToBiayaTetapObject_(fcValues);
        fcPayload.internetPerBulan = Number(fcObj.internetPerBulan) || 0;
        fcPayload.perawatanPerBulan = Number(fcObj.perawatanPerBulan) || 0;
        try { fcPayload.operasionalLainRows = JSON.parse(fcObj.operasionalLainRowsJson || "[]"); } catch (e) {}
        try { fcPayload.depresiasiRows = JSON.parse(fcObj.depresiasiRowsJson || "[]"); } catch (e) {}
      }
    }
    saveBiayaTetapOutlet_impl_(newCabangId, fcPayload);

    // 10) Ringkasan estimasi - reuse Dashboard (tidak duplikasi rumus).
    var summaryRes = getDashboardFullSummary_impl_(newCabangId);

    return {
      ok: true,
      data: {
        cabangId: newCabangId,
        namaLaundry: cabangRes.data.cabang.profil.namaLaundry,
        summary: (summaryRes && summaryRes.ok) ? summaryRes.data : null,
      },
    };
  } catch (err) {
    return errorResponse_(err, "cloneOnboardingTemplate");
  }
}
