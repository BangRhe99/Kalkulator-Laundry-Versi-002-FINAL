/**
 * ============================================================================
 * MODUL: AUTH (Member Login/Daftar - password tetap, verifikasi via klik link)
 * ============================================================================
 * Username WAJIB alamat @gmail.com. LOGIN SELALU email+password (tidak
 * berubah). Yang berubah [2026-07-22] cuma cara MEMBUKTIKAN kepemilikan
 * email: dulu user ketik kode OTP 4 angka, sekarang user KLIK LINK yang
 * dikirim Firebase Auth (magic link, dikirim client-side lewat
 * sendSignInLinkToEmail - lihat Script_Fitur_FirebaseAuth.html). Link itu
 * TIDAK PERNAH dipakai untuk login langsung (Firebase idToken cuma dipakai
 * SEKALI untuk membuktikan email lalu dibuang) - dipakai untuk 2 hal:
 *   1. Verifikasi pendaftaran baru (ganti verifyOtp lama)
 *   2. Reset password (ganti confirmPasswordReset lama, ketik kode)
 *
 * Penyimpanan pakai pola key-value yang sama seperti modul lain (lihat
 * Util_Penyimpanan.gs):
 *   - "authOtp_<email>"           -> pendaftaran yang BELUM diverifikasi
 *                                    (hash password sementara, kedaluwarsa
 *                                    5 menit) - nama key historis, isinya
 *                                    sekarang TIDAK ada field kode lagi.
 *   - "authPasswordReset_<email>" -> permintaan reset password yang MENUNGGU
 *                                    klik link (kedaluwarsa 5 menit)
 *   - "authUser_<email>"          -> akun yang SUDAH terverifikasi (hash +
 *                                    salt password, siap dipakai login)
 *
 * PUBLIC FUNCTIONS:
 * - registerUser(email, password)
 * - verifyEmailMagicLink(idToken, email)
 * - loginUser(email, password)
 * - requestPasswordReset(email)
 * - confirmPasswordResetMagicLink(idToken, email, newPassword)
 * - logoutUser(sessionToken)
 *
 * [2026-07-13] MULTI-TENANT: setiap akun (authUser_<email>) sekarang juga
 * punya field tenantSpreadsheetId - ID spreadsheet KHUSUS akun itu (dibuat
 * otomatis oleh provisionTenantSpreadsheet_ saat verifikasi email sukses utk
 * akun BARU) yang menyimpan SEMUA data bisnis (outlet, biaya, harga) milik
 * akun itu, terpisah total dari akun lain. loginUser yang sukses membuat
 * "authSession_<token>" (lihat createSession_/resolveSession_) - token ini
 * yang divalidasi withTenant_ (Code.gs) di SETIAP pemanggilan fungsi backend
 * lain, supaya baca/tulis data selalu diarahkan ke spreadsheet tenant yang
 * benar & tidak bisa dipalsukan dari client.
 *
 * [2026-07-22] FITUR KODE AKSES/BILLING (trial afiliator + kode Lynk.id)
 * DIHAPUS TOTAL - tidak berfungsi/tidak dipakai, semua akun sekarang akses
 * penuh tanpa gerbang kode apa pun.
 * ============================================================================
 */

var AUTH_PENDING_TTL_MS_ = 5 * 60 * 1000; // 5 menit (pending registrasi & pending reset password)

// [MAGIC LINK] API key web Firebase (project secret-cipher-488105-f2) -
// dipakai firebaseVerifyIdToken_ untuk verifikasi idToken lewat REST publik
// Identity Toolkit. SAMA persis dengan apiKey di Script_Fitur_FirebaseAuth.html
// (client) - kalau project Firebase pernah diganti/key di-rotate, update
// DUA-DUANYA. Web API key Firebase memang didesain publik (bukan rahasia,
// keamanan sesungguhnya dari Authorized Domains + verifikasi idToken ini).
var FIREBASE_WEB_API_KEY_ = "AIzaSyC06_ALEXOK9R_aL7bSvIVI7u_d0ANlSyk";

// [ADMIN] Email pemilik app - satu-satunya yang boleh memanggil fungsi admin
// (adminListAccounts/adminDeleteAccount, lihat masing-masing di bawah).
// Client (Script_Fitur_Auth.html, AUTH_ADMIN_EMAIL_CLIENT_) punya salinan email yang sama
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
 *   - requestPasswordReset: max 3 kali / 10 menit / email
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

