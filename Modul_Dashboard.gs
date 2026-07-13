/**
 * ============================================================================
 * MODUL: DASHBOARD MENU UTAMA
 * ============================================================================
 * Modul ini hanya membaca data dari modul existing untuk menampilkan rangkuman
 * kondisi outlet di Menu Utama.
 *
 * PUBLIC FUNCTIONS (argumen pertama SELALU sessionToken - lihat withTenant_
 * di Code.gs):
 * - getDashboardCabangSummary(sessionToken, cabangId)
 * - getDashboardMasterBiayaSummary(sessionToken, cabangId)
 * - getDashboardHPPSummary(sessionToken, cabangId)
 * - getDashboardHargaLayananSummary(sessionToken, cabangId)
 * - getDashboardFixedCostSummary(sessionToken, cabangId)
 * - getDashboardFullSummary(sessionToken, cabangId)
 * - saveBepServiceMix(sessionToken, cabangId, mixMap)
 * - getDashboardBEPSummary(sessionToken, cabangId)
 * - getDashboardPotensiOmsetSummary(sessionToken, cabangId)
 * ============================================================================
 */

function dashboardError_(err, stage) {
  if (typeof errorResponse_ === "function") {
    return errorResponse_(err, stage);
  }
  return {
    ok: false,
    error: err && err.message ? err.message : String(err || "Terjadi kesalahan."),
    stage: stage || "dashboard:unknown"
  };
}

function dashboardNumber_(value, fallback) {
  const n = Number(value);
  return isFinite(n) ? n : (fallback || 0);
}

function dashboardRound2_(value) {
  return Math.round(dashboardNumber_(value, 0) * 100) / 100;
}

function dashboardArray_(value) {
  return Array.isArray(value) ? value : [];
}

function dashboardFormatRp_(value) {
  var num = Math.round(dashboardNumber_(value, 0));
  var sign = num < 0 ? "-" : "";
  return sign + "Rp" + Math.abs(num).toLocaleString("id-ID");
}

// Cache baca-sekali-per-eksekusi: getDashboardFullSummary_impl_() memanggil 7
// fungsi kartu, dan HAMPIR SEMUANYA lewat dashboardGetCabangRows_() sendiri-
// sendiri -> listCabang_impl_() (JSON.parse + computeSummary_ tiap cabang) diulang
// berkali-kali padahal hasilnya identik dalam satu kali load dashboard.
// Variabel global Apps Script reset otomatis tiap eksekusi google.script.run
// baru, jadi aman dari data basi lintas request (pola sama seperti
// _dataSheetCache_ di Util_Penyimpanan.gs).
let _dashboardCabangRowsCache_ = null;

function dashboardGetCabangRows_() {
  if (_dashboardCabangRowsCache_) return _dashboardCabangRowsCache_;

  if (typeof listCabang_impl_ !== "function") {
    return {
      ok: false,
      error: "Fungsi listCabang_impl_ belum tersedia.",
      stage: "dashboardGetCabangRows_:listCabang_missing"
    };
  }

  const res = listCabang_impl_();
  if (!res || !res.ok) {
    return {
      ok: false,
      error: res && res.error ? res.error : "Gagal membaca daftar cabang.",
      stage: res && res.stage ? res.stage : "dashboardGetCabangRows_:listCabang_impl_"
    };
  }

  _dashboardCabangRowsCache_ = {
    ok: true,
    data: dashboardArray_(res.data)
  };
  return _dashboardCabangRowsCache_;
}

function dashboardOutletName_(item) {
  if (!item) return "Outlet tanpa nama";
  return String(item.namaLaundry || item.nama || item.namaCabang || "Outlet tanpa nama");
}

// [2026-07-13] 9 fungsi publik Dashboard di bawah ini (semua "getDashboard*"
// + saveBepServiceMix) dibungkus withTenant_ (Code.gs) - argumen pertama
// SELALU sessionToken, badan logic asli dipindah ke nama "_impl_". Panggilan
// silang antar fungsi Dashboard (mis. getDashboardFullSummary_impl_ ->
// getDashboardCabangSummary_impl_ dkk) SUDAH diarahkan ke versi "_impl_"
// (lihat masing-masing).
function getDashboardCabangSummary(sessionToken, cabangId) {
  return withTenant_(sessionToken, function () { return getDashboardCabangSummary_impl_(cabangId); });
}

function getDashboardCabangSummary_impl_(cabangId) {
  try {
    const cabangRes = dashboardGetCabangRows_();
    if (!cabangRes.ok) return cabangRes;

    const allRows = cabangRes.data;
    const filtered = cabangId ? allRows.filter(function(r) { return r.id === cabangId; }) : allRows;
    const rows = filtered.map(function (item) {
      const summary = item.summary || {};
      const cuci = summary.cuci || {};
      const kering = summary.kering || {};

      // Dulu di sini panggil getCabang(item.id) lagi (baca ulang sheet) hanya
      // untuk ambil mesinCuci/mesinPengering/okupansi. Sekarang listCabang_impl_()
      // sudah menyertakan field ini langsung, jadi tidak perlu fetch kedua.
      const mesinCuci = dashboardArray_(item.mesinCuci);
      const mesinPengering = dashboardArray_(item.mesinPengering);
      const mesinSetrika = dashboardArray_(item.mesinSetrika);
      const setrikaSummary = summary.setrika || {};
      const okupansiSrc = item.okupansi || {};
      const okupansiCuci = dashboardNumber_(okupansiSrc.cuciPersen, 0);
      const okupansiKering = dashboardNumber_(okupansiSrc.keringPersen, 0);
      const okupansiSetrika = dashboardNumber_(okupansiSrc.setrikaPersen, 0);

      return {
        cabangId: String(item.id || ""),
        namaLaundry: dashboardOutletName_(item),
        kategoriLayanan: String(item.kategoriLayanan || ""),
        totalUnitCuci: dashboardNumber_(item.totalUnitCuci, 0),
        totalUnitPengering: dashboardNumber_(item.totalUnitPengering, 0),
        loadCuciPerBulan: dashboardRound2_(cuci.loadPerBulan),
        loadKeringPerBulan: dashboardRound2_(kering.loadPerBulan),
        jamBukaMenit: dashboardNumber_(item.jamBukaMenit, 0),
        jamTutupMenit: dashboardNumber_(item.jamTutupMenit, 0),
        jenisCuci: (function() { if (!mesinCuci.length) return ""; var j = mesinCuci[0].jenis || ""; return j === "rumah_tangga" ? "home" : j === "komersial" ? "commercial" : j; })(),
        jenisKering: (function() { if (!mesinPengering.length) return ""; var j = mesinPengering[0].jenis || ""; return j === "komersial" ? "commercial" : j; })(),
        durasiCuci: mesinCuci.length ? dashboardNumber_(mesinCuci[0].durasiMenit, 0) : 0,
        durasiKering: mesinPengering.length ? dashboardNumber_(mesinPengering[0].durasiMenit, 0) : 0,
        okupansiCuci: okupansiCuci,
        okupansiKering: okupansiKering,
        totalUnitSetrika: dashboardNumber_(setrikaSummary.totalUnit, 0),
        kapasitasSetrikaKgPerJam: dashboardRound2_(setrikaSummary.kapasitasKgPerJam),
        kgSetrikaPerBulan: dashboardRound2_(setrikaSummary.kgPerBulan),
        jenisSetrika: mesinSetrika.length ? String(mesinSetrika[0].jenis || "") : "",
        okupansiSetrika: okupansiSetrika
      };
    });

    return {
      ok: true,
      data: {
        totalOutlet: rows.length,
        rows: rows
      }
    };
  } catch (err) {
    return dashboardError_(err, "getDashboardCabangSummary_impl_");
  }
}

// Gabungan 6 fungsi Dashboard jadi 1 eksekusi server: browser cukup 1 kali
// google.script.run, dan cache baca sheet (Util_Penyimpanan.gs) kepakai
// bersama oleh keenam sub-panggilan di bawah (bukan reset tiap panggilan).
function getDashboardFullSummary(sessionToken, cabangId) {
  return withTenant_(sessionToken, function () { return getDashboardFullSummary_impl_(cabangId); });
}

function getDashboardFullSummary_impl_(cabangId) {
  try {
    return {
      ok: true,
      data: {
        cabang: getDashboardCabangSummary_impl_(cabangId),
        masterBiaya: getDashboardMasterBiayaSummary_impl_(cabangId),
        hpp: getDashboardHPPSummary_impl_(cabangId),
        hargaLayanan: getDashboardHargaLayananSummary_impl_(cabangId),
        fixedCost: getDashboardFixedCostSummary_impl_(cabangId),
        bep: getDashboardBEPSummary_impl_(cabangId),
        potensiOmset: getDashboardPotensiOmsetSummary_impl_(cabangId)
      }
    };
  } catch (err) {
    return dashboardError_(err, "getDashboardFullSummary_impl_");
  }
}

