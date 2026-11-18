import { firebaseConfig, useEmulators } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { connectAuthEmulator, getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  collection, connectFirestoreEmulator, doc, getDoc, getFirestore, onSnapshot, runTransaction,
  serverTimestamp, updateDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const $ = (selector) => document.querySelector(selector);
const views = ["login-view", "instructions-view", "exam-view", "complete-view", "admin-view"];
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const state = {
  user: null, authError: null, exam: null, examId: "", attemptId: "", attemptRef: null,
  attempt: null, sessionId: "", answers: {}, reviewed: new Set(), questionOrder: [],
  optionOrders: {}, current: 0, deadline: 0, timerHandle: 0,
  syncHandle: 0, submitRetryHandle: 0, submitRetrying: false, dirty: false, violationBusy: false, lastViolationAt: 0,
  wakeLock: null, adminUnsubscribers: [], currentAdminExam: ""
};

function showView(id) {
  for (const view of views) $(`#${view}`).classList.toggle("hidden", view !== id);
}

function notify(message, duration = 4200) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  window.clearTimeout(notify.timeout);
  notify.timeout = window.setTimeout(() => toast.classList.add("hidden"), duration);
}

function setSaveStatus(text, error = false) {
  const el = $("#save-status");
  if (el) {
    el.textContent = text;
    el.style.color = error ? "var(--red)" : "";
  }
}

function localKey() {
  return `exam:${state.examId}:${state.attemptId}`;
}

function saveLocal() {
  if (!state.attemptId) return;
  try {
    localStorage.setItem(localKey(), JSON.stringify({
      answers: state.answers,
      reviewed: [...state.reviewed],
      questionOrder: state.questionOrder,
      optionOrders: state.optionOrders
    }));
  } catch (error) {
    console.error("Could not save exam progress locally.", error);
    notify("This device could not save progress locally. Check available storage.");
  }
}

function loadLocal() {
  try {
    const saved = localStorage.getItem(localKey());
    if (!saved) return false;
    const value = JSON.parse(saved);
    state.answers = value.answers && typeof value.answers === "object" ? value.answers : {};
    state.reviewed = new Set(Array.isArray(value.reviewed) ? value.reviewed : []);
    state.questionOrder = Array.isArray(value.questionOrder) ? value.questionOrder : [];
    state.optionOrders = value.optionOrders && typeof value.optionOrders === "object" ? value.optionOrders : {};
    state.dirty = true;
    return true;
  } catch (error) {
    console.error("Could not restore local exam progress.", error);
    return false;
  }
}

