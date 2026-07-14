/**
 * ============================================================================
 * MODUL: AUTH (Member Login/Daftar dengan verifikasi OTP email)
 * ============================================================================
 * Username WAJIB alamat @gmail.com. Pendaftaran baru harus verifikasi kode
 * OTP 4 angka yang dikirim ke email tsb (dikirim via MailApp - akun Apps
 * Script yang deploy WAJIB otorisasi izin kirim email saat Deploy pertama).
 *
 * Penyimpanan pakai pola key-value yang sama seperti modul lain (lihat
 * Util_Penyimpanan.gs):
 *   - "authOtp_<email>"      -> pendaftaran yang BELUM diverifikasi (OTP,
 *                               hash password sementara, kedaluwarsa 5 menit)
 *   - "authUser_<email>"     -> akun yang SUDAH terverifikasi (hash + salt
 *                               password, siap dipakai login)
 *   - "accessCode_<KODE>"    -> kode akses billing (lihat blok AKSES/BILLING
 *                               di bawah)
 *
 * PUBLIC FUNCTIONS:
 * - registerUser(email, password, accessCode)
 * - verifyOtp(email, code)
 * - resendOtp(email)
 * - loginUser(email, password)
 * - requestPasswordReset(email)
 * - confirmPasswordReset(email, code, newPassword)
 * - logoutUser(sessionToken)
 *
 * [2026-07-13] MULTI-TENANT: setiap akun (authUser_<email>) sekarang juga
 * punya field tenantSpreadsheetId - ID spreadsheet KHUSUS akun itu (dibuat
 * otomatis oleh provisionTenantSpreadsheet_ saat verifyOtp sukses utk akun
 * BARU) yang menyimpan SEMUA data bisnis (outlet, biaya, harga) milik akun
 * itu, terpisah total dari akun lain. loginUser/verifyOtp yang sukses juga
 * membuat "authSession_<token>" (lihat createSession_/resolveSession_) -
 * token ini yang divalidasi withTenant_ (Code.gs) di SETIAP pemanggilan
 * fungsi backend lain, supaya baca/tulis data selalu diarahkan ke
 * spreadsheet tenant yang benar & tidak bisa dipalsukan dari client.
 *
 * [2026-07-14] AKSES/BILLING: kode akses OPSIONAL saat pendaftaran (dulu
 * wajib) - kosong = akses permanen gratis langsung. Kode dibuat MANUAL dari
 * editor Apps Script lewat generateLynkAccessCodes_(count) (tipe "paid",
 * akses permanen) atau generateAffiliateTrialCode_(nama) (tipe
 * "affiliate_trial", akses 7 hari), ATAU dari panel admin (screenAdminAfiliator)
 * lewat adminGenerateAccessCode (1 klik, tanpa input apa pun - selalu tipe
 * "affiliate_trial" 7 hari). Semua kode HANYA bisa dipakai 1x (lihat
 * registerUser). Lihat blok fungsi admin di akhir file (dekat
 * migrateOwnerToTenant_).
 * ============================================================================
 */

var AUTH_OTP_TTL_MS_ = 5 * 60 * 1000; // 5 menit

// [ADMIN] Email pemilik app - satu-satunya yang boleh memanggil fungsi admin
// (adminGenerateAccessCode/adminListAccessCodes/adminListAccounts/
// adminDeleteAccount, lihat masing-masing di bawah). Client (Script_
// Fitur_Auth.html, AUTH_ADMIN_EMAIL_CLIENT_) punya salinan email yang sama
// HANYA untuk kosmetik (tampil/sembunyi kartu menu) - kalau email admin
// berganti, ubah DUA-DUANYA supaya tetap sinkron.
var AUTH_ADMIN_EMAIL_ = "rheza354@gmail.com";
var AUTH_SESSION_TTL_MS_ = 30 * 24 * 60 * 60 * 1000; // 30 hari

/**
 * [RATE LIMIT] Pakai CacheService (bukan sheet) - counter sementara yang
 * kedaluwarsa otomatis, tidak menumpuk baris permanen di spreadsheet Master
 * & tidak perlu dibersihkan manual. Cocok utk pembatasan per-email:
 *   - loginUser: max 5 password salah / 15 menit / email (reset saat sukses)
 *   - registerUser: jeda 60 detik antar percobaan / email
 *   - resendOtp: max 3 kali / 10 menit / email
 * CATATAN: ini membatasi per EMAIL, bukan per pengunjung/IP (Apps Script web
 * app tidak expose IP pemanggil) - cukup untuk mencegah 1 email disklinamai
 * berulang-ulang, tapi tidak mencegah penyerang mencoba banyak email
 * BERBEDA sekaligus. Perlindungan tambahan (captcha dst) bisa menyusul kalau
 * pola serangan itu benar-benar terjadi.
 */
function authRateLimitCount_(key) {
  var raw = CacheService.getScriptCache().get(key);
  return raw ? parseInt(raw, 10) : 0;
}

function authRateLimitBump_(key, ttlSeconds) {
  var count = authRateLimitCount_(key) + 1;
  CacheService.getScriptCache().put(key, String(count), ttlSeconds);
  return count;
}

function authRateLimitReset_(key) {
  CacheService.getScriptCache().remove(key);
}

function authKeyOtp_(email) {
  return "authOtp_" + email;
}

function authKeyUser_(email) {
  return "authUser_" + email;
}

function authKeySession_(token) {
  return "authSession_" + token;
}

function authKeyAccessCode_(code) {
  return "accessCode_" + code;
}

function authGenerateToken_() {
  return Utilities.getUuid() + Utilities.getUuid();
}

/**
 * createSession_: dipanggil SETELAH email+password (atau OTP) tervalidasi.
 * Menulis "authSession_<token>" -> {email, tenantSpreadsheetId, expiresAt}
 * di spreadsheet Master (SELALU Master, terlepas tenant mana pun, makanya
 * dipanggil lewat ensureDataSheet_() biasa - BUKAN di dalam withTenant_).
 */
function createSession_(email) {
  var sheet = ensureDataSheet_();
  var raw = readKey_(sheet, authKeyUser_(email));
  if (!raw) return null;
  var user = JSON.parse(raw);
  var token = authGenerateToken_();
  writeKey_(sheet, authKeySession_(token), JSON.stringify({
    email: email,
    tenantSpreadsheetId: user.tenantSpreadsheetId || "",
    createdAt: Date.now(),
    expiresAt: Date.now() + AUTH_SESSION_TTL_MS_
  }));
  return token;
}

/**
 * resolveSession_: dipanggil withTenant_ (Code.gs) di SETIAP pemanggilan
 * fungsi backend lain. Balikin null kalau token kosong/tidak ada/kadaluarsa
 * (withTenant_ akan menolak permintaan dgn {ok:false, code:"UNAUTHORIZED"}).
 */
