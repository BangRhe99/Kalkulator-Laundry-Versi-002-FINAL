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
- **JANGAN salah hitung index `$before`/`$after` saat splice** — ini penyebab bug
  paling sering di sesi 2026-07-04 (baris duplikat, baris hilang, kurung kurawal
  timpang). Selalu `Get-Content | Select-Object -Skip N -First M` untuk verifikasi
  hasil SEBELUM lanjut ke langkah berikutnya, jangan asumsi splice berhasil.
- **Semua fungsi yang dipanggil dari `onclick="..."` di HTML WAJIB pakai
  `window.namaFungsi = function () {...}`**, BUKAN `function namaFungsi() {...}`
  biasa — karena seluruh script utama Index.html dibungkus IIFE
  `(function () {...})()` (baris ~821-4889). Fungsi biasa di dalam IIFE tidak
  terjangkau dari onclick (scope global), errornya baru muncul saat tombol
  diklik (`ReferenceError: ... is not defined`), TIDAK muncul saat load halaman.
- **Tombol kecil di dalam card yang punya `onclick` navigasi** (misal seluruh
  `.menu-card` bisa diklik pindah layar) WAJIB `event.stopPropagation()` di
  handler tombolnya, kalau tidak klik tombol kecil ikut memicu navigasi pindah
  layar yang tidak diinginkan.
- **File `.gs` tidak bisa langsung `node --check`** (ekstensi tidak dikenali) —
  copy dulu ke `.js` sementara (`Copy-Item nama.gs nama_check.js`), baru cek,
  lalu hapus.

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

### SELESAI (semua 6 card dashboard sudah didesain ulang & live-tested):

**Header:** Icon mesin cuci SVG + "Kalkulator Laundry" (spasi terpisah), gap 6px, word-spacing -3px

**Filter Outlet:** Pill filter kanan atas sejajar "Dashboard Bisnis", klik → overlay
pilih outlet (tersimpan di localStorage), teks "1 outlet aktif" kecil di bawah pill

**Card Profil Outlet:** Badge kategori + jam operasional (format leading-zero
`07.00 – 21.00`). 2 KPI besar `Kap. Cuci / bulan` (sage) & `Kap. Kering / bulan`
(brass), rata kiri semua. Tiap KPI ada baris "Okupansi N% [?]" — tombol `?` tap
untuk buka tooltip penjelasan singkat (hover otomatis di desktop lewat
`@media (hover:hover)`). Mini-card Washer/Dryer `flex:1` (sejajar penuh, bukan
rata kiri), tampilkan durasi mesin kalau ada data (`"home · 30 menit"`).
JS: `window.toggleOkupansiTooltip`.
*Bug yang diperbaiki:* `listCabang()` ternyata TIDAK menyertakan array
`mesinCuci`/`mesinPengering` (cuma summary ringkas) → `getDashboardCabangSummary`
sekarang ambil detail lengkap lewat `getCabang(id)` untuk `jenisCuci`,
`jenisKering`, `durasiCuci`, `durasiKering`, `okupansiCuci`, `okupansiKering`.

**Card Master Biaya Produksi:** Pill "Lengkap"/"N/4 komponen" **dihapus total**.
Bar chart diperbesar (`height:6px`, `border-radius:3px` persegi, bukan pill
tipis). Label komponen fixed `width:74px` (kolom sejajar rapi seperti tabel),
kolom persentase & nominal juga fixed width, gap dirapatkan. Angka dibulatkan
(`money0()`). Komponen yang sudah diisi tapi nilainya Rp0 (misal Air pakai
sumur) tetap tampil dengan label **"Rp 0 (tanpa biaya)"**, tidak hilang dari
daftar — backend pakai flag `gasComplete`/`listrikComplete`/`airComplete`/
`notaComplete` (form pernah diisi), bukan `nilai > 0`.