function shuffled(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function ensureOrder() {
  const questions = state.exam.questions;
  const knownIds = new Set(questions.map((question) => question.id));
  if (state.questionOrder.length !== questions.length || state.questionOrder.some((id) => !knownIds.has(id))) {
    state.questionOrder = shuffled(questions.map((question) => question.id));
  }
  for (const question of questions) {
    const optionIds = new Set(question.options.map((option) => option.id));
    const order = state.optionOrders[question.id];
    if (!Array.isArray(order) || order.length !== optionIds.size || order.some((id) => !optionIds.has(id))) {
      state.optionOrders[question.id] = shuffled(question.options.map((option) => option.id));
    }
  }
}

function getQuestion(id) {
  return state.exam.questions.find((question) => question.id === id);
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function renderQuestion() {
  const id = state.questionOrder[state.current];
  const question = getQuestion(id);
  if (!question) return;
  $("#exam-title").textContent = state.exam.title;
  $("#exam-code-label").textContent = state.examId;
  $("#question-count").textContent = `Question ${state.current + 1} of ${state.questionOrder.length}`;
  $("#question-number").textContent = `QUESTION ${state.current + 1}`;
  $("#question-text").textContent = question.text;
  const options = $("#options-list");
  options.replaceChildren();
  for (const optionId of state.optionOrders[id]) {
    const option = question.options.find((item) => item.id === optionId);
    if (!option) continue;
    const label = document.createElement("label");
    label.className = "option-row";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "answer";
    input.value = option.id;
    input.checked = state.answers[id] === option.id;
    input.addEventListener("change", () => {
      state.answers[id] = option.id;
      state.dirty = true;
      saveLocal();
      renderNavigator();
    });
    const text = document.createElement("span");
    text.textContent = option.text;
    label.append(input, text);
    options.append(label);
  }
  const marked = state.reviewed.has(id);
  $("#review-button").textContent = marked ? "★ Marked for review" : "☆ Mark for review";
  $("#review-button").setAttribute("aria-pressed", String(marked));
  $("#previous-question").disabled = state.current === 0;
  $("#next-question").textContent = state.current === state.questionOrder.length - 1 ? "Review answers" : "Next";
  renderNavigator();
}

function renderNavigator() {
  const nav = $("#question-navigator");
  if (!nav) return;
  nav.replaceChildren();
  state.questionOrder.forEach((id, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "question-jump";
    if (state.answers[id]) button.classList.add("answered");
    if (state.reviewed.has(id)) button.classList.add("review");
    if (index === state.current) button.classList.add("current");
    button.textContent = String(index + 1);
    button.setAttribute("aria-label", `Go to question ${index + 1}${state.answers[id] ? ", answered" : ""}${state.reviewed.has(id) ? ", marked for review" : ""}`);
    button.addEventListener("click", () => {
      state.current = index;
      renderQuestion();
    });
    nav.append(button);
  });
  const answeredCount = Object.keys(state.answers).filter((id) => state.questionOrder.includes(id)).length;
  $("#navigator-summary").textContent = `${answeredCount} of ${state.questionOrder.length} answered`;
}

function makeAttemptId(rollNumber) {
  return rollNumber.trim().toUpperCase();
}

function getSessionId() {
  const key = `exam-session:${state.examId}:${state.attemptId}`;
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
}

function showInstructions() {
  $("#instructions-title").textContent = state.exam.title;
  const iOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const deviceNote = iOS && !standalone
    ? "\n\nOn iPhone/iPad Safari, fullscreen is not available. For the best experience, tap Share → Add to Home Screen, then open the app from your Home Screen."
    : "";
  $("#instructions-content").textContent =
    `${state.exam.instructions || "Read each question carefully. You may move between questions and mark questions for review."}\n\n` +
    `Duration: ${state.exam.durationMinutes} minutes\nQuestions: ${state.exam.questions.length}\n` +
    `Maximum violations: ${state.exam.maxViolations}${deviceNote}`;
  showView("instructions-view");
}

function parseDate(value) {
  if (!value) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

async function enterExam(event) {
  event.preventDefault();
  const examId = $("#exam-code").value.trim().toUpperCase();
  const batch = $("#student-batch").value.trim();
  const rollNumber = $("#roll-number").value.trim();
  if (!examId || !batch || !rollNumber) return;
  if (!state.user) {
    notify("Wait for Firebase sign-in to finish, then continue.");
    return;
  }
  if (batch.length > 40) {
    notify("Batch must be 40 characters or fewer.");
    return;
  }
  if (!/^[A-Z0-9_-]{1,40}$/.test(rollNumber.toUpperCase())) {
    notify("Roll number must use 1–40 letters, numbers, hyphens, or underscores.");
    return;
  }
  const ref = doc(db, "exams", examId);
  try {
    const snapshot = await getDoc(ref);
    if (!snapshot.exists()) throw new Error("No exam was found for that code.");
    const exam = snapshot.data();
    if (!exam.published) throw new Error("This exam is not currently available.");
    if (!Array.isArray(exam.questions) || !exam.questions.length) throw new Error("This exam does not have any questions yet.");
    const now = Date.now();
    const start = parseDate(exam.startAt);
    const end = parseDate(exam.endAt);
    if (start && now < start) throw new Error(`This exam opens at ${new Date(start).toLocaleString()}.`);
    if (end && now > end) throw new Error("The exam window has closed.");
    state.exam = exam;
    state.examId = examId;
    state.attemptId = makeAttemptId(rollNumber);
    state.sessionId = getSessionId();
    state.attemptRef = doc(db, "exams", examId, "attempts", state.attemptId);
    state.dirty = false;
    state.answers = {};
    state.reviewed = new Set();
    state.questionOrder = [];
    state.optionOrders = {};
    const attemptSnapshot = await getDoc(state.attemptRef);
    if (attemptSnapshot.exists()) {
      const attempt = attemptSnapshot.data();
      if (attempt.uid !== state.user.uid || attempt.rollNumber !== rollNumber.toUpperCase()) {
        throw new Error("An exam session already exists for this roll number on another device or account. Contact your exam administrator.");
      }
      if (attempt.batch !== batch) {
        throw new Error("The batch entered does not match the existing attempt for this roll number.");
      }
      if (attempt.sessionId !== state.sessionId) {
        throw new Error("This roll number is already active in another tab. Return to the original exam tab.");
      }
      if (attempt.status !== "in_progress") {
        showCompletion("Your exam was already submitted.");
        return;
      }
      state.attempt = attempt;
      const hasLocal = loadLocal();
      if (!hasLocal) {
        state.answers = attempt.answers || {};
        state.reviewed = new Set(attempt.reviewed || []);
        state.questionOrder = attempt.questionOrder || [];
        state.optionOrders = attempt.optionOrders || {};
      }
    } else {
      state.attempt = { rollNumber: rollNumber.toUpperCase(), batch, violations: [], status: "new" };
    }
    ensureOrder();
    showInstructions();
  } catch (error) {
    console.error("Could not open exam.", error);
    notify(error.message || "Could not open the exam. Check your connection and try again.");
  }
}

async function requestFullscreen() {
  if (document.fullscreenElement || !document.documentElement.requestFullscreen) return;
  try {
    await document.documentElement.requestFullscreen();
  } catch (error) {
    console.warn("Fullscreen request was not granted.", error);
  }
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible" || state.wakeLock) return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => { state.wakeLock = null; });
  } catch (error) {
    console.info("Screen Wake Lock is unavailable.", error);
  }
}

async function startAttempt() {
  const durationMinutes = Number(state.exam.durationMinutes);
  if (!Number.isFinite(durationMinutes) || durationMinutes < 1) {
    notify("This exam has an invalid duration. Contact the administrator.");
    return;
  }
  try {
    const fullscreenRequest = requestFullscreen();
    if (!state.attempt || state.attempt.status === "new") {
      const initialAttempt = {
        uid: state.user.uid,
        rollNumber: state.attempt.rollNumber,
        batch: state.attempt.batch,
        sessionId: state.sessionId,
        status: "in_progress",
        answers: state.answers,
        reviewed: [...state.reviewed],
        questionOrder: state.questionOrder,
        optionOrders: state.optionOrders,
        violations: [],
        violationCount: 0,
        durationSeconds: durationMinutes * 60,
        startedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      };
      await runTransaction(db, async (transaction) => {
        const existing = await transaction.get(state.attemptRef);
        if (existing.exists()) throw new Error("An attempt already exists for this roll number.");
        transaction.set(state.attemptRef, initialAttempt);
      });
      state.attempt = { ...initialAttempt, startedAt: null };
      const created = await getDoc(state.attemptRef);
      if (created.exists() && created.data().startedAt?.toMillis) {
        state.attempt.startedAt = created.data().startedAt.toMillis();
      }
    }
    const startedAt = typeof state.attempt.startedAt === "number"
      ? state.attempt.startedAt
      : state.attempt.startedAt?.toMillis?.();
    if (!startedAt) throw new Error("The server did not confirm the exam start time. Please try again.");
    state.deadline = startedAt + Number(state.attempt.durationSeconds || durationMinutes * 60) * 1000;
    state.current = 0;
    saveLocal();
    showView("exam-view");
    renderQuestion();
    await fullscreenRequest;
    await requestWakeLock();
    beginTimer();
    window.clearInterval(state.syncHandle);
    state.syncHandle = window.setInterval(() => { if (state.dirty) syncAttempt(); }, 150_000);
    attachAntiCheat();
  } catch (error) {
    console.error("Could not start exam.", error);
    notify(error.message || "Could not start the exam. Try again when online.");
  }
}

function beginTimer() {
  window.clearInterval(state.timerHandle);
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
    $("#timer").textContent = formatTime(remaining);
    $(".timer-box").classList.toggle("urgent", remaining <= 300);
    if (remaining <= 0) submitExam("time_expired");
  };
  tick();
  state.timerHandle = window.setInterval(tick, 1000);
}

function attemptPayload() {
  return {
    answers: state.answers,
    reviewed: [...state.reviewed],
    questionOrder: state.questionOrder,
    optionOrders: state.optionOrders,
    violations: state.attempt.violations || [],
    violationCount: Number(state.attempt.violationCount || 0),
    status: state.attempt.status || "in_progress",
    updatedAt: serverTimestamp()
  };
}

async function syncAttempt() {
  if (!state.attemptRef || !state.attempt || state.attempt.status === "new" || !state.dirty) return true;
  saveLocal();
  if (!navigator.onLine) {
    setSaveStatus("Offline — will retry", true);
    return false;
  }
  setSaveStatus("Syncing…");
  try {
    await updateDoc(state.attemptRef, attemptPayload());
    state.dirty = false;
    setSaveStatus("Synced");
    saveLocal();
    return true;
  } catch (error) {
    console.error("Could not sync exam progress.", error);
    setSaveStatus("Sync pending — retrying", true);
    return false;
  }
}

async function recordViolation(type) {
  if (state.violationBusy || !state.attempt || state.attempt.status !== "in_progress") return;
  const now = Date.now();
  if (now - state.lastViolationAt < 1200) return;
  state.lastViolationAt = now;
  state.violationBusy = true;
  const violations = [...(state.attempt.violations || []), { type, timestamp: new Date(now).toISOString() }];
  state.attempt.violations = violations;
  state.attempt.violationCount = violations.length;
  state.dirty = true;
  saveLocal();
  $("#violation-message").textContent =
    `Event recorded: ${type.replaceAll("_", " ")}. Violation ${violations.length} of ${state.exam.maxViolations}. The timer continues while the exam is paused.`;
  $("#blocking-overlay").classList.remove("hidden");
  const synced = await syncAttempt();
  if (!synced) notify("Violation saved on this device. It will sync when your connection returns.");
  if (violations.length >= Number(state.exam.maxViolations)) {
    await submitExam("violation_limit");
  }
  state.violationBusy = false;
}

function attachAntiCheat() {
  if (state.antiCheatAttached) return;
  state.antiCheatAttached = true;
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && state.attempt?.status === "in_progress") recordViolation("fullscreen_exit");
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && state.attempt?.status === "in_progress") recordViolation("visibility_change");
    if (document.visibilityState === "visible") requestWakeLock();
  });
  window.addEventListener("blur", () => {
    if (state.attempt?.status === "in_progress") recordViolation("window_blur");
  });
  document.addEventListener("contextmenu", (event) => {
    if (state.attempt?.status === "in_progress") {
      event.preventDefault();
      recordViolation("right_click");
    }
  });
  for (const eventName of ["copy", "paste", "cut"]) {
    document.addEventListener(eventName, (event) => {
      if (state.attempt?.status === "in_progress") {
        event.preventDefault();
        recordViolation(eventName);
      }
    });
  }
  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    const blocked = key === "f12" || (event.ctrlKey && event.shiftKey && key === "i") ||
      (event.ctrlKey && key === "u") || (event.metaKey && event.altKey && key === "i");
    if (blocked && state.attempt?.status === "in_progress") {
      event.preventDefault();
      recordViolation("blocked_keyboard_shortcut");
    }
  });
}