function resolveSession_(token) {
  var cleanToken = String(token || "").trim();
  if (!cleanToken) return null;

  var sheet = ensureDataSheet_();
  var raw = readKey_(sheet, authKeySession_(cleanToken));
  if (!raw) return null;

  var session;
  try {
    session = JSON.parse(raw);
  } catch (e) {
    return null;
  }

  if (Date.now() > Number(session.expiresAt || 0)) {
    deleteKeyRow_(sheet, authKeySession_(cleanToken));
    return null;
  }

  // [ONLINE TRACKING - 2026-07-14] Update lastActivityAt PALING BANYAK 1x per
  // menit per sesi, BUKAN di setiap pemanggilan - resolveSession_ dipanggil
  // withTenant_ di SETIAP request backend, kalau ditulis tiap kali akan jadi
  // "write storm" ke LockService.getScriptLock() (global, bukan per-user) saat
  // banyak user aktif bersamaan. Ambang "online" di panel admin 5 menit, jadi
  // akurasi 1 menit ini cukup, dipakai adminListAccounts (Modul_Auth.gs).
  var now = Date.now();
  if (now - Number(session.lastActivityAt || 0) > 60 * 1000) {
    session.lastActivityAt = now;
    writeKey_(sheet, authKeySession_(cleanToken), JSON.stringify(session));
  }

  return session;
}

/**
 * logoutUser: hapus sesi dari server (bukan cuma clear localStorage di
 * client) supaya token yang sama tidak bisa dipakai lagi setelah user klik
 * Keluar.
 */
function logoutUser(sessionToken) {
  try {
    var sheet = ensureDataSheet_();
    deleteKeyRow_(sheet, authKeySession_(String(sessionToken || "").trim()));
    return { ok: true, data: {} };
  } catch (err) {
    return errorResponse_(err, "logoutUser");
  }
}

/**
 * rapikanTampilanSheetAktif_: styling visual sebuah sheet (header bold +
 * warna, freeze baris judul, lebar kolom) - HANYA visual, TIDAK mengubah
 * nama sheet/kolom/urutan data. Dipanggil otomatis tiap kali sheet
 * BiayaNotaKasir/BiayaTetapOutlet baru dibuat (lihat getBiayaNotaKasirSheet_/
 * getBiayaTetapSheet_) supaya tenant baru langsung dapat tampilan rapi tanpa
 * perlu dirapikan manual satu-satu lagi.
 */
function rapikanTampilanSheetAktif_(sheet) {
  if (!sheet) return;

  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headerRange = sheet.getRange(1, 1, 1, lastCol);

  headerRange.setFontWeight("bold");
  headerRange.setBackground("#2E5E4E");
  headerRange.setFontColor("#FFFFFF");
  headerRange.setHorizontalAlignment("center");
  headerRange.setVerticalAlignment("middle");

  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 32);

  for (var c = 1; c <= lastCol; c++) {
    sheet.autoResizeColumn(c);
    var w = sheet.getColumnWidth(c);
    if (w < 110) sheet.setColumnWidth(c, 110);
    if (w > 260) sheet.setColumnWidth(c, 260);
  }

  Logger.log("[RAPIKAN] Sheet '" + sheet.getName() + "' dirapikan (" + lastCol + " kolom).");
}

/**
 * provisionTenantSpreadsheet_: dipanggil verifyOtp saat akun BARU aktif.
 * Membuat 1 spreadsheet kosong baru khusus akun ini (SpreadsheetApp.create -
 * TIDAK butuh template/DriveApp, karena ensureDataSheet_/getBiayaNotaKasirSheet_/
 * getBiayaTetapSheet_ semuanya SUDAH auto-membuat sheet+header sendiri saat
 * pertama diakses). ID-nya disimpan di authUser_<email>.tenantSpreadsheetId.
 * Idempoten: kalau akun sudah punya tenantSpreadsheetId, tidak bikin baru lagi.
 */
function provisionTenantSpreadsheet_(email) {
  return _withDataLock_(function () {
    var sheet = ensureDataSheet_();
    var raw = readKey_(sheet, authKeyUser_(email));
    if (!raw) throw new Error("Akun tidak ditemukan saat menyiapkan data tenant.");

    var user = JSON.parse(raw);
    if (user.tenantSpreadsheetId) return user.tenantSpreadsheetId;

    var newSs = SpreadsheetApp.create("Data Laundry - " + email);
    var newId = newSs.getId();

    // Sembunyikan "Sheet1" bawaan Google (tidak bisa dihapus di titik ini -
    // spreadsheet wajib punya >=1 sheet, dan sheet data lain belum terbentuk
    // sampai pertama diakses) supaya tidak terlihat sebagai tab kosong yang
    // membingungkan tenant baru. [BUG 2026-07-14] Sheet1 ini SATU-SATUNYA
    // sheet yang ada di titik ini - Google Sheets menolak permintaan
    // menyembunyikan sheet terakhir yang terlihat ("Anda tidak dapat
    // menyembunyikan semua sheet dalam dokumen"), jadi hideSheet() di sini
    // SELALU gagal & menggagalkan seluruh provisioning (akun jadi aktif tapi
    // tenantSpreadsheetId tidak pernah tersimpan). Bungkus try/catch supaya
    // kegagalan kosmetik ini tidak lagi menggagalkan hal yang penting
    // (menyambungkan akun ke datanya) - Sheet1 kosong tertinggal terlihat,
    // itu saja, tidak masalah.
    var defaultSheet = newSs.getSheets()[0];
    if (defaultSheet) {
      try { defaultSheet.hideSheet(); } catch (hideErr) {}
    }

    user.tenantSpreadsheetId = newId;
    _writeKeyCore_(sheet, authKeyUser_(email), JSON.stringify(user));
    return newId;
  });
}

function authIsValidGmail_(email) {
  var e = String(email || "").trim().toLowerCase();
  var basicEmailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!basicEmailRe.test(e)) return false;
  return e.indexOf("@gmail.com") === e.length - "@gmail.com".length;
}

function authNormalizeEmail_(email) {
  return String(email || "").trim().toLowerCase();
}

/**
 * [LAMA - v1] SHA-256 1 putaran. HANYA dipakai untuk memverifikasi akun lama
 * yang password-nya belum sempat di-upgrade. JANGAN dipakai untuk hash baru
 * lagi - lihat authHashPasswordV2_. Akun yang berhasil login pakai v1 akan
 * otomatis di-upgrade ke v2 saat itu juga (lihat loginUser).
 */
function authHashPasswordV1_(password, salt) {
  var raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(password) + ":" + String(salt),
    Utilities.Charset.UTF_8
  );
  return raw.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? "0" + v : v;
  }).join("");
}

