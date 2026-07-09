/**
 * ============================================================================
 * MODUL: DASHBOARD MENU UTAMA
 * ============================================================================
 * Modul ini hanya membaca data dari modul existing untuk menampilkan rangkuman
 * kondisi outlet di Menu Utama.
 *
 * PUBLIC FUNCTIONS:
 * - getDashboardCabangSummary()
 * - getDashboardMasterBiayaSummary()
 * - getDashboardHPPSummary()
 * - getDashboardHargaLayananSummary()
 * - getDashboardFixedCostSummary()
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

function dashboardGetCabangRows_() {
  if (typeof listCabang !== "function") {
    return {
      ok: false,
      error: "Fungsi listCabang belum tersedia.",
      stage: "dashboardGetCabangRows_:listCabang_missing"
    };
  }

  const res = listCabang();
  if (!res || !res.ok) {
    return {
      ok: false,
      error: res && res.error ? res.error : "Gagal membaca daftar cabang.",
      stage: res && res.stage ? res.stage : "dashboardGetCabangRows_:listCabang"
    };
  }

  return {
    ok: true,
    data: dashboardArray_(res.data)
  };
}

function dashboardOutletName_(item) {
  if (!item) return "Outlet tanpa nama";
  return String(item.namaLaundry || item.nama || item.namaCabang || "Outlet tanpa nama");
}

function getDashboardCabangSummary(cabangId) {
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
      // untuk ambil mesinCuci/mesinPengering/okupansi. Sekarang listCabang()
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
    return dashboardError_(err, "getDashboardCabangSummary");
  }
}

// Gabungan 6 fungsi Dashboard jadi 1 eksekusi server: browser cukup 1 kali
// google.script.run, dan cache baca sheet (Util_Penyimpanan.gs) kepakai
// bersama oleh keenam sub-panggilan di bawah (bukan reset tiap panggilan).
function getDashboardFullSummary(cabangId) {
  try {
    return {
      ok: true,
      data: {
        cabang: getDashboardCabangSummary(cabangId),
        masterBiaya: getDashboardMasterBiayaSummary(cabangId),
        hpp: getDashboardHPPSummary(cabangId),
        hargaLayanan: getDashboardHargaLayananSummary(cabangId),
        fixedCost: getDashboardFixedCostSummary(cabangId),
        bep: getDashboardBEPSummary(cabangId),
        potensiOmset: getDashboardPotensiOmsetSummary(cabangId)
      }
    };
  } catch (err) {
    return dashboardError_(err, "getDashboardFullSummary");
  }
}

function getDashboardMasterBiayaSummary(cabangId) {
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
        if (typeof listBiayaGas === "function") {
          const gasRes = listBiayaGas(cabangId);
          gasComplete = !!(gasRes && gasRes.ok && gasRes.data && Array.isArray(gasRes.data.items) && gasRes.data.items.length > 0);
        }
      } catch (e) {}
      if (gasComplete) lengkapCount++; else missing.push("Gas");

      let listrikComplete = false;
      try {
        if (typeof getBiayaListrik === "function") {
          const listrikRes = getBiayaListrik(cabangId);
          listrikComplete = !!(listrikRes && listrikRes.ok && listrikRes.data && listrikRes.data.record && listrikRes.data.record.updatedAt);
        }
      } catch (e) {}
      if (listrikComplete) lengkapCount++; else missing.push("Listrik");

      let airComplete = false;
      try {
        if (typeof getBiayaAir === "function") {
          const airRes = getBiayaAir(cabangId);
          airComplete = !!(airRes && airRes.ok && airRes.data && airRes.data.record && airRes.data.record.updatedAt);
        }
      } catch (e) {}
      if (airComplete) lengkapCount++; else missing.push("Air");

      let notaComplete = false;
      try {
        if (typeof getBiayaNotaKasir === "function") {
          const notaRes = getBiayaNotaKasir(cabangId);
          notaComplete = !!(notaRes && notaRes.ok && notaRes.data && notaRes.data.record && notaRes.data.record.updatedAt);
        }
      } catch (e) {}
      if (notaComplete) lengkapCount++; else missing.push("Nota/Kasir");

      let chemicalComplete = false;
      try {
        if (typeof listBiayaChemical === "function") {
          const chemicalRes = listBiayaChemical(cabangId);
          chemicalComplete = !!(chemicalRes && chemicalRes.ok && chemicalRes.data && Array.isArray(chemicalRes.data.items) && chemicalRes.data.items.length > 0);
        }
      } catch (e) {}
      if (chemicalComplete) lengkapCount++; else missing.push("Chemical");

      let packingComplete = false;
      try {
        if (typeof listBiayaPacking === "function") {
          const packingRes = listBiayaPacking(cabangId);
          packingComplete = !!(packingRes && packingRes.ok && packingRes.data && Array.isArray(packingRes.data.items) && packingRes.data.items.length > 0);
        }
      } catch (e) {}
      if (packingComplete) lengkapCount++; else missing.push("Packing");
      // Ambil nilai biaya per load per komponen
      const komponenBiaya = [];
      let totalBiayaPerLoad = 0;

      try {
        if (typeof listBiayaGas === "function") {
          const gasRes = listBiayaGas(cabangId);
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
            dashboardArray_(gasRes.data.items).forEach(function(g) {
              const s = g.summary || {};
              gasTotalPerJam += dashboardNumber_(s.biayaGasSetrikaPerJam, 0);
              gasTotalPerLoad += dashboardNumber_(s.biayaPerLoad, 0);
            });
            if (gasComplete) {
              if (isJasaSetrika) {
                komponenBiaya.push({ key: "gas", label: "Gas LPG", biayaPerLoad: dashboardRound2_(gasTotalPerJam), unitSuffix: "/jam" });
                totalBiayaPerLoad += gasTotalPerJam;
              } else {
                komponenBiaya.push({ key: "gas", label: "Gas LPG", biayaPerLoad: dashboardRound2_(gasTotalPerLoad) });
                totalBiayaPerLoad += gasTotalPerLoad;
              }
            }
          }
        }
      } catch(e) {}

      try {
        if (typeof getBiayaListrik === "function") {
          const listrikRes = getBiayaListrik(cabangId);
          if (listrikRes && listrikRes.ok && listrikRes.data && listrikRes.data.summary) {
            const cuciArr = Array.isArray(listrikRes.data.summary.cuci) ? listrikRes.data.summary.cuci : [];
            const pengeringArr = Array.isArray(listrikRes.data.summary.pengering) ? listrikRes.data.summary.pengering : [];
            const pompaPerLoad = cuciArr.length > 0 ? dashboardNumber_(cuciArr[0].rpPompaPerLoad, 0) : 0;
            const washerPerLoad = cuciArr.length > 0 ? dashboardNumber_(cuciArr[0].rpListrikPerLoad, 0) : 0;
            const dryerPerLoad = pengeringArr.length > 0 ? dashboardNumber_(pengeringArr[0].rpListrikPerLoad, 0) : 0;
            const rataListrik = pompaPerLoad + washerPerLoad + dryerPerLoad;
            if (listrikComplete) {
              komponenBiaya.push({ key: "listrik", label: "Listrik", biayaPerLoad: dashboardRound2_(rataListrik) });
              totalBiayaPerLoad += rataListrik;
            }
          }
        }
      } catch(e) {}
      try {
        if (typeof getBiayaAir === "function") {
          const airRes = getBiayaAir(cabangId);
          if (airRes && airRes.ok && airRes.data && airRes.data.summary) {
            const airPerLoad = dashboardNumber_(airRes.data.summary.biayaPerLoad, 0);
            if (airComplete) {
              komponenBiaya.push({ key: "air", label: "Air", biayaPerLoad: dashboardRound2_(airPerLoad) });
              totalBiayaPerLoad += airPerLoad;
            }
          }
        }
      } catch(e) {}

      try {
        if (typeof getBiayaNotaKasir === "function") {
          const notaRes = getBiayaNotaKasir(cabangId);
          if (notaRes && notaRes.ok && notaRes.data && notaRes.data.summary) {
            const notaPerLoad = dashboardNumber_(notaRes.data.summary.totalBiayaNotaKasirPerLoad, 0);
            if (notaComplete) {
              komponenBiaya.push({ key: "nota", label: "Nota/Kasir", biayaPerLoad: dashboardRound2_(notaPerLoad) });
              totalBiayaPerLoad += notaPerLoad;
            }
          }
        }
      } catch(e) {}

      try {
        if (typeof listBiayaChemical === "function") {
          const chemicalRes = listBiayaChemical(cabangId);
          if (chemicalRes && chemicalRes.ok && chemicalRes.data && chemicalRes.data.items) {
            // Akumulasi biayaPerLoad SEMUA item chemical (Deterjen, Softener,
            // Parfum, Pelicin, dan item tambahan lain) jadi satu angka total.
            let chemicalTotalPerLoad = 0;
            dashboardArray_(chemicalRes.data.items).forEach(function(c) {
              const s = c.summary || {};
              chemicalTotalPerLoad += dashboardNumber_(s.biayaPerLoad, 0);
            });
            if (chemicalComplete) {
              komponenBiaya.push({ key: "chemical", label: "Chemical", biayaPerLoad: dashboardRound2_(chemicalTotalPerLoad) });
              totalBiayaPerLoad += chemicalTotalPerLoad;
            }
          }
        }
      } catch(e) {}

      try {
        if (typeof listBiayaPacking === "function") {
          const packingRes = listBiayaPacking(cabangId);
          if (packingRes && packingRes.ok && packingRes.data && packingRes.data.items) {
            // Akumulasi biayaPerLoad item packing utk layanan KILOAN saja:
            // item non-plastik (Isolasi, dll) selalu ikut; item plastik
            // (Plastik HD/PP/Jinjing/custom) cuma ikut kalau dicentang
            // layanan "kiloan". Plastik Jinjing yang cuma dicentang Bed
            // Cover sengaja TIDAK diikutkan di sini.
            let packingTotalPerLoad = 0;
            dashboardArray_(packingRes.data.items).forEach(function(p) {
              const record = p.record || {};
              const s = p.summary || {};
              const isPlastik = typeof isPackingPlastikNama_ === "function" ? isPackingPlastikNama_(record.nama) : false;
              const layananArr = Array.isArray(record.layananPacking) ? record.layananPacking : ["kiloan", "bed_cover"];
              const included = !isPlastik || layananArr.indexOf("kiloan") >= 0;
              if (included) packingTotalPerLoad += dashboardNumber_(s.biayaPerLoad, 0);
            });
            if (packingComplete) {
              komponenBiaya.push({ key: "packing", label: "Packing", biayaPerLoad: dashboardRound2_(packingTotalPerLoad) });
              totalBiayaPerLoad += packingTotalPerLoad;
            }
          }
        }
      } catch(e) {}

      totalBiayaPerLoad = dashboardRound2_(totalBiayaPerLoad);
      komponenBiaya.forEach(function(k) {
        k.persen = totalBiayaPerLoad > 0 ? dashboardRound2_(k.biayaPerLoad / totalBiayaPerLoad * 100) : 0;
      });

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
    return dashboardError_(err, "getDashboardMasterBiayaSummary");
  }
}

function getDashboardHPPSummary(cabangId) {
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
        if (typeof getStrukturBiayaHPP === "function") {
          const hppRes = getStrukturBiayaHPP(cabangId);
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
          errorText = "Fungsi getStrukturBiayaHPP belum tersedia.";
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
    return dashboardError_(err, "getDashboardHPPSummary");
  }
}

function getDashboardHargaLayananSummary(cabangId) {
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
        if (typeof getHargaLayanan === "function") {
          const hargaRes = getHargaLayanan(cabangId);
          if (hargaRes && hargaRes.ok && hargaRes.data) {
            layanan = dashboardArray_(hargaRes.data.layanan);
            warnings = dashboardArray_(hargaRes.data.warnings);
          } else {
            errorText = hargaRes && hargaRes.error ? hargaRes.error : "Harga layanan belum bisa dibaca.";
          }
        } else {
          errorText = "Fungsi getHargaLayanan belum tersedia.";
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
    return dashboardError_(err, "getDashboardHargaLayananSummary");
  }
}

function getDashboardFixedCostSummary(cabangId) {
  try {
    if (typeof listBiayaTetapOutletSummaries !== "function") {
      return {
        ok: false,
        error: "Fungsi listBiayaTetapOutletSummaries belum tersedia.",
        stage: "getDashboardFixedCostSummary:listBiayaTetapOutletSummaries_missing"
      };
    }

    const res = listBiayaTetapOutletSummaries();
    if (!res || !res.ok) {
      return {
        ok: false,
        error: res && res.error ? res.error : "Gagal membaca summary fixed cost.",
        stage: res && res.stage ? res.stage : "getDashboardFixedCostSummary:listBiayaTetapOutletSummaries"
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
    return dashboardError_(err, "getDashboardFixedCostSummary");
  }
}

/**
 * getDashboardBEPSummary
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

function saveBepServiceMix(cabangId, mixMap) {
  try {
    var cleanId = typeof cabangId === "string" ? cabangId.trim() : "";
    if (!cleanId) {
      return { ok: false, error: "ID cabang tidak valid.", stage: "saveBepServiceMix:validate_cabang_id" };
    }
    if (!mixMap || typeof mixMap !== "object") {
      return { ok: false, error: "Data mix tidak valid.", stage: "saveBepServiceMix:validate_mix" };
    }

    var cleanMix = {};
    var total = 0;
    Object.keys(mixMap).forEach(function (key) {
      var val = Math.max(0, dashboardNumber_(mixMap[key], 0));
      cleanMix[key] = val;
      total += val;
    });

    if (total <= 0) {
      return { ok: false, error: "Total persen mix harus lebih dari 0.", stage: "saveBepServiceMix:validate_total" };
    }

    // Sanitize: normalisasi otomatis ke total 100% (kalau user isi tidak
    // pas 100, misal 98 atau 103), supaya tidak perlu tolak dengan error.
    Object.keys(cleanMix).forEach(function (key) {
      cleanMix[key] = dashboardRound2_((cleanMix[key] / total) * 100);
    });

    var sheet = ensureDataSheet_();
    writeKey_(sheet, getBepMixKey_(cleanId), JSON.stringify({
      mix: cleanMix,
      updatedAt: new Date().toISOString()
    }));

    return { ok: true, data: { cabangId: cleanId, mix: cleanMix } };
  } catch (err) {
    return dashboardError_(err, "saveBepServiceMix");
  }
}

function bepEffectiveHarga_(item) {
  if (item.hargaJualPerLoad !== undefined) return dashboardNumber_(item.hargaJualPerLoad, 0);
  if (item.hargaJualPerJam !== undefined) return dashboardNumber_(item.hargaJualPerJam, 0);
  return dashboardNumber_(item.hargaJual, 0);
}

function bepEffectiveHpp_(item) {
  if (item.hppPerLoad !== undefined) return dashboardNumber_(item.hppPerLoad, 0);
  if (item.hppPerJam !== undefined) return dashboardNumber_(item.hppPerJam, 0);
  return dashboardNumber_(item.hpp, 0);
}

function getDashboardBEPSummary(cabangId) {
  try {
    var fixedCostRes = getDashboardFixedCostSummary(cabangId);
    var hppRes = getDashboardHPPSummary(cabangId);
    var hargaRes = getDashboardHargaLayananSummary(cabangId);

    var warnings = [];
    var fixedCostPerBulan = 0;

    // Ambil fixed cost
    if (fixedCostRes && fixedCostRes.ok && fixedCostRes.data) {
      fixedCostPerBulan = dashboardNumber_(fixedCostRes.data.totalFixedCostPerBulan, 0);
    } else {
      warnings.push("Fixed cost belum diisi.");
    }

    // Ambil HPP per layanan (key -> total HPP)
    var hppByKey = {};
    if (hppRes && hppRes.ok && hppRes.data && hppRes.data.rows && hppRes.data.rows.length) {
      var hppRow = hppRes.data.rows[0];
      dashboardArray_(hppRow.layananList).forEach(function (svc) {
        if (svc && svc.key) hppByKey[svc.key] = svc;
      });
    } else {
      warnings.push("HPP belum tersedia.");
    }

    // Ambil harga jual per layanan
    var hargaLayananItems = [];
    if (hargaRes && hargaRes.ok && hargaRes.data && hargaRes.data.rows && hargaRes.data.rows.length) {
      var hargaRow = hargaRes.data.rows[0];
      if (hargaRow && typeof getHargaLayanan === "function") {
        var detailRes = getHargaLayanan(hargaRow.cabangId);
        if (detailRes && detailRes.ok && detailRes.data && detailRes.data.layanan) {
          hargaLayananItems = detailRes.data.layanan;
        }
      }
    }

    // Layanan aktif utk BEP = layanan yang punya HPP DAN harga jual > 0
    var activeServices = [];
    hargaLayananItems.forEach(function (item) {
      if (!item || !item.key) return;
      var hppSvc = hppByKey[item.key];
      var harga = bepEffectiveHarga_(item);
      var hpp = hppSvc ? dashboardNumber_(hppSvc.total, 0) : bepEffectiveHpp_(item);
      if (harga > 0 && hpp > 0) {
        activeServices.push({ key: item.key, title: item.title || item.key, harga: harga, hpp: hpp });
      }
    });

    var activeKeys = activeServices.map(function (s) { return s.key; });
    var mix = getBepServiceMix_(cabangId, activeKeys);

    // rataHPP & rataHarga dihitung dengan METODE YANG SAMA: weighted average
    // pakai persen mix kontribusi tiap layanan (bukan lagi midpoint min-max
    // vs rata-rata biasa yang tidak konsisten).
    var rataHPP = 0;
    var rataHarga = 0;
    activeServices.forEach(function (s) {
      var pct = dashboardNumber_(mix[s.key], 0) / 100;
      rataHPP += s.hpp * pct;
      rataHarga += s.harga * pct;
    });
    rataHPP = dashboardRound2_(rataHPP);
    rataHarga = dashboardRound2_(rataHarga);

    if (rataHarga <= 0) warnings.push("Harga jual belum diisi.");
    if (rataHPP <= 0) warnings.push("HPP belum bisa dihitung.");

    // Hitung BEP
    var marginPerLoad = dashboardRound2_(rataHarga - rataHPP);
    var bepLoadPerBulan = 0;
    var bepOmsetPerBulan = 0;

    if (marginPerLoad > 0 && fixedCostPerBulan > 0) {
      bepLoadPerBulan = Math.ceil(fixedCostPerBulan / marginPerLoad);
      bepOmsetPerBulan = dashboardRound2_(bepLoadPerBulan * rataHarga);
    } else if (marginPerLoad <= 0 && rataHarga > 0) {
      warnings.push("Margin per load negatif atau nol — harga jual lebih rendah dari HPP.");
    }

    return {
      ok: true,
      data: {
        fixedCostPerBulan: fixedCostPerBulan,
        rataHPP: rataHPP,
        rataHarga: rataHarga,
        marginPerLoad: marginPerLoad,
        bepLoadPerBulan: bepLoadPerBulan,
        bepOmsetPerBulan: bepOmsetPerBulan,
        bepLoadPerMinggu: dashboardRound2_(bepLoadPerBulan / 4),
        bepOmsetPerMinggu: dashboardRound2_(bepOmsetPerBulan / 4),
        bepLoadPerHari: dashboardRound2_(bepLoadPerBulan / 30),
        bepOmsetPerHari: dashboardRound2_(bepOmsetPerBulan / 30),
        warnings: warnings,
        isComplete: warnings.length === 0
      }
    };
  } catch (err) {
    return dashboardError_(err, "getDashboardBEPSummary");
  }
}

// ----------------------------------------------------------------------------
// POTENSI OMSET: estimasi omset/biaya produksi/profit di KAPASITAS PENUH
// outlet, dengan basis load-equivalent yang sama seperti BEP (mix % kontribusi
// per layanan). Kapasitas maksimum dibatasi oleh mesin yang jadi BOTTLENECK
// (cuci/pengering/setrika) sesuai kombinasi layanan yang dipilih -- misalnya
// "Cuci Kering Setrika" pakai 3 mesin sekaligus, "Cuci Saja" cuma pakai mesin
// cuci. Kapasitas mentah mesin (loadMaksimalPerHari/loadPerBulan) SUMBER
// KEBENARAN TUNGGAL-nya tetap computeGroupLoad_ di Modul_Cabang.gs, TIDAK
// dihitung ulang dengan cara lain di sini.
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

function getDashboardPotensiOmsetSummary(cabangId) {
  try {
    var fixedCostRes = getDashboardFixedCostSummary(cabangId);
    var hppRes = getDashboardHPPSummary(cabangId);
    var hargaRes = getDashboardHargaLayananSummary(cabangId);
    var cabangRes = getDashboardCabangSummary(cabangId);

    var warnings = [];
    var fixedCostPerBulan = 0;
    if (fixedCostRes && fixedCostRes.ok && fixedCostRes.data) {
      fixedCostPerBulan = dashboardNumber_(fixedCostRes.data.totalFixedCostPerBulan, 0);
    } else {
      warnings.push("Fixed cost belum diisi.");
    }

    var hppByKey = {};
    if (hppRes && hppRes.ok && hppRes.data && hppRes.data.rows && hppRes.data.rows.length) {
      dashboardArray_(hppRes.data.rows[0].layananList).forEach(function (svc) {
        if (svc && svc.key) hppByKey[svc.key] = svc;
      });
    } else {
      warnings.push("HPP belum tersedia.");
    }

    var hargaLayananItems = [];
    if (hargaRes && hargaRes.ok && hargaRes.data && hargaRes.data.rows && hargaRes.data.rows.length) {
      var hargaRow = hargaRes.data.rows[0];
      if (hargaRow && typeof getHargaLayanan === "function") {
        var detailRes = getHargaLayanan(hargaRow.cabangId);
        if (detailRes && detailRes.ok && detailRes.data && detailRes.data.layanan) {
          hargaLayananItems = detailRes.data.layanan;
        }
      }
    }

    // Bed Cover sengaja tidak masuk (basisnya per item, bukan per load -
    // tidak sebanding dgn kalkulasi bottleneck load-equivalent di bawah).
    var activeServices = [];
    hargaLayananItems.forEach(function (item) {
      if (!item || !item.key || item.key === "bed_cover") return;
      var hppSvc = hppByKey[item.key];
      var harga = bepEffectiveHarga_(item);
      var hpp = hppSvc ? dashboardNumber_(hppSvc.total, 0) : bepEffectiveHpp_(item);
      if (harga > 0 && hpp > 0) {
        activeServices.push({ key: item.key, title: item.title || item.key, harga: harga, hpp: hpp });
      }
    });

    var activeKeys = activeServices.map(function (s) { return s.key; });
    var mix = getBepServiceMix_(cabangId, activeKeys);

    var rataHPP = 0;
    var rataHarga = 0;
    activeServices.forEach(function (s) {
      var pct = dashboardNumber_(mix[s.key], 0) / 100;
      rataHPP += s.hpp * pct;
      rataHarga += s.harga * pct;
    });
    rataHPP = dashboardRound2_(rataHPP);
    rataHarga = dashboardRound2_(rataHarga);

    if (rataHarga <= 0) warnings.push("Harga jual belum diisi.");
    if (rataHPP <= 0) warnings.push("HPP belum bisa dihitung.");

    // Kapasitas mentah mesin cuci & pengering (load/bulan, okupansi sudah
    // termasuk) - persis field yang sama dipakai kartu Profil Outlet.
    var cabangRow = (cabangRes && cabangRes.ok && cabangRes.data && cabangRes.data.rows && cabangRes.data.rows.length)
      ? cabangRes.data.rows[0] : null;
    var washerCapacityPerBulan = cabangRow ? dashboardNumber_(cabangRow.loadCuciPerBulan, 0) : 0;
    var dryerCapacityPerBulan = cabangRow ? dashboardNumber_(cabangRow.loadKeringPerBulan, 0) : 0;

    // Kapasitas setrika aslinya kg/jam (bukan "load") - dikonversi ke
    // load-equivalent/bulan lewat kapasitasKgPerLoad, anchor yang sama dipakai
    // semua konversi per-Kg <-> per-Load di Modul_StrukturBiayaHPP.gs.
    var setrikaCapacityPerBulan = 0;
    var kapasitasKgPerLoad = 0;
    if (typeof getStrukturBiayaHPP === "function") {
      var hppFullRes = getStrukturBiayaHPP(cabangId);
      if (hppFullRes && hppFullRes.ok && hppFullRes.data && hppFullRes.data.konversi) {
        kapasitasKgPerLoad = dashboardNumber_(hppFullRes.data.konversi.kapasitasKgPerLoad, 0);
      }
    }
    if (cabangRow && kapasitasKgPerLoad > 0) {
      var totalMenitPerHari = dashboardNumber_(cabangRow.jamTutupMenit, 0) - dashboardNumber_(cabangRow.jamBukaMenit, 0);
      if (totalMenitPerHari < 0) totalMenitPerHari += 24 * 60;
      var totalJamPerHari = totalMenitPerHari / 60;
      var okupansiSetrikaFraksi = Math.max(0, Math.min(100, dashboardNumber_(cabangRow.okupansiSetrika, 0))) / 100;
      var kapasitasSetrikaKgPerJam = dashboardNumber_(cabangRow.kapasitasSetrikaKgPerJam, 0);
      var setrikaKgPerBulan = kapasitasSetrikaKgPerJam * okupansiSetrikaFraksi * totalJamPerHari * 30;
      setrikaCapacityPerBulan = dashboardRound2_(setrikaKgPerBulan / kapasitasKgPerLoad);
    }

    var capacityByMachine = { washer: washerCapacityPerBulan, dryer: dryerCapacityPerBulan, setrika: setrikaCapacityPerBulan };

    // usageShare = total mix% layanan aktif yang memakai mesin tsb.
    var usageShare = { washer: 0, dryer: 0, setrika: 0 };
    activeServices.forEach(function (s) {
      var usage = bepMachineUsageMap_(s.key);
      var pct = dashboardNumber_(mix[s.key], 0) / 100;
      usageShare.washer += usage.washer * pct;
      usageShare.dryer += usage.dryer * pct;
      usageShare.setrika += usage.setrika * pct;
    });

    // Total transaksi maksimum = dibatasi mesin paling cepat "penuh"
    // (bottleneck), bukan penjumlahan sederhana semua kapasitas mesin.
    var candidateLoads = [];
    ["washer", "dryer", "setrika"].forEach(function (m) {
      if (usageShare[m] > 0 && capacityByMachine[m] > 0) {
        candidateLoads.push(capacityByMachine[m] / usageShare[m]);
      }
    });

    var maksimalTransaksiPerBulan = candidateLoads.length ? dashboardRound2_(Math.min.apply(null, candidateLoads)) : 0;
    if (!maksimalTransaksiPerBulan) {
      warnings.push("Kapasitas mesin belum bisa dihitung - cek Profil Outlet & konversi kapasitas kg per load.");
    }

    var estimasiOmsetPerBulan = dashboardRound2_(rataHarga * maksimalTransaksiPerBulan);
    var estimasiBiayaProduksiPerBulan = dashboardRound2_(rataHPP * maksimalTransaksiPerBulan);
    var estimasiProfitPerBulan = dashboardRound2_(estimasiOmsetPerBulan - estimasiBiayaProduksiPerBulan - fixedCostPerBulan);

    return {
      ok: true,
      data: {
        maksimalTransaksiPerBulan: maksimalTransaksiPerBulan,
        rataHPP: rataHPP,
        rataHarga: rataHarga,
        fixedCostPerBulan: fixedCostPerBulan,
        estimasiOmsetPerBulan: estimasiOmsetPerBulan,
        estimasiBiayaProduksiPerBulan: estimasiBiayaProduksiPerBulan,
        estimasiProfitPerBulan: estimasiProfitPerBulan,
        serviceMix: activeServices.map(function (s) {
          return { key: s.key, title: s.title, percent: dashboardRound2_(mix[s.key] || 0) };
        }),
        warnings: warnings,
        isComplete: warnings.length === 0 && maksimalTransaksiPerBulan > 0
      }
    };
  } catch (err) {
    return dashboardError_(err, "getDashboardPotensiOmsetSummary");
  }
}
