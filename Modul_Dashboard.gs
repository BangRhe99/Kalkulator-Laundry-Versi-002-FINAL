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

function dashboardFormatRp_(value) {
  var num = Math.round(dashboardNumber_(value, 0));
  var sign = num < 0 ? "-" : "";
  return sign + "Rp" + Math.abs(num).toLocaleString("id-ID");
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

    // VALIDASI WAJIB: total kontribusi harus 100% (toleransi 0.5% utk
    // pembulatan input desimal) -- BUKAN dinormalisasi otomatis, supaya user
    // sadar & sengaja menetapkan proporsi yang benar (sesuai spesifikasi BEP
    // Campuran Layanan).
    if (Math.abs(total - 100) > 0.5) {
      return {
        ok: false,
        error: "Total kontribusi layanan harus 100%.",
        stage: "saveBepServiceMix:validate_total"
      };
    }

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

  var hppRes = getDashboardHPPSummary(cabangId);
  var hppByKey = {};
  if (hppRes && hppRes.ok && hppRes.data && hppRes.data.rows && hppRes.data.rows.length) {
    dashboardArray_(hppRes.data.rows[0].layananList).forEach(function (svc) {
      if (svc && svc.key) hppByKey[svc.key] = svc;
    });
  } else {
    warnings.push("HPP belum tersedia.");
  }

  var hargaRes = getDashboardHargaLayananSummary(cabangId);
  var requiredItems = [];
  if (hargaRes && hargaRes.ok && hargaRes.data && hargaRes.data.rows && hargaRes.data.rows.length) {
    var hargaRow = hargaRes.data.rows[0];
    if (hargaRow && typeof getHargaLayanan === "function") {
      var detailRes = getHargaLayanan(hargaRow.cabangId);
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

function getDashboardBEPSummary(cabangId) {
  try {
    var fixedCostRes = getDashboardFixedCostSummary(cabangId);
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
    return dashboardError_(err, "getDashboardBEPSummary");
  }
}

function omzetBepBulanan_selisihRelatif_(omzetBep, totalBiayaBep) {
  var basis = Math.max(Math.abs(omzetBep), Math.abs(totalBiayaBep), 1);
  return Math.abs(omzetBep - totalBiayaBep) / basis;
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
    var cabangRes = getDashboardCabangSummary(cabangId);

    var warnings = [];
    var fixedCostPerBulan = 0;
    if (fixedCostRes && fixedCostRes.ok && fixedCostRes.data) {
      fixedCostPerBulan = dashboardNumber_(fixedCostRes.data.totalFixedCostPerBulan, 0);
    } else {
      warnings.push("Fixed cost belum diisi.");
    }

    var weighted = getBepWeightedServiceData_(cabangId);
    warnings = warnings.concat(weighted.warnings);
    var activeServices = weighted.services;
    var rataHPP = weighted.rataHPP;
    var rataHarga = weighted.rataHarga;

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
      var pct = dashboardNumber_(s.percent, 0) / 100;
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

    var maksimalTransaksiPerBulan = (weighted.ok && candidateLoads.length) ? Math.min.apply(null, candidateLoads) : 0;
    if (weighted.ok && !maksimalTransaksiPerBulan) {
      warnings.push("Kapasitas mesin belum bisa dihitung - cek Profil Outlet & konversi kapasitas kg per load.");
    }

    var estimasiOmsetPerBulan = rataHarga * maksimalTransaksiPerBulan;
    var estimasiBiayaProduksiPerBulan = rataHPP * maksimalTransaksiPerBulan;
    var estimasiProfitPerBulan = estimasiOmsetPerBulan - estimasiBiayaProduksiPerBulan - fixedCostPerBulan;

    return {
      ok: true,
      data: {
        maksimalTransaksiPerBulan: dashboardRound2_(maksimalTransaksiPerBulan),
        rataHPP: dashboardRound2_(rataHPP),
        rataHarga: dashboardRound2_(rataHarga),
        fixedCostPerBulan: fixedCostPerBulan,
        estimasiOmsetPerBulan: dashboardRound2_(estimasiOmsetPerBulan),
        estimasiBiayaProduksiPerBulan: dashboardRound2_(estimasiBiayaProduksiPerBulan),
        estimasiProfitPerBulan: dashboardRound2_(estimasiProfitPerBulan),
        serviceMix: activeServices.map(function (s) {
          return { key: s.key, title: s.title, percent: s.percent };
        }),
        warnings: warnings,
        isComplete: weighted.ok && maksimalTransaksiPerBulan > 0
      }
    };
  } catch (err) {
    return dashboardError_(err, "getDashboardPotensiOmsetSummary");
  }
}