function getDashboardMasterBiayaSummary(sessionToken, cabangId) {
  return withTenant_(sessionToken, function () { return getDashboardMasterBiayaSummary_impl_(cabangId); });
}

function getDashboardMasterBiayaSummary_impl_(cabangId) {
  try {
    const cabangRes = dashboardGetCabangRows_();
    if (!cabangRes.ok) return cabangRes;

    const allRows = cabangRes.data;
    const filtered = cabangId ? allRows.filter(function(r) { return r.id === cabangId; }) : allRows;
    const rows = filtered.map(function (item) {
      const cabangId = String(item.id || "");
      const missing = [];
      let lengkapCount = 0;

      let gasComplete = false;
      try {
        if (typeof listBiayaGas_impl_ === "function") {
          const gasRes = listBiayaGas_impl_(cabangId);
          gasComplete = !!(gasRes && gasRes.ok && gasRes.data && Array.isArray(gasRes.data.items) && gasRes.data.items.length > 0);
        }
      } catch (e) {}
      if (gasComplete) lengkapCount++; else missing.push("Gas");

      let listrikComplete = false;
      try {
        if (typeof getBiayaListrik_impl_ === "function") {
          const listrikRes = getBiayaListrik_impl_(cabangId);
          listrikComplete = !!(listrikRes && listrikRes.ok && listrikRes.data && listrikRes.data.record && listrikRes.data.record.updatedAt);
        }
      } catch (e) {}
      if (listrikComplete) lengkapCount++; else missing.push("Listrik");

      let airComplete = false;
      try {
        if (typeof getBiayaAir_impl_ === "function") {
          const airRes = getBiayaAir_impl_(cabangId);
          airComplete = !!(airRes && airRes.ok && airRes.data && airRes.data.record && airRes.data.record.updatedAt);
        }
      } catch (e) {}
      if (airComplete) lengkapCount++; else missing.push("Air");

      let notaComplete = false;
      try {
        if (typeof getBiayaNotaKasir_impl_ === "function") {
          const notaRes = getBiayaNotaKasir_impl_(cabangId);
          notaComplete = !!(notaRes && notaRes.ok && notaRes.data && notaRes.data.record && notaRes.data.record.updatedAt);
        }
      } catch (e) {}
      if (notaComplete) lengkapCount++; else missing.push("Nota/Kasir");

      let chemicalComplete = false;
      try {
        if (typeof listBiayaChemical_impl_ === "function") {
          const chemicalRes = listBiayaChemical_impl_(cabangId);
          chemicalComplete = !!(chemicalRes && chemicalRes.ok && chemicalRes.data && Array.isArray(chemicalRes.data.items) && chemicalRes.data.items.length > 0);
        }
      } catch (e) {}
      if (chemicalComplete) lengkapCount++; else missing.push("Chemical");

      let packingComplete = false;
      try {
        if (typeof listBiayaPacking_impl_ === "function") {
          const packingRes = listBiayaPacking_impl_(cabangId);
          packingComplete = !!(packingRes && packingRes.ok && packingRes.data && Array.isArray(packingRes.data.items) && packingRes.data.items.length > 0);
        }
      } catch (e) {}
      if (packingComplete) lengkapCount++; else missing.push("Packing");
      // Ambil nilai biaya per load per komponen
      const komponenBiaya = [];
      let totalBiayaPerLoad = 0;
      let gasCardRef = null;

      try {
        if (typeof listBiayaGas_impl_ === "function") {
          const gasRes = listBiayaGas_impl_(cabangId);
          if (gasRes && gasRes.ok && gasRes.data && gasRes.data.items) {
            // Kategori Jasa Setrika: gas dipakai untuk memanaskan setrika uap,
            // dihitung PER JAM (s.biayaGasSetrikaPerJam, diisi kalau record
            // punya acuan mesin setrika), bukan per load seperti kategori lain
            // yang merujuk mesin pengering (s.biayaPerLoad). Satu tabung gas
            // bisa punya kedua acuan sekaligus - baca field yang sesuai per
            // item supaya nilainya tidak selalu Rp0.
            const isJasaSetrika = String(item.kategoriLayanan || "") === "jasa_setrika";
            let gasTotalPerLoad = 0;
            let gasTotalPerJam = 0;
            const gasItems = dashboardArray_(gasRes.data.items);
            gasItems.forEach(function(g) {
              const s = g.summary || {};
              gasTotalPerJam += dashboardNumber_(s.biayaGasSetrikaPerJam, 0);
              gasTotalPerLoad += dashboardNumber_(s.biayaPerLoad, 0);
            });

            // gasCard: field APA ADANYA persis kartu "Analisa Biaya Gas" per
            // record (Harga per tabung/Estimasi pemakaian/Konversi
            // waktu/Estimasi load/Biaya Gas Dryer Per Load/Biaya Gas Setrika
            // Per Jam) - diambil dari tabung PERTAMA (mayoritas outlet cuma
            // punya 1 konfigurasi tabung). Dua nominal Rp terakhir pakai
            // TOTAL semua tabung (gasTotalPerLoad/gasTotalPerJam, SAMA PERSIS
            // angka yang dipakai totalBiayaPerLoad di bawah, bukan hitungan
            // baru) supaya konsisten kalau ada >1 tabung. moreCount dipakai
            // frontend utk kasih catatan "+N tabung lain" kalau lebih dari 1.
            const gasPrimary = gasItems.length ? gasItems[0] : null;
            const gasPrimaryRecord = (gasPrimary && gasPrimary.record) || {};
            const gasPrimarySummary = (gasPrimary && gasPrimary.summary) || {};
            const gasCard = gasPrimary ? {
              kapasitasLabel: String(gasPrimaryRecord.kapasitasLabel || ""),
              hargaPerTabung: dashboardNumber_(gasPrimaryRecord.hargaPerTabung, 0),
              estimasiPemakaianJam: dashboardNumber_(gasPrimaryRecord.estimasiPemakaianJam, 0),
              konversiMenit: dashboardRound2_(dashboardNumber_(gasPrimarySummary.konversiMenit, 0)),
              hasDryerRef: !!gasPrimaryRecord.dryerRefId,
              dryerRefDurasiMenit: dashboardRound2_(dashboardNumber_(gasPrimarySummary.dryerRefDurasiMenit, 0)),
              estimasiLoadPemakaian: dashboardRound2_(dashboardNumber_(gasPrimarySummary.estimasiLoadPemakaian, 0)),
              biayaGasDryerPerLoad: dashboardRound2_(gasTotalPerLoad),
              hasSetrikaRef: !!gasPrimaryRecord.setrikaRefId,
              setrikaKapasitasKgPerJam: dashboardRound2_(dashboardNumber_(gasPrimarySummary.setrikaKapasitasKgPerJam, 0)),
              biayaGasSetrikaPerJam: dashboardRound2_(gasTotalPerJam),
              biayaPerJam: dashboardRound2_(dashboardNumber_(gasPrimarySummary.biayaPerJam, 0)),
              biayaPerMenit: dashboardRound2_(dashboardNumber_(gasPrimarySummary.biayaPerMenit, 0)),
              persenDryerPerLoad: 0,
              persenSetrikaPerJam: 0,
              moreCount: Math.max(0, gasItems.length - 1)
            } : null;
            gasCardRef = gasCard;

            if (gasComplete) {
              if (isJasaSetrika) {
                komponenBiaya.push({ key: "gas", label: "Gas LPG", biayaPerLoad: dashboardRound2_(gasTotalPerJam), unitSuffix: "/jam", gasCard: gasCard });
                totalBiayaPerLoad += gasTotalPerJam;
              } else {
                komponenBiaya.push({ key: "gas", label: "Gas LPG", biayaPerLoad: dashboardRound2_(gasTotalPerLoad), gasCard: gasCard });
                totalBiayaPerLoad += gasTotalPerLoad;
              }
            }
          }
        }
      } catch(e) {}

      try {
        if (typeof getBiayaListrik_impl_ === "function") {
          const listrikRes = getBiayaListrik_impl_(cabangId);
          if (listrikRes && listrikRes.ok && listrikRes.data && listrikRes.data.summary) {
            const listrikRecord = listrikRes.data.record || {};
            const cuciArr = Array.isArray(listrikRes.data.summary.cuci) ? listrikRes.data.summary.cuci : [];
            const pengeringArr = Array.isArray(listrikRes.data.summary.pengering) ? listrikRes.data.summary.pengering : [];
            const pompaPerLoad = cuciArr.length > 0 ? dashboardNumber_(cuciArr[0].rpPompaPerLoad, 0) : 0;
            const washerPerLoad = cuciArr.length > 0 ? dashboardNumber_(cuciArr[0].rpListrikPerLoad, 0) : 0;
            const dryerPerLoad = pengeringArr.length > 0 ? dashboardNumber_(pengeringArr[0].rpListrikPerLoad, 0) : 0;
            const rataListrik = pompaPerLoad + washerPerLoad + dryerPerLoad;
            // Watt Setrika Listrik cuma relevan kalau outlet ini benar-benar
            // punya baris mesin setrika berjenis "listrik" - setrika uap
            // tidak berbiaya listrik sama sekali (lihat Modul_BiayaListrik.gs).
            const setrikaRowsListrik_ = dashboardArray_(item.mesinSetrika);
            const adaSetrikaListrik_ = setrikaRowsListrik_.some(function (m) { return m.jenis === "listrik"; });
            // [Jasa Setrika + Setrika Uap] Kategori ini tidak punya mesin
            // cuci/pengering sama sekali, dan uap tidak berbiaya listrik ->
            // kartu "Listrik" di Master Biaya Produksi dinonaktifkan total
            // (bukan cuma tampil Rp0) - berlaku HP & desktop sekaligus karena
            // keduanya baca array komponenBiaya yang sama ini.
            const isJasaSetrikaTanpaListrik_ = String(item.kategoriLayanan || "") === "jasa_setrika" && !adaSetrikaListrik_;
            if (listrikComplete && !isJasaSetrikaTanpaListrik_) {
              const listrikDetail = [
                { label: "TDL per kWh", amount: dashboardRound2_(dashboardNumber_(listrikRecord.tdlPerKwh, 0)) },
                { label: "Watt Mesin Cuci", text: dashboardNumber_(listrikRecord.wattMesinCuci, 0) + " watt" },
                { label: "Watt Mesin Pengering", text: dashboardNumber_(listrikRecord.wattMesinPengering, 0) + " watt" }
              ];
              if (adaSetrikaListrik_) {
                listrikDetail.push({ label: "Watt Setrika Listrik", text: dashboardNumber_(listrikRecord.wattSetrikaListrik, 0) + " watt" });
              }
              listrikDetail.push({ label: "Pompa Air / Load", amount: dashboardRound2_(pompaPerLoad) });
              listrikDetail.push({ label: "Washer (Cuci) / Load", amount: dashboardRound2_(washerPerLoad) });
              listrikDetail.push({ label: "Dryer (Pengering) / Load", amount: dashboardRound2_(dryerPerLoad) });
              komponenBiaya.push({ key: "listrik", label: "Listrik", biayaPerLoad: dashboardRound2_(rataListrik), detail: listrikDetail });
              totalBiayaPerLoad += rataListrik;
            }
          }
        }
      } catch(e) {}
      try {
        if (typeof getBiayaAir_impl_ === "function") {
          const airRes = getBiayaAir_impl_(cabangId);
          if (airRes && airRes.ok && airRes.data && airRes.data.summary) {
            const airRecord = airRes.data.record || {};
            const airSummary = airRes.data.summary || {};
            // [Jasa Setrika + Setrika Uap] "kebutuhan air per load" tidak
            // relevan (kategori ini tidak punya mesin cuci) - ganti total ke
            // "kebutuhan air setrika uap/jam" (computeBiayaAirSummary_ di
            // Modul_BiayaAir.gs SUDAH menghitung ini, tinggal dipakai di sini,
            // bukan rumus baru). Berlaku HP & desktop sekaligus (array sama).
            const isJasaSetrika = String(item.kategoriLayanan || "") === "jasa_setrika";
            const pakaiAirSetrikaUap_ = isJasaSetrika && !!airSummary.adaSetrikaUap;
            const airPerLoad = pakaiAirSetrikaUap_
              ? dashboardNumber_(airSummary.biayaAirSetrikaUapPerJam, 0)
              : dashboardNumber_(airSummary.biayaPerLoad, 0);
            if (airComplete) {
              const sumberAirLabel_ = { pdam: "PDAM / Meteran", tangki: "Tangki / Toren", sumur: "Sumur Bor" }[airSummary.sumberAir] || "-";
              const airDetail = [{ label: "Sumber air", text: sumberAirLabel_ }];
              if (pakaiAirSetrikaUap_) {
                airDetail.push({ label: "Harga per m³", amount: dashboardRound2_(dashboardNumber_(airRecord.hargaPerM3, 0)) });
                airDetail.push({ label: "Kebutuhan air setrika uap/jam", text: dashboardNumber_(airRecord.kebutuhanAirSetrikaUapPerJam, 0) + " liter" });
              } else if (airSummary.sumberAir === "pdam") {
                airDetail.push({ label: "Harga per m³", amount: dashboardRound2_(dashboardNumber_(airRecord.hargaPerM3, 0)) });
                airDetail.push({ label: "Kebutuhan air/load", text: dashboardNumber_(airRecord.kebutuhanAirPerLoad, 0) + " liter" });
              } else if (airSummary.sumberAir === "tangki") {
                airDetail.push({ label: "Harga per tangki", amount: dashboardRound2_(dashboardNumber_(airRecord.hargaPerTangki, 0)) });
                airDetail.push({ label: "Kapasitas tangki", text: dashboardNumber_(airRecord.kapasitasTangkiLiter, 0) + " liter" });
                airDetail.push({ label: "Kebutuhan air/load", text: dashboardNumber_(airRecord.kebutuhanAirPerLoad, 0) + " liter" });
              }
              komponenBiaya.push({
                key: "air",
                label: "Air",
                biayaPerLoad: dashboardRound2_(airPerLoad),
                unitSuffix: pakaiAirSetrikaUap_ ? "/jam" : undefined,
                detail: airDetail
              });
              totalBiayaPerLoad += airPerLoad;
            }
          }
        }
      } catch(e) {}

      try {
        if (typeof getBiayaNotaKasir_impl_ === "function") {
          const notaRes = getBiayaNotaKasir_impl_(cabangId);
          if (notaRes && notaRes.ok && notaRes.data && notaRes.data.summary) {
            const notaPerLoad = dashboardNumber_(notaRes.data.summary.totalBiayaNotaKasirPerLoad, 0);
            if (notaComplete) {
              const notaDetail = [
                { label: "Biaya Aplikasi/Kasir", amount: dashboardRound2_(dashboardNumber_(notaRes.data.summary.biayaAplikasiPerLoad, 0)) },
                { label: "Biaya Nota/Kertas", amount: dashboardRound2_(dashboardNumber_(notaRes.data.summary.biayaNotaPerLoad, 0)) }
              ];
              komponenBiaya.push({ key: "nota", label: "Nota/Kasir", biayaPerLoad: dashboardRound2_(notaPerLoad), detail: notaDetail });
              totalBiayaPerLoad += notaPerLoad;
            }
          }
        }
      } catch(e) {}

      try {
        if (typeof listBiayaChemical_impl_ === "function") {
          const chemicalRes = listBiayaChemical_impl_(cabangId);
          if (chemicalRes && chemicalRes.ok && chemicalRes.data && chemicalRes.data.items) {
            // Akumulasi biayaPerLoad SEMUA item chemical (Deterjen, Softener,
            // Parfum, Pelicin, dan item tambahan lain) jadi satu angka total.
            let chemicalTotalPerLoad = 0;
            const chemicalItems = dashboardArray_(chemicalRes.data.items);
            chemicalItems.forEach(function(c) {
              const s = c.summary || {};
              chemicalTotalPerLoad += dashboardNumber_(s.biayaPerLoad, 0);
            });
            if (chemicalComplete) {
              const chemicalNames = chemicalItems.map(function(c) { return (c.record && c.record.nama) ? String(c.record.nama) : ""; }).filter(Boolean);
              komponenBiaya.push({
                key: "chemical", label: "Chemical", biayaPerLoad: dashboardRound2_(chemicalTotalPerLoad),
                detail: [
                  { label: "Jumlah item", text: chemicalItems.length + " item" },
                  { label: "Item tercatat", text: chemicalNames.length ? chemicalNames.join(", ") : "-" }
                ]
              });
              totalBiayaPerLoad += chemicalTotalPerLoad;
            }
          }
        }
      } catch(e) {}

      try {
        if (typeof listBiayaPacking_impl_ === "function") {
          const packingRes = listBiayaPacking_impl_(cabangId);
          if (packingRes && packingRes.ok && packingRes.data && packingRes.data.items) {
            // Akumulasi biayaPerLoad item packing utk layanan KILOAN saja:
            // item non-plastik (Isolasi, dll) selalu ikut; item plastik
            // (Plastik HD/PP/Jinjing/custom) cuma ikut kalau dicentang
            // layanan "kiloan". Plastik Jinjing yang cuma dicentang Bed
            // Cover sengaja TIDAK diikutkan di sini.
            let packingTotalPerLoad = 0;
            let packingIncludedCount = 0;
            dashboardArray_(packingRes.data.items).forEach(function(p) {
              const record = p.record || {};
              const s = p.summary || {};
              const isPlastik = typeof isPackingPlastikNama_ === "function" ? isPackingPlastikNama_(record.nama) : false;
              const layananArr = Array.isArray(record.layananPacking) ? record.layananPacking : ["kiloan", "bed_cover"];
              const included = !isPlastik || layananArr.indexOf("kiloan") >= 0;
              if (included) { packingTotalPerLoad += dashboardNumber_(s.biayaPerLoad, 0); packingIncludedCount++; }
            });
            if (packingComplete) {
              komponenBiaya.push({
                key: "packing", label: "Packing", biayaPerLoad: dashboardRound2_(packingTotalPerLoad),
                detail: [{ label: "Item dihitung (layanan kiloan)", text: packingIncludedCount + " item" }]
              });
              totalBiayaPerLoad += packingTotalPerLoad;
            }
          }
        }
      } catch(e) {}

      totalBiayaPerLoad = dashboardRound2_(totalBiayaPerLoad);
      komponenBiaya.forEach(function(k) {
        k.persen = totalBiayaPerLoad > 0 ? dashboardRound2_(k.biayaPerLoad / totalBiayaPerLoad * 100) : 0;
      });
      if (gasCardRef) {
        gasCardRef.persenDryerPerLoad = totalBiayaPerLoad > 0 ? dashboardRound2_(gasCardRef.biayaGasDryerPerLoad / totalBiayaPerLoad * 100) : 0;
        gasCardRef.persenSetrikaPerJam = totalBiayaPerLoad > 0 ? dashboardRound2_(gasCardRef.biayaGasSetrikaPerJam / totalBiayaPerLoad * 100) : 0;
      }

      return {
        cabangId: cabangId,
        namaLaundry: dashboardOutletName_(item),
        lengkapCount: lengkapCount,
        totalKomponen: 6,
        isComplete: lengkapCount === 6,
        missing: missing,
        komponenBiaya: komponenBiaya,
        totalBiayaPerLoad: totalBiayaPerLoad
      };
    });

    const completeOutlet = rows.filter(function (row) { return row.isComplete; }).length;

    return {
      ok: true,
      data: {
        totalOutlet: rows.length,
        completeOutlet: completeOutlet,
        incompleteOutlet: rows.length - completeOutlet,
        rows: rows
      }
    };
  } catch (err) {
    return dashboardError_(err, "getDashboardMasterBiayaSummary_impl_");
  }
}

