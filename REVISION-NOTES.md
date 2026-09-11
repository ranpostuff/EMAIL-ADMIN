# RescuePriority Admin Dashboard — Revision Notes

This revision preserves Firebase Authentication, the `admins/{uid}` authorization check, existing database connections, incident monitoring, attendance/violation QR scanners, grade/section navigation, and all unrelated dashboard modules.

Added/improved:
- Personalized greeting derived from the signed-in Firebase Auth account (`displayName`, with email-local-part fallback).
- Administrator role/email metadata in the top bar.
- Separate `Submitted By` and `Student Involved` information in incident details.
- Incident type, student-identification method, and description in incident details.
- Backward-compatible fallbacks for legacy incident records.
- Professional inline SVG folder/person icons replacing emoji in grade/section/student browsing.
- Database rules synchronized with the Student App for the additive incident fields.
