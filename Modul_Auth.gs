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
 *   - "authOtp_<email>"  -> pendaftaran yang BELUM diverifikasi (OTP, hash
 *                           password sementara, kedaluwarsa 5 menit)
 *   - "authUser_<email>" -> akun yang SUDAH terverifikasi (hash + salt
 *                           password, siap dipakai login)
 *
 * PUBLIC FUNCTIONS:
 * - registerUser(email, password)
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
 * ============================================================================
 */

var AUTH_OTP_TTL_MS_ = 5 * 60 * 1000; // 5 menit
var AUTH_SESSION_TTL_MS_ = 30 * 24 * 60 * 60 * 1000; // 30 hari

function authKeyOtp_(email) {
  return "authOtp_" + email;
}

function authKeyUser_(email) {
  return "authUser_" + email;
}

function authKeySession_(token) {
  return "authSession_" + token;
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

function authHashPassword_(password, salt) {
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
 * verifyOtp() dipanggil dengan kode yang benar. Kalau email tidak valid,
 * OTP TIDAK PERNAH dikirim (validasi terjadi sebelum MailApp dipanggil).
 */
function registerUser(email, password) {
  try {
    var cleanEmail = authNormalizeEmail_(email);
    if (!authIsValidGmail_(cleanEmail)) {
      return { ok: false, error: "Email harus alamat Gmail yang valid (contoh: nama@gmail.com).", stage: "registerUser:validate_email" };
    }

    var cleanPassword = typeof password === "string" ? password : "";
    if (cleanPassword.length < 6) {
      return { ok: false, error: "Password minimal 6 karakter.", stage: "registerUser:validate_password" };
    }

    var sheet = ensureDataSheet_();

    if (readKey_(sheet, authKeyUser_(cleanEmail))) {
      return { ok: false, error: "Email ini sudah terdaftar. Silakan masuk.", stage: "registerUser:already_registered" };
    }

    var salt = Utilities.getUuid();
    var passwordHash = authHashPassword_(cleanPassword, salt);
    var otp = authGenerateOtp_();

    // Kirim dulu sebelum simpan - kalau MailApp gagal (misal alamat gmail
    // valid formatnya tapi kena error pengiriman), jangan tinggalkan OTP
    // "menggantung" yang tidak pernah bisa dipakai user.
    try {
      authSendOtpEmail_(cleanEmail, otp);
    } catch (mailErr) {
      return { ok: false, error: "Gagal mengirim email OTP. Coba lagi beberapa saat.", stage: "registerUser:send_mail" };
    }

    writeKey_(sheet, authKeyOtp_(cleanEmail), JSON.stringify({
      email: cleanEmail,
      otp: otp,
      expiresAt: Date.now() + AUTH_OTP_TTL_MS_,
      passwordHash: passwordHash,
      salt: salt,
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
      return { ok: false, error: "Kode OTP sudah kedaluwarsa. Silakan daftar ulang.", stage: "verifyOtp:expired" };
    }

    if (cleanCode !== String(pending.otp || "")) {
      return { ok: false, error: "Kode OTP salah. Coba lagi.", stage: "verifyOtp:mismatch" };
    }

    writeKey_(sheet, authKeyUser_(cleanEmail), JSON.stringify({
      email: cleanEmail,
      passwordHash: pending.passwordHash,
      salt: pending.salt,
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
    var sheet = ensureDataSheet_();
    var raw = readKey_(sheet, authKeyOtp_(cleanEmail));
    if (!raw) {
      return { ok: false, error: "Tidak ada pendaftaran yang menunggu verifikasi untuk email ini.", stage: "resendOtp:not_found" };
    }

    var pending = JSON.parse(raw);
    var otp = authGenerateOtp_();

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

    var sheet = ensureDataSheet_();
    var raw = readKey_(sheet, authKeyUser_(cleanEmail));
    if (!raw) {
      return { ok: false, error: "Email atau password salah.", stage: "loginUser:not_found" };
    }

    var user = JSON.parse(raw);
    var hash = authHashPassword_(cleanPassword, user.salt);
    if (hash !== user.passwordHash) {
      return { ok: false, error: "Email atau password salah.", stage: "loginUser:mismatch" };
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
 * [2026-07-13] Wrapper SEKALI-PAKAI - email pemilik sudah ditulis LANGSUNG di
 * kode (bukan lewat parameter terminal), supaya "clasp run jalankanMigrasiSekali_"
 * bisa dijalankan TANPA --params sama sekali (menghindari masalah tanda kutip
 * JSON yang beda-beda tiap jenis terminal Windows). Boleh dihapus setelah
 * dijalankan sekali dan berhasil - TIDAK dipanggil dari UI/client manapun.
 */
function jalankanMigrasiSekali_() {
  migrateOwnerToTenant_("rheza354@gmail.com");
}

/**
 * [2026-07-13] Diagnosa sekali-pakai: cek apakah tenantSpreadsheetId
 * benar-benar tersimpan & spreadsheet mana yang dipakai eksekusi ini - untuk
 * melacak kenapa loginUser masih bilang "belum tersambung ke data" padahal
 * migrateOwnerToTenant_ sudah lapor OK. Boleh dihapus setelah masalah selesai.
 */
function cekStatusAkunSekali_() {
  var email = authNormalizeEmail_("rheza354@gmail.com");
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Logger.log("Spreadsheet ID (Master) yang dipakai eksekusi ini: " + (ss ? ss.getId() : "(kosong/null)"));
  Logger.log("Spreadsheet Name: " + (ss ? ss.getName() : "(kosong/null)"));

  var sheet = ensureDataSheet_();
  var raw = readKey_(sheet, authKeyUser_(email));
  Logger.log("Key dicari: " + authKeyUser_(email));
  Logger.log("Isi tersimpan (authUser_...): " + raw);

  // Cek juga apakah ada baris DUPLIKAT dgn key yang sama (indikasi race
  // condition lama sebelum LockService dipasang).
  var allValues = sheet.getDataRange().getValues();
  var matchCount = 0;
  for (var i = 1; i < allValues.length; i++) {
    if (allValues[i][0] === authKeyUser_(email)) matchCount++;
  }
  Logger.log("Jumlah baris dgn key ini di sheet: " + matchCount + " (harusnya 1)");
}