function getDashboardHPPSummary(sessionToken, cabangId) {
  return withTenant_(sessionToken, function () { return getDashboardHPPSummary_impl_(cabangId); });
}

function getDashboardHPPSummary_impl_(cabangId) {
  try {
    const cabangRes = dashboardGetCabangRows_();
    if (!cabangRes.ok) return cabangRes;

    const allRows = cabangRes.data;
    const filtered = cabangId ? allRows.filter(function(r) { return r.id === cabangId; }) : allRows;
    const rows = filtered.map(function (item) {
      const cabangId = String(item.id || "");
      let layanan = [];
      let warnings = [];
      let hppCuciKering = 0;
      let errorText = "";
      let bedCoverAktif = true;
      let serviceToggles = [];

      try {
        if (typeof getStrukturBiayaHPP_impl_ === "function") {
          const hppRes = getStrukturBiayaHPP_impl_(cabangId);
          if (hppRes && hppRes.ok && hppRes.data) {
            layanan = dashboardArray_(hppRes.data.layanan);
            warnings = dashboardArray_(hppRes.data.warnings);
            bedCoverAktif = hppRes.data.bedCoverAktif !== false;
            serviceToggles = dashboardArray_(hppRes.data.serviceToggles).map(function (t) {
              return { key: t.key || "", title: t.title || "", aktif: t.aktif !== false };
            });
          } else {
            errorText = hppRes && hppRes.error ? hppRes.error : "HPP belum bisa dibaca.";
          }
        } else {
          errorText = "Fungsi getStrukturBiayaHPP_impl_ belum tersedia.";
        }
      } catch (e) {
        errorText = e && e.message ? e.message : String(e);
      }
      const totals = [];
      const layananList = [];
      layanan.forEach(function (svc) {
        if (!svc) return;
        const total = dashboardNumber_(svc.total, 0);
        if (total > 0) {
          totals.push(total);
        }
        const components = dashboardArray_(svc.components).map(function(c) {
          return { key: c.key || "", label: c.label || "", amount: dashboardRound2_(c.amount), percent: dashboardRound2_(c.percent) };
        });
        layananList.push({ key: svc.key || "", title: svc.title || "", total: dashboardRound2_(total), components: components });
        if (String(svc.key || "") === "cuci_kering") {
          hppCuciKering = dashboardRound2_(total);
        }
      });

      const isReady = totals.length > 0;

      return {
        cabangId: cabangId,
        namaLaundry: dashboardOutletName_(item),
        kategoriLayanan: String(item.kategoriLayanan || ""),
        isReady: isReady,
        hppMin: isReady ? dashboardRound2_(Math.min.apply(null, totals)) : 0,
        hppMax: isReady ? dashboardRound2_(Math.max.apply(null, totals)) : 0,
        hppCuciKering: hppCuciKering,
        layananList: layananList,
        bedCoverAktif: bedCoverAktif,
        serviceToggles: serviceToggles,
        warningsCount: warnings.length + (errorText ? 1 : 0),
        errorText: errorText
      };
    });

    return {
      ok: true,
      data: {
        totalOutlet: rows.length,
        readyOutlet: rows.filter(function (row) { return row.isReady; }).length,
        rows: rows
      }
    };
  } catch (err) {
    return dashboardError_(err, "getDashboardHPPSummary_impl_");
  }
}

