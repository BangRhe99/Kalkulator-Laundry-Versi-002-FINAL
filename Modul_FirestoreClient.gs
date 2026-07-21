/**
 * ============================================================================
 * MODUL: FIRESTORE CLIENT (REST API wrapper untuk Apps Script)
 * ============================================================================
 * Apps Script TIDAK punya SDK Firestore native -- modul ini bicara langsung
 * ke Firestore REST API v1 lewat UrlFetchApp, otentikasi pakai service
 * account (JWT bearer flow -> OAuth2 access token, di-cache 55 menit).
 *
 * SETUP SEKALI JALAN (WAJIB sebelum modul ini bisa dipakai -- dilakukan
 * MANUAL oleh pemilik project, BUKAN lewat kode/commit apapun):
 *   1. Di Google Cloud Console, buat Firestore database (mode "Native"),
 *      di project yang sama dengan Apps Script ini (Project Settings
 *      Apps Script > Google Cloud Platform (GCP) Project, lihat project id-nya).
 *   2. Buat Service Account (IAM & Admin > Service Accounts), role:
 *      "Cloud Datastore User" (cukup ini, prinsip least-privilege).
 *   3. Buat JSON key untuk service account itu (tab Keys > Add Key >
 *      Create new key > JSON) -- file akan terdownload ke komputermu.
 *   4. Di Apps Script EDITOR (bukan di file .gs manapun!): klik gerigi
 *      "Project Settings" > scroll ke "Script Properties" > "Add script
 *      property", tambahkan 3 baris ini (isi dari file JSON key tadi):
 *        FIRESTORE_PROJECT_ID    <- field "project_id" di JSON
 *        FIRESTORE_CLIENT_EMAIL  <- field "client_email" di JSON
 *        FIRESTORE_PRIVATE_KEY   <- field "private_key" di JSON (utuh,
 *                                    termasuk baris -----BEGIN/END-----)
 *   Kredensial TIDAK PERNAH ditulis ke kode -- itu sebabnya dibaca dari
 *   Script Properties, bukan konstanta di file ini.
 * ============================================================================
 */

function firestoreProjectId_() {
  var id = PropertiesService.getScriptProperties().getProperty("FIRESTORE_PROJECT_ID");
  if (!id) throw new Error("FIRESTORE_PROJECT_ID belum di-setup di Script Properties.");
  return id;
}

function firestoreBaseUrl_() {
  return "https://firestore.googleapis.com/v1/projects/" + firestoreProjectId_() + "/databases/(default)/documents";
}

/**
 * Ambil OAuth2 access token dari service account (JWT bearer flow),
 * di-cache di CacheService 55 menit (token asli berlaku 60 menit).
 */
function firestoreAccessToken_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get("firestore_access_token");
  if (cached) return cached;

  var props = PropertiesService.getScriptProperties();
  var clientEmail = props.getProperty("FIRESTORE_CLIENT_EMAIL");
  var privateKey = props.getProperty("FIRESTORE_PRIVATE_KEY");
  if (!clientEmail || !privateKey) {
    throw new Error("Kredensial Firestore belum di-setup (FIRESTORE_CLIENT_EMAIL / FIRESTORE_PRIVATE_KEY di Script Properties). Lihat komentar di atas file ini.");
  }
  // File JSON service account menyimpan private_key dengan literal "\n"
  // (dua karakter backslash+n), bukan baris baru sungguhan -- kalau di-paste
  // apa adanya ke Script Properties, ubah balik jadi baris baru asli di sini
  // supaya computeRsaSha256Signature tidak gagal parse PEM-nya.
  privateKey = privateKey.replace(/\\n/g, "\n");

  var now = Math.floor(Date.now() / 1000);
  var header = { alg: "RS256", typ: "JWT" };
  var claimSet = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  var toSign = firestoreBase64Url_(JSON.stringify(header)) + "." + firestoreBase64Url_(JSON.stringify(claimSet));
  var signatureBytes = Utilities.computeRsaSha256Signature(toSign, privateKey);
  var jwt = toSign + "." + Utilities.base64EncodeWebSafe(signatureBytes).replace(/=+$/, "");

  var resp = UrlFetchApp.fetch("https://oauth2.googleapis.com/token", {
    method: "post",
    payload: {
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    },
    muteHttpExceptions: true,
  });
  var body = JSON.parse(resp.getContentText());
  if (!body.access_token) {
    throw new Error("Gagal ambil token Firestore: " + resp.getContentText());
  }
  cache.put("firestore_access_token", body.access_token, 55 * 60);
  return body.access_token;
}

function firestoreBase64Url_(str) {
  return Utilities.base64EncodeWebSafe(Utilities.newBlob(str).getBytes()).replace(/=+$/, "");
}

function firestoreFetch_(method, url, payload) {
  var options = {
    method: method,
    headers: { Authorization: "Bearer " + firestoreAccessToken_() },
    muteHttpExceptions: true,
    contentType: "application/json",
  };
  if (payload !== undefined) options.payload = JSON.stringify(payload);
  var resp = UrlFetchApp.fetch(url, options);
  var code = resp.getResponseCode();
  var text = resp.getContentText();
  if (code >= 300) {
    throw new Error("Firestore API error (" + code + "): " + text);
  }
  return text ? JSON.parse(text) : null;
}

