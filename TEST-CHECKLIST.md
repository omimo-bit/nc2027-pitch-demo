# Test Checklist — NC 2027 V7

## A. Backend

- [ ] GAS `/exec` dapat dibuka.
- [ ] Health Check PASS.
- [ ] Login NC001 PASS.
- [ ] Login DE001 PASS.
- [ ] Login DA001 PASS.
- [ ] Tidak ada 504 pada request normal.

## B. Visual Audit Field

- [ ] Kamera HP dapat membuka rear camera.
- [ ] Fallback Take / Choose Photo bekerja.
- [ ] AI analysis menghasilkan facing / SOS / confidence.
- [ ] Manual input dapat diisi.
- [ ] Submit menghasilkan record di Google Sheets.
- [ ] Original dan annotated image tersimpan di private Drive.

## C. Visual Review Workspace

- [ ] Login DE001.
- [ ] Menu Visual Review Workspace muncul.
- [ ] Audit terbaru muncul pada queue.
- [ ] Original photo terlihat.
- [ ] AI annotated photo terlihat.
- [ ] Manual vs AI comparison terlihat.
- [ ] Accept AI berhasil.
- [ ] Use Manual berhasil.
- [ ] Override menghitung SOS otomatis.
- [ ] Override invalid (facing > total) ditolak backend.
- [ ] Reviewer note tersimpan.
- [ ] Request Correction masih bekerja.

## D. Verified Result

- [ ] `SubmissionVersions` memiliki reason `VISUAL_AUDIT_REVIEW`.
- [ ] `Submissions.version` bertambah.
- [ ] `Submissions.validation_status` = VALIDATED setelah review.
- [ ] `ValidationResults` memiliki rule `VISUAL_REVIEW`.
- [ ] `AuditLogs` mencatat keputusan reviewer.

## E. Dashboard

- [ ] Tab SOS menampilkan Manual SOS.
- [ ] Tab SOS menampilkan AI SOS.
- [ ] Tab SOS menampilkan Verified SOS.
- [ ] Final Source menunjukkan AI / MANUAL / OVERRIDE.
- [ ] History menampilkan Review Status.
- [ ] View Evidence tetap bekerja.

## F. Offline

- [ ] 2G / 3G / unstable menyimpan submission ke local queue.
- [ ] Queue sync ketika jaringan membaik.
- [ ] idempotency tetap mencegah duplicate submission.
