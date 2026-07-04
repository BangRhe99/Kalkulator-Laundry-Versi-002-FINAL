# KONTEKS PROYEK: Kalkulator Laundry Versi 002
**File ini gabungan dari konteks proyek + rule desain dashboard. Upload file ini saja di awal sesi baru.**

---

## IDENTITAS PROYEK

- **Nama:** Kalkulator Laundry Versi 002 - FINAL
- **Platform:** Google Apps Script Web App
- **GitHub:** https://github.com/BangRhe99/Kalkulator-Laundry-Versi-002-FINAL
- **URL Produksi:** https://script.google.com/macros/s/AKfycbxW6oL3GjGDUo8WKYOvfR5lIvdgAoNFiEI_hi9BDpsZwbA1oy58iq50w4VvvPR5TKnaQw/exec
- **Folder Lokal:** `C:\Users\user\Documents\Kalkulator-Laundry-Versi-002-FINAL`

---

## STRUKTUR FILE UTAMA

| File | Fungsi |
|------|--------|
| `Code.gs` | Entry point Web App, `doGet()`, `include()` |
| `Index.html` | HTML utama + seluruh JavaScript browser (~4900+ baris) |
| `Style_Tokens.html` | CSS variables / design tokens |
| `Style_Base.html` | Layout dasar, body, wrap, header, brand |
| `Style_Components.html` | Card, tombol, komponen UI (~900+ baris) |
| `Style_Module_*.html` | CSS khusus per modul (masing-masing dibungkus `<style>...</style>`) |
| `Modul_Dashboard.gs` | Fungsi backend untuk data Dashboard (~550+ baris) |
| `Modul_Cabang.gs` | CRUD data outlet/cabang |
| `Modul_BiayaGas.gs` | Biaya Gas LPG |
| `Modul_BiayaListrik.gs` | Biaya Listrik |
| `Modul_BiayaAir.gs` | Biaya Air |
| `Modul_BiayaNotaKasir.gs` | Biaya Nota/Kasir |
| `Modul_BiayaTetapOutlet.gs` | Fixed Cost bulanan |
| `Modul_HargaLayanan.gs` | Harga Jual & Margin |
| `Modul_StrukturBiayaHPP.gs` | HPP per layanan |

---

## WORKFLOW STANDAR

```
Edit file lokal
→ git add . && git commit -m "pesan" && git push
→ clasp push
→ Deploy New Version di Apps Script editor
→ Test di URL /exec
```

**PENTING:** `clasp push` saja TIDAK cukup. Harus Deploy New Version.

---

## GAYA KOMUNIKASI USER

1. **Step by step** — satu langkah, satu konfirmasi
2. **Verifikasi dulu** sebelum eksekusi — cek posisi baris sebelum patch
3. **Tidak tebak-tebakan** — audit dulu, jangan asal patch
4. **Backup selalu** sebelum perubahan besar
5. **Verifikasi screen count = 16** setelah setiap patch Index.html
6. **Claude boleh dan wajib beda pendapat** kalau prinsip user bertentangan standar desain
7. **Tidak perlu jelaskan ulang** struktur atau alur kerja
8. **Hemat token** — verifikasi cukup 1 baris atau radius kecil (±3 baris), JANGAN minta user paste ulang seluruh blok
9. **Patch harus bersih sekali jalan** — hindari tambal-sulam baris per baris yang melelahkan
10. **Semua eksekusi/edit/debug file dilakukan user sendiri via PowerShell** — Claude hanya analisis dan menyiapkan perintah siap-pakai

---

## METODE PATCH AMAN

### Berbasis Nomor Baris (untuk edit 1 baris):
```powershell
$lines = Get-Content "Index.html" -Encoding UTF8
$lines[index] = "isi baru"
Set-Content -Path "Index.html" -Value $lines -Encoding UTF8
```

### Splice untuk Ganti/Sisip Banyak Baris (PALING ANDAL untuk blok besar):
```powershell
$lines = Get-Content "Index.html" -Encoding UTF8
$before = $lines[0..N]
$after  = $lines[M..$($lines.Length - 1)]
$new = @('baris1', 'baris2', 'baris3')
Set-Content -Path "Index.html" -Value ($before + $new + $after) -Encoding UTF8
```
**HATI-HATI:** pastikan indeks `$before` dan `$after` tidak memotong baris penting
(mis. `.withSuccessHandler(function (res) {`). Ini penyebab bug berulang di sesi lalu.