var AUTH_HASH_V2_ITERATIONS_ = 10000;

function authBytesToHex_(bytes) {
  return bytes.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? "0" + v : v;
  }).join("");
}

/**
 * [BARU - v2] HMAC-SHA256 diulang 10.000x (skema mirip PBKDF2 - GAS tidak
 * punya bcrypt/scrypt/PBKDF2 bawaan). Jauh lebih lambat di-brute-force
 * dibanding v1 (SHA-256 1 putaran) kalau spreadsheet Master bocor. Dipakai
 * untuk SEMUA password baru (registerUser) & password lama yang di-upgrade
 * otomatis saat login berhasil (lihat loginUser).
 */
function authHashPasswordV2_(password, salt) {
  var value = String(password) + ":" + String(salt);
  for (var i = 0; i < AUTH_HASH_V2_ITERATIONS_; i++) {
    var bytes = Utilities.computeHmacSha256Signature(value, salt);
    value = authBytesToHex_(bytes);
  }
  return value;
}

function authGenerateOtp_() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function authSendOtpEmail_(email, otp) {
  MailApp.sendEmail({
    to: email,
    subject: "Kode OTP Pendaftaran - Kalkulator Laundry",
    body:
      "Halo,\n\n" +
      "Kode verifikasi (OTP) untuk pendaftaran akun Kalkulator Laundry Anda:\n\n" +
      "    " + otp + "\n\n" +
      "Kode ini berlaku selama 5 menit. Jangan bagikan kode ini ke siapa pun.\n\n" +
      "Kalau Anda tidak merasa mendaftar, abaikan email ini."
  });
}

/**
 * registerUser: validasi email (WAJIB @gmail.com) & password (min 6
 * karakter), lalu kirim OTP 4 angka ke email tsb. Akun BELUM aktif sampai
 * verifyOtp() dipanggil dengan kode yang benar. Kalau email/kode tidak
 * valid, OTP TIDAK PERNAH dikirim (validasi terjadi sebelum MailApp
 * dipanggil).
 *
 * [2026-07-14] Kode akses sekarang OPSIONAL (dulu wajib). Kosong = akses
 * permanen gratis langsung (accessType "paid", accessExpiresAt null - sama
 * seperti kode Lynk.id berbayar), TANPA reservasi kode apa pun. Diisi =
 * logika lama tetap berlaku (validasi kode ada/belum dipakai, ambil
 * type/trialDays dari kode - dari pembelian Lynk.id atau kode trial
 * afiliator, lihat generateLynkAccessCodes_/adminGenerateAccessCode).
 *
 * [AKSES/BILLING] Kode akses (kalau diisi) direservasi (ditandai used) DI
 * SINI, SEBELUM OTP dikirim - supaya 1 kode tidak bisa direbut 2 pendaftar
 * sekaligus. Kalau pengiriman OTP gagal ATAU pendaftar tidak pernah
 * menyelesaikan verifyOtp (OTP kedaluwarsa 5 menit), kode akan "menggantung"
 * berstatus used tanpa akun jadi - admin bisa lepas lagi lewat
 * releaseAccessCode_().
 */
function registerUser(email, password, accessCode) {
  try {
    var cleanEmail = authNormalizeEmail_(email);
    if (!authIsValidGmail_(cleanEmail)) {
      return { ok: false, error: "Email harus alamat Gmail yang valid (contoh: nama@gmail.com).", stage: "registerUser:validate_email" };
    }

    var cleanPassword = typeof password === "string" ? password : "";
    if (cleanPassword.length < 6) {
      return { ok: false, error: "Password minimal 6 karakter.", stage: "registerUser:validate_password" };
    }

    var cleanAccessCode = String(accessCode || "").trim().toUpperCase();

    // [RATE LIMIT] Jeda 60 detik antar percobaan daftar per email - cegah
    // klik berulang cepat menghabiskan kuota email OTP harian percuma.
    var registerRlKey = "rl_register_" + cleanEmail;
    if (authRateLimitCount_(registerRlKey) > 0) {
      return { ok: false, error: "Mohon tunggu sebentar sebelum mencoba daftar lagi.", stage: "registerUser:rate_limited" };
    }
    authRateLimitBump_(registerRlKey, 60);

    var sheet = ensureDataSheet_();

    if (readKey_(sheet, authKeyUser_(cleanEmail))) {
      return { ok: false, error: "Email ini sudah terdaftar. Silakan masuk.", stage: "registerUser:already_registered" };
    }

    var accessType = "paid";
    var trialDays = 0;
    var codeObj = null;

    if (cleanAccessCode) {
      var codeRaw = readKey_(sheet, authKeyAccessCode_(cleanAccessCode));
      if (!codeRaw) {
        return { ok: false, error: "Kode akses tidak valid.", stage: "registerUser:invalid_access_code" };
      }
      codeObj = JSON.parse(codeRaw);
      if (codeObj.used) {
        return { ok: false, error: "Kode akses ini sudah pernah dipakai.", stage: "registerUser:access_code_used" };
      }

      // Reservasi kode SEKARANG (sebelum OTP terkirim) supaya tidak bisa
      // direbut pendaftar lain di saat bersamaan.
      codeObj.used = true;
      codeObj.usedByEmail = cleanEmail;
      codeObj.usedAt = new Date().toISOString();
      writeKey_(sheet, authKeyAccessCode_(cleanAccessCode), JSON.stringify(codeObj));

      accessType = codeObj.type || "paid";
      trialDays = codeObj.trialDays || 0;
    }

    var salt = Utilities.getUuid();
    var passwordHash = authHashPasswordV2_(cleanPassword, salt);
    var otp = authGenerateOtp_();

    // Kirim dulu sebelum simpan - kalau MailApp gagal (misal alamat gmail
    // valid formatnya tapi kena error pengiriman), jangan tinggalkan OTP
    // "menggantung" yang tidak pernah bisa dipakai user. Kode akses juga
    // dilepas lagi (rollback) supaya tidak hangus percuma.
    try {
      authSendOtpEmail_(cleanEmail, otp);
    } catch (mailErr) {
      if (cleanAccessCode) releaseAccessCode_(cleanAccessCode);
      return { ok: false, error: "Gagal mengirim email OTP. Coba lagi beberapa saat.", stage: "registerUser:send_mail" };
    }

    writeKey_(sheet, authKeyOtp_(cleanEmail), JSON.stringify({
      email: cleanEmail,
      accessCode: cleanAccessCode,
      accessType: accessType,
      trialDays: trialDays,
      otp: otp,
      expiresAt: Date.now() + AUTH_OTP_TTL_MS_,
      passwordHash: passwordHash,
      salt: salt,
      hashVersion: 2,
      createdAt: new Date().toISOString()
    }));

    return { ok: true, data: { email: cleanEmail } };
  } catch (err) {
    return errorResponse_(err, "registerUser");
  }
}

