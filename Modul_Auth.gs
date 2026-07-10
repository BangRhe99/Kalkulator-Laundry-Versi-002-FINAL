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
 * ============================================================================
 */

var AUTH_OTP_TTL_MS_ = 5 * 60 * 1000; // 5 menit

function authKeyOtp_(email) {
  return "authOtp_" + email;
}

function authKeyUser_(email) {
  return "authUser_" + email;
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
      verifiedAt: new Date().toISOString()
    }));
    deleteKeyRow_(sheet, authKeyOtp_(cleanEmail));

    return { ok: true, data: { email: cleanEmail } };
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

    return { ok: true, data: { email: cleanEmail } };
  } catch (err) {
    return errorResponse_(err, "loginUser");
  }
}