### Patch Blok JS Kompleks (banyak quote) — via file temp:
Kalau string JS penuh kutip ganda/tunggal dan `<`, JANGAN tulis inline di PowerShell.
Tulis ke file `.txt` pakai here-string `@'...'@`, lalu inject:
```powershell
@'
...isi JS bersih...
'@ | Set-Content -Path "patch.txt" -Encoding UTF8

$lines = Get-Content "Index.html" -Encoding UTF8
$patch = Get-Content "patch.txt" -Encoding UTF8
$before = $lines[0..N]
$after  = $lines[M..$($lines.Length - 1)]
Set-Content -Path "Index.html" -Value ($before + $patch + $after) -Encoding UTF8
Remove-Item "patch.txt"
```

### VERIFIKASI SYNTAX PALING AKURAT — via Node.js:
Node sudah terpasang (v24). Ekstrak JS dari Index.html (buang komentar HTML dulu
supaya `<script>` di komentar tidak ikut), lalu `node --check`:
```powershell
@'
const fs = require('fs');
let html = fs.readFileSync('Index.html', 'utf8');
html = html.replace(/<!--[\s\S]*?-->/g, '');
const re = /<script[^>]*>([\s\S]*?)<\/script>/g;
let m, parts = [];
while ((m = re.exec(html)) !== null) { parts.push(m[1]); }
fs.writeFileSync('extracted2.js', parts.join('\n'), 'utf8');
'@ | Set-Content -Path "extract.js" -Encoding UTF8
node extract.js
node --check extracted2.js
```
Kalau bersih = tidak ada output. Kalau error = kasih nomor baris di
`extracted2.js` yang tinggal dicocokkan. **Selalu bersihkan file temp setelahnya.**

### Audit Syntax Error — Radius Minimum:
Error di baris N → audit `$lines[(N-4)..(N+16)]`. Cukup satu kali, tidak melebar.
**Catatan:** nomor baris dari browser Apps Script (`userCodeAppPanel`) kadang
menunjuk lokasi eksekusi, bukan lokasi asli error. `node --check` lebih akurat.

### Verifikasi Wajib Setelah Patch Index.html:
```powershell
(Select-String -Path "Index.html" -Pattern 'id="screen').Count
# Harus = 16
```

### Anti-Pattern yang Harus Dihindari:
- JANGAN `Add-Content` untuk CSS/JS — nempel di luar tag `</style>` / `</script>`,
  akibatnya CSS tercetak sebagai teks di halaman. CSS baru HARUS disisipkan
  SEBELUM `</style>` (pakai splice, bukan Add-Content).
- JANGAN `""` (double-double quote) di dalam JavaScript string
- JANGAN string replace multi-baris tanpa verifikasi kecocokan dulu
- JANGAN splice yang memotong baris pembuka handler (`.withSuccessHandler(...)`)
- JANGAN pakai `$lines` variabel lama setelah file diubah — selalu `Get-Content` ulang

---

## RULE SESI DESAIN DASHBOARD

### Identitas Claude dalam sesi desain:
Bertindaklah sebagai **Elite FinTech UI/UX Director**, **Senior UI Engineer**, **Web Performance Architect**.

### Gaya Visual: Spatial Minimalist Hyper-Premium FinTech
- White-space presisi, card premium dengan shadow ambient lembut
- Border lembut, radius besar, gradient elegan (tidak berlebihan)
- Glassmorphism ringan jika sesuai
- Tampilan eksklusif, aman, profesional, mudah dibaca
- Tidak ramai, tidak penuh sesak — setiap elemen harus punya fungsi dan alasan visual

### Prinsip UX Wajib:
1. **F-Pattern / Z-Pattern** — KPI utama di posisi yang mata langsung tangkap
2. **The 5-Second Rule** — pengguna paham kondisi utama dalam 5 detik
3. **Progressive Disclosure** — data penting di depan, detail di balik klik
4. **Semantik Warna Konsisten:** Hijau/sage = aman/positif, Merah = risiko/bahaya,
   Kuning/oranye/brass = perhatian/brand, Abu/netral = data pendukung
5. **Visualisasi Tepat** — chart hanya kalau ada data tren/komparasi, bukan dekorasi

### Jenis Dashboard:
**Strategic Dashboard** (bukan Operational/Analytical) — pengguna adalah pemilik
laundry yang ingin melihat kondisi kesehatan bisnis secara sekilas untuk
pengambilan keputusan strategis.