/**
 * verifyOtp: cocokkan kode OTP 4 angka. Kalau benar & belum kedaluwarsa,
 * akun dipindah dari "pendaftaran belum aktif" (authOtp_) ke "akun aktif"
 * (authUser_) supaya bisa dipakai loginUser().
 */
function verifyOtp(email, code) {
  try {
    var cleanEmail = authNormalizeEmail_(email);
    var cleanCode = String(code || "").trim();

    // [RATE LIMIT 2026-07-14] Maks 5 kode salah / 15 menit / email - kode
    // OTP cuma 4 angka (10.000 kombinasi), tanpa batas percobaan bisa
    // ditebak habis-habisan oleh skrip otomatis (apalagi app sekarang bisa
    // diakses anonim). Direset saat verifikasi sukses.
    var otpRlKey = "rl_verifyotp_" + cleanEmail;
    if (authRateLimitCount_(otpRlKey) >= 5) {
      return { ok: false, error: "Terlalu banyak percobaan kode salah. Coba lagi dalam 15 menit.", stage: "verifyOtp:rate_limited" };
    }

    var sheet = ensureDataSheet_();
    var raw = readKey_(sheet, authKeyOtp_(cleanEmail));
    if (!raw) {
      return { ok: false, error: "Tidak ada pendaftaran yang menunggu verifikasi untuk email ini.", stage: "verifyOtp:not_found" };
    }

    var pending = JSON.parse(raw);
    if (Date.now() > Number(pending.expiresAt || 0)) {
      deleteKeyRow_(sheet, authKeyOtp_(cleanEmail));
      // Pendaftaran dibatalkan (kedaluwarsa) - lepas lagi kode akses yang
      // sempat direservasi di registerUser supaya tidak hangus percuma,
      // bisa dipakai ulang oleh pendaftaran berikutnya.
      if (pending.accessCode) releaseAccessCode_(pending.accessCode);
      return { ok: false, error: "Kode OTP sudah kedaluwarsa. Silakan daftar ulang.", stage: "verifyOtp:expired" };
    }

    if (cleanCode !== String(pending.otp || "")) {
      authRateLimitBump_(otpRlKey, 15 * 60);
      return { ok: false, error: "Kode OTP salah. Coba lagi.", stage: "verifyOtp:mismatch" };
    }

    authRateLimitReset_(otpRlKey);

    var accessType = pending.accessType || "paid";
    var accessExpiresAt = accessType === "affiliate_trial"
      ? Date.now() + (Number(pending.trialDays) || 7) * 24 * 60 * 60 * 1000
      : null;

    writeKey_(sheet, authKeyUser_(cleanEmail), JSON.stringify({
      email: cleanEmail,
      passwordHash: pending.passwordHash,
      salt: pending.salt,
      hashVersion: pending.hashVersion || 1,
      accessType: accessType,
      accessExpiresAt: accessExpiresAt,
      createdAt: pending.createdAt || new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
      tenantSpreadsheetId: ""
    }));
    deleteKeyRow_(sheet, authKeyOtp_(cleanEmail));

    // Akun baru aktif -> siapkan spreadsheet data khusus akun ini SEKARANG,
    // supaya begitu login pertama kali, data sudah siap dipakai. [2026-07-14]
    // Dibungkus try/catch: akun SUDAH resmi aktif di titik ini - kalau
    // pembuatan spreadsheet kebetulan gagal (timeout/quota Drive sesaat),
    // JANGAN balas error ke user (membingungkan: "verifikasi gagal" padahal
    // akun jadi) - biarkan lolos, self-heal di loginUser akan membuatkannya
    // saat login berikutnya.
    try {
      provisionTenantSpreadsheet_(cleanEmail);
    } catch (provisionErr) {}

    var sessionToken = createSession_(cleanEmail);
    return { ok: true, data: { email: cleanEmail, sessionToken: sessionToken } };
  } catch (err) {
    return errorResponse_(err, "verifyOtp");
  }
}

/**
 * resendOtp: kirim ulang kode BARU (yang lama otomatis tidak berlaku lagi)
 * ke pendaftaran yang masih menunggu verifikasi.
 */
function resendOtp(email) {
  try {
    var cleanEmail = authNormalizeEmail_(email);

    // [RATE LIMIT] Maks 3 kali kirim ulang / 10 menit / email - cegah spam
    // klik "Kirim ulang" menghabiskan kuota email OTP harian.
    var resendRlKey = "rl_resend_" + cleanEmail;
    if (authRateLimitCount_(resendRlKey) >= 3) {
      return { ok: false, error: "Terlalu banyak permintaan kirim ulang. Coba lagi dalam beberapa menit.", stage: "resendOtp:rate_limited" };
    }

    var sheet = ensureDataSheet_();
    var raw = readKey_(sheet, authKeyOtp_(cleanEmail));
    if (!raw) {
      return { ok: false, error: "Tidak ada pendaftaran yang menunggu verifikasi untuk email ini.", stage: "resendOtp:not_found" };
    }

    var pending = JSON.parse(raw);
    var otp = authGenerateOtp_();
    authRateLimitBump_(resendRlKey, 10 * 60);

    try {
      authSendOtpEmail_(cleanEmail, otp);
    } catch (mailErr) {
      return { ok: false, error: "Gagal mengirim email OTP. Coba lagi beberapa saat.", stage: "resendOtp:send_mail" };
    }

    pending.otp = otp;
    pending.expiresAt = Date.now() + AUTH_OTP_TTL_MS_;
    writeKey_(sheet, authKeyOtp_(cleanEmail), JSON.stringify(pending));

    return { ok: true, data: { email: cleanEmail } };
  } catch (err) {
    return errorResponse_(err, "resendOtp");
  }
}

/**
 * loginUser: cocokkan email + password terhadap akun yang SUDAH aktif
 * (lolos verifikasi OTP). Pesan error sengaja digeneralkan (tidak bilang
 * "email tidak ditemukan" vs "password salah" terpisah) supaya tidak bocor
 * info email mana yang terdaftar.
 */