// ----------------------------------------------------------------------------
// Konversi objek JS <-> format "fields" Firestore REST
// ----------------------------------------------------------------------------

function firestoreToValue_(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === "string") return { stringValue: value };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(firestoreToValue_) } };
  }
  if (typeof value === "object") {
    return { mapValue: { fields: firestoreToFields_(value) } };
  }
  return { stringValue: String(value) };
}

function firestoreToFields_(obj) {
  var fields = {};
  Object.keys(obj || {}).forEach(function (key) {
    fields[key] = firestoreToValue_(obj[key]);
  });
  return fields;
}

function firestoreFromValue_(value) {
  if (!value) return null;
  if ("nullValue" in value) return null;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("stringValue" in value) return value.stringValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("arrayValue" in value) {
    return (value.arrayValue.values || []).map(firestoreFromValue_);
  }
  if ("mapValue" in value) {
    return firestoreFromFields_(value.mapValue.fields || {});
  }
  return null;
}

function firestoreFromFields_(fields) {
  var obj = {};
  Object.keys(fields || {}).forEach(function (key) {
    obj[key] = firestoreFromValue_(fields[key]);
  });
  return obj;
}

function firestoreFromDoc_(doc) {
  if (!doc || !doc.fields) return null;
  var obj = firestoreFromFields_(doc.fields);
  obj._path = doc.name;
  return obj;
}

// ----------------------------------------------------------------------------
// Operasi dasar: get, set (upsert / merge sebagian), batchGet, listCollection
// ----------------------------------------------------------------------------

/** relPath contoh: "tenants/abc123/cabang/xyz/config/air" */
function firestoreGet_(relPath) {
  try {
    var doc = firestoreFetch_("get", firestoreBaseUrl_() + "/" + relPath);
    return firestoreFromDoc_(doc);
  } catch (err) {
    if (String(err).indexOf("(404)") !== -1) return null;
    throw err;
  }
}

/**
 * Upsert dokumen di relPath.
 * - Tanpa updateMaskFields: dokumen DIGANTI TOTAL dengan `data` (dipakai
 *   untuk dokumen yang memang seharusnya 1 kesatuan, mis. config/air).
 * - Dengan updateMaskFields (array nama field top-level): HANYA field itu
 *   yang ditimpa, field lain di dokumen yang sama tidak tersentuh. WAJIB
 *   dipakai kalau menulis field `computed` di dokumen Cabang, supaya
 *   profil/mesinCuci/dst milik cabang itu tidak ikut terhapus.
 */
function firestoreSet_(relPath, data, updateMaskFields) {
  var url = firestoreBaseUrl_() + "/" + relPath;
  if (updateMaskFields && updateMaskFields.length) {
    url += "?" + updateMaskFields.map(function (f) {
      return "updateMask.fieldPaths=" + encodeURIComponent(f);
    }).join("&");
  }
  return firestoreFetch_("patch", url, { fields: firestoreToFields_(data) });
}

/**
 * Ambil banyak dokumen sekaligus dalam SATU HTTP call (bukan 1 request per
 * dokumen) -- ini yang dipakai recomputeCabangSummary_ nanti supaya baca
 * config/air + config/listrik + dst tidak jadi banyak round-trip terpisah.
 * relPaths: array of "tenants/.../cabang/..." (tanpa base URL)
 * Return: map { relPath: objOrNull }
 */
function firestoreBatchGet_(relPaths) {
  if (!relPaths.length) return {};
  var fullNames = relPaths.map(function (p) {
    return "projects/" + firestoreProjectId_() + "/databases/(default)/documents/" + p;
  });
  var result = firestoreFetch_("post", firestoreBaseUrl_() + ":batchGet", { documents: fullNames });
  var out = {};
  relPaths.forEach(function (p) { out[p] = null; });
  (result || []).forEach(function (item) {
    if (!item.found) return;
    var name = item.found.name;
    var relPath = name.substring(name.indexOf("/documents/") + "/documents/".length);
    out[relPath] = firestoreFromDoc_(item.found);
  });
  return out;
}

/** List semua dokumen di subkoleksi, mis. parentRelPath="tenants/x/cabang/y", collectionId="gas". */
function firestoreListCollection_(parentRelPath, collectionId) {
  var url = firestoreBaseUrl_() + "/" + parentRelPath + "/" + collectionId;
  var result = firestoreFetch_("get", url);
  var docs = (result && result.documents) || [];
  return docs.map(firestoreFromDoc_);
}

/**
 * Tes cepat: jalankan MANUAL dari Apps Script editor (pilih fungsi ini di
 * dropdown, klik Run) setelah Script Properties diisi, untuk pastikan
 * kredensial & koneksi ke Firestore sudah benar sebelum lanjut ke migrasi
 * data sungguhan.
 */
function testFirestoreConnection_() {
  var testPath = "tenants/_diagnostic/ping";
  firestoreSet_(testPath, { pingAt: new Date(), ok: true });
  var readBack = firestoreGet_(testPath);
  Logger.log("Koneksi Firestore OK. Baca balik: %s", JSON.stringify(readBack));
  return readBack;
}
