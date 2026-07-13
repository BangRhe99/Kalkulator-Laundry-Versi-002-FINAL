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
 * [2026-07-13] AKSES/BILLING: pendaftaran WAJIB kode akses valid & belum
 * dipakai (dari pembelian Lynk.id atau kode trial afiliator). Kode dibuat
 * MANUAL dari editor Apps Script lewat generateLynkAccessCodes_(count)
 * (tipe "paid", akses permanen) atau generateAffiliateTrialCode_(nama)
 * (tipe "affiliate_trial", akses 7 hari lalu diblokir sampai admin
 * mengaktifkan permanen lewat activateAccountPermanent_(email)). Lihat
 * blok fungsi admin di akhir file (dekat migrateOwnerToTenant_).
 * ============================================================================
 */

var AUTH_OTP_TTL_MS_ = 5 * 60 * 1000; // 5 menit

// [ADMIN] Email pemilik app - satu-satunya yang boleh memanggil
// adminCreateAffiliateAccount (lihat fungsi itu di bawah). Client (Script_
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
    // membingungkan tenant baru.
    var defaultSheet = newSs.getSheets()[0];
    if (defaultSheet) defaultSheet.hideSheet();

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
 * registerUser: validasi email (WAJIB @gmail.com), password (min 6 karakter)
 * & kode akses (dari pembelian Lynk.id atau kode trial afiliator - lihat
 * generateLynkAccessCodes_/generateAffiliateTrialCode_), lalu kirim OTP 4
 * angka ke email tsb. Akun BELUM aktif sampai verifyOtp() dipanggil dengan
 * kode yang benar. Kalau email/kode tidak valid, OTP TIDAK PERNAH dikirim
 * (validasi terjadi sebelum MailApp dipanggil).
 *
 * [AKSES/BILLING] Kode akses direservasi (ditandai used) DI SINI, SEBELUM
 * OTP dikirim - supaya 1 kode tidak bisa direbut 2 pendaftar sekaligus.
 * Kalau pengiriman OTP gagal ATAU pendaftar tidak pernah menyelesaikan
 * verifyOtp (OTP kedaluwarsa 5 menit), kode akan "menggantung" berstatus
 * used tanpa akun jadi - admin bisa lepas lagi lewat releaseAccessCode_().
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
    if (!cleanAccessCode) {
      return { ok: false, error: "Kode akses wajib diisi.", stage: "registerUser:validate_access_code" };
    }

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

    var codeRaw = readKey_(sheet, authKeyAccessCode_(cleanAccessCode));
    if (!codeRaw) {
      return { ok: false, error: "Kode akses tidak valid.", stage: "registerUser:invalid_access_code" };
    }
    var codeObj = JSON.parse(codeRaw);
    if (codeObj.used) {
      return { ok: false, error: "Kode akses ini sudah pernah dipakai.", stage: "registerUser:access_code_used" };
    }

    // Reservasi kode SEKARANG (sebelum OTP terkirim) supaya tidak bisa
    // direbut pendaftar lain di saat bersamaan.
    codeObj.used = true;
    codeObj.usedByEmail = cleanEmail;
    codeObj.usedAt = new Date().toISOString();
    writeKey_(sheet, authKeyAccessCode_(cleanAccessCode), JSON.stringify(codeObj));

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
      codeObj.used = false;
      codeObj.usedByEmail = "";
      codeObj.usedAt = "";
      writeKey_(sheet, authKeyAccessCode_(cleanAccessCode), JSON.stringify(codeObj));
      return { ok: false, error: "Gagal mengirim email OTP. Coba lagi beberapa saat.", stage: "registerUser:send_mail" };
    }

    writeKey_(sheet, authKeyOtp_(cleanEmail), JSON.stringify({
      email: cleanEmail,
      accessCode: cleanAccessCode,
      accessType: codeObj.type || "paid",
      trialDays: codeObj.trialDays || 0,
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
      return { ok: false, error: "Kode OTP salah. Coba lagi.", stage: "verifyOtp:mismatch" };
    }

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
    // supaya begitu login pertama kali, data sudah siap dipakai (bukan
    // "kosong tanpa tenant" yang bikin loginUser menolak).
    provisionTenantSpreadsheet_(cleanEmail);

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

    // Akun terverifikasi tapi BELUM punya spreadsheet tenant (mis. akun lama
    // dari sebelum fitur multi-tenant ini ada) - JANGAN auto-provision di
    // sini (beresiko membuat spreadsheet kosong baru & "memutus" akun dari
    // data asli yang sudah ada). Harus disambungkan manual dulu lewat
    // migrateOwnerToTenant_() dari editor Apps Script.
    if (!user.tenantSpreadsheetId) {
      return { ok: false, error: "Akun ini belum tersambung ke data. Hubungi admin untuk menyelesaikan penyiapan akun.", stage: "loginUser:missing_tenant" };
    }

    var sessionToken = createSession_(cleanEmail);
    return { ok: true, data: { email: cleanEmail, sessionToken: sessionToken } };
  } catch (err) {
    return errorResponse_(err, "loginUser");
  }
}