function getDashboardHargaLayananSummary(sessionToken, cabangId) {
  return withTenant_(sessionToken, function () { return getDashboardHargaLayananSummary_impl_(cabangId); });
}

function getDashboardHargaLayananSummary_impl_(cabangId) {
  try {
    const cabangRes = dashboardGetCabangRows_();
    if (!cabangRes.ok) return cabangRes;

    const allRows = cabangRes.data;
    const filtered = cabangId ? allRows.filter(function(r) { return r.id === cabangId; }) : allRows;
    const rows = filtered.map(function (item) {
      const cabangId = String(item.id || "");
      let layanan = [];
      let warnings = [];
      let errorText = "";

      try {
        if (typeof getHargaLayanan_impl_ === "function") {
          const hargaRes = getHargaLayanan_impl_(cabangId);
          if (hargaRes && hargaRes.ok && hargaRes.data) {
            layanan = dashboardArray_(hargaRes.data.layanan);
            warnings = dashboardArray_(hargaRes.data.warnings);
          } else {
            errorText = hargaRes && hargaRes.error ? hargaRes.error : "Harga layanan belum bisa dibaca.";
          }
        } else {
          errorText = "Fungsi getHargaLayanan_impl_ belum tersedia.";
        }
      } catch (e) {
        errorText = e && e.message ? e.message : String(e);
      }

      let hargaTerisiCount = 0;
      let rugiCount = 0;
      let tipisCount = 0;
      let impasCount = 0;
      let amanCount = 0;
      const marginPercents = [];

      layanan.forEach(function (svc) {
        if (!svc) return;
        const hargaJual = dashboardNumber_(svc.hargaJual, 0);
        const status = String(svc.status || "");

        if (hargaJual > 0) {
          hargaTerisiCount++;
          marginPercents.push(dashboardNumber_(svc.marginPercent, 0));

          if (status === "rugi") rugiCount++;
          else if (status === "tipis") tipisCount++;
          else if (status === "impas") impasCount++;
          else if (status === "aman") amanCount++;
        }
      });

      const layananList = layanan
        .filter(function(svc) { return svc && dashboardNumber_(svc.hargaJual, 0) > 0; })
        .map(function(svc) {
          const row = {
            key: String(svc.key || ""),
            title: String(svc.title || ""),
            marginPercent: dashboardRound2_(dashboardNumber_(svc.marginPercent, 0)),
            status: String(svc.status || "aman"),
            hpp: dashboardRound2_(dashboardNumber_(svc.hpp, 0)),
            hargaJual: dashboardRound2_(dashboardNumber_(svc.hargaJual, 0)),
            margin: dashboardRound2_(dashboardNumber_(svc.margin, 0))
          };
          // Rincian Per Load/Per Jam & Per Kg (drop_off/hybrid & jasa_setrika)
          // - lihat buildHargaLayananItems_ di Modul_HargaLayanan.gs. Hanya
          // diteruskan kalau field-nya memang ada di svc, supaya baris
          // self_service/Bed Cover (yang tidak punya rincian ini) tetap bersih.
          if (svc.hargaJualPerKg !== undefined) row.hargaJualPerKg = dashboardRound2_(dashboardNumber_(svc.hargaJualPerKg, 0));
          if (svc.hppPerLoad !== undefined) row.hppPerLoad = dashboardRound2_(dashboardNumber_(svc.hppPerLoad, 0));
          if (svc.marginPerLoad !== undefined) row.marginPerLoad = dashboardRound2_(dashboardNumber_(svc.marginPerLoad, 0));
          if (svc.marginPercentPerLoad !== undefined) row.marginPercentPerLoad = dashboardRound2_(dashboardNumber_(svc.marginPercentPerLoad, 0));
          if (svc.hppPerKg !== undefined) row.hppPerKg = dashboardRound2_(dashboardNumber_(svc.hppPerKg, 0));
          if (svc.marginPerKg !== undefined) row.marginPerKg = dashboardRound2_(dashboardNumber_(svc.marginPerKg, 0));
          if (svc.marginPercentPerKg !== undefined) row.marginPercentPerKg = dashboardRound2_(dashboardNumber_(svc.marginPercentPerKg, 0));
          if (svc.hppPerJam !== undefined) row.hppPerJam = dashboardRound2_(dashboardNumber_(svc.hppPerJam, 0));
          if (svc.marginPerJam !== undefined) row.marginPerJam = dashboardRound2_(dashboardNumber_(svc.marginPerJam, 0));
          if (svc.marginPercentPerJam !== undefined) row.marginPercentPerJam = dashboardRound2_(dashboardNumber_(svc.marginPercentPerJam, 0));
          if (svc.kapasitasKgPerLoad !== undefined) row.kapasitasKgPerLoad = dashboardRound2_(dashboardNumber_(svc.kapasitasKgPerLoad, 0));
          if (svc.setrikaKapasitasKgPerJam !== undefined) row.setrikaKapasitasKgPerJam = dashboardRound2_(dashboardNumber_(svc.setrikaKapasitasKgPerJam, 0));
          if (svc.unitLabel !== undefined) row.unitLabel = String(svc.unitLabel || "");
          if (svc.minimumOrderKg !== undefined) row.minimumOrderKg = dashboardRound2_(dashboardNumber_(svc.minimumOrderKg, 0));
          if (svc.omzetMinimumOrder !== undefined) row.omzetMinimumOrder = dashboardRound2_(dashboardNumber_(svc.omzetMinimumOrder, 0));
          return row;
        });
      const totalLayanan = layanan.length;
      let status = "ok";
      if (rugiCount > 0) {
        status = "danger";
      } else if (tipisCount > 0 || hargaTerisiCount < totalLayanan || errorText) {
        status = "warning";
      }

      return {
        cabangId: cabangId,
        namaLaundry: dashboardOutletName_(item),
        kategoriLayanan: String(item.kategoriLayanan || ""),
        totalLayanan: totalLayanan,
        hargaTerisiCount: hargaTerisiCount,
        rugiCount: rugiCount,
        tipisCount: tipisCount,
        impasCount: impasCount,
        amanCount: amanCount,
        minMarginPercent: marginPercents.length ? dashboardRound2_(Math.min.apply(null, marginPercents)) : null,
        layananList: layananList,
        warningsCount: warnings.length + (errorText ? 1 : 0),
        status: status,
        errorText: errorText
      };
    });

    return {
      ok: true,
      data: {
        totalOutlet: rows.length,
        dangerOutlet: rows.filter(function (row) { return row.status === "danger"; }).length,
        warningOutlet: rows.filter(function (row) { return row.status === "warning"; }).length,
        rows: rows
      }
    };
  } catch (err) {
    return dashboardError_(err, "getDashboardHargaLayananSummary_impl_");
  }
}