function authGenerateToken_() {
  return Utilities.getUuid() + Utilities.getUuid();
}

/**
 * firebaseVerifyIdToken_: satu-satunya cara Apps Script memverifikasi idToken
 * Firebase (tidak ada Firebase Admin SDK di GAS) - panggil REST publik
 * Identity Toolkit accounts:lookup, Google yang validasi signature/expiry.
 * Balikin {email, uid} kalau valid, throw kalau tidak (idToken palsu/
 * kedaluwarsa/project salah).
 */
function firebaseVerifyIdToken_(idToken) {
  var cleanToken = String(idToken || "").trim();
  if (!cleanToken) throw new Error("idToken kosong.");

  var resp = UrlFetchApp.fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + FIREBASE_WEB_API_KEY_,
    {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ idToken: cleanToken }),
      muteHttpExceptions: true
    }
  );

  var body = JSON.parse(resp.getContentText() || "{}");
  if (resp.getResponseCode() !== 200 || !body.users || !body.users[0]) {
    var msg = (body.error && body.error.message) || "idToken tidak valid.";
    throw new Error("Verifikasi email gagal: " + msg);
  }

  var user = body.users[0];
  return { email: authNormalizeEmail_(user.email), uid: user.localId };
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

/**
 * registerUser: [2026-07-22 - PERFORMA] Password TIDAK PERNAH dikirim mentah
 * ke sini lagi - client (authDeriveHash_, Script_Fitur_AuthCrypto.html) yang
 * menghitung PBKDF2-HMAC-SHA256 10.000 iterasi via Web Crypto API browser
 * (~10ms, native/hardware-accelerated) lalu kirim salt+hash JADI ke sini.
 * Alasan: Apps Script punya overhead besar per panggilan fungsi native -
 * menghitung 10.000 iterasi HMAC DI SERVER (skema lama, lihat
 * authHashPasswordV2_) makan 6+ DETIK per hash (diukur nyata, bukan
 * estimasi) - di browser hal SAMA PERSIS cuma ~10ms. Kekuatan kriptografi
 * (10.000 iterasi) TIDAK berkurang sama sekali, cuma pindah tempat eksekusi.
 * Konsekuensi: validasi panjang password (min 6 karakter) TIDAK BISA lagi
 * dicek di sini (server tidak pernah lihat password mentah) - PINDAH ke
 * client SEBELUM hashing (lihat submitAuthRegister, Script_Fitur_Auth.html).
 *
 * Simpan pendaftaran PENDING (belum aktif, hashVersion 3 langsung - akun
 * BARU tidak pernah lewat skema lama sama sekali). Pengiriman email
 * verifikasi (magic link Firebase) dipicu CLIENT-SIDE setelah fungsi ini
 * sukses - fungsi ini sendiri TIDAK mengirim email apa pun. Akun baru aktif
 * setelah verifyEmailMagicLink() dipanggil dengan idToken yang valid.
 */
function registerUser(email, salt, derivedHash) {
  try {
    var cleanEmail = authNormalizeEmail_(email);
    if (!authIsValidGmail_(cleanEmail)) {
      return { ok: false, error: "Email harus alamat Gmail yang valid (contoh: nama@gmail.com).", stage: "registerUser:validate_email" };
    }

    var cleanSalt = typeof salt === "string" ? salt.trim() : "";
    var cleanHash = typeof derivedHash === "string" ? derivedHash.trim() : "";
    if (!cleanSalt || !cleanHash) {
      return { ok: false, error: "Data pendaftaran tidak lengkap.", stage: "registerUser:validate_hash" };
    }

    // [RATE LIMIT] Jeda 60 detik antar percobaan daftar per email - cegah
    // klik berulang cepat memicu banyak pengiriman link berturut-turut.
    var registerRlKey = "rl_register_" + cleanEmail;
    if (authRateLimitCount_(registerRlKey) > 0) {
      return { ok: false, error: "Mohon tunggu sebentar sebelum mencoba daftar lagi.", stage: "registerUser:rate_limited" };
    }
    authRateLimitBump_(registerRlKey, 60);

    var sheet = ensureDataSheet_();

    if (readKey_(sheet, authKeyUser_(cleanEmail))) {
      return { ok: false, error: "Email ini sudah terdaftar. Silakan masuk.", stage: "registerUser:already_registered" };
    }

    writeKey_(sheet, authKeyOtp_(cleanEmail), JSON.stringify({
      email: cleanEmail,
      expiresAt: Date.now() + AUTH_PENDING_TTL_MS_,
      passwordHash: cleanHash,
      salt: cleanSalt,
      hashVersion: 3,
      createdAt: new Date().toISOString()
    }));

    return { ok: true, data: { email: cleanEmail } };
  } catch (err) {
    return errorResponse_(err, "registerUser");
  }
}