**Card Struktur Biaya HPP · Variable Cost:** Redesign total — jadi **3
mini-card collapsible**: HPP Cuci Saja / HPP Kering Saja / HPP Cuci Kering.
Tiap mini-card: baris ringkasan (judul + total Rp + panah ⌄), klik → detail
per komponen (label, persen, nominal) muncul di bawah, panah berputar 180°.
"Lengkap"/"TERTINGGI"/"TERENDAH" dihapus semua. Ketiga layanan SELALU tampil
(tidak lagi disortir/disembunyikan berdasar nilai). CSS: `.hpp-mini-*` di
`Style_Module_HPP.html`. JS: `window.toggleHppDetail`.

**Card Harga Layanan:** Pill status "Aman"/"Perhatian"/"Ada yang rugi"
**dihapus total** (warna bar sudah cukup jadi sinyal). Tiap baris layanan bisa
diklik → detail **HPP, Harga Jual, Margin** (Rupiah) muncul di bawah, pola
sama seperti card HPP. CSS: `.hl-item`, `.hl-detail-*`. JS: `window.toggleHlDetail`.

**Card Biaya Tetap Outlet (Fixed Cost):** Pill "Terisi"/"Belum diisi"
**dihapus**. Angka dibulatkan, "per bulan" ditaruh sejajar nominal (font kecil,
bukan di baris terpisah). Klik nominal → detail **6 komponen** (Sewa Outlet,
Gaji Karyawan, Internet, Penyusutan Mesin, Biaya Perawatan, Operasional
Lainnya) muncul di bawah. JS: `window.toggleFcDetail`.