function getDashboardFixedCostSummary(sessionToken, cabangId) {
  return withTenant_(sessionToken, function () { return getDashboardFixedCostSummary_impl_(cabangId); });
}

function getDashboardFixedCostSummary_impl_(cabangId) {
  try {
    if (typeof listBiayaTetapOutletSummaries_impl_ !== "function") {
      return {
        ok: false,
        error: "Fungsi listBiayaTetapOutletSummaries_impl_ belum tersedia.",
        stage: "getDashboardFixedCostSummary_impl_:listBiayaTetapOutletSummaries_missing"
      };
    }

    const res = listBiayaTetapOutletSummaries_impl_();
    if (!res || !res.ok) {
      return {
        ok: false,
        error: res && res.error ? res.error : "Gagal membaca summary fixed cost.",
        stage: res && res.stage ? res.stage : "getDashboardFixedCostSummary_impl_:listBiayaTetapOutletSummaries_impl_"
      };
    }

    const rows = dashboardArray_(res.data).map(function (item) {
      const cabang = item.cabang || {};
      const summary = item.summary || {};
      const warnings = dashboardArray_(item.warnings);

      const components = dashboardArray_(summary.components).map(function (c) {
        return { key: String(c.key || ""), label: String(c.label || ""), amount: dashboardRound2_(c.amount) };
      });

      return {
        cabangId: String(cabang.id || ""),
        namaLaundry: String(cabang.namaLaundry || "Outlet tanpa nama"),
        hasData: !!item.hasData,
        totalPerBulan: dashboardRound2_(summary.totalPerBulan),
        totalPerHari: dashboardRound2_(summary.totalPerHari),
        components: components,
        warningsCount: warnings.length
      };
    });

    const filteredRows = cabangId ? rows.filter(function(r) { return r.cabangId === cabangId; }) : rows;
    const totalFixedCostPerBulan = dashboardRound2_(filteredRows.reduce(function (sum, row) {
      return sum + dashboardNumber_(row.totalPerBulan, 0);
    }, 0));

    return {
      ok: true,
      data: {
        totalOutlet: rows.length,
        totalFixedCostPerBulan: totalFixedCostPerBulan,
        rows: filteredRows
      }
    };
  } catch (err) {
    return dashboardError_(err, "getDashboardFixedCostSummary_impl_");
  }
}

/**
 * getDashboardBEPSummary_impl_
 * Menghitung Break Even Point (BEP) berdasarkan:
 * - Fixed Cost per bulan
 * - Rata-rata HPP per load (semua layanan)
 * - Rata-rata harga jual per load (semua layanan)
 */
// ----------------------------------------------------------------------------
// BEP: mix kontribusi % per layanan aktif -- dipakai supaya rataHPP & rataHarga
// dihitung dengan metode SAMA (weighted average), bukan lagi rataHPP pakai
// midpoint min-max sedang rataHarga pakai rata-rata biasa (itu penyebab
// margin bisa jadi negatif tiba-tiba cuma gara-gara 1 layanan di-toggle).
// Default (belum pernah diatur user): rata sama besar antar layanan aktif.
// ----------------------------------------------------------------------------

function getBepMixKey_(cabangId) {
  return "bepMix_" + cabangId;
}

function getBepServiceMix_(cabangId, activeKeys) {
  var defaultMix = {};
  var n = activeKeys.length;
  activeKeys.forEach(function (key) {
    defaultMix[key] = n > 0 ? dashboardRound2_(100 / n) : 0;
  });

  try {
    var sheet = ensureDataSheet_();
    var raw = readKey_(sheet, getBepMixKey_(cabangId));
    if (!raw) return defaultMix;

    var parsed = JSON.parse(raw);
    var storedMix = parsed && parsed.mix ? parsed.mix : null;
    if (!storedMix) return defaultMix;

    // Kalau daftar layanan aktif berubah sejak mix terakhir disimpan (toggle
    // di-nonaktifkan/aktifkan, kategori outlet berubah, dst), mix lama sudah
    // tidak relevan lagi -> balik ke default rata sama besar.
    var storedKeys = Object.keys(storedMix).sort().join(",");
    var currentKeys = activeKeys.slice().sort().join(",");
    if (storedKeys !== currentKeys) return defaultMix;

    return storedMix;
  } catch (err) {
    return defaultMix;
  }
}