/**
 * verifyEmailMagicLink: dipanggil client SETELAH user klik link Firebase &
 * berhasil signInWithEmailLink (lihat authHandleBootAuth_, Script_Fitur_
 * Auth.html). idToken dicek ke server Google (firebaseVerifyIdToken_) untuk
 * memastikan benar-benar pemilik email itu (bukan dipalsukan dari client),
 * BUKAN untuk login - akun yang berhasil diverifikasi TETAP harus login
 * manual pakai password (lihat submitAuthLogin) TIDAK ada sessionToken yang
 * dibuat di sini.
 */
function verifyEmailMagicLink(idToken, email) {
  try {
    var claimedEmail = authNormalizeEmail_(email);
    var verified;
    try {
      verified = firebaseVerifyIdToken_(idToken);
    } catch (verifyErr) {
      return { ok: false, error: verifyErr.message, stage: "verifyEmailMagicLink:invalid_token" };
    }
    if (verified.email !== claimedEmail) {
      return { ok: false, error: "Email tidak cocok dengan link verifikasi.", stage: "verifyEmailMagicLink:email_mismatch" };
    }

    var sheet = ensureDataSheet_();
    var raw = readKey_(sheet, authKeyOtp_(claimedEmail));
    if (!raw) {
      return { ok: false, error: "Tidak ada pendaftaran yang menunggu verifikasi untuk email ini.", stage: "verifyEmailMagicLink:not_found" };
    }

    var pending = JSON.parse(raw);
    if (Date.now() > Number(pending.expiresAt || 0)) {
      deleteKeyRow_(sheet, authKeyOtp_(claimedEmail));
      return { ok: false, error: "Link verifikasi sudah kedaluwarsa. Silakan daftar ulang.", stage: "verifyEmailMagicLink:expired" };
    }

    writeKey_(sheet, authKeyUser_(claimedEmail), JSON.stringify({
      email: claimedEmail,
      passwordHash: pending.passwordHash,
      salt: pending.salt,
      hashVersion: pending.hashVersion || 1,
      createdAt: pending.createdAt || new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
      tenantSpreadsheetId: ""
    }));
    deleteKeyRow_(sheet, authKeyOtp_(claimedEmail));

    // Akun baru aktif -> siapkan spreadsheet data khusus akun ini SEKARANG,
    // supaya begitu login pertama kali, data sudah siap dipakai. [2026-07-14]
    // Dibungkus try/catch: akun SUDAH resmi aktif di titik ini - kalau
    // pembuatan spreadsheet kebetulan gagal (timeout/quota Drive sesaat),
    // JANGAN balas error ke user (membingungkan: "verifikasi gagal" padahal
    // akun jadi) - biarkan lolos, self-heal di loginUser akan membuatkannya
    // saat login berikutnya.
    try {
      provisionTenantSpreadsheet_(claimedEmail);
    } catch (provisionErr) {}

    return { ok: true, data: { email: claimedEmail } };
  } catch (err) {
    return errorResponse_(err, "verifyEmailMagicLink");
  }
}

// [MAGIC LINK/PERFORMA] Pepper server-only (TIDAK PERNAH dikirim ke client)
// dipakai getAuthSalt bikin salt PALSU deterministik utk email yang belum
// terdaftar - supaya bentuk respons SELALU sama persis (email ada/tidak ada
// tidak bisa dibedakan dari luar), sama seperti prinsip pesan error
// loginUser/requestPasswordReset yang sudah digeneralkan.
var AUTH_SALT_PEPPER_ = "kl-salt-pepper-9f3a1c7e-jangan-kirim-ke-client";

function authFakeSalt_(email) {
  var bytes = Utilities.computeHmacSha256Signature(email, AUTH_SALT_PEPPER_);
  return authBytesToHex_(bytes);
}