function authGenerateReadablePassword_() {
  // Tanpa karakter membingungkan (0/O, 1/l/I) supaya gampang dibaca/diketik
  // manual afiliator kalau perlu, walau normalnya tinggal salin dari email.
  var chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  var out = "";
  for (var i = 0; i < 10; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function authSendAffiliateCredentialsEmail_(email, password, afiliatorLabel) {
  var appUrl = ScriptApp.getService().getUrl();
  MailApp.sendEmail({
    to: email,
    subject: "Akun Kalkulator Laundry Anda (Trial Afiliator 7 Hari)",
    body:
      "Halo " + (afiliatorLabel || "") + ",\n\n" +
      "Akun trial afiliator Kalkulator Laundry Anda sudah aktif, berlaku 7 hari:\n\n" +
      "Link aplikasi : " + appUrl + "\n" +
      "Email         : " + email + "\n" +
      "Password      : " + password + "\n\n" +
      "Setelah 7 hari, akun ini perlu diaktifkan admin dulu untuk lanjut dipakai.\n\n" +
      "Selamat mencoba!"
  });
}

/**
 * adminCreateAffiliateAccount: dipanggil dari layar "Buat Akun Afiliator"
 * (screenAdminAfiliator) - HANYA email AUTH_ADMIN_EMAIL_ yang lolos cek di
 * bawah, user lain akan ditolak walau sesi login-nya valid. Beda dari
 * registerUser: TIDAK butuh kode akses & TIDAK lewat verifikasi OTP (admin
 * yang membuat langsung dianggap tepercaya) - password acak dibuat di sini,
 * langsung dikirim ke email afiliator.
 *
 * SENGAJA TIDAK dibungkus withTenant_ (Code.gs) - fungsi ini menulis ke
 * spreadsheet Master (authUser_/dst), bukan ke tenant manapun, sama seperti
 * registerUser/loginUser/dkk lain di file ini.
 */
function adminCreateAffiliateAccount(sessionToken, targetEmail, afiliatorLabel) {
  try {
    var session = resolveSession_(sessionToken);
    if (!session || authNormalizeEmail_(session.email) !== AUTH_ADMIN_EMAIL_) {
      return { ok: false, error: "Akses ditolak.", stage: "adminCreateAffiliateAccount:forbidden", code: "FORBIDDEN" };
    }

    var cleanEmail = authNormalizeEmail_(targetEmail);
    if (!authIsValidGmail_(cleanEmail)) {
      return { ok: false, error: "Email harus alamat Gmail yang valid (contoh: nama@gmail.com).", stage: "adminCreateAffiliateAccount:validate_email" };
    }

    var sheet = ensureDataSheet_();
    if (readKey_(sheet, authKeyUser_(cleanEmail))) {
      return { ok: false, error: "Email ini sudah terdaftar.", stage: "adminCreateAffiliateAccount:already_registered" };
    }

    var tempPassword = authGenerateReadablePassword_();
    var salt = Utilities.getUuid();
    var passwordHash = authHashPasswordV2_(tempPassword, salt);

    writeKey_(sheet, authKeyUser_(cleanEmail), JSON.stringify({
      email: cleanEmail,
      passwordHash: passwordHash,
      salt: salt,
      hashVersion: 2,
      accessType: "affiliate_trial",
      accessExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      afiliatorLabel: String(afiliatorLabel || ""),
      createdAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
      tenantSpreadsheetId: ""
    }));

    provisionTenantSpreadsheet_(cleanEmail);

    try {
      authSendAffiliateCredentialsEmail_(cleanEmail, tempPassword, afiliatorLabel);
    } catch (mailErr) {
      // Akun tetap valid & aktif walau email gagal terkirim - admin lihat
      // tempPassword dari response ini & sampaikan manual ke afiliator.
      return { ok: true, data: { email: cleanEmail, tempPassword: tempPassword, emailSent: false } };
    }

    return { ok: true, data: { email: cleanEmail, tempPassword: tempPassword, emailSent: true } };
  } catch (err) {
    return errorResponse_(err, "adminCreateAffiliateAccount");
  }
}

/**
 * adminListAccounts: daftar SEMUA akun (aktif + yang masih menunggu
 * verifikasi OTP) buat layar "Buat Akun Afiliator" (screenAdminAfiliator) -
 * sama seperti adminCreateAffiliateAccount, HANYA AUTH_ADMIN_EMAIL_ yang
 * lolos. Read-only - tidak mengubah data apa pun.
 */
function adminListAccounts(sessionToken) {
  try {
    var session = resolveSession_(sessionToken);
    if (!session || authNormalizeEmail_(session.email) !== AUTH_ADMIN_EMAIL_) {
      return { ok: false, error: "Akses ditolak.", stage: "adminListAccounts:forbidden", code: "FORBIDDEN" };
    }

    var sheet = ensureDataSheet_();
    var now = Date.now();

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

      return {
        email: u.email || "",
        pending: false,
        status: status,
        accessExpiresAt: u.accessExpiresAt || null,
        afiliatorLabel: u.afiliatorLabel || "",
        createdAt: u.createdAt || ""
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
        createdAt: p.createdAt || ""
      };
    }).filter(function (x) { return !!x; });

    var all = accounts.concat(pendingAccounts);
    all.sort(function (a, b) {
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });

    return { ok: true, data: { accounts: all, totalAktif: accounts.length, totalPending: pendingAccounts.length } };
  } catch (err) {
    return errorResponse_(err, "adminListAccounts");
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