function saveBepServiceMix(sessionToken, cabangId, mixMap) {
  return withTenant_(sessionToken, function () { return saveBepServiceMix_impl_(cabangId, mixMap); });
}

function saveBepServiceMix_impl_(cabangId, mixMap) {
  try {
    var cleanId = typeof cabangId === "string" ? cabangId.trim() : "";
    if (!cleanId) {
      return { ok: false, error: "ID cabang tidak valid.", stage: "saveBepServiceMix_impl_:validate_cabang_id" };
    }
    if (!mixMap || typeof mixMap !== "object") {
      return { ok: false, error: "Data mix tidak valid.", stage: "saveBepServiceMix_impl_:validate_mix" };
    }

    var cleanMix = {};
    var total = 0;
    Object.keys(mixMap).forEach(function (key) {
      var val = Math.max(0, dashboardNumber_(mixMap[key], 0));
      cleanMix[key] = val;
      total += val;
    });

    // VALIDASI WAJIB: total kontribusi harus 100% (toleransi 0.5% utk
    // pembulatan input desimal) -- BUKAN dinormalisasi otomatis, supaya user
    // sadar & sengaja menetapkan proporsi yang benar (sesuai spesifikasi BEP
    // Campuran Layanan).
    if (Math.abs(total - 100) > 0.5) {
      return {
        ok: false,
        error: "Total kontribusi layanan harus 100%.",
        stage: "saveBepServiceMix_impl_:validate_total"
      };
    }

    var sheet = ensureDataSheet_();
    writeKey_(sheet, getBepMixKey_(cleanId), JSON.stringify({
      mix: cleanMix,
      updatedAt: new Date().toISOString()
    }));

    return { ok: true, data: { cabangId: cleanId, mix: cleanMix } };
  } catch (err) {
    return dashboardError_(err, "saveBepServiceMix_impl_");
  }
}

// bepEffectiveOmzetPerOrder_: omzetPerOrder yang benar-benar sebanding dengan
// hpp per order (Load/Jam). Untuk layanan berbasis per Kg (kiloan non-Bed
// Cover & Jasa Setrika), omzet per order = Harga Jual x Minimum Order (Kg)
// -- field `omzetMinimumOrder` dari Modul_HargaLayanan.gs, HANYA ada kalau
// user sudah mengisi Minimum Order. Kalau belum diisi, kembalikan null
// (BUKAN 0 atau harga per Kg mentah) supaya jelas dianggap "belum lengkap",
// bukan diam-diam salah unit (ini penyebab bug lama: harga per Kg dan HPP
// per Load ketemu langsung tanpa dikonversi).
function bepEffectiveOmzetPerOrder_(item) {
  var isKgBased = item.hppPerLoad !== undefined || item.hppPerJam !== undefined;
  if (!isKgBased) {
    return dashboardNumber_(item.hargaJual, 0);
  }
  if (dashboardNumber_(item.minimumOrderKg, 0) > 0 && item.omzetMinimumOrder !== undefined) {
    return dashboardNumber_(item.omzetMinimumOrder, 0);
  }
  return null;
}

function bepEffectiveHpp_(item) {
  if (item.hppPerLoad !== undefined) return dashboardNumber_(item.hppPerLoad, 0);
  if (item.hppPerJam !== undefined) return dashboardNumber_(item.hppPerJam, 0);
  return dashboardNumber_(item.hpp, 0);
}

// ----------------------------------------------------------------------------
// getBepWeightedServiceData_: SATU-SATUNYA tempat menghitung rataHPP/rataHarga
// weighted-mix, dipakai BEP dan Potensi Omset supaya dua kartu itu selalu
// konsisten (tidak ada rumus ganda). Menerapkan ATURAN VALIDASI WAJIB dari
// spesifikasi BEP Campuran Layanan:
//   1. Kalau ada layanan (yang seharusnya ikut dihitung) belum lengkap harga
//      jual/HPP-nya -> JANGAN hitung BEP dulu (ok:false + pesan jelas),
//      bukan cuma diam-diam dikeluarkan dari mix.
//   2. Total kontribusi % harus 100% (toleransi 0.5%) -> kalau tidak, ok:false
//      + pesan "Total kontribusi layanan harus 100%."
// `services` (lengkap dengan `percent`) tetap dikembalikan MESKI ok:false,
// supaya modal "Atur %" tetap bisa dipakai user memperbaiki datanya.
// ----------------------------------------------------------------------------
function getBepWeightedServiceData_(cabangId) {
  var warnings = [];

  var hppRes = getDashboardHPPSummary_impl_(cabangId);
  var hppByKey = {};
  if (hppRes && hppRes.ok && hppRes.data && hppRes.data.rows && hppRes.data.rows.length) {
    dashboardArray_(hppRes.data.rows[0].layananList).forEach(function (svc) {
      if (svc && svc.key) hppByKey[svc.key] = svc;
    });
  } else {
    warnings.push("HPP belum tersedia.");
  }

  var hargaRes = getDashboardHargaLayananSummary_impl_(cabangId);
  var requiredItems = [];
  if (hargaRes && hargaRes.ok && hargaRes.data && hargaRes.data.rows && hargaRes.data.rows.length) {
    var hargaRow = hargaRes.data.rows[0];
    if (hargaRow && typeof getHargaLayanan_impl_ === "function") {
      var detailRes = getHargaLayanan_impl_(hargaRow.cabangId);
      if (detailRes && detailRes.ok && detailRes.data && detailRes.data.layanan) {
        // Bed Cover basisnya per item (bukan per order/load) -- tidak
        // sebanding dgn model BEP campuran layanan di sini, tidak diikutkan.
        requiredItems = detailRes.data.layanan.filter(function (item) {
          return item && item.key && item.key !== "bed_cover";
        });
      }
    }
  }

  if (!requiredItems.length) {
    warnings.push("Harga jual belum diisi.");
    return { ok: false, warnings: warnings, services: [], rataHPP: 0, rataHarga: 0 };
  }

  var activeKeys = requiredItems.map(function (item) { return item.key; });
  var mix = getBepServiceMix_(cabangId, activeKeys);

  var services = requiredItems.map(function (item) {
    var hppSvc = hppByKey[item.key];
    return {
      key: item.key,
      title: item.title || item.key,
      harga: bepEffectiveOmzetPerOrder_(item), // null = belum lengkap (lihat catatan fungsinya)
      hpp: hppSvc ? dashboardNumber_(hppSvc.total, 0) : bepEffectiveHpp_(item),
      percent: dashboardRound2_(mix[item.key] || 0)
    };
  });

  var totalMix = 0;
  services.forEach(function (s) { totalMix += dashboardNumber_(s.percent, 0); });
  var mixValid = Math.abs(totalMix - 100) <= 0.5;
  if (!mixValid) {
    warnings.push("Total kontribusi layanan harus 100%.");
  }

  var incompleteNames = [];
  services.forEach(function (s) {
    if (s.harga === null) {
      incompleteNames.push(s.title + " (Minimum Order Kg belum diisi di Harga Layanan)");
    } else if (!(s.harga > 0 && s.hpp > 0)) {
      incompleteNames.push(s.title + " (harga jual/HPP belum lengkap)");
    }
  });
  if (incompleteNames.length) {
    warnings.push("Lengkapi dulu: " + incompleteNames.join(", ") + ".");
  }

  if (!mixValid || incompleteNames.length) {
    return { ok: false, warnings: warnings, services: services, rataHPP: 0, rataHarga: 0 };
  }

  // rataHPP & rataHarga = weighted average (metode SAMA persis utk keduanya),
  // TIDAK dibulatkan di sini -- pembulatan hanya untuk tampilan akhir.
  var rataHPP = 0;
  var rataHarga = 0;
  services.forEach(function (s) {
    var pct = dashboardNumber_(s.percent, 0) / 100;
    rataHPP += s.hpp * pct;
    rataHarga += s.harga * pct;
  });

  return {
    ok: true,
    warnings: warnings,
    services: services,
    rataHPP: rataHPP,
    rataHarga: rataHarga
  };
}

function getDashboardBEPSummary(sessionToken, cabangId) {
  return withTenant_(sessionToken, function () { return getDashboardBEPSummary_impl_(cabangId); });
}

