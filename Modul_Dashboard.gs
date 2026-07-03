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
        jenisCuci: (function() { var arr = dashboardArray_(item.mesinCuci); if (!arr.length) return ""; var j = arr[0].jenis || ""; return j === "rumah_tangga" ? "home" : j === "komersial" ? "commercial" : j; })(),
        jenisKering: (function() { var arr = dashboardArray_(item.mesinPengering); if (!arr.length) return ""; var j = arr[0].jenis || ""; return j === "konversi" ? "home" : j === "komersial" ? "commercial" : j; })()
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
      // Ambil nilai biaya per load per komponen
      const komponenBiaya = [];
      let totalBiayaPerLoad = 0;

      try {
        if (typeof listBiayaGas === "function") {
          const gasRes = listBiayaGas(cabangId);
          if (gasRes && gasRes.ok && gasRes.data && gasRes.data.items) {
            let gasTotalPerLoad = 0;
            dashboardArray_(gasRes.data.items).forEach(function(g) {
              gasTotalPerLoad += dashboardNumber_((g.summary || {}).biayaPerLoad, 0);
            });
            if (gasTotalPerLoad > 0) {
              komponenBiaya.push({ key: "gas", label: "Gas LPG", biayaPerLoad: dashboardRound2_(gasTotalPerLoad) });
              totalBiayaPerLoad += gasTotalPerLoad;
            }
          }
        }
      } catch(e) {}

      try {
        if (typeof getBiayaListrik === "function") {
          const listrikRes = getBiayaListrik(cabangId);
          if (listrikRes && listrikRes.ok && listrikRes.data && listrikRes.data.summary) {
            const rataListrik = dashboardNumber_(listrikRes.data.summary.rataRataBiayaPerLoad, 0);
            if (rataListrik > 0) {
              komponenBiaya.push({ key: "listrik", label: "Listrik", biayaPerLoad: dashboardRound2_(rataListrik) });
              totalBiayaPerLoad += rataListrik;
            }
          }
        }
      } catch(e) {}

      try {
        if (typeof getBiayaAir === "function") {
          const airRes = getBiayaAir(cabangId);
          if (airRes && airRes.ok && airRes.data && airRes.data.record) {
            const airPerLoad = dashboardNumber_(airRes.data.record.biayaPerLoad, 0);
            if (airPerLoad > 0) {
              komponenBiaya.push({ key: "air", label: "Air", biayaPerLoad: dashboardRound2_(airPerLoad) });
              totalBiayaPerLoad += airPerLoad;
            }
          }
        }
      } catch(e) {}

      try {
        if (typeof getBiayaNotaKasir === "function") {
          const notaRes = getBiayaNotaKasir(cabangId);
          if (notaRes && notaRes.ok && notaRes.data && notaRes.data.record) {
            const notaPerLoad = dashboardNumber_(notaRes.data.record.totalBiayaNotaKasirPerLoad, 0);
            if (notaPerLoad > 0) {
              komponenBiaya.push({ key: "nota", label: "Nota/Kasir", biayaPerLoad: dashboardRound2_(notaPerLoad) });
              totalBiayaPerLoad += notaPerLoad;
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
        totalKomponen: 4,
        isComplete: lengkapCount === 4,
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

      try {
        if (typeof getStrukturBiayaHPP === "function") {
          const hppRes = getStrukturBiayaHPP(cabangId);
          if (hppRes && hppRes.ok && hppRes.data) {
            layanan = dashboardArray_(hppRes.data.layanan);
            warnings = dashboardArray_(hppRes.data.warnings);
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

      layanan.forEach(function (svc) {
        if (!svc) return;
        const total = dashboardNumber_(svc.total, 0);
        if (total > 0) totals.push(total);
        if (String(svc.key || "") === "cuci_kering") {
          hppCuciKering = dashboardRound2_(total);
        }
      });

      const isReady = totals.length > 0;

      return {
        cabangId: cabangId,
        namaLaundry: dashboardOutletName_(item),
        isReady: isReady,
        hppMin: isReady ? dashboardRound2_(Math.min.apply(null, totals)) : 0,
        hppMax: isReady ? dashboardRound2_(Math.max.apply(null, totals)) : 0,
        hppCuciKering: hppCuciKering,
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
        totalLayanan: totalLayanan,
        hargaTerisiCount: hargaTerisiCount,
        rugiCount: rugiCount,
        tipisCount: tipisCount,
        impasCount: impasCount,
        amanCount: amanCount,
        minMarginPercent: marginPercents.length ? dashboardRound2_(Math.min.apply(null, marginPercents)) : null,
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

      return {
        cabangId: String(cabang.id || ""),
        namaLaundry: String(cabang.namaLaundry || "Outlet tanpa nama"),
        hasData: !!item.hasData,
        totalPerBulan: dashboardRound2_(summary.totalPerBulan),
        totalPerHari: dashboardRound2_(summary.totalPerHari),
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
        rows: rows
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
function getDashboardBEPSummary(cabangId) {
  try {
    var fixedCostRes = getDashboardFixedCostSummary(cabangId);
    var hppRes = getDashboardHPPSummary(cabangId);
    var hargaRes = getDashboardHargaLayananSummary(cabangId);

    var warnings = [];
    var fixedCostPerBulan = 0;
    var rataHPP = 0;
    var rataHarga = 0;

    // Ambil fixed cost
    if (fixedCostRes && fixedCostRes.ok && fixedCostRes.data) {
      fixedCostPerBulan = dashboardNumber_(fixedCostRes.data.totalFixedCostPerBulan, 0);
    } else {
      warnings.push("Fixed cost belum diisi.");
    }

    // Ambil rata-rata HPP dari semua layanan
    if (hppRes && hppRes.ok && hppRes.data && hppRes.data.rows && hppRes.data.rows.length) {
      var hppRow = hppRes.data.rows[0];
      if (hppRow.hppMin > 0 && hppRow.hppMax > 0) {
        rataHPP = dashboardRound2_((hppRow.hppMin + hppRow.hppMax) / 2);
      } else if (hppRow.hppCuciKering > 0) {
        rataHPP = hppRow.hppCuciKering;
      }
    } else {
      warnings.push("HPP belum tersedia.");
    }

    // Ambil rata-rata harga jual dari semua layanan
    if (hargaRes && hargaRes.ok && hargaRes.data && hargaRes.data.rows && hargaRes.data.rows.length) {
      var hargaRow = hargaRes.data.rows[0];
      if (hargaRow && typeof getHargaLayanan === "function") {
        var detailRes = getHargaLayanan(hargaRow.cabangId);
        if (detailRes && detailRes.ok && detailRes.data && detailRes.data.layanan) {
          var layanan = detailRes.data.layanan.filter(function(l) { return l.hargaJual > 0; });
          if (layanan.length > 0) {
            var totalHarga = layanan.reduce(function(sum, l) { return sum + dashboardNumber_(l.hargaJual, 0); }, 0);
            rataHarga = dashboardRound2_(totalHarga / layanan.length);
          }
        }
      }
    }

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