async function submitExam(reason = "student_submit") {
  if (!state.attempt || state.attempt.status !== "in_progress") return;
  state.attempt.status = "submitted";
  state.dirty = true;
  saveLocal();
  window.clearInterval(state.timerHandle);
  window.clearInterval(state.syncHandle);
  $("#blocking-overlay").classList.add("hidden");
  try {
    await updateDoc(state.attemptRef, {
      ...attemptPayload(),
      status: "submitted",
      submitReason: reason,
      submittedAt: serverTimestamp()
    });
    state.dirty = false;
    window.clearTimeout(state.submitRetryHandle);
    localStorage.removeItem(localKey());
    if (state.wakeLock) {
      const lock = state.wakeLock;
      state.wakeLock = null;
      lock.release().catch((error) => console.info("Could not release screen wake lock.", error));
    }
    showCompletion(reason === "time_expired" ? "Time is up. Your exam has been submitted." : "Your responses have been saved. You may close this page.");
  } catch (error) {
    console.error("Could not submit exam to Firestore.", error);
    state.dirty = true;
    saveLocal();
    showCompletion("Your submission is saved on this device and will retry when your connection returns.");
    scheduleSubmitRetry();
  }
}

async function retrySubmission() {
  if (!state.attemptRef || !state.attempt || state.attempt.status !== "submitted" || !state.dirty || state.submitRetrying) return;
  state.submitRetrying = true;
  try {
    await updateDoc(state.attemptRef, {
      ...attemptPayload(),
      status: "submitted",
      submitReason: "submission_retry",
      submittedAt: serverTimestamp()
    });
    state.attempt.status = "submitted";
    state.dirty = false;
    window.clearTimeout(state.submitRetryHandle);
    localStorage.removeItem(localKey());
    $("#complete-message").textContent = "Your responses have been submitted.";
  } catch (error) {
    console.error("Submission retry failed.", error);
    scheduleSubmitRetry();
  } finally {
    state.submitRetrying = false;
  }
}