### Aturan Teknis yang Tidak Boleh Dilanggar:
1. **100% Native Vanilla HTML/CSS/JS** — tidak boleh framework/library tambahan
2. **Tidak boleh mengubah** struktur database, logic backend, rumus, fungsi save/load
3. **CSS efisien** — GPU-friendly, tidak bertumpuk, tidak saling override
4. **Mobile-first** — semua harus pas di HP tanpa scroll horizontal
5. **Animasi** — smooth, elegan, tidak berat, tidak berlebihan
6. **Font angka finansial** — gunakan `font-variant-numeric: tabular-nums`
7. **Tidak boleh AI slop** — tidak ada emoji berlebihan, tidak ada dekorasi kosong

### Alur Desain yang Benar:
**Fase 1 — Analisis dulu, JANGAN langsung kode:** tentukan jenis dashboard, rancang
layout & hierarki visual, tentukan data depan vs di balik klik, beri wireframe
text sederhana, minta konfirmasi user sebelum lanjut.
**Fase 2 — Implementasi:** patch kecil per komponen, verifikasi tiap langkah,
tidak boleh patch besar sekaligus.

---

## DESIGN SYSTEM

### CSS Variables Utama (JANGAN buat baru sembarangan):
```css
--brass      /* oranye brand */
--sage       /* hijau/teal — aman, washer */
--volt       /* kuning */
--red        /* bahaya/error */
--panel      /* background card */
--panel-2    /* background card secondary */
--border     /* warna border */
--text       /* teks utama */
--text-dim   /* teks redup */
--text-faint /* teks sangat redup */
--radius     /* border radius standar */
--radius-lg  /* border radius besar */
--app-edge-x /* padding horizontal halaman */
--font-display, --font-body, --font-mono
```

---

## KATEGORI LAYANAN & KOMPONEN BIAYA (VARIABLE COST)

Kategori outlet: **Self Service, Cuci Saja, Kering Saja, Cuci Kering**

Struktur biaya per layanan:
- **Cuci Saja:** nota/admin, air per load, listrik washer per load, listrik pompa
- **Kering Saja:** nota/admin, listrik dryer per load, gas per load
- **Cuci Kering:** nota/admin, air per load, listrik washer per load, listrik pompa,
  listrik dryer per load, gas per load

**Catatan rumus listrik (untuk cost analysis, BUKAN rata-rata):**
- Pompa/load = `cuci[0].rpPompaPerLoad` (otomatis dibagi jumlah unit mesin cuci
  dari profil outlet: `wattPompaAir / totalUnitCuci`)
- Washer/load = `cuci[0].rpListrikPerLoad` (per unit, ambil mesin pertama)
- Dryer/load = `pengering[0].rpListrikPerLoad` (per unit, ambil mesin pertama)
- Total Listrik/load = Pompa + Washer + Dryer

---

## STATUS FITUR DASHBOARD

### SELESAI:

**Header:** Icon mesin cuci SVG + "Kalkulator Laundry" (spasi terpisah), gap 6px, word-spacing -3px

**Filter Outlet:** Pill filter kanan atas sejajar "Dashboard Bisnis", klik → overlay
pilih outlet (tersimpan di localStorage), teks "1 outlet aktif" kecil di bawah pill

**Card Profil Outlet:** Badge kategori + jam operasional, 2 KPI besar Cuci/Kering
(warna brass), mini-card Washer (sage) + Dryer (brass), label "N washer · home"
dan "N dryer · commercial"

**Card Master Biaya Produksi (Opsi B: Dominasi Biaya):** Breakdown komponen
di-sort tertinggi→terendah (by persen), progress bar per komponen (Gas=brass,
Listrik=volt, Air=sage, Nota=text-dim), pill status "Lengkap"/"N/4 komponen",
komponen 0 pakai class `.zero`. CSS: `.mb-*` di `Style_Components.html`
(`.mb-bar-wrap` & `.mb-progress-bar` WAJIB `flex:1`)

**Card Struktur Biaya HPP · Variable Cost:** Breakdown HPP per jenis layanan
di-sort tertinggi→terendah, tag "tertinggi"(merah)/"terendah"(sage) kalau >1
layanan, pill status "Lengkap"/"N warning". CSS: `.hpp-*` di
`Style_Module_HPP.html`. Detail lengkap tetap di layar detail (klik card)

**Card Target Titik Impas (BEP):** Sudah diaudit — field backend↔frontend cocok
(`bepLoadPerBulan`, `bepOmsetPerBulan`, dst.), rumus `FixedCost / MarginPerLoad`
matematis benar, CSS `.bep-*` sudah ada. **Belum ditest live di browser** — perlu
dicek dengan outlet yang datanya lengkap (Fixed Cost + HPP + Harga Layanan terisi).
Catatan: rataHPP & rataHarga dihitung rata-rata sederhana lintas layanan
(bukan tertimbang volume load) — ini keputusan desain, bukan bug.