/**
 * getAuthSalt: [2026-07-22] Langkah PERTAMA alur login cepat - client perlu
 * tahu salt akun (buat hitung PBKDF2 lokal, lihat authDeriveHash_) SEBELUM
 * tahu password-nya benar atau tidak. Public (tanpa sessionToken, sama
 * seperti loginUser/requestPasswordReset) - salt BUKAN rahasia (itu memang
 * fungsinya di skema hash begini), yang rahasia cuma passwordHash-nya.
 * Anti-enumeration: email yang TIDAK terdaftar tetap dapat balasan berbentuk
 * SAMA (salt palsu deterministik dari AUTH_SALT_PEPPER_) - tidak ada cara
 * membedakan dari luar apakah email itu benar-benar terdaftar.
 */
function getAuthSalt(email) {
  try {
    var cleanEmail = authNormalizeEmail_(email);
    var sheet = ensureDataSheet_();
    var raw = readKey_(sheet, authKeyUser_(cleanEmail));
    if (!raw) {
      return { ok: true, data: { salt: authFakeSalt_(cleanEmail), hashVersion: 1 } };
    }
    var user = JSON.parse(raw);
    return { ok: true, data: { salt: user.salt, hashVersion: user.hashVersion || 1 } };
  } catch (err) {
    return errorResponse_(err, "getAuthSalt");
  }
}

/**
 * loginFinish_: bagian akhir login yang SAMA PERSIS dipakai loginUser
 * (jalur lambat/legacy) & loginUserV3 (jalur cepat) SETELAH password
 * terverifikasi cocok - self-heal tenant spreadsheet + buat sesi. Diekstrak
 * supaya tidak duplikasi logic self-heal antar 2 fungsi.
 */
function loginFinish_(sheet, user, cleanEmail) {
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
      return { ok: false, error: "Akun ini belum tersambung ke data. Hubungi admin untuk menyelesaikan penyiapan akun.", stage: "loginFinish_:missing_tenant" };
    }
  }

  var sessionToken = createSession_(cleanEmail);
  return { ok: true, data: { email: cleanEmail, sessionToken: sessionToken } };
}

/**
 * loginUser: jalur LAMBAT/legacy - dipakai HANYA utk akun yang belum
 * ter-upgrade ke hashVersion 3 (hash masih dihitung DI SERVER, ~6-7 detik
 * sekali - lihat catatan performa di registerUser). Begitu sukses, response
 * kasih tahu client (`needsHashUpgrade`) supaya client hitung hash v3 di
 * browser & panggil upgradeAuthHashV3 di belakang layar - SEKALI itu saja
 * per akun, login-login berikutnya otomatis lewat loginUserV3 yang cepat.
 * Pesan error sengaja digeneralkan (tidak bilang "email tidak ditemukan" vs
 * "password salah" terpisah) supaya tidak bocor info email mana yang
 * terdaftar.
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

    var result = loginFinish_(sheet, user, cleanEmail);
    if (result.ok) {
      // [2026-07-22] Kasih tahu client supaya upgrade ke hashVersion 3 di
      // belakang layar (fire-and-forget, TIDAK menunda masuk app) - salt
      // TETAP salt lama, cuma hash-nya yang nanti dihitung ulang di client.
      result.data.needsHashUpgrade = true;
      result.data.salt = user.salt;
    }
    return result;
  } catch (err) {
    return errorResponse_(err, "loginUser");
  }
}

/**
 * loginUserV3: [2026-07-22] Jalur CEPAT - dipakai kalau akun sudah
 * hashVersion 3 (client sudah tahu ini via getAuthSalt). Client SUDAH
 * menghitung PBKDF2 10.000 iterasi di browser (~10ms) & kirim hasilnya ke
 * sini - server TINGGAL BANDINGKAN STRING, TIDAK ADA hashing sama sekali di
 * server. Ini yang menghilangkan 6+ detik dari proses login. Rate limit &
 * pesan error SAMA seperti loginUser (anti brute-force & anti-enumeration).
 */
