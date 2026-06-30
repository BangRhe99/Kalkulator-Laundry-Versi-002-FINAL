/**
 * ============================================================================
 * MIGRASI SKEMA — riwayat & logika upgrade versi skema data
 * ============================================================================
 *
 * KENAPA FILE INI TERPISAH DARI Modul_*.gs:
 *   File ini bukan "fitur" yang dipakai user, tapi "riwayat" bagaimana bentuk
 *   data berubah dari waktu ke waktu. Dipisah supaya kalau kamu lupa versi
 *   skema sekarang berapa atau migrasi apa saja yang pernah terjadi, tinggal
 *   buka SATU file ini — tidak perlu menelusuri Modul_Cabang.gs,
 *   Modul_BiayaGas.gs, dst satu per satu.
 *
 * RIWAYAT SKEMA (lihat juga komentar SCHEMA_VERSION di Code.gs):
 *   v1 -> v2 : Operasional tunggal (1 set data/Sheet) jadi multi-cabang.
 *              Satuan kapasitas mesin diubah dari kg menjadi LOAD/siklus.
 *              ADA transformasi data lama -> lihat migrateV1ToV2_ di bawah.
 *   v2 -> v3 : Penambahan modul Master Biaya, kategori Gas LPG.
 *              TIDAK ADA transformasi data lama (data baru, bukan migrasi).
 *   v3 -> v4 : Penambahan modul Master Biaya, kategori Listrik.
 *              TIDAK ADA transformasi data lama (data baru, dibuat on-demand).
 *
 * CARA MENAMBAH MIGRASI BARU (v4 -> v5 dan seterusnya):
 *   1. Di ensureMigrated_(), tambah blok baru:
 *        if (meta.schemaVersion < 5) {
 *          migrateV4ToV5_(sheet);   // HANYA jika ada transformasi data lama
 *          meta.schemaVersion = 5;
 *        }
 *      Jika fitur barumu TIDAK mengubah bentuk data lama (seperti v2->v3 dan
 *      v3->v4 di atas), cukup naikkan meta.schemaVersion TANPA memanggil
 *      fungsi migrateXToY_ apapun — jangan buat fungsi migrasi kosong.
 *   2. Naikkan SCHEMA_VERSION di Code.gs ke angka yang sama.
 *   3. Tulis catatan riwayat skema baru di komentar atas file ini DAN di
 *      Code.gs, supaya kedua tempat selalu sinkron.
 *
 * DAFTAR ISI:
 *   - ensureMigrated_      -> dipanggil di awal SETIAP fungsi publik di semua
 *                             Modul_*.gs. Idempotent: aman dipanggil berkali-
 *                             kali, hanya benar-benar migrasi sekali.
 *   - migrateV1ToV2_       -> transformasi data v1 (single record) ke v2
 *                             (multi-cabang). Lihat catatan detail di bawah.
 *   - timeStringToMinutes_ -> helper KHUSUS migrasi v1 (parse "HH:MM" lama)
 * ============================================================================
 */

/**
 * Dipanggil di awal setiap fungsi publik. Idempotent: aman dipanggil berkali-kali,
 * hanya benar-benar memigrasi sekali (ditandai lewat key "meta").
 */
function ensureMigrated_() {
  const sheet = ensureDataSheet_();
  const metaRaw = readKey_(sheet, KEY_META);
  const meta = metaRaw ? JSON.parse(metaRaw) : { schemaVersion: 0 };

  if (meta.schemaVersion >= SCHEMA_VERSION) {
    return;
  }

  if (meta.schemaVersion < 1) {
    meta.schemaVersion = 1;
  }

  if (meta.schemaVersion < 2) {
    migrateV1ToV2_(sheet);
    meta.schemaVersion = 2;
  }

  if (meta.schemaVersion < 3) {
    // v2 -> v3: tidak ada migrasi data (Master Biaya adalah data baru,
    // bukan transformasi data lama). Hanya menaikkan nomor skema.
    meta.schemaVersion = 3;
  }

  if (meta.schemaVersion < 4) {
    // v3 -> v4: tidak ada migrasi data (konfigurasi listrik adalah data baru
    // per cabang, dibuat on-demand lewat getBiayaListrik/saveBiayaListrik).
    meta.schemaVersion = 4;
  }

  // Pola untuk migrasi berikutnya, jangan dihapus sebagai acuan:
  // if (meta.schemaVersion < 5) {
  //   migrateV4ToV5_(sheet);
  //   meta.schemaVersion = 5;
  // }

  writeKey_(sheet, KEY_META, JSON.stringify(meta));
}

/**
 * v1 menyimpan SATU object di key "operasional_v1" dengan kapasitas dalam kg
 * dan jam dalam string "HH:MM". v2 menyimpan BANYAK cabang dengan jam dalam
 * menit (integer) dan field profil yang konsisten dengan struktur cabang.
 * Jika ditemukan data v1, dikonversi jadi satu cabang pertama ("Cabang 1")
 * supaya data lama TIDAK HILANG.
 */
function migrateV1ToV2_(sheet) {
  const legacyRaw = readKey_(sheet, KEY_LEGACY_V1);
  if (!legacyRaw) return;

  try {
    const legacy = JSON.parse(legacyRaw);
    const cabang = defaultCabang_();
    cabang.id = newId_("c");
    cabang.profil.namaLaundry = toSafeString_(legacy.profil && legacy.profil.namaLaundry, "Cabang 1", 100);
    cabang.profil.jamBukaMenit = timeStringToMinutes_(legacy.profil && legacy.profil.jamBuka, 8 * 60);
    cabang.profil.jamTutupMenit = timeStringToMinutes_(legacy.profil && legacy.profil.jamTutup, 21 * 60);
    cabang.mesinCuci = toMachineArray_(legacy.mesinCuci);
    cabang.mesinPengering = toMachineArray_(legacy.mesinPengering);
    cabang.kategoriLayanan = legacy.kategoriLayanan || "self_service";
    cabang.okupansi.cuciPersen = toNumber_(legacy.okupansi && legacy.okupansi.cuciPersen, 70);
    cabang.okupansi.keringPersen = toNumber_(legacy.okupansi && legacy.okupansi.keringPersen, 70);
    const now = new Date().toISOString();
    cabang.createdAt = legacy.updatedAt || now;
    cabang.updatedAt = legacy.updatedAt || now;

    writeKey_(sheet, "cabang_" + cabang.id, JSON.stringify(cabang));
    appendToOrder_(sheet, KEY_CABANG_ORDER, cabang.id);
  } catch (e) {
    Logger.log("Migrasi v1->v2 gagal dibaca, data v1 dilewati: " + e.message);
  }
}

function timeStringToMinutes_(hhmm, fallback) {
  if (typeof hhmm !== "string") return fallback;
  const m = hhmm.match(/^(\d{2}):(\d{2})$/);
  if (!m) return fallback;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return fallback;
  return h * 60 + mm;
}