**Bug Backend Dashboard yang SUDAH DIPERBAIKI:**
- **Listrik:** field `summary.rataRataBiayaPerLoad` tidak ada → diganti hitung
  dari `summary.cuci[0]` + `summary.pengering[0]` (pompa+washer+dryer)
- **Air:** salah ambil dari `record.biayaPerLoad` → dibetulkan ke `summary.biayaPerLoad`
- **Nota/Kasir:** salah ambil dari `record.totalBiayaNotaKasirPerLoad` →
  dibetulkan ke `summary.totalBiayaNotaKasirPerLoad`
- Konsekuensi: backend hanya push komponen dengan biayaPerLoad > 0 (bukan bug)

---

### PRIORITAS BERIKUTNYA

1. **Test live card BEP** di browser dengan outlet berdata lengkap
2. **Desain ulang card yang belum disentuh:**
   - Harga Layanan (data: `amanCount`, `tipisCount`, `rugiCount`, `minMarginPercent`, `status`)
   - Biaya Tetap Outlet / Fixed Cost (data: `hasData`, `totalPerBulan`, `totalPerHari`)
3. **Perbaikan tampilan layar detail** (Gas, Listrik, Air, Nota)
4. **Fitur Packing** untuk laundry kiloan/hybrid (komponen biaya ke-5 dan ke-6)

---

## DATA BACKEND TERSEDIA

### `getDashboardCabangSummary(cabangId)`:
`cabangId`, `namaLaundry`, `kategoriLayanan`, `totalUnitCuci`, `totalUnitPengering`,
`loadCuciPerBulan`, `loadKeringPerBulan`, `jamBukaMenit`, `jamTutupMenit`,
`jenisCuci`, `jenisKering`

### `getDashboardMasterBiayaSummary(cabangId)`:
`cabangId`, `namaLaundry`, `lengkapCount`, `totalKomponen(4)`, `isComplete`,
`missing[]`, `komponenBiaya[]{key, label, biayaPerLoad, persen}`, `totalBiayaPerLoad`

### `getDashboardHPPSummary(cabangId)`:
`cabangId`, `namaLaundry`, `isReady`, `hppMin`, `hppMax`, `hppCuciKering`,
`warningsCount`, `errorText`, `layananList[]{key, title, total}` (sort
tertinggi→terendah, hanya total>0)

### `getDashboardHargaLayananSummary(cabangId)`:
`cabangId`, `namaLaundry`, `totalLayanan`, `hargaTerisiCount`, `rugiCount`,
`tipisCount`, `impasCount`, `amanCount`, `minMarginPercent`, `warningsCount`,
`status`, `errorText`

### `getDashboardFixedCostSummary(cabangId)`:
`cabangId`, `namaLaundry`, `hasData`, `totalPerBulan`, `totalPerHari`, `warningsCount`

### `getDashboardBEPSummary(cabangId)`:
`fixedCostPerBulan`, `rataHPP`, `rataHarga`, `marginPerLoad`, `bepLoadPerBulan`,
`bepOmsetPerBulan`, `bepLoadPerMinggu`, `bepOmsetPerMinggu`, `bepLoadPerHari`,
`bepOmsetPerHari`, `warnings[]`, `isComplete`

---

## SUMBER DATA MODUL (untuk referensi field yang benar)

- **Listrik** (`getBiayaListrik`): `data.summary.cuci[]` & `data.summary.pengering[]`,
  tiap item punya `rpListrikPerLoad`, `rpPompaPerLoad`, `rpTotalPerLoad`
- **Air** (`getBiayaAir`): `data.summary.biayaPerLoad` (BUKAN di record)
- **Nota/Kasir** (`getBiayaNotaKasir`): `data.summary.totalBiayaNotaKasirPerLoad`,
  `biayaAplikasiPerLoad`, `biayaNotaPerLoad`
- **HPP** (`getStrukturBiayaHPP`): `data.layanan[]` tiap item punya `key`, `title`,
  `total`, `components[]`; juga `data.warnings[]`

---

## CARA MULAI SESI BARU

1. Upload file `KONTEKS_PROYEK.md` ini ke Claude (satu file saja, cukup)
2. Tulis salah satu:
   - **"Lanjutkan Kalkulator Laundry. Test live card BEP."**
   - **"Lanjutkan desain Dashboard. Fokus ke card Harga Layanan."**
   - **"Lanjutkan desain Dashboard. Fokus ke card Biaya Tetap Outlet."**
3. Claude langsung paham tanpa penjelasan ulang — rule proyek dan rule desain sudah menyatu di file ini.
