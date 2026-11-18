# PMM 3.0 Exam Portal

A mobile-first static exam app using Firebase Anonymous Authentication and Cloud Firestore. The student app reads one published exam document (all questions and options together), stores answers locally, and syncs changes periodically and on violations/submission. Correct options are written separately to an admin-only answer-key document.

## Files and data model

- `exams/{EXAM_CODE}` — public exam metadata and its complete `questions` array in one Firestore document.
- `exams/{EXAM_CODE}/private/answerKey` — question ID to correct option ID map. Never put correct options in the public exam document.
- `exams/{EXAM_CODE}/attempts/{ROLL_NUMBER}` — one attempt per normalized roll number. The document stores the anonymous Auth UID, answer IDs, randomized display order, status, and violation log. Student reads/writes are limited by the rules to the authenticated owner.
- `admins/{AUTH_UID}` — trusted admin membership. Create this document manually in the Firebase console for each trusted admin UID; the app does not let clients grant admin access.

All questions are kept in the exam document to avoid one read per question. Firestore documents have a 1 MiB maximum; the authoring screen caps exams at 100 questions and 900 KB serialized size. Use fewer/smaller questions if needed.

## Firebase setup

1. Create a Firebase project and register a Web app.
2. In **Authentication → Sign-in method**, enable **Anonymous**.
3. Create a Cloud Firestore database.
4. Copy `firebase-config.example.js` to `firebase-config.js` (or edit the provided `firebase-config.js`) and fill in the Firebase Web app config. Firebase web config is public; do not put service-account keys in the browser.
5. In **Firestore → Rules**, publish `firestore.rules`.
6. To grant admin access: open the app once, sign in anonymously, and read the UID in the browser's Firebase Authentication users list (or inspect the signed-in user in dev tools). In the Firestore console, create `admins/{that UID}` with any non-sensitive field, for example `{ "role": "admin" }`. Do this only for trusted admins.
7. Serve the folder over HTTPS or localhost (service workers and the Fullscreen API require a secure context). For example, use the Firebase Hosting emulator or `python -m http.server 8000`.
8. Open Admin, create an exam, set the opening/closing window and violation limit, add four-option MCQs with their answer, and save. The public exam and private key are saved as separate documents.

Students enter their Pharmacy batch (for example, `2024–2028`) with their exam code and roll number. Batch is stored with the attempt, shown in the admin dashboard, and included in CSV exports. The exam code and roll number are case-insensitive; roll numbers are normalized to uppercase and may contain letters, numbers, `_`, and `-` (maximum 40 characters). The roll number is the attempt document ID, visible to admins only; students cannot list attempts.

## Security and anti-cheat limitations

Firestore rules protect the private key and restrict student data access. These browser-only checks are deterrents, not a tamper-proof proctoring system: students can use another device, alter browser code, change their local clock, or lose connectivity. Timer expiry is enforced by the running client, and submissions/violation timestamps originate in the client except for Firestore `startedAt`, `updatedAt`, and `submittedAt` server timestamps. For high-stakes exams, add a trusted backend (for example, Cloud Functions) to validate deadlines and score submissions.

The exam timer starts from Firestore's `serverTimestamp()` on the attempt. The app reloads an existing attempt only on the same anonymous-auth account/device; anonymous accounts are device/browser scoped. One active attempt per roll is enforced by the document ID plus create-only rules, but an admin must clear an attempt in the Firebase console to reset a student.

Answers stay in memory and localStorage and are synced every 150 seconds, on each violation, and on submission. A failed sync remains dirty and retries on the next interval or when the browser comes online. Submitting while offline stores local work and retries automatically. Avoid clearing site storage while an exam is in progress.

## Scale and cost guidance

The app avoids per-question reads and per-answer-click writes. Each student's normal Firestore traffic is one exam read, an attempt read/create, and a periodic attempt update; an admin uses one live listener per selected exam rather than polling every student. 500 students still create 500 attempt documents and 500 anonymous Auth accounts, so test against a Firebase Emulator Suite before production.

Before a real exam, enable **Google Cloud Billing budget alerts** (for example, 50%, 80%, and 100% notifications), review Firestore/Auth usage and quotas, and set conservative project alerts. Budget alerts notify but do not automatically cap spending. Check Firestore document size, listener fan-out, and regional quotas for the expected peak. A single admin listener reads the selected exam's attempt collection initially and then receives incremental changes.

## Load test (local emulators only)

Start the Firebase Emulator Suite with Authentication on port 9099 and Firestore on 8080, deploy the rules to the Firestore emulator, and set `useEmulators = true` in `firebase-config.js`. Create a published exam in the emulator (use the app's Admin screen after adding the emulator Auth UID under `admins/{UID}` in the emulator Firestore UI). Then run:

```powershell
$env:FIREBASE_PROJECT_ID = "your-emulator-project-id"
$env:EXAM_CODE = "BIO-101"
node .\load-test.mjs
```

By default, the script refuses non-local emulator endpoints and creates 500 anonymous users concurrently, reads the exam once per student, and creates one attempt document per student. Set `STUDENTS` to adjust the count up to 1000 and `ROLL_PREFIX` to avoid existing attempt IDs on repeated runs. The script does not reset emulator data. Do not point it at production.

## Deploy

### GitHub Pages

1. Put the static files in a GitHub repository and ensure `firebase-config.js` contains the project's public web config.
2. In repository **Settings → Pages**, deploy from the branch/root (or configure a workflow to publish the static files).
3. Add the deployed Pages origin to Firebase **Authentication → Settings → Authorized domains**.
4. Publish Firestore rules separately in the Firebase console. GitHub Pages does not deploy Firestore rules.

### Firebase Hosting

1. Install Firebase CLI and run `firebase login`, then `firebase init hosting` in this folder.
2. Select the Firebase project, use the current folder as the public directory, and configure it as a single-page app if prompted.
3. Ensure `firebase.json` deploys `firestore.rules` using `"firestore": { "rules": "firestore.rules" }`.
4. Run `firebase deploy --only hosting,firestore:rules`.

The included service worker caches the local app shell and PMM 3.0 install icons for returning visits. Firebase SDK modules and Firestore data still require network access; an in-progress exam can continue locally and sync when connectivity returns.