function loginUserV3(email, derivedHash) {
  try {
    var cleanEmail = authNormalizeEmail_(email);
    var cleanHash = typeof derivedHash === "string" ? derivedHash.trim() : "";

    var loginRlKey = "rl_login_" + cleanEmail;
    if (authRateLimitCount_(loginRlKey) >= 5) {
      return { ok: false, error: "Terlalu banyak percobaan gagal. Coba lagi dalam 15 menit.", stage: "loginUserV3:rate_limited" };
    }

    var sheet = ensureDataSheet_();
    var raw = readKey_(sheet, authKeyUser_(cleanEmail));
    if (!raw) {
      authRateLimitBump_(loginRlKey, 15 * 60);
      return { ok: false, error: "Email atau password salah.", stage: "loginUserV3:not_found" };
    }

    var user = JSON.parse(raw);
    if ((user.hashVersion || 1) !== 3 || !cleanHash || cleanHash !== user.passwordHash) {
      authRateLimitBump_(loginRlKey, 15 * 60);
      return { ok: false, error: "Email atau password salah.", stage: "loginUserV3:mismatch" };
    }

    authRateLimitReset_(loginRlKey);
    return loginFinish_(sheet, user, cleanEmail);
  } catch (err) {
    return errorResponse_(err, "loginUserV3");
  }
}

/**
 * upgradeAuthHashV3: [2026-07-22] Dipanggil client SEKALI di belakang layar
 * (fire-and-forget) tepat setelah loginUser (jalur legacy) sukses & memberi
 * flag needsHashUpgrade - client hitung PBKDF2 pakai salt LAMA (dari
 * response loginUser) di browser, kirim hash-nya ke sini. TIDAK perlu
 * verifikasi password lagi (sessionToken yang baru dibuat loginUser SUDAH
 * bukti kepemilikan akun) - tinggal simpan & tandai hashVersion 3. Setelah
 * ini akun tsb SELAMANYA lewat jalur cepat loginUserV3.
 */
function upgradeAuthHashV3(sessionToken, derivedHash) {
  try {
    var session = resolveSession_(sessionToken);
    if (!session) {
      return { ok: false, error: "Sesi tidak valid.", stage: "upgradeAuthHashV3:invalid_session", code: "UNAUTHORIZED" };
    }
    var cleanHash = typeof derivedHash === "string" ? derivedHash.trim() : "";
    if (!cleanHash) {
      return { ok: false, error: "Data upgrade tidak lengkap.", stage: "upgradeAuthHashV3:validate_hash" };
    }

    var cleanEmail = authNormalizeEmail_(session.email);
    var sheet = ensureDataSheet_();
    var raw = readKey_(sheet, authKeyUser_(cleanEmail));
    if (!raw) {
      return { ok: false, error: "Akun tidak ditemukan.", stage: "upgradeAuthHashV3:user_not_found" };
    }

    var user = JSON.parse(raw);
    user.passwordHash = cleanHash;
    user.hashVersion = 3;
    writeKey_(sheet, authKeyUser_(cleanEmail), JSON.stringify(user));

    return { ok: true, data: { email: cleanEmail } };
  } catch (err) {
    return errorResponse_(err, "upgradeAuthHashV3");
  }
}

function authKeyPasswordReset_(email) {
  return "authPasswordReset_" + email;
}

/**
 * requestPasswordReset: tandai PENDING reset password (kalau akun memang
 * terdaftar) - email link Firebase dipicu CLIENT-SIDE setelah fungsi ini
 * sukses (lihat submitAuthForgotPassword, Script_Fitur_Auth.html), fungsi
 * ini TIDAK mengirim email apa pun. SENGAJA SELALU balas {ok:true} ke client
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

    // [RATE LIMIT] Maks 3 kali minta reset / 10 menit / email.
    var rlKey = "rl_pwreset_" + cleanEmail;
    if (authRateLimitCount_(rlKey) >= 3) {
      return { ok: false, error: "Terlalu banyak permintaan reset password. Coba lagi dalam beberapa menit.", stage: "requestPasswordReset:rate_limited" };
    }

    var sheet = ensureDataSheet_();
    var userExists = !!readKey_(sheet, authKeyUser_(cleanEmail));

    if (userExists) {
      authRateLimitBump_(rlKey, 10 * 60);
      writeKey_(sheet, authKeyPasswordReset_(cleanEmail), JSON.stringify({
        email: cleanEmail,
        expiresAt: Date.now() + AUTH_PENDING_TTL_MS_,
        createdAt: new Date().toISOString()
      }));
    }

    return { ok: true, data: { email: cleanEmail } };
  } catch (err) {
    return errorResponse_(err, "requestPasswordReset");
  }
}

/**
 * confirmPasswordResetMagicLink: dipanggil client SETELAH user klik link
 * Firebase & berhasil signInWithEmailLink (lihat authHandleBootAuth_,
 * Script_Fitur_Auth.html). idToken diverifikasi ke server Google
 * (firebaseVerifyIdToken_) untuk memastikan benar-benar pemilik email itu.
 * [2026-07-22 - PERFORMA] Password baru TIDAK PERNAH dikirim mentah - client
 * generate salt baru & hitung PBKDF2 (authDeriveHash_) SEBELUM memanggil ini
 * (sama seperti registerUser) - langsung hashVersion 3, tidak pernah lewat
 * skema lambat. Semua sesi login lama milik email ini DIHAPUS PAKSA (scan
 * authSession_ lewat readKeysByPrefix_) supaya device manapun yang masih
 * pakai password lama otomatis ter-logout.
 */
