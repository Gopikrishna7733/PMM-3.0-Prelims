#!/usr/bin/env node
// Emulator-first smoke load test: 500 anonymous sign-ins, exam reads, and attempt creates.
const students = Number(process.env.STUDENTS || 500);
const projectId = process.env.FIREBASE_PROJECT_ID;
const examCode = (process.env.EXAM_CODE || "").trim().toUpperCase();
const rollPrefix = (process.env.ROLL_PREFIX || "LOAD").trim().toUpperCase();
const authUrl = (process.env.AUTH_EMULATOR_URL || "http://127.0.0.1:9099").replace(/\/$/, "");
const firestoreUrl = (process.env.FIRESTORE_EMULATOR_URL || "http://127.0.0.1:8080").replace(/\/$/, "");

if (!projectId || !examCode) {
  console.error("Set FIREBASE_PROJECT_ID and EXAM_CODE. This script defaults to local Firebase emulators.");
  process.exit(1);
}
if (!Number.isInteger(students) || students < 1 || students > 1000) {
  console.error("STUDENTS must be an integer from 1 to 1000.");
  process.exit(1);
}
if (!/^[A-Z0-9_-]{1,30}$/.test(rollPrefix)) {
  console.error("ROLL_PREFIX must use 1–30 letters, numbers, hyphens, or underscores.");
  process.exit(1);
}
function isLocalEndpoint(value) {
  try {
    const hostname = new URL(value).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

if (!isLocalEndpoint(authUrl)) {
  console.error("Refusing to send load-test traffic to a non-local Auth endpoint.");
  process.exit(1);
}
if (!isLocalEndpoint(firestoreUrl)) {
  console.error("Refusing to send load-test traffic to a non-local Firestore endpoint.");
  process.exit(1);
}

const authEndpoint = `${authUrl}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`;
const examEndpoint = `${firestoreUrl}/v1/projects/${projectId}/databases/(default)/documents/exams/${encodeURIComponent(examCode)}`;
const commitEndpoint = `${firestoreUrl}/v1/projects/${projectId}/databases/(default)/documents:commit`;
const field = (value) => ({ stringValue: String(value) });
const fields = {
  uid: field(""),
  rollNumber: field(""),
  batch: field("LOAD-TEST"),
  sessionId: field(""),
  status: field("in_progress"),
  answers: { mapValue: { fields: {} } },
  reviewed: { arrayValue: { values: [] } },
  questionOrder: { arrayValue: { values: [] } },
  optionOrders: { mapValue: { fields: {} } },
  violations: { arrayValue: { values: [] } },
  violationCount: { integerValue: "0" },
  durationSeconds: { integerValue: "3600" }
};

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function runStudent(index) {
  const roll = `${rollPrefix}${String(index + 1).padStart(4, "0")}`;
  const authData = await request(authEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ returnSecureToken: true })
  });
  const headers = { Authorization: `Bearer ${authData.idToken}` };
  const exam = await request(examEndpoint, { headers });
  if (exam.fields?.published?.booleanValue !== true) throw new Error("Exam must be published before the test.");
  const examQuestions = exam.fields.questions?.arrayValue?.values || [];
  fields.uid.stringValue = authData.localId;
  fields.rollNumber.stringValue = roll;
  fields.sessionId.stringValue = `load-session-${index}-${crypto.randomUUID()}`;
  fields.durationSeconds.integerValue = String((exam.fields.durationMinutes?.integerValue || 60) * 60);
  fields.questionOrder.arrayValue.values = examQuestions.map((item, i) => field(item.mapValue.fields.id.stringValue || `q${i}`));

  const name = `projects/${projectId}/databases/(default)/documents/exams/${examCode}/attempts/${roll}`;
  await request(commitEndpoint, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      writes: [{
        update: { name, fields: { ...fields } },
        updateTransforms: [
          { fieldPath: "startedAt", setToServerValue: "REQUEST_TIME" },
          { fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }
        ],
        currentDocument: { exists: false }
      }]
    })
  });
  return roll;
}

const startedAt = Date.now();
console.log(`Starting ${students} concurrent emulator students for ${examCode}…`);
const results = await Promise.allSettled(Array.from({ length: students }, (_, index) => runStudent(index)));
const failed = results.filter((result) => result.status === "rejected");
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`Finished in ${elapsed}s: ${students - failed.length}/${students} attempts created.`);
if (failed.length) {
  for (const result of failed.slice(0, 10)) console.error(`Failure: ${result.reason.message}`);
  if (failed.length > 10) console.error(`…and ${failed.length - 10} more failures.`);
  process.exitCode = 1;
}
