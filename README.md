# NC 2027 Pitch Demo — UI V2

Demo siap pitching untuk alur **NC → Validation → Data Entry → Data Analyst Dashboard**, dengan mobile field UI dan desktop analytics UI mengikuti blueprint terbaru.

## Stack demo

- Frontend: static responsive PWA, di-deploy dari **Vercel**
- Source code: **GitHub**
- API proxy/secrets: **Vercel Function** (`/api/gas`)
- Backend: **Google Apps Script (GAS)**
- Demo database: **Google Sheets** yang dibuat otomatis oleh `setupDemo()`
- Google Cloud project: **tidak diperlukan**
- Library frontend: **tidak ada**
- npm dependency: **tidak ada**

## Yang dipertahankan dari PRD/DRD/ERD

Demo tidak mengubah konsep data yang sudah disepakati. GAS membuat tabel/tab berikut: Users, Assignments, Regions, Areas, Stores, Products, PJP, PJPVisits, TaskDefinitions, VisitTasks, Submissions, StockTaking, Offtake, PriceMonitoring, CompetitorActivity, GWPAllocations, GWPTransactions, Consumers, ConsumerInteractions, ValidationResults, CorrectionRequests, SubmissionVersions, Targets, DailyNCKPI, dan AuditLogs.

Demo hanya mengaktifkan sebagian alur sebagai **vertical slice** pitching:

1. Login role demo.
2. NC melihat PJP/task.
3. NC input Stock Taking / Offtake.
4. Sistem membuat `submission_id` dan `idempotency_key`.
5. Auto validation menghasilkan `VALIDATED` atau `WARNING`.
6. Data Entry melihat exception queue dan dapat Validate / Request Correction.
7. Data Analyst/PM melihat KPI, trend, regional performance, dan data quality.
8. Saat backend/internet gagal, field submission masuk local offline queue lalu mencoba sync lagi.

## Akun demo

- NC: `NC001` / PIN `1234`
- Data Entry: `DE001` / PIN `1234`
- Data Analyst: `DA001` / PIN `1234`
- Project Manager: `PM001` / PIN `1234`

## Mulai dari sini

1. Baca **SETUP-SUPER-MUDAH.md** untuk setup GAS → GitHub → Vercel.
2. Baca **UI-V2-README.md** untuk alur demo mobile dan desktop.
3. Gunakan **PITCH-SCRIPT.md** saat latihan presentasi.

## Penting

Ini adalah **pitch demonstration**, bukan konfigurasi production untuk data konsumen asli. Jangan masukkan PII/consumer data riil. Production tetap mengikuti security/auth/storage architecture yang sudah dirancang sebelumnya.