function confirmPasswordResetMagicLink(idToken, email, salt, derivedHash) {
  try {
    var claimedEmail = authNormalizeEmail_(email);
    var cleanSalt = typeof salt === "string" ? salt.trim() : "";
    var cleanHash = typeof derivedHash === "string" ? derivedHash.trim() : "";
    if (!cleanSalt || !cleanHash) {
      return { ok: false, error: "Data password tidak lengkap.", stage: "confirmPasswordResetMagicLink:validate_hash" };
    }

    var verified;
    try {
      verified = firebaseVerifyIdToken_(idToken);
    } catch (verifyErr) {
      return { ok: false, error: verifyErr.message, stage: "confirmPasswordResetMagicLink:invalid_token" };
    }
    if (verified.email !== claimedEmail) {
      return { ok: false, error: "Email tidak cocok dengan link verifikasi.", stage: "confirmPasswordResetMagicLink:email_mismatch" };
    }

    var sheet = ensureDataSheet_();
    var raw = readKey_(sheet, authKeyPasswordReset_(claimedEmail));
    if (!raw) {
      return { ok: false, error: "Tidak ada permintaan reset password untuk email ini. Ulangi dari awal.", stage: "confirmPasswordResetMagicLink:not_found" };
    }

    var pending = JSON.parse(raw);
    if (Date.now() > Number(pending.expiresAt || 0)) {
      deleteKeyRow_(sheet, authKeyPasswordReset_(claimedEmail));
      return { ok: false, error: "Link reset sudah kedaluwarsa. Ulangi dari awal.", stage: "confirmPasswordResetMagicLink:expired" };
    }

    var cleanEmail = claimedEmail;
    var userRaw = readKey_(sheet, authKeyUser_(cleanEmail));
    if (!userRaw) {
      deleteKeyRow_(sheet, authKeyPasswordReset_(cleanEmail));
      return { ok: false, error: "Akun tidak ditemukan.", stage: "confirmPasswordResetMagicLink:user_not_found" };
    }

    var user = JSON.parse(userRaw);
    user.passwordHash = cleanHash;
    user.salt = cleanSalt;
    user.hashVersion = 3;
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
    return errorResponse_(err, "confirmPasswordResetMagicLink");
  }
}

// ----------------------------------------------------------------------------
// LYNK.ID AUTO-PROVISIONING (webhook payment.received - lihat doPost, Code.gs)
// ----------------------------------------------------------------------------
// [2026-07-22] Begitu customer bayar produk Kalkulator Laundry di Lynk.id,
// akun otomatis "diundang" (invite) TANPA admin perlu generate apa pun
// manual - cocok utk pembelian jam berapa pun termasuk saat admin offline.
// Invite BUKAN akun aktif - cuma bukti "email ini sudah terverifikasi
// bayar", customer masih harus klik link & pilih password sendiri
// (completeLynkInvite) sebelum akun jadi aktif & bisa dipakai login.

var LYNK_INVITE_TTL_MS_ = 48 * 60 * 60 * 1000; // 48 jam

function authKeyLynkProcessed_(refId) {
  return "lynkProcessed_" + refId;
}

function authKeyLynkInvite_(token) {
  return "lynkInvite_" + token;
}

/**
 * processLynkPurchaseWebhook_: dipanggil doPost (Code.gs) SETELAH token URL
 * tervalidasi. Validasi ISI payload sendiri di sini (bukan di doPost) -
 * event harus "payment.received", status harus SUCCESS, DAN salah satu item
 * yang dibeli harus produk Kalkulator Laundry (toko user jual banyak produk
 * lain juga - pembelian produk LAIN harus diabaikan, tidak boleh ikut dapat
 * akun). Idempoten lewat refId - Lynk.id bisa kirim ulang webhook yang sama
 * (retry) kalau respons sebelumnya dianggap gagal, JANGAN kirim 2 email
 * invite utk 1 transaksi yang sama.
 */