function scheduleSubmitRetry() {
  window.clearTimeout(state.submitRetryHandle);
  window.addEventListener("online", retrySubmission, { once: true });
  state.submitRetryHandle = window.setTimeout(retrySubmission, 15_000);
}

function showCompletion(message) {
  $("#complete-message").textContent = message;
  showView("complete-view");
}

function goToQuestion(index) {
  if (index < 0 || index >= state.questionOrder.length) return;
  state.current = index;
  renderQuestion();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function installStudentHandlers() {
  $("#entry-form").addEventListener("submit", enterExam);
  $("#start-exam").addEventListener("click", startAttempt);
  $("#previous-question").addEventListener("click", () => goToQuestion(state.current - 1));
  $("#next-question").addEventListener("click", () => {
    if (state.current < state.questionOrder.length - 1) goToQuestion(state.current + 1);
    else {
      const unanswered = state.questionOrder.filter((id) => !state.answers[id]).length;
      notify(unanswered ? `${unanswered} unanswered question${unanswered === 1 ? "" : "s"} remain. Review before submitting.` : "You’ve reached the end. Review your answers or submit.");
      $("#navigator-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });
  $("#review-button").addEventListener("click", () => {
    const id = state.questionOrder[state.current];
    if (state.reviewed.has(id)) state.reviewed.delete(id);
    else state.reviewed.add(id);
    state.dirty = true;
    saveLocal();
    renderQuestion();
  });
  $("#submit-exam").addEventListener("click", () => {
    const unanswered = state.questionOrder.filter((id) => !state.answers[id]).length;
    if (window.confirm(`Submit your exam now?${unanswered ? ` ${unanswered} question(s) are unanswered.` : ""}`)) submitExam();
  });
  $("#resume-exam").addEventListener("click", async () => {
    $("#blocking-overlay").classList.add("hidden");
    await requestFullscreen();
    await requestWakeLock();
    state.violationBusy = false;
  });
  $("#navigator-toggle").addEventListener("click", () => {
    const panel = $("#navigator-panel");
    const collapsed = panel.classList.toggle("navigator-collapsed");
    $("#navigator-toggle").textContent = collapsed ? "Show" : "Hide";
    $("#navigator-toggle").setAttribute("aria-expanded", String(!collapsed));
  });
  window.addEventListener("online", () => { if (state.dirty) syncAttempt(); });
  window.addEventListener("orientationchange", () => window.setTimeout(renderQuestion, 100));
}

function addField(labelText, value = "", type = "text", required = false) {
  const label = document.createElement("label");
  label.textContent = labelText;
  const input = document.createElement("input");
  input.type = type;
  input.value = value || "";
  input.required = required;
  label.append(input);
  return { label, input };
}

function renderAdminQuestion(question = null) {
  const card = document.createElement("div");
  card.className = "admin-question";
  const grid = document.createElement("div");
  grid.className = "admin-question-grid";
  const prompt = document.createElement("textarea");
  prompt.rows = 2;
  prompt.required = true;
  prompt.placeholder = "Question text";
  prompt.value = question?.text || "";
  grid.append(prompt);
  const optionInputs = [];
  for (let index = 0; index < 4; index++) {
    const option = question?.options?.[index];
    const row = document.createElement("div");
    row.className = "admin-grid";
    const field = addField(`Option ${String.fromCharCode(65 + index)}`, option?.text || "", "text", true);
    row.append(field.label);
    grid.append(row);
    optionInputs.push(field.input);
  }
  const answerLabel = document.createElement("label");
  answerLabel.textContent = "Correct option";
  const answerSelect = document.createElement("select");
  for (let index = 0; index < 4; index++) {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `Option ${String.fromCharCode(65 + index)}`;
    answerSelect.append(option);
  }
  const correctIndex = question ? question.options.findIndex((option) => option.id === question.correctOptionId) : 0;
  answerSelect.value = String(Math.max(0, correctIndex));
  answerLabel.append(answerSelect);
  grid.append(answerLabel);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "button button-outline";
  remove.textContent = "Remove question";
  remove.addEventListener("click", () => card.remove());
  card.append(grid, remove);
  card.getQuestionData = () => {
    const id = question?.id || crypto.randomUUID();
    const options = optionInputs.map((input, index) => ({ id: question?.options?.[index]?.id || crypto.randomUUID(), text: input.value.trim() }));
    return {
      question: { id, text: prompt.value.trim(), options },
      answer: options[Number(answerSelect.value)].id
    };
  };
  $("#admin-questions").append(card);
}

function adminShell(isAdmin) {
  for (const unsubscribe of state.adminUnsubscribers) unsubscribe();
  for (const unsubscribe of state.adminAttemptUnsubscribers || []) unsubscribe();
  state.adminUnsubscribers = [];
  state.adminAttemptUnsubscribers = [];
  state.currentAdminExam = "";
  const root = $("#admin-view");
  root.replaceChildren();
  const header = document.createElement("section");
  header.className = "admin-section";
  header.innerHTML = `<div class="admin-toolbar"><div><p class="eyebrow">ADMINISTRATION</p><h1>Exam dashboard</h1></div><button id="back-to-student" class="button button-outline" type="button">Student portal</button></div><p id="admin-identity" class="muted"></p>`;
  root.append(header);
  $("#back-to-student").addEventListener("click", () => showView("login-view"));
  $("#admin-identity").textContent = `Signed in UID: ${state.user.uid}`;
  if (!isAdmin) {
    const denied = document.createElement("section");
    denied.className = "admin-section";
    denied.innerHTML = `<h2>Admin access is not enabled for this account</h2><p class="muted">Ask a project owner to add an <code>admins/${state.user.uid}</code> document in Firestore. Only trusted administrators should be added.</p>`;
    root.append(denied);
    return;
  }

  const formSection = document.createElement("section");
  formSection.className = "admin-section";
  formSection.innerHTML = `<div class="admin-toolbar"><h2 id="editor-heading">Create an exam</h2><button id="new-exam" class="button button-outline" type="button">New exam</button></div><form id="exam-editor" class="form-stack">
    <div class="admin-grid" id="exam-fields"></div>
    <label>Instructions<textarea id="exam-instructions" rows="3"></textarea></label>
    <label class="inline-check"><input id="exam-published" type="checkbox" checked> Publish exam</label>
    <div class="admin-toolbar"><h2>Questions</h2><button id="add-question" class="button button-outline" type="button">Add question</button></div>
    <div id="admin-questions"></div><button class="button button-primary" type="submit">Save exam</button>
  </form>`;
  root.append(formSection);
  const fieldset = $("#exam-fields");
  const fields = [
    ["code", "Exam code", "text"], ["title", "Title", "text"], ["duration", "Duration (minutes)", "number"],
    ["start", "Opens (optional)", "datetime-local"], ["end", "Closes (optional)", "datetime-local"], ["violations", "Maximum violations", "number"]
  ];
  for (const [id, label, type] of fields) {
    const field = addField(label, "", type, ["code", "title", "duration", "violations"].includes(id));
    field.input.id = `editor-${id}`;
    if (type === "number") {
      field.input.min = "1";
      if (id === "duration") field.input.max = "1440";
    }
    fieldset.append(field.label);
  }
  $("#editor-code").setAttribute("pattern", "[A-Za-z0-9_-]+");
  $("#editor-code").maxLength = 40;
  $("#admin-published").checked = true;
  renderAdminQuestion();
  $("#add-question").addEventListener("click", () => renderAdminQuestion());
  $("#new-exam").addEventListener("click", resetExamEditor);
  $("#exam-editor").addEventListener("submit", saveExamFromEditor);

  const listSection = document.createElement("section");
  listSection.className = "admin-section";
  listSection.innerHTML = `<div class="admin-toolbar"><h2>Live exams and results</h2><div><button id="edit-selected-exam" class="button button-outline" type="button">Edit selected</button> <button id="export-results" class="button button-outline" type="button">Export CSV</button></div></div><label>Select exam<select id="admin-exam-select"><option value="">Loading…</option></select></label><div id="live-results" class="admin-empty">Choose an exam to see live attempts.</div>`;
  root.append(listSection);
  $("#admin-exam-select").addEventListener("change", (event) => watchAdminExam(event.target.value));
  $("#edit-selected-exam").addEventListener("click", async () => {
    const examId = $("#admin-exam-select").value;
    if (!examId) return notify("Select an exam first.");
    try {
      const snapshot = await getDoc(doc(db, "exams", examId));
      if (!snapshot.exists()) throw new Error("Exam not found.");
      await editExam(examId, snapshot.data());
    } catch (error) {
      console.error("Could not load exam for editing.", error);
      notify("Could not load this exam for editing.");
    }
  });
  $("#export-results").addEventListener("click", exportResults);
  watchExams();
}

function resetExamEditor() {
  $("#exam-editor").reset();
  $("#admin-questions").replaceChildren();
  $("#exam-published").checked = true;
  $("#editor-heading").textContent = "Create an exam";
  $("#editor-code").disabled = false;
  renderAdminQuestion();
}

function datetimeValue(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

async function editExam(examId, exam) {
  $("#editor-code").value = examId;
  $("#editor-code").disabled = true;
  $("#editor-title").value = exam.title || "";
  $("#editor-duration").value = exam.durationMinutes || "";
  $("#editor-start").value = datetimeValue(exam.startAt);
  $("#editor-end").value = datetimeValue(exam.endAt);
  $("#editor-violations").value = exam.maxViolations || 3;
  $("#exam-instructions").value = exam.instructions || "";
  $("#exam-published").checked = !!exam.published;
  $("#admin-questions").replaceChildren();
  const snapshot = await getDoc(doc(db, "exams", examId, "private", "answerKey"));
  if (!snapshot.exists()) throw new Error("Answer key was not found.");
  const key = snapshot.data().answers || {};
  for (const question of exam.questions || []) {
    renderAdminQuestion({ ...question, correctOptionId: key[question.id] });
  }
  $("#editor-heading").textContent = `Edit ${examId}`;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function saveExamFromEditor(event) {
  event.preventDefault();
  const examId = $("#editor-code").value.trim().toUpperCase();
  const cards = [...$("#admin-questions").children];
  if (cards.length < 1 || cards.length > 100) {
    notify("Add between 1 and 100 questions.");
    return;
  }
  const questions = [];
  const answers = {};
  for (const card of cards) {
    const result = card.getQuestionData();
    if (!result.question.text || result.question.options.some((option) => !option.text)) {
      notify("Every question and each of its four options must have text.");
      return;
    }
    questions.push(result.question);
    answers[result.question.id] = result.answer;
  }
  const exam = {
    title: $("#editor-title").value.trim(),
    durationMinutes: Number($("#editor-duration").value),
    startAt: $("#editor-start").value ? new Date($("#editor-start").value).toISOString() : "",
    endAt: $("#editor-end").value ? new Date($("#editor-end").value).toISOString() : "",
    maxViolations: Number($("#editor-violations").value),
    instructions: $("#exam-instructions").value.trim(),
    published: $("#exam-published").checked,
    questions,
    updatedAt: serverTimestamp()
  };
  if (!/^[A-Z0-9_-]{1,40}$/.test(examId) || !exam.title || !Number.isInteger(exam.durationMinutes) || exam.durationMinutes < 1 || exam.durationMinutes > 1440 ||
      !Number.isInteger(exam.maxViolations) || exam.maxViolations < 1) {
    notify("Check the exam code, title, duration, and violation limit.");
    return;
  }
  if (exam.startAt && exam.endAt && Date.parse(exam.startAt) >= Date.parse(exam.endAt)) {
    notify("The exam close time must be after its open time.");
    return;
  }
  if (new TextEncoder().encode(JSON.stringify(exam)).length > 900_000) {
    notify("This exam is too large for one Firestore document. Reduce the question text or options.");
    return;
  }
  try {
    const batch = writeBatch(db);
    batch.set(doc(db, "exams", examId), exam);
    batch.set(doc(db, "exams", examId, "private", "answerKey"), { answers, updatedAt: serverTimestamp() });
    await batch.commit();
    notify("Exam and private answer key saved.");
    resetExamEditor();
  } catch (error) {
    console.error("Could not save exam.", error);
    notify("Could not save the exam. Check admin permissions and your connection.");
  }
}

function watchExams() {
  const unsubscribe = onSnapshot(collection(db, "exams"), (snapshot) => {
    const select = $("#admin-exam-select");
    if (!select) return;
    const previous = select.value;
    select.replaceChildren(new Option("Select an exam", ""));
    snapshot.docs.forEach((item) => {
      const option = new Option(`${item.id} — ${item.data().title || ""}`, item.id);
      select.append(option);
    });
    if (previous && snapshot.docs.some((item) => item.id === previous)) {
      select.value = previous;
    } else if (snapshot.docs.length) {
      select.value = snapshot.docs[0].id;
      watchAdminExam(select.value);
    }
  }, (error) => {
    console.error("Could not listen to exams.", error);
    notify("Could not load exams. Check Firestore permissions.");
  });
  state.adminUnsubscribers.push(unsubscribe);
}

async function watchAdminExam(examId) {
  if (!examId || state.currentAdminExam === examId) return;
  state.currentAdminExam = examId;
  for (const unsubscribe of state.adminAttemptUnsubscribers || []) unsubscribe();
  let exam;
  let answerKey;
  try {
    const examSnapshot = await getDoc(doc(db, "exams", examId));
    if (!examSnapshot.exists() || state.currentAdminExam !== examId) return;
    exam = examSnapshot.data();
    const keySnapshot = await getDoc(doc(db, "exams", examId, "private", "answerKey"));
    if (!keySnapshot.exists()) {
      notify("No private answer key is available for this exam.");
      return;
    }
    if (state.currentAdminExam !== examId) return;
    answerKey = keySnapshot.data().answers || {};
  } catch (error) {
    console.error("Could not load admin exam data.", error);
    notify("Could not load exam details or answer key. Check admin permissions.");
    return;
  }
  const attempts = new Map();
  const render = () => renderAdminResults(examId, exam, answerKey, [...attempts.values()]);
  const unsubscribe = onSnapshot(collection(db, "exams", examId, "attempts"), (snapshot) => {
    for (const changed of snapshot.docChanges()) {
      if (changed.type === "removed") attempts.delete(changed.doc.id);
      else attempts.set(changed.doc.id, { id: changed.doc.id, ...changed.doc.data() });
    }
    render();
  }, (error) => {
    console.error("Could not listen to attempts.", error);
    notify("Could not load live attempts. Check admin permissions.");
  });
  state.adminAttemptUnsubscribers = [unsubscribe];
  $("#admin-exam-select").value = examId;
  $("#live-results").textContent = "Listening for live attempts…";
  $("#live-results").dataset.examId = examId;
  $("#live-results")._exam = exam;
  $("#live-results")._answerKey = answerKey;
  $("#live-results")._attempts = attempts;
}

function renderAdminResults(examId, exam, answerKey, attempts) {
  const container = $("#live-results");
  if (!container || container.dataset.examId !== examId) return;
  attempts.sort((a, b) => String(a.rollNumber || "").localeCompare(String(b.rollNumber || "")));
  container.replaceChildren();
  container._attemptsArray = attempts;
  container._answerKey = answerKey;
  container._exam = exam;
  if (!attempts.length) {
    container.className = "admin-empty";
    container.textContent = "No students have started this exam.";
    return;
  }
  container.className = "admin-table-wrap";
  const table = document.createElement("table");
  table.className = "admin-table";
  const head = document.createElement("thead");
  head.innerHTML = "<tr><th>Roll number</th><th>Batch</th><th>Status</th><th>Score</th><th>Violations</th><th>Started</th><th>Violation log</th></tr>";
  table.append(head);
  const body = document.createElement("tbody");
  for (const attempt of attempts) {
    const score = attempt.status === "submitted"
      ? Object.entries(answerKey).filter(([id, correct]) => attempt.answers?.[id] === correct).length
      : "—";
    const row = document.createElement("tr");
    const values = [
      attempt.rollNumber || "—",
      attempt.batch || "—",
      attempt.status || "—",
      attempt.status === "submitted" ? `${score}/${exam.questions.length}` : "—",
      String(attempt.violationCount || (attempt.violations || []).length),
      attempt.startedAt?.toDate ? attempt.startedAt.toDate().toLocaleString() : "—"
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = value;
      if (value === "in_progress" || value === "submitted") {
        const pill = document.createElement("span");
        pill.className = `status-pill ${value}`;
        pill.textContent = value.replace("_", " ");
        cell.replaceChildren(pill);
      }
      row.append(cell);
    }
    const logCell = document.createElement("td");
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "View log";
    const log = document.createElement("ul");
    for (const item of attempt.violations || []) {
      const li = document.createElement("li");
      li.textContent = `${item.type} — ${item.timestamp}`;
      log.append(li);
    }
    if (!(attempt.violations || []).length) {
      const li = document.createElement("li");
      li.textContent = "No violations";
      log.append(li);
    }
    details.append(summary, log);
    logCell.append(details);
    row.append(logCell);
    body.append(row);
  }
  table.append(body);
  container.append(table);
}

function csvEscape(value) {
  const text = String(value ?? "");
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

function exportResults() {
  const container = $("#live-results");
  const attempts = container?._attemptsArray || [];
  const key = container?._answerKey || {};
  const exam = container?._exam;
  if (!exam) {
    notify("Select an exam with results before exporting.");
    return;
  }
  const rows = [["Roll number", "Batch", "Status", "Score", "Total", "Violation count", "Violation log"]];
  for (const attempt of attempts) {
    const score = Object.entries(key).filter(([id, correct]) => attempt.answers?.[id] === correct).length;
    const log = (attempt.violations || []).map((item) => `${item.type} @ ${item.timestamp}`).join("; ");
    rows.push([attempt.rollNumber, attempt.batch, attempt.status, attempt.status === "submitted" ? score : "", exam.questions.length, attempt.violationCount || 0, log]);
  }
  const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${$("#admin-exam-select").value}-results.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

async function openAdmin() {
  showView("admin-view");
  if (!state.user) {
    const root = $("#admin-view");
    root.replaceChildren();
    const section = document.createElement("section");
    section.className = "admin-section";
    const title = document.createElement("h1");
    title.textContent = "Admin dashboard";
    const message = document.createElement("p");
    message.className = "muted";
    message.textContent = state.authError
      ? "Firebase sign-in is unavailable. Enable Anonymous Authentication in Firebase Console and verify the web app configuration, then reload."
      : "Waiting for Firebase anonymous sign-in to finish…";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "button button-outline";
    back.textContent = "Back to student portal";
    back.addEventListener("click", () => showView("login-view"));
    section.append(title, message, back);
    root.append(section);
    return;
  }
  try {
    const membership = await getDoc(doc(db, "admins", state.user.uid));
    adminShell(membership.exists());
  } catch (error) {
    console.error("Could not check admin access.", error);
    notify("Could not check admin access. Verify Firestore setup.");
  }
}

async function initialize() {
  installStudentHandlers();
  $("#admin-toggle").addEventListener("click", openAdmin);
  if (useEmulators) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
  }
  if (!firebaseConfig.projectId || firebaseConfig.projectId === "YOUR_PROJECT_ID") {
    notify("Configure firebase-config.js with your Firebase web app settings to enable the portal.", 12000);
  }
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      state.user = user;
      state.authError = null;
      return;
    }
    try {
      const credential = await signInAnonymously(auth);
      state.user = credential.user;
    } catch (error) {
      console.error("Anonymous sign-in failed.", error);
      state.authError = error;
      notify("Firebase sign-in failed. Check your Firebase configuration and enable Anonymous Authentication.", 10000);
    }
  });
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("Service worker registration failed.", error));
  }
}

initialize();