function getDashboardBEPSummary_impl_(cabangId) {
  try {
    var fixedCostRes = getDashboardFixedCostSummary_impl_(cabangId);
    var warnings = [];
    var fixedCostPerBulan = 0;

    if (fixedCostRes && fixedCostRes.ok && fixedCostRes.data) {
      fixedCostPerBulan = dashboardNumber_(fixedCostRes.data.totalFixedCostPerBulan, 0);
    } else {
      warnings.push("Fixed cost belum diisi.");
    }

    var weighted = getBepWeightedServiceData_(cabangId);
    warnings = warnings.concat(weighted.warnings);

    var rataHPP = weighted.rataHPP;
    var rataHarga = weighted.rataHarga;
    var marginPerLoad = 0;
    var bepLoadPerBulan = 0;
    var bepOmsetPerBulan = 0;
    var variableCostBepBulanan = 0;
    var totalBiayaSaatBep = 0;

    if (weighted.ok) {
      // RUMUS BEP CAMPURAN (tidak dibulatkan sampai tahap tampilan akhir):
      marginPerLoad = rataHarga - rataHPP;

      if (marginPerLoad > 0 && fixedCostPerBulan > 0) {
        bepLoadPerBulan = fixedCostPerBulan / marginPerLoad;
        bepOmsetPerBulan = bepLoadPerBulan * rataHarga;
        variableCostBepBulanan = bepLoadPerBulan * rataHPP;
        totalBiayaSaatBep = fixedCostPerBulan + variableCostBepBulanan;

        // VALIDASI WAJIB: saat BEP, omzet harus (kurang lebih) sama dengan
        // total biaya. Kalau melenceng jauh, itu tanda rumus/satuan salah --
        // jangan diam-diam, munculkan peringatan supaya ketahuan dari log.
        var selisihRelatif = omzetBepBulanan_selisihRelatif_(bepOmsetPerBulan, totalBiayaSaatBep);
        if (selisihRelatif > 0.01) {
          warnings.push("Perhitungan BEP tidak konsisten (selisih omzet vs total biaya > 1%) - cek data harga/HPP.");
        }
      } else if (marginPerLoad <= 0) {
        warnings.push("Margin kontribusi belum aman. Harga jual belum cukup untuk menutup HPP.");
        // Rincian per layanan supaya kelihatan jelas layanan mana yang
        // menyeret rata-rata jadi negatif (bukan cuma "pokoknya negatif").
        weighted.services.forEach(function (s) {
          var marginService = s.harga - s.hpp;
          warnings.push(
            s.title + " (" + dashboardRound2_(s.percent) + "% kontribusi): Harga " +
            dashboardFormatRp_(s.harga) + " - HPP " + dashboardFormatRp_(s.hpp) +
            " = margin " + dashboardFormatRp_(marginService) + (marginService < 0 ? " (RUGI)" : "")
          );
        });
      }
    }

    return {
      ok: true,
      data: {
        fixedCostPerBulan: fixedCostPerBulan,
        rataHPP: dashboardRound2_(rataHPP),
        rataHarga: dashboardRound2_(rataHarga),
        marginPerLoad: dashboardRound2_(marginPerLoad),
        bepLoadPerBulan: dashboardRound2_(bepLoadPerBulan),
        bepOmsetPerBulan: dashboardRound2_(bepOmsetPerBulan),
        bepLoadPerMinggu: dashboardRound2_(bepLoadPerBulan / 4),
        bepOmsetPerMinggu: dashboardRound2_(bepOmsetPerBulan / 4),
        bepLoadPerHari: dashboardRound2_(bepLoadPerBulan / 30),
        bepOmsetPerHari: dashboardRound2_(bepOmsetPerBulan / 30),
        variableCostBepBulanan: dashboardRound2_(variableCostBepBulanan),
        totalBiayaSaatBep: dashboardRound2_(totalBiayaSaatBep),
        serviceMix: weighted.services.map(function (s) {
          return { key: s.key, title: s.title, percent: s.percent };
        }),
        warnings: warnings,
        isComplete: weighted.ok && marginPerLoad > 0 && bepLoadPerBulan > 0
      }
    };
  } catch (err) {
    return dashboardError_(err, "getDashboardBEPSummary_impl_");
  }
}

function omzetBepBulanan_selisihRelatif_(omzetBep, totalBiayaBep) {
  var basis = Math.max(Math.abs(omzetBep), Math.abs(totalBiayaBep), 1);
  return Math.abs(omzetBep - totalBiayaBep) / basis;
}

// ----------------------------------------------------------------------------
// POTENSI OMSET: estimasi omset/biaya produksi/profit di KAPASITAS PENUH
// outlet. Rumus v2 (diperbaiki dari versi sebelumnya yang menghitung tiap
// layanan independen -- itu bikin tidak ada satupun mesin yang benar-benar
// 100% terpakai, padahal namanya "kapasitas penuh"). Sekarang mesin
// diperlakukan sebagai SATU kolam sumber daya yang dipakai BERGANTIAN oleh
// semua layanan aktif, sesuai definisi Kontribusi % di modal "Atur %"
// ("porsi tiap layanan dari total transaksi bulanan"):
//   1. Kapasitas mesin (load/bulan utk cuci & pengering, kg/bulan utk
//      setrika) - field sama yang dipakai kartu Profil Outlet & BEP, sumber
//      kebenaran tunggal tetap computeGroupLoad_/computeSetrikaCapacity_ di
//      Modul_Cabang.gs, TIDAK dihitung ulang dengan cara lain di sini.
//   2. Hitung rata-rata pemakaian tiap mesin PER 1 TRANSAKSI OUTLET (bukan
//      per layanan), ditimbang Kontribusi %: cuci/pengering dihitung 1
//      siklus per transaksi (kalau layanan itu pakai mesinnya), setrika
//      dihitung dalam Kg pakai Minimum Order layanan itu (krn basis setrika
//      memang Kg, bukan siklus).
//   3. Total Transaksi Maksimum/bulan = kapasitas mesin dibagi rata-rata
//      pemakaiannya, diambil yang PALING KECIL (mesin yang paling cepat
//      penuh/bottleneck) -- ini angka bersama utk SELURUH outlet, bukan per
//      layanan, supaya tidak ada mesin yang "dihitung dua kali" dipakai
//      lebih dari satu layanan sekaligus.
//   4. Total Transaksi itu dipecah per layanan pakai Kontribusi %-nya
//      masing-masing, dikonversi ke Kg pakai Minimum Order (utk layanan
//      berbasis Kg) atau dipakai langsung sbg Load (Self Service), lalu
//      dikali Harga Layanan -> omset layanan itu, dikali HPP -> biaya
//      produksi layanan itu. Dijumlahkan semua layanan aktif -> total
//      Estimasi Omset/Biaya Produksi, lalu Profit = Omset - Biaya - Fixed Cost.
// ----------------------------------------------------------------------------

function bepMachineUsageMap_(key) {
  var map = {
    cuci_saja: { washer: 1, dryer: 0, setrika: 0 },
    kering_saja: { washer: 0, dryer: 1, setrika: 0 },
    cuci_kering: { washer: 1, dryer: 1, setrika: 0 },
    cuci_kering_lipat: { washer: 1, dryer: 1, setrika: 0 },
    cuci_kering_setrika: { washer: 1, dryer: 1, setrika: 1 },
    setrika_saja: { washer: 0, dryer: 0, setrika: 1 }
  };
  return map[key] || { washer: 0, dryer: 0, setrika: 0 };
}

function getDashboardPotensiOmsetSummary(sessionToken, cabangId) {
  return withTenant_(sessionToken, function () { return getDashboardPotensiOmsetSummary_impl_(cabangId); });
}