function processLynkPurchaseWebhook_(payload) {
  if (!payload || payload.event !== "payment.received") return;

  var d = payload.data || {};
  if (d.message_action !== "SUCCESS") return;

  var md = d.message_data || {};
  var items = md.items || [];
  var isKalkulatorLaundry = items.some(function (item) {
    return item && item.uuid === LYNK_PRODUCT_UUID_KALKULATOR_LAUNDRY_;
  });
  if (!isKalkulatorLaundry) return;

  var refId = String(md.refId || "").trim();
  var email = authNormalizeEmail_((md.customer && md.customer.email) || "");
  if (!refId || !authIsValidGmail_(email)) {
    Logger.log("[processLynkPurchaseWebhook_] refId/email tidak valid, diabaikan. refId=" + refId + " email=" + email);
    return;
  }

  var sheet = ensureDataSheet_();

  // [IDEMPOTEN] refId yang sama sudah pernah diproses -> jangan kirim email
  // invite lagi (mencegah duplikat kalau Lynk.id retry webhook).
  if (readKey_(sheet, authKeyLynkProcessed_(refId))) {
    Logger.log("[processLynkPurchaseWebhook_] refId " + refId + " sudah pernah diproses, dilewati.");
    return;
  }

  var token = Utilities.getUuid() + Utilities.getUuid();
  writeKey_(sheet, authKeyLynkInvite_(token), JSON.stringify({
    email: email,
    refId: refId,
    expiresAt: Date.now() + LYNK_INVITE_TTL_MS_,
    used: false,
    createdAt: new Date().toISOString()
  }));

  try {
    MailApp.sendEmail({
      to: email,
      subject: "Akun Kalkulator Laundry Anda Sudah Siap!",
      body:
        "Halo,\n\n" +
        "Terima kasih sudah membeli Kalkulator Laundry. Akun Anda sudah disiapkan untuk email ini.\n\n" +
        "Klik link berikut untuk membuat password & mengaktifkan akun Anda:\n" +
        APP_EXEC_URL_ + "?lynkInvite=" + encodeURIComponent(token) + "\n\n" +
        "Link ini berlaku 48 jam dan hanya bisa dipakai 1 kali.\n\n" +
        "Kalau Anda tidak merasa melakukan pembelian ini, abaikan email ini."
    });
  } catch (mailErr) {
    Logger.log("[processLynkPurchaseWebhook_] gagal kirim email ke " + email + ": " + mailErr.message);
  }

  // Tandai refId sudah diproses SETELAH email terkirim (kalau MailApp gagal
  // di atas, refId TIDAK ditandai - webhook retry berikutnya masih bisa
  // coba lagi, bukan hangus percuma).
  writeKey_(sheet, authKeyLynkProcessed_(refId), JSON.stringify({ refId: refId, email: email, processedAt: new Date().toISOString() }));
}

/**
 * getLynkInvite: dipanggil client saat halaman dibuka dgn ?lynkInvite=<token>
 * (lihat authHandleBootAuth_/boot, Script_Fitur_Auth.html) - validasi invite
 * & balikin email-nya (utk ditampilkan read-only di layar "Aktifkan Akun").
 * Public (tanpa session, sama seperti getAuthSalt) krn dipanggil SEBELUM
 * akun ada.
 */
function getLynkInvite(token) {
  try {
    var cleanToken = String(token || "").trim();
    if (!cleanToken) {
      return { ok: false, error: "Link tidak valid.", stage: "getLynkInvite:empty_token" };
    }

    var sheet = ensureDataSheet_();
    var raw = readKey_(sheet, authKeyLynkInvite_(cleanToken));
    if (!raw) {
      return { ok: false, error: "Link tidak ditemukan atau sudah tidak berlaku.", stage: "getLynkInvite:not_found" };
    }

    var invite = JSON.parse(raw);
    if (invite.used) {
      return { ok: false, error: "Link ini sudah pernah dipakai.", stage: "getLynkInvite:already_used" };
    }
    if (Date.now() > Number(invite.expiresAt || 0)) {
      return { ok: false, error: "Link ini sudah kedaluwarsa. Hubungi admin untuk mendapatkan link baru.", stage: "getLynkInvite:expired" };
    }

    return { ok: true, data: { email: invite.email } };
  } catch (err) {
    return errorResponse_(err, "getLynkInvite");
  }
}