**Card Target Titik Impas (BEP):** Ditambah **grafik garis BEP native SVG**
(tanpa library) — garis Omset (sage) vs Total Biaya (brass) berpotongan di
titik BEP, zona rugi (merah muda tipis)/untung (sage tipis), label angka di
ujung sumbu X (load maksimum grafik) & Y (Rp maksimum grafik). Semua angka
dibulatkan tanpa desimal (termasuk Load/Hari yang sebelumnya 1 desimal). Teks
kecil "load" di bawah angka Load/Bulan-Minggu-Hari dihapus (sudah terwakili di
label judul). Fungsi: `buildBepChartSvg(d)`.
*Belum selesai — lihat Prioritas Berikutnya #1:* label sumbu Y grafik saat ini
pakai skala arbitrer (`bepLoadPerBulan × 1.8`), BUKAN target omset maksimum
riil bisnis. User minta diganti dengan kapasitas maksimum sungguhan, tapi ini
butuh fitur baru "Kontribusi Omset" dulu (lihat detail di Prioritas #1).

---

### PRIORITAS BERIKUTNYA

1. **[PENDING KEPUTUSAN USER] Fitur "Kontribusi Omset" + garis Target Omset
   Maksimum di grafik BEP.** User berhenti di sini untuk istirahat, tinggal
   lanjutkan dari titik ini. Konteks:
   - Tujuan: ganti label skala sumbu Y grafik BEP (saat ini angka arbitrer
     1.8× BEP) dengan **Target Omset Maksimum riil** berdasarkan kapasitas
     mesin outlet.
   - Kendala: outlet Self Service punya 3 layanan (Cuci Saja, Kering Saja,
     Cuci Kering) yang berbagi 2 sumber daya (mesin cuci & mesin pengering).
     Cuci Kering pakai KEDUANYA sekaligus, jadi kapasitas maksimum bukan
     penjumlahan sederhana — dibatasi oleh mesin yang jadi *bottleneck*.
   - Solusi yang disepakati arahnya: user usul form input baru **"Kontribusi
     Omset"** — owner set sendiri persentase kontribusi tiap layanan
     (misal Cuci Saja 50%, Kering Saja 5%, Cuci Kering 45%, total 100%).
   - Rumus yang perlu dibangun:
     - Pemakaian mesin cuci = (%CuciSaja + %CuciKering) × total transaksi
     - Pemakaian mesin pengering = (%KeringSaja + %CuciKering) × total transaksi
     - Total transaksi maksimum = yang lebih membatasi antara kapasitas mesin
       cuci vs pengering (`summary.cuci.loadMaksimalPerHari` &
       `summary.kering.loadMaksimalPerHari`, sudah ada di
       `Modul_Cabang.gs:362`, computeGroupLoad_ — ini SUMBER KEBENARAN
       TUNGGAL kapasitas, jangan hitung ulang dengan cara lain)
     - Omset maksimum = total transaksi maksimum × harga rata-rata tertimbang
   - Yang perlu dibangun kalau lanjut penuh: field data baru + migrasi default
     di `Modul_Cabang.gs`, form input 3 kolom persentase di layar Profil
     Outlet (validasi total = 100%), rumus bottleneck di backend, baru garis
     "Target Omset Maksimum" + gridline Y-axis di `buildBepChartSvg`.
   - Alternatif sementara (kalau tidak mau kerjain penuh dulu): pakai
     pendekatan bottleneck dengan asumsi kontribusi default, fitur
     "Kontribusi Omset" sesungguhnya jadi task terpisah nanti.
   - **User belum memilih salah satu opsi ini — tanyakan dulu di awal sesi
     berikutnya sebelum lanjut.**
2. **Card "Kap. Setrika" untuk kategori Drop Off/Kiloan & Hybrid** (belum dikerjakan):
   - Satuan per jam (beda dari Cuci/Kering yang per bulan)
   - Form input data setrika di menu Profil Outlet belum aktif — harus dibuat dulu sebelum card dashboard bisa jalan
   - Gaya visual: statis, elegan, premium — konsisten dengan card Cuci/Kering yang sudah ada
   - Dashboard harus adaptif per kategori outlet: Self Service tetap 2 KPI (Cuci/Kering), Drop Off/Kiloan & Hybrid jadi 3 KPI (+ Setrika)
3. **Backend HPP untuk Drop Off/Kiloan & Hybrid belum ada sama sekali** —
   `Modul_StrukturBiayaHPP.gs` cuma punya `buildSelfServiceHPPStructure_`
   (nama fungsinya eksplisit "SelfService"). Untuk kategori lain perlu fungsi
   BARU untuk layanan: Cuci Saja, Cuci Kering Lipat, Cuci Kering Setrika,
   Setrika Saja, Bed Cover (mungkin bertambah lagi). Jangan bikin "tampilan
   fleksibel" dulu sebelum logika backend ini ada — berisiko UI kosong/menyesatkan.
4. **2 card tambahan untuk Drop Off/Kiloan & Hybrid:** Packing dan Deterjen
   (komponen biaya ke-5 dan ke-6, disebutkan user tapi belum dirinci detailnya)
5. **Perbaikan tampilan layar detail** (Gas, Listrik, Air, Nota) — belum disentuh
6. **Keputusan desain yang SUDAH FINAL (jangan diusulkan ulang):**
   - Tidak perlu warna berbeda per layanan HPP (sage/brass/volt) — user bilang
     "nanti kesan norak" kalau kategori lain (Drop Off/Kiloan) yang punya
     5-6 layanan ikut diwarnai semua. Total HPP tetap netral/hitam.
   - Warna hanya dipakai untuk Self Service (cuma 2-3 layanan, masih efektif
     jadi pembeda cepat)

---

## DATA BACKEND TERSEDIA

### `getDashboardCabangSummary(cabangId)`:
`cabangId`, `namaLaundry`, `kategoriLayanan`, `totalUnitCuci`, `totalUnitPengering`,
`loadCuciPerBulan`, `loadKeringPerBulan`, `jamBukaMenit`, `jamTutupMenit`,
`jenisCuci`, `jenisKering`, `durasiCuci`, `durasiKering` (menit siklus, dari
mesin pertama), `okupansiCuci`, `okupansiKering` (persen 0-100) — 4 field
terakhir diambil via `getCabang(cabangId).data.cabang` karena `listCabang()`
tidak menyertakan array `mesinCuci`/`mesinPengering`/`okupansi`.

### `getDashboardMasterBiayaSummary(cabangId)`:
`cabangId`, `namaLaundry`, `lengkapCount`, `totalKomponen(4)`, `isComplete`,
`missing[]`, `komponenBiaya[]{key, label, biayaPerLoad, persen}`, `totalBiayaPerLoad`.
Komponen sekarang di-push berdasarkan flag "form pernah diisi"
(`gasComplete`/`listrikComplete`/`airComplete`/`notaComplete`), BUKAN
`biayaPerLoad > 0` — supaya komponen yang sengaja Rp0 (misal air sumur) tetap
tampil, bukan hilang dari daftar.

### `getDashboardHPPSummary(cabangId)`:
`cabangId`, `namaLaundry`, `isReady`, `hppMin`, `hppMax`, `hppCuciKering`,
`warningsCount`, `errorText`, `layananList[]{key, title, total,
components[]{key, label, amount, percent}}` — SELALU 3 item (Cuci Saja/Kering
Saja/Cuci Kering), TIDAK LAGI di-sort atau difilter berdasarkan nilai (urutan
tetap natural dari backend `buildSelfServiceHPPStructure_`).

### `getDashboardHargaLayananSummary(cabangId)`:
`cabangId`, `namaLaundry`, `totalLayanan`, `hargaTerisiCount`, `rugiCount`,
`tipisCount`, `impasCount`, `amanCount`, `minMarginPercent`, `warningsCount`,
`status`, `errorText`, `layananList[]{key, title, marginPercent, status, hpp,
hargaJual, margin}` — 3 field terakhir (`hpp`/`hargaJual`/`margin`) baru
ditambahkan untuk detail collapsible di dashboard.

### `getDashboardFixedCostSummary(cabangId)`:
`cabangId`, `namaLaundry`, `hasData`, `totalPerBulan`, `totalPerHari`,
`components[]{key, label, amount}` (6 komponen: sewa, gaji, internet,
depresiasi, perawatan, lainnya), `warningsCount`

### `getDashboardBEPSummary(cabangId)`:
`fixedCostPerBulan`, `rataHPP`, `rataHarga`, `marginPerLoad`, `bepLoadPerBulan`,
`bepOmsetPerBulan`, `bepLoadPerMinggu`, `bepOmsetPerMinggu`, `bepLoadPerHari`,
`bepOmsetPerHari`, `warnings[]`, `isComplete` (belum berubah — field
"Target Omset Maksimum" belum ditambahkan, lihat Prioritas #1)

### Kapasitas maksimum mesin (untuk fitur "Kontribusi Omset" mendatang):
`getCabang(cabangId).data.summary.cuci.loadMaksimalPerHari` dan
`.summary.kering.loadMaksimalPerHari` — kapasitas 100% okupansi per hari,
per grup mesin (cuci/pengering terpisah). Sumber: `computeGroupLoad_` di
`Modul_Cabang.gs:343` (SUMBER KEBENARAN TUNGGAL kapasitas, sudah dipakai juga
oleh angka "Kapasitas maksimal/hari" di layar detail Profil Outlet).

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
2. Tulis: **"Lanjutkan Kalkulator Laundry, lanjut dari yang kemarin."**
3. Claude langsung paham tanpa penjelasan ulang — rule proyek dan rule desain sudah menyatu di file ini.

### Titik berhenti sesi terakhir (2026-07-04):
Sedang membahas **Prioritas Berikutnya #1** — fitur "Kontribusi Omset" untuk
grafik BEP. User belum memilih antara "bangun penuh sekarang" vs "pendekatan
sementara dulu". **Tanyakan dulu itu di awal sesi**, jangan langsung mengerjakan
salah satu opsi. Semua konteks teknisnya (rumus bottleneck, field yang perlu
ditambah, data kapasitas yang sudah tersedia) ada di bagian Prioritas
Berikutnya #1 di atas.