function loginUser(email, password) {
  try {
    var cleanEmail = authNormalizeEmail_(email);
    var cleanPassword = typeof password === "string" ? password : "";

    // [RATE LIMIT] Maks 5 percobaan gagal / 15 menit / email (reset saat
    // login sukses) - cegah brute-force tebak password. Diperiksa SEBELUM
    // cek akun ada/tidak, supaya email yang tidak terdaftar pun tidak bisa
    // dipakai tebak-tebak tanpa batas.
    var loginRlKey = "rl_login_" + cleanEmail;
    if (authRateLimitCount_(loginRlKey) >= 5) {
      return { ok: false, error: "Terlalu banyak percobaan gagal. Coba lagi dalam 15 menit.", stage: "loginUser:rate_limited" };
    }

    var sheet = ensureDataSheet_();
    var raw = readKey_(sheet, authKeyUser_(cleanEmail));
    if (!raw) {
      authRateLimitBump_(loginRlKey, 15 * 60);
      return { ok: false, error: "Email atau password salah.", stage: "loginUser:not_found" };
    }

    var user = JSON.parse(raw);
    var hashVersion = user.hashVersion || 1;
    var isMatch;

    if (hashVersion >= 2) {
      isMatch = authHashPasswordV2_(cleanPassword, user.salt) === user.passwordHash;
    } else {
      isMatch = authHashPasswordV1_(cleanPassword, user.salt) === user.passwordHash;
      // [UPGRADE OTOMATIS] Password benar tapi masih pakai skema lama (SHA-256
      // 1 putaran) - hash ulang ke v2 (HMAC-SHA256 x10.000) & simpan sekarang
      // juga, supaya makin lama makin sedikit akun yang masih pakai skema
      // lemah, tanpa perlu paksa user ganti password.
      if (isMatch) {
        user.passwordHash = authHashPasswordV2_(cleanPassword, user.salt);
        user.hashVersion = 2;
        writeKey_(sheet, authKeyUser_(cleanEmail), JSON.stringify(user));
      }
    }

    if (!isMatch) {
      authRateLimitBump_(loginRlKey, 15 * 60);
      return { ok: false, error: "Email atau password salah.", stage: "loginUser:mismatch" };
    }

    authRateLimitReset_(loginRlKey);

    // [AKSES/TRIAL] accessExpiresAt kosong = akses permanen (kode Lynk.id).
    // Terisi = trial afiliator, tolak login kalau sudah lewat - data TIDAK
    // dihapus, admin bisa aktifkan permanen lewat activateAccountPermanent_().
    if (user.accessExpiresAt && Date.now() > Number(user.accessExpiresAt)) {
      return { ok: false, error: "Masa trial akun ini sudah berakhir. Hubungi admin untuk melanjutkan.", stage: "loginUser:trial_expired" };
    }

    // [SELF-HEAL 2026-07-14] Spreadsheet tenant terisi tapi TIDAK bisa
    // dibuka oleh eksekusi saat ini. Sejak pindah ke executeAs:
    // USER_DEPLOYING (semua eksekusi sebagai akun pemilik app), kasus ini
    // terjadi utk akun era USER_ACCESSING yang spreadsheet-nya kadung dibuat
    // di Drive CUSTOMER sendiri (pemilik app tidak punya akses). Buang ID
    // yang tak terjangkau itu supaya jatuh ke blok provisioning ulang di
    // bawah - dibuatkan spreadsheet baru di Drive pemilik app. Konsekuensi:
    // data di spreadsheet lama (kalau ada isinya) tidak terbawa - file lama
    // tetap utuh di Drive customer, bisa diminta di-share manual kalau
    // datanya perlu diselamatkan.
    if (user.tenantSpreadsheetId) {
      try {
        SpreadsheetApp.openById(user.tenantSpreadsheetId).getName();
      } catch (accessErr) {
        user.tenantSpreadsheetId = "";
        writeKey_(sheet, authKeyUser_(cleanEmail), JSON.stringify(user));
      }
    }

    // [SELF-HEAL 2026-07-14] Akun terverifikasi tapi BELUM punya spreadsheet
    // tenant - biasanya karena provisionTenantSpreadsheet_ di verifyOtp
    // sempat gagal di tengah jalan (lihat riwayat bug hideSheet()). Coba
    // lagi di sini. Sejak executeAs: USER_DEPLOYING, spreadsheet dibuat di
    // Drive pemilik app - selalu bisa diakses eksekusi berikutnya, tidak ada
    // lagi masalah kepemilikan silang seperti era USER_ACCESSING.
    if (!user.tenantSpreadsheetId) {
      try {
        provisionTenantSpreadsheet_(cleanEmail);
        user = JSON.parse(readKey_(sheet, authKeyUser_(cleanEmail)));
      } catch (provisionErr) {}

      if (!user.tenantSpreadsheetId) {
        return { ok: false, error: "Akun ini belum tersambung ke data. Hubungi admin untuk menyelesaikan penyiapan akun.", stage: "loginUser:missing_tenant" };
      }
    }

    var sessionToken = createSession_(cleanEmail);
    return { ok: true, data: { email: cleanEmail, sessionToken: sessionToken } };
  } catch (err) {
    return errorResponse_(err, "loginUser");
  }
}

function authKeyPasswordReset_(email) {
  return "authPasswordReset_" + email;
}

function authSendPasswordResetEmail_(email, otp) {
  MailApp.sendEmail({
    to: email,
    subject: "Kode Reset Password - Kalkulator Laundry",
    body:
      "Halo,\n\n" +
      "Kode untuk reset password akun Kalkulator Laundry Anda:\n\n" +
      "    " + otp + "\n\n" +
      "Kode ini berlaku selama 5 menit.\n\n" +
      "Kalau Anda tidak meminta reset password, abaikan email ini - password Anda TIDAK akan berubah tanpa kode ini."
  });
}

/**
 * requestPasswordReset: kirim kode 4 angka ke email (kalau akun memang
 * terdaftar) untuk reset password. SENGAJA SELALU balas {ok:true} ke client
 * terlepas akun ada/tidak (sama seperti prinsip pesan error loginUser yang
 * digeneralkan) - supaya form ini tidak bisa dipakai mengecek email mana
 * yang terdaftar di sistem.
 */
function requestPasswordReset(email) {
  try {
    var cleanEmail = authNormalizeEmail_(email);
    if (!authIsValidGmail_(cleanEmail)) {
      return { ok: false, error: "Email harus alamat Gmail yang valid (contoh: nama@gmail.com).", stage: "requestPasswordReset:validate_email" };
    }

    // [RATE LIMIT] Maks 3 kali kirim kode reset / 10 menit / email.
    var rlKey = "rl_pwreset_" + cleanEmail;
    if (authRateLimitCount_(rlKey) >= 3) {
      return { ok: false, error: "Terlalu banyak permintaan reset password. Coba lagi dalam beberapa menit.", stage: "requestPasswordReset:rate_limited" };
    }

    var sheet = ensureDataSheet_();
    var userExists = !!readKey_(sheet, authKeyUser_(cleanEmail));

    if (userExists) {
      authRateLimitBump_(rlKey, 10 * 60);
      var otp = authGenerateOtp_();
      try {
        authSendPasswordResetEmail_(cleanEmail, otp);
        writeKey_(sheet, authKeyPasswordReset_(cleanEmail), JSON.stringify({
          email: cleanEmail,
          otp: otp,
          expiresAt: Date.now() + AUTH_OTP_TTL_MS_,
          createdAt: new Date().toISOString()
        }));
      } catch (mailErr) {
        // Diam-diam gagal (tetap balas ok:true - jangan bocorkan status akun
        // ke client). confirmPasswordReset otomatis akan gagal juga kalau
        // user coba lanjut, karena tidak ada kode tersimpan.
      }
    }

    return { ok: true, data: { email: cleanEmail } };
  } catch (err) {
    return errorResponse_(err, "requestPasswordReset");
  }
}

