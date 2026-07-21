/**
 * ============================================================================
 * MODUL: LAYER COMPUTED FIRESTORE (Fase 4 -- "hitung saat SIMPAN, baca sekali")
 * ============================================================================
 * Ini inti percepatan migrasi Firestore. Prinsip: hasil kalkulasi HPP
 * TIDAK dihitung ulang tiap layar dibuka (mahal di Firestore karena tiap baca
 * = 1 HTTP round-trip), melainkan dihitung SEKALI saat data biaya berubah,
 * lalu disimpan ("denormalisasi") ke field `computed.hpp` pada dokumen Cabang.
 * Baca berikutnya cukup 1 GET, bukan fan-out 7 sumber.
 *
 * tenantId Firestore = ID spreadsheet tenant aktif (activeDataSpreadsheetId_,
 * Util_Penyimpanan.gs) -- unik & stabil per tenant, tersedia otomatis di dalam
 * withTenant_ (Code.gs) maupun konteks pemilik (spreadsheet Master).
 *
 * SUMBER KEBENARAN kalkulasi TETAP getStrukturBiayaHPP_impl_
 * (Modul_StrukturBiayaHPP.gs) -- TIDAK diduplikasi di sini. Modul ini hanya
 * memindahkan KAPAN & KE MANA hasilnya disimpan.
 *
 * CATATAN AMAN: recomputeCabangSummary_ BEST-EFFORT (dibungkus try/catch,
 * TIDAK PERNAH melempar). Jadi kalau nanti dipanggil dari fungsi simpan
 * (saveBiayaAir dkk), kegagalan Firestore (jaringan/kuota) TIDAK menggagalkan
 * penyimpanan ke Sheets yang merupakan sumber kebenaran saat ini.
 * ============================================================================
 */

function firestoreCabangDocPath_(tenantId, cabangId) {
  return "tenants/" + tenantId + "/cabang/" + cabangId;
}

/**
 * Hitung ulang HPP satu cabang (via jalur Sheets yang sudah ada & terbukti)
 * lalu simpan ke field `computed.hpp` dokumen Cabang di Firestore.
 * updateMask ["computed"] -> hanya field computed yang ditimpa, field lain
 * (profil/mesin dari fase migrasi lain) tidak tersentuh.
 * BEST-EFFORT: tidak pernah melempar; kembalikan {ok:false,...} kalau gagal.
 */
function recomputeCabangSummary_(cabangId) {
  try {
    if (!cabangId || typeof cabangId !== "string") {
      return { ok: false, error: "cabangId tidak valid" };
    }
    const tenantId = activeDataSpreadsheetId_();
    if (!tenantId) return { ok: false, error: "tenantId (spreadsheet aktif) tidak ditemukan" };

    // Buang cache HPP per-eksekusi supaya dihitung ULANG dari data terbaru
    // (penting kalau dipanggil tepat setelah save dalam eksekusi yang sama).
    if (typeof _strukturBiayaHPPCache_ !== "undefined" && _strukturBiayaHPPCache_ && _strukturBiayaHPPCache_[cabangId]) {
      delete _strukturBiayaHPPCache_[cabangId];
    }

    const hppRes = getStrukturBiayaHPP_impl_(cabangId);
    if (!hppRes || !hppRes.ok) {
      return { ok: false, error: (hppRes && hppRes.error) || "getStrukturBiayaHPP gagal" };
    }

    firestoreSet_(
      firestoreCabangDocPath_(tenantId, cabangId),
      { computed: { hpp: hppRes.data, computedAt: new Date() } },
      ["computed"]
    );
    return { ok: true, tenantId: tenantId, cabangId: cabangId };
  } catch (err) {
    console.warn("recomputeCabangSummary_ gagal (non-fatal) utk " + cabangId + ": " + err);
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * Baca HPP CEPAT: 1 GET dari Firestore (computed.hpp). Kalau belum ada
 * (cabang belum pernah di-recompute), fallback hitung dari Sheets SEKALIGUS
 * memicu recompute supaya baca berikutnya sudah cepat. `_source` menandai
 * dari mana hasilnya, berguna saat verifikasi.
 */
function getStrukturBiayaHPPFast_(cabangId) {
  try {
    const tenantId = activeDataSpreadsheetId_();
    if (tenantId) {
      const doc = firestoreGet_(firestoreCabangDocPath_(tenantId, cabangId));
      if (doc && doc.computed && doc.computed.hpp) {
        return { ok: true, data: doc.computed.hpp, _source: "firestore", _computedAt: doc.computed.computedAt || null };
      }
    }
  } catch (err) {
    console.warn("getStrukturBiayaHPPFast_ Firestore gagal, fallback Sheets: " + err);
  }
  const res = getStrukturBiayaHPP_impl_(cabangId);
  try { recomputeCabangSummary_(cabangId); } catch (e) {}
  if (res && res.ok) res._source = "sheets_fallback";
  return res;
}

/**
 * Hapus dokumen computed cabang di Firestore (dipanggil saat cabang dihapus,
 * supaya tidak ada bayangan "hantu"). BEST-EFFORT.
 */
function deleteCabangComputed_(cabangId) {
  try {
    const tenantId = activeDataSpreadsheetId_();
    if (!tenantId || !cabangId) return;
    firestoreDeleteDoc_(firestoreCabangDocPath_(tenantId, cabangId));
  } catch (err) {
    console.warn("deleteCabangComputed_ gagal (non-fatal): " + err);
  }
}

/**
 * Backfill: recompute SEMUA cabang milik tenant aktif. Dipakai sekali saat
 * migrasi awal (mengisi computed.hpp untuk semua cabang yang sudah ada),
 * atau dari endpoint diagnostik. Return ringkasan per cabang.
 */
function recomputeAllCabang_() {
  const listRes = listCabang_impl_();
  if (!listRes || !listRes.ok) {
    return { ok: false, error: (listRes && listRes.error) || "listCabang gagal" };
  }
  const hasil = [];
  for (let i = 0; i < listRes.data.length; i++) {
    const c = listRes.data[i];
    const r = recomputeCabangSummary_(c.id);
    hasil.push({ id: c.id, nama: c.namaLaundry, ok: r.ok, error: r.error || null });
  }
  return { ok: true, tenantId: activeDataSpreadsheetId_(), total: hasil.length, hasil: hasil };
}