/**
 * completeLynkInvite: aktivasi akun sesungguhnya - password dihitung CLIENT
 * (authGenerateSalt_/authDeriveHash_, sama seperti registerUser) sebelum
 * dikirim ke sini, langsung hashVersion 3. TIDAK createSession_ (customer
 * tetap harus login manual pakai password yang baru diset - konsisten
 * dengan verifyEmailMagicLink).
 */
function completeLynkInvite(token, salt, derivedHash) {
  try {
    var cleanToken = String(token || "").trim();
    var cleanSalt = typeof salt === "string" ? salt.trim() : "";
    var cleanHash = typeof derivedHash === "string" ? derivedHash.trim() : "";
    if (!cleanSalt || !cleanHash) {
      return { ok: false, error: "Data password tidak lengkap.", stage: "completeLynkInvite:validate_hash" };
    }

    var sheet = ensureDataSheet_();
    var raw = readKey_(sheet, authKeyLynkInvite_(cleanToken));
    if (!raw) {
      return { ok: false, error: "Link tidak ditemukan atau sudah tidak berlaku.", stage: "completeLynkInvite:not_found" };
    }

    var invite = JSON.parse(raw);
    if (invite.used) {
      return { ok: false, error: "Link ini sudah pernah dipakai.", stage: "completeLynkInvite:already_used" };
    }
    if (Date.now() > Number(invite.expiresAt || 0)) {
      return { ok: false, error: "Link ini sudah kedaluwarsa. Hubungi admin untuk mendapatkan link baru.", stage: "completeLynkInvite:expired" };
    }

    var cleanEmail = authNormalizeEmail_(invite.email);
    if (readKey_(sheet, authKeyUser_(cleanEmail))) {
      return { ok: false, error: "Email ini sudah punya akun. Silakan masuk seperti biasa.", stage: "completeLynkInvite:already_registered" };
    }

    writeKey_(sheet, authKeyUser_(cleanEmail), JSON.stringify({
      email: cleanEmail,
      passwordHash: cleanHash,
      salt: cleanSalt,
      hashVersion: 3,
      createdAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
      tenantSpreadsheetId: ""
    }));

    invite.used = true;
    writeKey_(sheet, authKeyLynkInvite_(cleanToken), JSON.stringify(invite));

    try {
      provisionTenantSpreadsheet_(cleanEmail);
    } catch (provisionErr) {}

    return { ok: true, data: { email: cleanEmail } };
  } catch (err) {
    return errorResponse_(err, "completeLynkInvite");
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

      var lastActiveAt = lastActiveByEmail_[authNormalizeEmail_(u.email)] || null;
      var online = !!lastActiveAt && (now - lastActiveAt) <= ADMIN_ONLINE_THRESHOLD_MS_;

      return {
        email: u.email || "",
        pending: false,
        status: "Aktif",
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
        status: (now > Number(p.expiresAt || 0)) ? "Link verifikasi kedaluwarsa (belum coba lagi)" : "Menunggu klik link verifikasi",
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
 * adminDeleteAccount: [2026-07-14] Hapus akun PERMANEN - authUser_<email>,
 * sesi aktifnya (paksa logout semua device), pendaftaran menggantung kalau
 * ada, DAN spreadsheet data tenant-nya dipindah ke Trash Drive (bukan musnah
 * instan - masih bisa dipulihkan manual dari Trash 30 hari kalau salah pilih
 * akun). Setelah dihapus, email yang sama BISA daftar ulang dari nol
 * (readKey_ authUser_ akan kosong, dianggap belum pernah terdaftar).
 *
 * [2026-07-22] Juga bisa dipakai membersihkan pendaftaran PENDING yang macet
 * (klik link verifikasi tidak pernah selesai/link kedaluwarsa) - akun begini
 * BELUM punya authUser_ sama sekali (cuma authOtp_), jadi tidak dianggap
 * "not_found" lagi selama SALAH SATU dari authUser_/authOtp_ ada.
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
    var pendingRaw = readKey_(sheet, authKeyOtp_(cleanEmail));
    if (!raw && !pendingRaw) {
      return { ok: false, error: "Akun tidak ditemukan.", stage: "adminDeleteAccount:not_found" };
    }

    if (raw) {
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
    }

    if (pendingRaw) {
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