/**
 * confirmPasswordReset: cocokkan kode reset, kalau benar & belum
 * kedaluwarsa, ganti password (salt baru + hash v2). Semua sesi login lama
 * milik email ini DIHAPUS PAKSA (scan authSession_ lewat readKeysByPrefix_)
 * supaya device manapun yang masih pakai password lama otomatis ter-logout.
 */
function confirmPasswordReset(email, code, newPassword) {
  try {
    var cleanEmail = authNormalizeEmail_(email);
    var cleanCode = String(code || "").trim();
    var cleanPassword = typeof newPassword === "string" ? newPassword : "";

    if (cleanPassword.length < 6) {
      return { ok: false, error: "Password baru minimal 6 karakter.", stage: "confirmPasswordReset:validate_password" };
    }

    // [RATE LIMIT 2026-07-14] Maks 5 kode salah / 15 menit / email - PALING
    // KRITIS dari semua rate limit di file ini: kode reset cuma 4 angka,
    // tanpa batas percobaan penyerang bisa menembak 10.000 kombinasi dalam
    // masa berlaku 5 menit & MENGAMBIL ALIH akun siapa pun (ganti password
    // tanpa tahu password lama). Direset saat kode benar.
    var resetRlKey = "rl_confirmreset_" + cleanEmail;
    if (authRateLimitCount_(resetRlKey) >= 5) {
      return { ok: false, error: "Terlalu banyak percobaan kode salah. Coba lagi dalam 15 menit.", stage: "confirmPasswordReset:rate_limited" };
    }

    var sheet = ensureDataSheet_();
    var raw = readKey_(sheet, authKeyPasswordReset_(cleanEmail));
    if (!raw) {
      return { ok: false, error: "Tidak ada permintaan reset password untuk email ini. Ulangi dari awal.", stage: "confirmPasswordReset:not_found" };
    }

    var pending = JSON.parse(raw);
    if (Date.now() > Number(pending.expiresAt || 0)) {
      deleteKeyRow_(sheet, authKeyPasswordReset_(cleanEmail));
      return { ok: false, error: "Kode reset sudah kedaluwarsa. Ulangi dari awal.", stage: "confirmPasswordReset:expired" };
    }
    if (cleanCode !== String(pending.otp || "")) {
      authRateLimitBump_(resetRlKey, 15 * 60);
      return { ok: false, error: "Kode reset salah. Coba lagi.", stage: "confirmPasswordReset:mismatch" };
    }

    authRateLimitReset_(resetRlKey);

    var userRaw = readKey_(sheet, authKeyUser_(cleanEmail));
    if (!userRaw) {
      deleteKeyRow_(sheet, authKeyPasswordReset_(cleanEmail));
      return { ok: false, error: "Akun tidak ditemukan.", stage: "confirmPasswordReset:user_not_found" };
    }

    var user = JSON.parse(userRaw);
    var salt = Utilities.getUuid();
    user.passwordHash = authHashPasswordV2_(cleanPassword, salt);
    user.salt = salt;
    user.hashVersion = 2;
    writeKey_(sheet, authKeyUser_(cleanEmail), JSON.stringify(user));
    deleteKeyRow_(sheet, authKeyPasswordReset_(cleanEmail));

    // [KEAMANAN] Paksa logout semua device yang masih pakai sesi lama.
    readKeysByPrefix_(sheet, "authSession_").forEach(function (row) {
      try {
        var s = JSON.parse(row.value);
        if (authNormalizeEmail_(s.email) === cleanEmail) deleteKeyRow_(sheet, row.key);
      } catch (e) {}
    });

    return { ok: true, data: { email: cleanEmail } };
  } catch (err) {
    return errorResponse_(err, "confirmPasswordReset");
  }
}

var ADMIN_ONLINE_THRESHOLD_MS_ = 5 * 60 * 1000; // 5 menit

/**
 * adminListAccounts: daftar SEMUA akun (aktif + yang masih menunggu
 * verifikasi OTP) buat panel admin (screenAdminAfiliator) - HANYA
 * AUTH_ADMIN_EMAIL_ yang lolos. Read-only - tidak mengubah data apa pun.
 *
 * [2026-07-14] Tambah status "online" per akun (lastActiveAt dari sesi
 * TERBARU milik email itu, lihat resolveSession_ - dianggap online kalau
 * aktivitas terakhir <=5 menit) & totalOnline di ringkasan, dipakai kartu
 * ringkasan panel admin.
 */
function adminListAccounts(sessionToken) {
  try {
    var session = resolveSession_(sessionToken);
    if (!session || authNormalizeEmail_(session.email) !== AUTH_ADMIN_EMAIL_) {
      return { ok: false, error: "Akses ditolak.", stage: "adminListAccounts:forbidden", code: "FORBIDDEN" };
    }

    var sheet = ensureDataSheet_();
    var now = Date.now();

    // Map email -> lastActivityAt TERBARU dari semua sesi aktifnya (1 akun
    // bisa login di >1 device/browser sekaligus).
    var lastActiveByEmail_ = {};
    readKeysByPrefix_(sheet, "authSession_").forEach(function (row) {
      var s;
      try { s = JSON.parse(row.value); } catch (e) { return; }
      if (!s || !s.email || now > Number(s.expiresAt || 0)) return;
      var email = authNormalizeEmail_(s.email);
      var la = Number(s.lastActivityAt || 0);
      if (!lastActiveByEmail_[email] || la > lastActiveByEmail_[email]) {
        lastActiveByEmail_[email] = la;
      }
    });

    var accounts = readKeysByPrefix_(sheet, authKeyUser_("")).map(function (row) {
      var u;
      try { u = JSON.parse(row.value); } catch (e) { return null; }

      var status;
      if (!u.accessExpiresAt) {
        status = "Aktif (permanen)";
      } else if (now > Number(u.accessExpiresAt)) {
        status = "Trial kedaluwarsa";
      } else {
        status = "Trial aktif";
      }

      var lastActiveAt = lastActiveByEmail_[authNormalizeEmail_(u.email)] || null;
      var online = !!lastActiveAt && (now - lastActiveAt) <= ADMIN_ONLINE_THRESHOLD_MS_;

      return {
        email: u.email || "",
        pending: false,
        status: status,
        accessExpiresAt: u.accessExpiresAt || null,
        afiliatorLabel: u.afiliatorLabel || "",
        createdAt: u.createdAt || "",
        lastActiveAt: lastActiveAt,
        online: online,
        hasTenant: !!u.tenantSpreadsheetId
      };
    }).filter(function (x) { return !!x; });

    var pendingAccounts = readKeysByPrefix_(sheet, authKeyOtp_("")).map(function (row) {
      var p;
      try { p = JSON.parse(row.value); } catch (e) { return null; }

      return {
        email: p.email || "",
        pending: true,
        status: (now > Number(p.expiresAt || 0)) ? "OTP kedaluwarsa (belum coba lagi)" : "Menunggu verifikasi OTP",
        accessExpiresAt: null,
        afiliatorLabel: "",
        createdAt: p.createdAt || "",
        lastActiveAt: null,
        online: false
      };
    }).filter(function (x) { return !!x; });

    var all = accounts.concat(pendingAccounts);
    all.sort(function (a, b) {
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });

    var totalOnline = accounts.filter(function (a) { return a.online; }).length;

    return { ok: true, data: { accounts: all, totalAktif: accounts.length, totalPending: pendingAccounts.length, totalOnline: totalOnline } };
  } catch (err) {
    return errorResponse_(err, "adminListAccounts");
  }
}