function getDashboardPotensiOmsetSummary_impl_(cabangId) {
  try {
    var fixedCostRes = getDashboardFixedCostSummary_impl_(cabangId);
    var cabangRes = getDashboardCabangSummary_impl_(cabangId);
    var bepRes = getDashboardBEPSummary_impl_(cabangId);

    var warnings = [];
    var fixedCostPerBulan = 0;
    if (fixedCostRes && fixedCostRes.ok && fixedCostRes.data) {
      fixedCostPerBulan = dashboardNumber_(fixedCostRes.data.totalFixedCostPerBulan, 0);
    } else {
      warnings.push("Fixed cost belum diisi.");
    }

    // [2026-07-13] Estimasi Profit dipakai versi "Omset - Target BEP Omset"
    // (keputusan user) - BUKAN lagi "Omset - Variable Cost - Fixed Cost".
    var targetBepOmsetPerBulan = (bepRes && bepRes.ok && bepRes.data) ? dashboardNumber_(bepRes.data.bepOmsetPerBulan, 0) : 0;

    // weighted dipakai HANYA utk daftar layanan aktif + Kontribusi % (mix
    // BEP) + validasi kelengkapan (total mix 100%, harga/HPP terisi) - SATU-
    // SATUNYA tempat menghitung itu, tidak diduplikasi di sini. rataHPP/
    // rataHarga miliknya TIDAK dipakai lagi utk rumus Potensi Omset (basisnya
    // "per order" campuran, beda satuan dgn perhitungan per-Kg/per-Load di
    // bawah), tapi tetap diteruskan ke output data (dulu juga tampil di sana).
    var weighted = getBepWeightedServiceData_(cabangId);
    warnings = warnings.concat(weighted.warnings);
    var activeServices = weighted.services;

    // Kapasitas mentah mesin (load/bulan utk cuci & pengering, kg/bulan utk
    // setrika - field kgSetrikaPerBulan sudah okupansi-adjusted), persis yang
    // dipakai kartu Profil Outlet.
    var cabangRow = (cabangRes && cabangRes.ok && cabangRes.data && cabangRes.data.rows && cabangRes.data.rows.length)
      ? cabangRes.data.rows[0] : null;
    var washerLoadPerBulan = cabangRow ? dashboardNumber_(cabangRow.loadCuciPerBulan, 0) : 0;
    var dryerLoadPerBulan = cabangRow ? dashboardNumber_(cabangRow.loadKeringPerBulan, 0) : 0;
    var setrikaKgPerBulan = cabangRow ? dashboardNumber_(cabangRow.kgSetrikaPerBulan, 0) : 0;

    // Detail harga/HPP/minimum order MENTAH per layanan (per Kg utk Kiloan/
    // Jasa Setrika, per Load utk Self Service) - dibaca ulang dari Harga
    // Layanan di sini supaya dapat angka aslinya, BUKAN versi "per order"
    // (omzetMinimumOrder) yang dipakai kartu BEP.
    var hargaDetailByKey = {};
    if (typeof getHargaLayanan_impl_ === "function") {
      var hargaDetailRes = getHargaLayanan_impl_(cabangId);
      if (hargaDetailRes && hargaDetailRes.ok && hargaDetailRes.data && hargaDetailRes.data.layanan) {
        hargaDetailRes.data.layanan.forEach(function (item) {
          if (item && item.key) hargaDetailByKey[item.key] = item;
        });
      }
    }

    var incompleteCapacity = [];

    // Data per layanan (dipakai 2 kali: hitung usage share mesin, lalu
    // pecah Total Transaksi) - disiapkan sekali di sini.
    var serviceCalc = [];
    activeServices.forEach(function (s) {
      var detail = hargaDetailByKey[s.key];
      if (!detail) return;
      var usage = bepMachineUsageMap_(s.key);
      var isKgBased = detail.unitLabel === "per kg";
      var minimumOrderKg = dashboardNumber_(detail.minimumOrderKg, 0);
      if (isKgBased && minimumOrderKg <= 0) {
        incompleteCapacity.push(detail.title + " (Minimum Order Kg belum diisi di Harga Layanan)");
      }
      serviceCalc.push({
        key: s.key,
        title: s.title,
        percent: dashboardNumber_(s.percent, 0),
        isKgBased: isKgBased,
        minimumOrderKg: minimumOrderKg,
        usage: usage,
        hargaPerUnit: dashboardNumber_(detail.hargaJual, 0),
        hppPerUnit: dashboardNumber_(detail.hpp, 0)
      });
    });
    if (incompleteCapacity.length) {
      warnings = warnings.concat(incompleteCapacity);
    }

    // Rata-rata pemakaian tiap mesin PER 1 TRANSAKSI OUTLET, ditimbang
    // Kontribusi % - cuci/pengering = 1 siklus/transaksi (kalau layanan itu
    // makai), setrika = Kg/transaksi lewat Minimum Order layanan itu (basis
    // setrika memang Kg, bukan siklus).
    var usageShareWasher = 0;
    var usageShareDryer = 0;
    var usageShareSetrikaKg = 0;
    serviceCalc.forEach(function (sc) {
      var pct = sc.percent / 100;
      if (sc.usage.washer) usageShareWasher += pct;
      if (sc.usage.dryer) usageShareDryer += pct;
      if (sc.usage.setrika && sc.isKgBased && sc.minimumOrderKg > 0) {
        usageShareSetrikaKg += pct * sc.minimumOrderKg;
      }
    });

    // Total Transaksi Maksimum/bulan = kapasitas mesin dibagi rata-rata
    // pemakaiannya, diambil PALING KECIL (mesin yang paling cepat penuh).
    var candidates = [];
    if (usageShareWasher > 0 && washerLoadPerBulan > 0) candidates.push(washerLoadPerBulan / usageShareWasher);
    if (usageShareDryer > 0 && dryerLoadPerBulan > 0) candidates.push(dryerLoadPerBulan / usageShareDryer);
    if (usageShareSetrikaKg > 0 && setrikaKgPerBulan > 0) candidates.push(setrikaKgPerBulan / usageShareSetrikaKg);

    var bisaHitung = weighted.ok && !incompleteCapacity.length && candidates.length > 0;
    var totalTransaksiPerBulan = bisaHitung ? Math.min.apply(null, candidates) : 0;

    var totalOmzet = 0;
    var totalBiaya = 0;
    var serviceDetailByKey = {};

    if (bisaHitung && totalTransaksiPerBulan > 0) {
      serviceCalc.forEach(function (sc) {
        var pct = sc.percent / 100;
        var jumlahTransaksi = totalTransaksiPerBulan * pct;
        var kapasitasUnit = sc.isKgBased ? (jumlahTransaksi * sc.minimumOrderKg) : jumlahTransaksi;
        var omzetLayanan = kapasitasUnit * sc.hargaPerUnit;
        var biayaLayanan = kapasitasUnit * sc.hppPerUnit;

        totalOmzet += omzetLayanan;
        totalBiaya += biayaLayanan;

        // Rincian per layanan utk dropdown "Kontribusi Omset per Layanan".
        serviceDetailByKey[sc.key] = {
          unit: sc.isKgBased ? "kg" : "load",
          jumlahTransaksi: dashboardRound2_(jumlahTransaksi),
          kapasitasKontribusi: dashboardRound2_(kapasitasUnit),
          hargaPerUnit: dashboardRound2_(sc.hargaPerUnit),
          hppPerUnit: dashboardRound2_(sc.hppPerUnit),
          omzetLayanan: dashboardRound2_(omzetLayanan),
          biayaLayanan: dashboardRound2_(biayaLayanan)
        };
      });
    }

    var estimasiOmsetPerBulan = totalOmzet;
    var estimasiBiayaProduksiPerBulan = totalBiaya;
    var estimasiProfitPerBulan = estimasiOmsetPerBulan - targetBepOmsetPerBulan;

    var isComplete = bisaHitung && totalTransaksiPerBulan > 0;
    if (weighted.ok && !incompleteCapacity.length && !candidates.length) {
      warnings.push("Kapasitas mesin belum bisa dihitung - cek Profil Outlet & Minimum Order di Harga Layanan.");
    }

    return {
      ok: true,
      data: {
        maksimalTransaksiPerBulan: dashboardRound2_(totalTransaksiPerBulan),
        rataHPP: dashboardRound2_(weighted.rataHPP),
        rataHarga: dashboardRound2_(weighted.rataHarga),
        fixedCostPerBulan: fixedCostPerBulan,
        estimasiOmsetPerBulan: dashboardRound2_(estimasiOmsetPerBulan),
        estimasiBiayaProduksiPerBulan: dashboardRound2_(estimasiBiayaProduksiPerBulan),
        targetBepOmsetPerBulan: dashboardRound2_(targetBepOmsetPerBulan),
        estimasiProfitPerBulan: dashboardRound2_(estimasiProfitPerBulan),
        serviceMix: activeServices.map(function (s) {
          var d = serviceDetailByKey[s.key] || null;
          return {
            key: s.key,
            title: s.title,
            percent: s.percent,
            unit: d ? d.unit : "",
            jumlahTransaksi: d ? d.jumlahTransaksi : 0,
            kapasitasKontribusi: d ? d.kapasitasKontribusi : 0,
            hargaPerUnit: d ? d.hargaPerUnit : 0,
            hppPerUnit: d ? d.hppPerUnit : 0,
            omzetLayanan: d ? d.omzetLayanan : 0,
            biayaLayanan: d ? d.biayaLayanan : 0
          };
        }),
        warnings: warnings,
        isComplete: isComplete
      }
    };
  } catch (err) {
    return dashboardError_(err, "getDashboardPotensiOmsetSummary_impl_");
  }
}