/**
 * adminGenerateAccessCode: [2026-07-14] Ganti alur lama (admin input email
 * afiliator lalu akun langsung dibuat) - sekarang admin CUKUP klik 1 tombol
 * di panel (screenAdminAfiliator), TANPA input email apa pun. Menghasilkan 1
 * kode trial 7 hari (type "affiliate_trial") yang belum terikat email
 * manapun - admin salin kode ini lalu kirim manual (WA/chat) ke calon user,
 * yang nanti mendaftar sendiri lewat form Daftar biasa pakai emailnya
 * sendiri + kode ini. Kode HANYA bisa dipakai 1x (lihat registerUser -
 * ditandai used begitu ada yang berhasil daftar dengannya), jadi otomatis 1
 * kode = 1 email, tidak bisa dipakai orang lain setelah itu.
 */
function adminGenerateAccessCode(sessionToken) {
  try {
    var session = resolveSession_(sessionToken);
    if (!session || authNormalizeEmail_(session.email) !== AUTH_ADMIN_EMAIL_) {
      return { ok: false, error: "Akses ditolak.", stage: "adminGenerateAccessCode:forbidden", code: "FORBIDDEN" };
    }

    var sheet = ensureDataSheet_();
    var code = "TRIAL-" + authRandomCodeSuffix_(8);

    writeKey_(sheet, authKeyAccessCode_(code), JSON.stringify({
      code: code,
      type: "affiliate_trial",
      ownerLabel: "",
      trialDays: 7,
      used: false,
      usedByEmail: "",
      createdAt: new Date().toISOString(),
      usedAt: ""
    }));

    return { ok: true, data: { code: code } };
  } catch (err) {
    return errorResponse_(err, "adminGenerateAccessCode");
  }
}

/**
 * adminListAccessCodes: riwayat SEMUA kode akses yang pernah dibuat (lewat
 * adminGenerateAccessCode ATAU generateLynkAccessCodes_/
 * generateAffiliateTrialCode_ manual dari editor) - dipakai panel admin
 * supaya kode yang belum dipakai bisa disalin ulang kapan saja. Read-only.
 */
function adminListAccessCodes(sessionToken) {
  try {
    var session = resolveSession_(sessionToken);
    if (!session || authNormalizeEmail_(session.email) !== AUTH_ADMIN_EMAIL_) {
      return { ok: false, error: "Akses ditolak.", stage: "adminListAccessCodes:forbidden", code: "FORBIDDEN" };
    }

    var sheet = ensureDataSheet_();
    var codes = readKeysByPrefix_(sheet, "accessCode_").map(function (row) {
      var c;
      try { c = JSON.parse(row.value); } catch (e) { return null; }
      return {
        code: c.code || "",
        type: c.type || "paid",
        used: !!c.used,
        usedByEmail: c.usedByEmail || "",
        createdAt: c.createdAt || "",
        usedAt: c.usedAt || ""
      };
    }).filter(function (x) { return !!x; });

    codes.sort(function (a, b) {
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });

    return { ok: true, data: { codes: codes } };
  } catch (err) {
    return errorResponse_(err, "adminListAccessCodes");
  }
}

/**
 * adminDeleteAccount: [2026-07-14] Hapus akun PERMANEN - authUser_<email>,
 * sesi aktifnya (paksa logout semua device), pendaftaran OTP menggantung
 * kalau ada, DAN spreadsheet data tenant-nya dipindah ke Trash Drive (bukan
 * musnah instan - masih bisa dipulihkan manual dari Trash 30 hari kalau
 * salah pilih akun). Setelah dihapus, email yang sama BISA daftar ulang dari
 * nol (readKey_ authUser_ akan kosong, dianggap belum pernah terdaftar).
 *
 * [PROTEKSI] Akun AUTH_ADMIN_EMAIL_ (pemilik app) tidak boleh dihapus lewat
 * sini - kalau terhapus, panel admin ini sendiri & 4 outlet Template
 * Estimasi Cepat (Modul_OnboardingEstimasi.gs, disimpan di spreadsheet
 * tenant admin) ikut tidak bisa diakses lagi.
 */
function adminDeleteAccount(sessionToken, targetEmail) {
  try {
    var session = resolveSession_(sessionToken);
    if (!session || authNormalizeEmail_(session.email) !== AUTH_ADMIN_EMAIL_) {
      return { ok: false, error: "Akses ditolak.", stage: "adminDeleteAccount:forbidden", code: "FORBIDDEN" };
    }

    var cleanEmail = authNormalizeEmail_(targetEmail);
    if (cleanEmail === AUTH_ADMIN_EMAIL_) {
      return { ok: false, error: "Akun admin utama tidak bisa dihapus dari sini.", stage: "adminDeleteAccount:protect_admin" };
    }

    var sheet = ensureDataSheet_();
    var raw = readKey_(sheet, authKeyUser_(cleanEmail));
    if (!raw) {
      return { ok: false, error: "Akun tidak ditemukan.", stage: "adminDeleteAccount:not_found" };
    }
    var user = JSON.parse(raw);

    if (user.tenantSpreadsheetId) {
      try {
        DriveApp.getFileById(user.tenantSpreadsheetId).setTrashed(true);
      } catch (driveErr) {
        // Spreadsheet mungkin sudah tidak ada/sudah di-trash sebelumnya -
        // tetap lanjut hapus akunnya, jangan gagalkan seluruh operasi.
      }
    }

    deleteKeyRow_(sheet, authKeyUser_(cleanEmail));

    if (readKey_(sheet, authKeyOtp_(cleanEmail))) {
      deleteKeyRow_(sheet, authKeyOtp_(cleanEmail));
    }

    readKeysByPrefix_(sheet, "authSession_").forEach(function (row) {
      try {
        var s = JSON.parse(row.value);
        if (authNormalizeEmail_(s.email) === cleanEmail) deleteKeyRow_(sheet, row.key);
      } catch (e) {}
    });

    return { ok: true, data: { email: cleanEmail } };
  } catch (err) {
    return errorResponse_(err, "adminDeleteAccount");
  }
}


/**
 * migrateOwnerToTenant_: jalankan MANUAL SEKALI dari editor Apps Script
 * (bukan dipanggil dari UI/client - sengaja tidak client-callable krn tidak
 * dibungkus withTenant_ & tidak dipanggil dari file .html manapun) untuk
 * menyambungkan akun PEMILIK aplikasi ini ke data yang SUDAH ADA di
 * spreadsheet Master ini sendiri (self-reference) - TIDAK memindah data
 * apa pun, cuma mengisi tenantSpreadsheetId.
 */
function migrateOwnerToTenant_(ownerEmail) {
  var cleanEmail = authNormalizeEmail_(ownerEmail);
  var sheet = ensureDataSheet_();
  var raw = readKey_(sheet, authKeyUser_(cleanEmail));
  if (!raw) {
    throw new Error("Akun " + cleanEmail + " belum terdaftar/terverifikasi. Daftar & verifikasi OTP dulu lewat UI, baru jalankan fungsi ini.");
  }
  var user = JSON.parse(raw);
  user.tenantSpreadsheetId = SpreadsheetApp.getActiveSpreadsheet().getId();
  writeKey_(sheet, authKeyUser_(cleanEmail), JSON.stringify(user));
  Logger.log("OK: " + cleanEmail + " sekarang tersambung ke spreadsheet Master ini (data asli tidak dipindah).");
}

/**
 * [AKSES/BILLING] Fungsi-fungsi di bawah ini SENGAJA TIDAK client-callable
 * (tidak dipanggil dari file .html manapun, tidak dibungkus withTenant_) -
 * jalankan MANUAL dari editor Apps Script (pilih nama fungsinya di dropdown
 * run, lalu klik Run). Sheet _data_operasional (Master) menyimpan kode-kode
 * ini di key "accessCode_<KODE>".
 */

function authRandomCodeSuffix_(length) {
  var raw = Utilities.getUuid().replace(/-/g, "").toUpperCase();
  return raw.slice(0, length);
}

/**
 * generateLynkAccessCodes_: bikin sejumlah kode akses SEKALI PAKAI (tipe
 * "paid", akses permanen - accessExpiresAt kosong). Jalankan lewat editor
 * Apps Script, isi jumlah kode yang mau dibuat (misal 50), lalu salin daftar
 * kode dari Logger (Lihat > Log Eksekusi) untuk diupload ke Lynk.id sebagai
 * daftar serial produk digital (1 kode terkirim otomatis per pembelian).
 */
function generateLynkAccessCodes_(count) {
  var sheet = ensureDataSheet_();
  var total = Number(count) || 0;
  var codes = [];

  for (var i = 0; i < total; i++) {
    var code = "KL-" + authRandomCodeSuffix_(8);
    codes.push(code);
    writeKey_(sheet, authKeyAccessCode_(code), JSON.stringify({
      code: code,
      type: "paid",
      ownerLabel: "",
      trialDays: 0,
      used: false,
      usedByEmail: "",
      createdAt: new Date().toISOString(),
      usedAt: ""
    }));
  }

  Logger.log("OK: " + total + " kode akses Lynk.id dibuat:\n" + codes.join("\n"));
  return codes;
}

/**
 * generateAffiliateTrialCode_: bikin 1 kode trial 7 hari untuk 1 afiliator
 * (bisa dilacak lewat ownerLabel siapa yang pakai kode ini). Jalankan lewat
 * editor Apps Script dengan nama afiliator sebagai argumen, salin kode dari
 * Logger, berikan ke afiliator terkait.
 */
function generateAffiliateTrialCode_(afiliatorLabel) {
  var sheet = ensureDataSheet_();
  var labelSlug = String(afiliatorLabel || "AFILIATOR").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  var code = "TRIAL-" + (labelSlug || "AFILIATOR") + "-" + authRandomCodeSuffix_(4);

  writeKey_(sheet, authKeyAccessCode_(code), JSON.stringify({
    code: code,
    type: "affiliate_trial",
    ownerLabel: String(afiliatorLabel || ""),
    trialDays: 7,
    used: false,
    usedByEmail: "",
    createdAt: new Date().toISOString(),
    usedAt: ""
  }));

  Logger.log("OK: kode trial afiliator dibuat untuk '" + afiliatorLabel + "': " + code);
  return code;
}

/**
 * activateAccountPermanent_: admin override manual - ubah akun trial
 * afiliator (atau akun lain) jadi akses permanen (accessExpiresAt
 * dikosongkan). Dipakai kalau afiliator jadi pelanggan tetap setelah masa
 * trial, atau kalau ada kasus khusus lain yang perlu diaktifkan manual.
 */
function activateAccountPermanent_(email) {
  var cleanEmail = authNormalizeEmail_(email);
  var sheet = ensureDataSheet_();
  var raw = readKey_(sheet, authKeyUser_(cleanEmail));
  if (!raw) {
    throw new Error("Akun " + cleanEmail + " tidak ditemukan.");
  }
  var user = JSON.parse(raw);
  user.accessType = "paid";
  user.accessExpiresAt = null;
  writeKey_(sheet, authKeyUser_(cleanEmail), JSON.stringify(user));
  Logger.log("OK: " + cleanEmail + " sekarang punya akses permanen.");
}

/**
 * releaseAccessCode_: lepas reservasi kode akses yang "menggantung" (used
 * tapi pendaftarnya tidak pernah selesai verifikasi OTP - kasus ini normalnya
 * sudah ditangani OTOMATIS oleh verifyOtp saat OTP kedaluwarsa, fungsi ini
 * cuma jaga-jaga untuk kasus manual/darurat lain).
 */
function releaseAccessCode_(code) {
  var cleanCode = String(code || "").trim().toUpperCase();
  var sheet = ensureDataSheet_();
  var raw = readKey_(sheet, authKeyAccessCode_(cleanCode));
  if (!raw) return;
  var codeObj = JSON.parse(raw);
  codeObj.used = false;
  codeObj.usedByEmail = "";
  codeObj.usedAt = "";
  writeKey_(sheet, authKeyAccessCode_(cleanCode), JSON.stringify(codeObj));
  Logger.log("OK: kode " + cleanCode + " dilepas, bisa dipakai lagi.");
}

