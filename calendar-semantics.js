import { calendarEndpointInstant, dateParts, validDate } from "./time.js";
import { normalizeLearningDays, learningTask } from "./learning.js";
const clone = (value) => structuredClone(value);
const VERSION = 2;
const identity = (task) => JSON.stringify([task.calendarLink?.calendarId || "local", task.calendarLink?.eventId || task.uid || task.id]);
const plain = (value) => String(value || "")
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
  .replace(/<[^>]*>/g, " ")
  .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&")
  .replace(/\s+/g, " ").trim();
const titleKey = (task) => `${task.calendarLink?.calendarId || "local"}\0${plain(task.calendarSource?.summary || task.title).toLocaleLowerCase()}`;

export const SQL_ORDER = ["row-number", "lag", "anti-joins", "union", "conditional-aggregation", "null", "date-boundary", "rank", "lead", "rolling-sum", "self-join", "retention", "funnel", "reconciliation", "query-plan"];
const SQL_TOPICS = [
  ["row-number", /\brow[ _-]?number\b/i], ["lag", /\blag\b/i],
  ["anti-joins", /\banti[ -]?joins?\b/i], ["union", /\bunion\b/i],
  ["conditional-aggregation", /conditional aggregation/i],
  ["null", /\bnull\b/i], ["date-boundary", /date boundar/i],
  ["rank", /\brank\b/i], ["lead", /\blead\b/i], ["rolling-sum", /rolling sum/i],
  ["self-join", /\bself[ -]?join\b/i], ["retention", /retention/i],
  ["funnel", /funnel/i], ["reconciliation", /reconciliation/i],
  ["query-plan", /query plan/i],
];
const hardInterview = /Real interview|recruiter interview|hiring interview|onsite interview|technical interview with|not a mock/i;
const preparation = /Mock interview|mock\s*(interview)?|interview\s*(prep(?:aration)?|practice)|Practice assessment|Assessment practice|practice\s*(assessment|test)|assessment\s*practice/i;
// A denied event purpose, not a substring in an object such as "practice book" or "simulator".
// Description quotes and historical clauses are removed before this is tested.
const practiceDenial = /\b(?:not|no longer)\s+(?:an?\s+)?(?:mock|practice)\b/i;
const hardAssessment = /Real assessment|hiring assessment|coding assessment|online assessment|(?:assessment|test).{0,20}(?:deadline|due by)/i;
const medical = /Medical appointment|dentist|dental appointment|medical appointment|doctor(?:'s)? appointment|vaccin(?:e|ation) appointment/i;
const outing = /barbecue|\bbbq\b|park outing|day trip|hiking/i;
const social = /badminton|movie|breakfast|lunch|dinner|workout|meetup|social gathering/i;
const jobContext = /job\s*prepare|Mock interview|mock|interview\s*(prep|practice)|SQL|interface\.ai/i;
const learningContent = /assignment|lesson|practice|study|project|homework|tutorial/i;

function evidence(task, field, detail) {
  return { source: field === "user" ? "user-confirmed" : "calendar-event", eventId: task.calendarLink?.eventId || null,
    field, excerpt: plain(detail).slice(0, 240) };
}

function courseFacts(title, description) {
  const combined = `${title} ${description}`;
  let course = /interface\.ai/i.test(combined) ? "interface.ai" : /\bSQL\b/i.test(combined) ? "sql" : null;
  const titleTopics = SQL_TOPICS.filter(([, regex]) => regex.test(title));
  const descriptionTopics = SQL_TOPICS.filter(([, regex]) => regex.test(description));
  const topics = titleTopics.length ? titleTopics : descriptionTopics;
  if (!course && topics.some(([key]) => ["row-number", "anti-joins", "conditional-aggregation", "rolling-sum", "self-join", "query-plan"].includes(key))) course = "sql";
  const stage = /homework|assignment/i.test(title) ? "homework"
    : /practice|exercise/i.test(title) ? "practice"
      : /lesson|tutorial|lecture/i.test(title) ? "teaching" : "block";
  let lessonKey = course === "sql" && topics.length === 1 ? topics[0][0] : null;
  if (course === "interface.ai") {
    const module = /interface\.ai\s*(?:part|module|[-—|:])*\s*0?([1-4])\b/i.exec(title);
    if (module) lessonKey = `module-${module[1]}`;
    else if (/assignment\s*a\b/i.test(combined)) lessonKey = "assignment-a";
  }
  return { course, lessonKey, stage };
}

// The subject of a course is not permission to move its real submission deadline.
// Keep this parser shared by classification and confirmation evidence: a prior
// learning decision must not certify a newly introduced deadline for itself.
function deadlineFacts(title, description) {
  const explicit = /(?:submission|application|project|assignment).{0,30}(?:deadline|due\s+(?:by|on|at))|(?:deadline).{0,20}(?:submission|application|project|assignment)/i;
  // A due date is evidence of a deadline, never a replacement event timestamp.
  const datedDue = /\bdue\s+(?:(?:by|on|at)\s+)?(?:\d{4}-\d{1,2}-\d{1,2}\b|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}\b|\d{1,2}\s+(?:Jan\w*|Feb\w*|Mar\w*|Apr\w*|May|Jun\w*|Jul\w*|Aug\w*|Sep\w*|Oct\w*|Nov\w*|Dec\w*)\b|(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?|today|tomorrow)\b|\d{1,2}:\d{2}\b|\d{1,2}\s*(?:am|pm)\b)/i;
  const marker = /\bdeadline\b|\bdue\b(?!\s+to\b)/i;
  const uncertain = /maybe|possibly|tentative|uncertain/i;
  let clear = false, ambiguous = false, denied = false;
  for (const text of [title, description]) {
    const unquoted = text.replace(/“[^”]*”|‘[^’]*’|"[^"]*"/g, " ");
    for (const sentence of unquoted.split(/[;!?]|\.(?=\s|$)/)) {
      if (/^\s*(?:historical|previous|formerly|old\s+(?:note|plan)|quoted|reference)\b/i.test(sentence)) continue;
      for (const clause of sentence.split(/,|\bbut\b/i)) {
      if (!marker.test(clause)) continue;
      if (/\b(?:not|no|cancelled|canceled)\b[^,;.!]{0,35}\b(?:deadline|due)\b/i.test(clause)) { denied = true; continue; }
      // Preparation for, discussion about, or notes from a deadline are work,
      // rather than a reminder that itself occupies a non-movable time.
      if (/\b(?:prepar\w*|review|about|discuss\w*|study)\b.{0,40}\b(?:deadline|due)\b|\bdeadline\b.{0,20}\b(?:notes|materials|preparation|practice)\b/i.test(clause)) continue;
      if (uncertain.test(clause)) ambiguous = true;
      else if (explicit.test(clause) || datedDue.test(clause)) clear = true;
      else ambiguous = true;
      }
    }
  }
  ambiguous ||= clear && denied;
  return { clear: clear && !ambiguous, ambiguous };
}

/** Whole-day intent in a description. Only an uncertain statement about Job
 * Prepare study on an explicit date makes that date a question. Quotes are
 * historical evidence, not a present instruction.
 */
function restIntent(description) {
  const current = description
    .replace(/“[^”]*”|‘[^’]*’|"[^"]*"|'[^']*'/g, " ");
  const ambiguousDates = new Set(), active = [];
  const uncertain = /maybe|possibly|uncertain|tentative/i;
  for (const sentence of current.split(/[;!?]/)) {
    let scopedDate = null;
    for (const raw of sentence.split(/,/)) {
      const clause = raw.trim();
      if (!clause) continue;
      const explicit = [...clause.matchAll(/\d{4}-\d{2}-\d{2}/g)].at(-1)?.[0];
      if (validDate(explicit)) scopedDate = explicit;
      if (!uncertain.test(clause)) active.push(clause);
      // A time of day makes the statement local, so it never concerns the whole date.
      if (scopedDate && uncertain.test(clause) && /Job\s*Prepare/i.test(clause) && !/\d{1,2}:\d{2}/.test(clause)) ambiguousDates.add(scopedDate);
    }
  }
  return { ambiguousDates: [...ambiguousDates], activeDescription: active.join(". ") };
}

// A confirmation binds semantic evidence, not an ETag or wall time.
function eventRuleDate(task, date, timeZone = "America/Los_Angeles") {
  const source = task.calendarSource, start = source?.start;
  if (validDate(start?.date)) return start.date;
  try {
    // Keep the original source-day anchor after local moves, but express it in
    // the workspace zone. Offsetless endpoints must never use the host zone.
    const instant = calendarEndpointInstant(start, source?.calendarTimeZone || source?.timeZone || timeZone);
    return dateParts(instant, timeZone).date;
  } catch { return date; }
}

// Preserve the source of a current activity declaration. A mixed title cannot
// hide a newly declared formal appointment in the description, and a course
// about interviews is not itself an interview. No full-text/ETag comparison.
function purposeDeclarations(text, isTitle = false) {
  const roles = [["interview", /(?:real|formal|hiring|recruiter|onsite)\s+interview/i],
    ["hard-assessment", /(?:hiring|coding|online|formal)\s+assessment/i],
    ["medical", medical]];
  const fixedIntent = /\b(?:keep|preserve|retain)\s+(?:the\s+)?(?:original|fixed)\s+time\b|\bcannot\s+(?:be\s+)?(?:moved|rescheduled)\b/i.test(text);
  const purposes = new Set();
  for (const clause of text.split(/[;!?]/)) for (const [purpose, pattern] of roles) {
    const match = pattern.exec(clause);
    if (!match) continue;
    const before = clause.slice(0, match.index).trim(), after = clause.slice(match.index + match[0].length);
    const reference = /\b(?:about|prepar(?:e|ing|ation)|practice|course|lesson|study|review|discussion|analysis|materials?)\b[^,;:.]{0,24}$/i.test(before) ||
      /^\s*(?:preparation|practice|course|lesson|materials?|notes|tools)\b/i.test(after);
    const direct = before === "";
    const assigned = /\b(?:this(?:\s+(?:event|appointment|activity|session))?\s+is|changed\s+to|scheduled\s+as)\s+(?:an?\s+)?$/i.test(before);
    if (!reference && (isTitle || direct || assigned || fixedIntent)) purposes.add(purpose);
  }
  return { purposes: [...purposes], practice: preparation.test(text), fixedTime: purposes.size > 0 && fixedIntent };
}

function purposeEvidence(task, date, timeZone) {
  const title = plain(task.calendarSource?.summary || task.title);
  const description = plain(task.calendarSource?.description);
  const activeDescription = restIntent(description).activeDescription;
  const asserted = `${title} ${activeDescription}`;
  const prep = preparation.test(asserted);
  const deadline = deadlineFacts(title, description);
  // Do not use prior learning tags, classification, management or locks as new
  // remote evidence: otherwise an old confirmation validates itself forever.
  return { interview: hardInterview.test(asserted) || /\binterview\b/i.test(title) && !prep,
    assessment: hardAssessment.test(asserted), medical: medical.test(asserted), deadline: deadline.clear, deadlineUncertain: deadline.ambiguous,
    learning: Boolean(courseFacts(title, description).course || prep || jobContext.test(asserted) && learningContent.test(asserted)),
    practice: prep,
    notPractice: practiceDenial.test(asserted),
    sources: { title: purposeDeclarations(title, true), description: purposeDeclarations(activeDescription) },
    assessmentUnspecified: /^(?:assessment|test)(?:\s|$)/i.test(title),
    outing: outing.test(asserted), life: social.test(title) };
}

function semanticEvidenceFingerprint(task, date, options = {}) {
  return JSON.stringify(purposeEvidence(task, date, options.timeZone));
}

function changedPurposeEvidence(decision, next) {
  let previous;
  try { previous = JSON.parse(decision.evidenceFingerprint); } catch { previous = {}; }
  const hardConflict = (purpose) => ({ purpose });
  // Hard evidence can already have been present when a mixed Mock/real event
  // was explicitly confirmed as practice. Removing that supporting evidence,
  // or newly denying practice, makes the old confirmation stale just as much
  // as introducing the first hard marker; ordinary text edits do neither.
  const practiceRetracted = previous.practice && !next.practice ||
    previous.learning && !next.learning || next.notPractice && !previous.notPractice;
  if (next.interview && (!previous.interview || practiceRetracted) && decision.purpose !== "interview") return hardConflict("interview");
  if (next.assessment && (!previous.assessment || practiceRetracted) && decision.purpose !== "hard-assessment") return hardConflict("hard-assessment");
  if (next.medical && (!previous.medical || practiceRetracted) && decision.purpose !== "medical") return hardConflict("medical");
  if ((next.deadline && (!previous.deadline || practiceRetracted) || next.deadlineUncertain && !previous.deadlineUncertain) && decision.purpose !== "deadline") return hardConflict("deadline");
  for (const [source, current] of Object.entries(next.sources || {})) {
    const prior = previous.sources?.[source];
    for (const purpose of current.purposes) {
      if (purpose === decision.purpose) continue;
      if (!prior?.purposes?.includes(purpose) || current.fixedTime && !prior.fixedTime || prior.practice && !current.practice)
        return { purpose };
    }
  }
  if (next.learning && !previous.learning && !studyPurposes.has(decision.purpose) && !next.interview && !next.assessment && !next.medical && !next.deadline)
    return { purpose: "learning" };
  return null;
}

function dateEvidenceFingerprint(rest, day) {
  return JSON.stringify({ status: rest.ambiguousDates.includes(day) ? "ambiguous" : "unspecified" });
}

function resolvedRest(raw, record) {
  const closed = new Set(), pending = new Set(raw.ambiguousDates);
  const confirmedClosedDates = [];
  let keepReadonly = false;
  for (const [day, decision] of Object.entries(record?.dateDecisions || {})) {
    if (!validDate(day)) continue;
    const changed = decision.evidenceFingerprint && decision.evidenceFingerprint !== dateEvidenceFingerprint(raw, day);
    if (changed && raw.ambiguousDates.includes(day)) pending.add(day);
    else pending.delete(day);
    if (decision.closed === true) { closed.add(day); confirmedClosedDates.push(day); }
    else if (decision.closed === false) closed.delete(day);
    if (decision.keepReadonly && !record?.overrideDateReadonly) keepReadonly = true;
  }
  if (record?.closedDate && validDate(record.closedDate)) { closed.add(record.closedDate); confirmedClosedDates.push(record.closedDate); }
  return { ...raw, closedDates: [...closed].sort(), ambiguousDates: [...pending].sort(), confirmedClosedDates, keepReadonly };
}

/** Facts only: calendar descriptions are never executable instructions. */
export function interpretEvent(task, date, options = {}) {
  const title = plain(task.calendarSource?.summary || task.title);
  const description = plain(task.calendarSource?.description);
  const calendarContext = plain(task.calendarSource?.calendarName);
  const learningCalendar = /^(?:Job\s*Prepare)(?:\s*[-—|:].*)?$/i.test(calendarContext);
  // A clearly named personal learning calendar supplies subject context, not
  // ownership permission. A dinner/interview there remains a fixed activity.
  const combined = `${title} ${description}${learningCalendar ? ` ${calendarContext}` : ""}`;
  const facts = courseFacts(title, description);
  const eventDecision = options.decisions?.[identity(task)];
  const decision = eventDecision?.purpose ? eventDecision : options.corrections?.[titleKey(task)];
  const result = { version: VERSION, purpose: "unknown", confidence: "unknown", source: "calendar-event",
    evidence: [], explanation: "Keep the original time; there is not enough information to determine its purpose.", ...facts };
  const personalDescription = task.calendarSource?.organizer?.self === true ||
    !task.calendarSource?.organizer && task.calendarSource?.creator?.self === true ||
    task.calendarSource?.trustedForPersonalRules === true;
  const rawRest = restIntent(description);
  const deadline = deadlineFacts(title, description);
  const rest = resolvedRest(rawRest, eventDecision || decision);
  result.closedDates = personalDescription ? rest.closedDates : [];
  result.confirmedClosedDates = personalDescription ? rest.confirmedClosedDates : [];
  result.keepReadonly = rest.keepReadonly;
  const prep = preparation.test(combined);
  const realInterview = hardInterview.test(combined) || (/\binterview\b/i.test(title) && !prep);
  const realAssessment = hardAssessment.test(combined) && !/Practice assessment|Assessment practice|practice\s*(assessment|test)|assessment\s*practice/i.test(title);
  const study = facts.course || (jobContext.test(combined) && learningContent.test(combined)) || prep || learningTask(task);
  const studyInTitle = preparation.test(title) ||
    (jobContext.test(title) || SQL_TOPICS.some(([, regex]) => regex.test(title))) && learningContent.test(title);
  if (personalDescription && rest.ambiguousDates.length) {
    result.purpose = "ambiguous-rest";
    result.confidence = "ambiguous";
    result.closedDateCandidates = rest.ambiguousDates;
    result.explanation = "It is unclear whether this is a full non-study day or only a fixed event period. Keep the existing schedule for now.";
  } else if (deadline.clear) {
    result.purpose = "deadline";
    result.confidence = "clear";
    result.learningWorkload = false;
    result.explanation = "This is a real submission or application deadline. Keep its time as a reminder; do not shift it with study.";
  } else if (deadline.ambiguous && !hardAssessment.test(title)) {
    result.purpose = "ambiguous-deadline";
    result.confidence = "ambiguous";
    result.explanation = "It is unclear whether this is preparation or a real deadline. Keep its original time for now.";
  } else if ((prep && hardInterview.test(title) && !/not a mock/i.test(combined)) ||
      (prep && realAssessment && /Real assessment|hiring assessment/i.test(combined))) {
    result.purpose = "ambiguous-assessment";
    result.confidence = "ambiguous";
    result.explanation = "The description mentions both practice and a real appointment. Confirm its purpose before moving it.";
  } else if (realInterview) {
    result.purpose = "interview";
    result.confidence = "clear";
    result.explanation = "This is a real interview. Keep its original time rather than shifting it with study.";
  } else if (realAssessment) {
    result.purpose = "hard-assessment";
    result.confidence = "clear";
    result.explanation = "This is a real assessment or hard deadline. Keep its original time rather than shifting it with study.";
    result.learningWorkload = /coding assessment|online assessment/i.test(combined) &&
      !/deadline reminder/i.test(combined);
  } else if ((medical.test(title) && !studyInTitle) || medical.test(description) && !study) {
    result.purpose = "medical";
    result.confidence = "clear";
    result.explanation = "Keep the medical appointment at its original time, leave a full hour free beforehand, and respect the study gap afterward.";
  } else if (outing.test(`${title} ${rest.activeDescription}`) && !studyInTitle) {
    result.purpose = "outing";
    result.confidence = "clear";
    result.explanation = result.closedDates.includes(date)
      ? "This is an outing or rest day with no study. Keep the event and other daily activities unchanged."
      : "Keep the outing at its original time. Without evidence of a full rest day, do not close the entire study day.";
  } else if (result.closedDates.length && !study) {
    result.purpose = "rest";
    result.confidence = "clear";
    result.explanation = "The event explicitly specifies a rest day, so do not schedule study.";
  } else if (social.test(title) && !studyInTitle) {
    result.purpose = /breakfast|lunch|dinner/i.test(title) ? "meal" : "life";
    result.confidence = "clear";
    result.explanation = "Keep this daily activity at its original time. It does not count as study or automatically close the whole day.";
  } else if (study) {
    result.purpose = /Mock interview|mock/i.test(combined) ? "mock"
      : /Practice assessment|Assessment practice|practice\s*(assessment|test)|assessment\s*practice/i.test(combined) ? "assessment-practice"
        : /interview\s*(prep|practice)/i.test(combined) ? "interview-prep" : "learning";
    result.confidence = "clear";
    result.planId = "job-prepare";
    result.explanation = "Group study, practice, and assignments by their original study day. Keep completion records and schedule later work in its original order.";
  } else if (/^(?:assessment|test)(?:\s|$)/i.test(title)) {
    result.purpose = "ambiguous-assessment";
    result.confidence = "ambiguous";
    result.explanation = "It is unclear whether this assessment is practice or formal. Keep its original time for now.";
  } else if (social.test(combined)) {
    result.purpose = /breakfast|lunch|dinner/i.test(title) ? "meal" : "life";
    result.confidence = "clear";
    result.explanation = "Keep this daily activity at its original time. It does not count as study or automatically close the whole day.";
  } else if (task.externalReadOnly) {
    result.purpose = "external";
    result.explanation = "Keep the external arrangement at its original time.";
  }
  if (decision?.purpose) {
    const incoming = changedPurposeEvidence(decision, purposeEvidence(task, date, options.timeZone));
    if (incoming && semanticEvidenceFingerprint(task, date, options) !== decision.evidenceFingerprint) {
      result.purpose = "ambiguous-confirmation";
      result.confidence = "ambiguous";
      result.confirmationConflict = { previousPurpose: decision.purpose, incomingPurpose: incoming.purpose };
      result.explanation = "New evidence conflicts with the previously confirmed purpose. Keep the original time and confirm its purpose again.";
    } else if (!personalDescription || !rest.ambiguousDates.length) {
      result.purpose = decision.purpose;
      result.confidence = "clear";
      result.source = "user-confirmed";
      result.planId = decision.planId;
      result.keepReadonly ||= decision.keepReadonly;
      result.explanation = decision.label || "Use the purpose you already confirmed.";
      result.evidence = [evidence(task, "user", decision.label || decision.purpose)];
    }
  }
  if (result.confidence !== "unknown") {
    result.evidence = [evidence(task, "title", title)];
    if (description) result.evidence.push(evidence(task, "description", description));
    if (learningCalendar && studyPurposes.has(result.purpose))
      result.evidence.push(evidence(task, "calendarName", calendarContext));
    if (result.purpose === "medical") result.evidence.push({ source: "user-confirmed-personal-rule", rule: "medical-before-60-after-no-extra-hour" });
  }
  return result;
}

const studyPurposes = new Set(["learning", "mock", "interview-prep", "assessment-practice"]);
const fixedPurposes = new Set(["interview", "hard-assessment", "deadline", "medical", "outing", "rest", "life", "meal"]);

function applyFacts(task, date, semantic, branch) {
  const wasReadonly = Boolean(task.externalReadOnly);
  task.semantic = semantic;
  task.purpose = semantic.purpose;
  task.explanation = semantic.explanation;
  // Clear facts for other dates already protect the plan while one local date
  // is still awaiting a decision; never wait for every ambiguity to be resolved.
  applyClosedDates(task, semantic, branch);
  if (semantic.confidence === "ambiguous") {
    // Previously adopted learning can become ambiguous after a remote description
    // changes. Old learning tags/management permission are history, not consent
    // to silently move this now-unconfirmed event or its package.
    if (!task.done) {
      task.semanticPendingLock ||= { locked: Boolean(task.locked),
        ...(task.semanticConflict ? { previousConflict: clone(task.semanticConflict) } : {}) };
      task.locked = true;
      task.semanticConflict = { source: "calendar-purpose-ambiguity", kind: "unconfirmed-purpose",
        ids: [task.id], message: `Confirm the purpose of “${task.title}” before adjusting related later study. The original arrangement stays unchanged.` };
    }
    return;
  }
  if (semantic.confidence === "unknown") return;
  if (task.semanticPendingLock) {
    task.locked = task.semanticPendingLock.locked || Boolean(task.timeLocked || task.lockSource === "user" || task.calendarClassification?.locked);
    if (task.semanticConflict?.source === "calendar-purpose-ambiguity") {
      if (task.semanticPendingLock.previousConflict) task.semanticConflict = clone(task.semanticPendingLock.previousConflict);
      else delete task.semanticConflict;
    }
    delete task.semanticPendingLock;
  }
  const previousClassification = task.calendarClassification;
  const explicitPlan = task.planId && task.planId !== "job-prepare" &&
    (task.learningPlanUserDefined || task.planSource === "user" || semantic.source === "user-confirmed" && semantic.planId ||
      previousClassification?.source === "user-confirmed-classification" &&
      !/^(?:sql|interface(?:\.ai)?|study-default|my-study-plan)$/i.test(task.planId));
  if (studyPurposes.has(semantic.purpose)) {
    task.tags = [...new Set([...(task.tags || []), "study"])];
    task.counted = true;
    if (task.learning === false) delete task.learning;
    task.learningWorkload = true;
    const nextPlanId = explicitPlan ? semantic.source === "user-confirmed" && semantic.planId || task.planId
      : semantic.planId || "job-prepare";
    if (task.planId && task.planId !== nextPlanId)
      task.semanticPlanHistory = [...new Set([...(task.semanticPlanHistory || []), task.planId])];
    task.planId = nextPlanId;
    task.packageOriginDate ||= date;
    task.type = "task";
    task.calendarClassification = { kind: "learning", planId: task.planId, purpose: semantic.purpose,
      ...(typeof previousClassification?.manage === "boolean" ? { manage: previousClassification.manage } : {}),
      ...(previousClassification?.locked ? { locked: true } : {}),
      source: semantic.source === "user-confirmed" ? "user-confirmed-purpose" : "built-in-personal-rule", evidence: clone(semantic.evidence) };
    if (task.protectionSource === "semantic-medical" && !previousClassification?.bufferExplicit) {
      task.bufferBefore = 0;
      task.bufferAfter = 0;
      delete task.protectionSource;
    }
    if (!task.calendarLink?.managed || semantic.keepReadonly) {
      task.externalReadOnly = true;
      task.locked = true;
      task.readonlyLock = true;
    } else {
      task.externalReadOnly = false;
      if (wasReadonly || task.readonlyLock || task.semanticLock || previousClassification?.locked)
        task.locked = Boolean(task.timeLocked || task.lockSource === "user" || previousClassification?.locked);
      delete task.readonlyLock;
    }
    delete task.semanticLock;
  } else if (fixedPurposes.has(semantic.purpose)) {
    // A changed purpose disables learning participation, not its stable history.
    // Restoring the purpose later reuses the original package and all evidence.
    task.tags = (task.tags || []).filter((tag) => tag !== "study");
    if (task.learning === true) task.learning = false;
    task.type = "activity";
    task.locked = true;
    task.semanticLock = true;
    task.counted = Boolean(semantic.learningWorkload);
    task.learningWorkload = Boolean(semantic.learningWorkload);
    task.calendarClassification = { kind: "fixed", purpose: semantic.purpose,
      ...(typeof previousClassification?.manage === "boolean" ? { manage: previousClassification.manage } : {}),
      ...(previousClassification?.locked ? { locked: true } : {}),
      source: semantic.source === "user-confirmed" ? "user-confirmed-purpose" : "built-in-personal-rule", evidence: clone(semantic.evidence),
      ...(previousClassification?.bufferExplicit ? { bufferExplicit: true } : {}) };
    if (semantic.purpose === "medical") {
      if (!previousClassification?.bufferExplicit && task.protectionSource !== "user") {
        task.bufferBefore = 60;
        task.bufferAfter = 0;
        task.protectionSource = "semantic-medical";
      }
    } else if (previousClassification?.kind !== "fixed" ||
      !previousClassification.bufferExplicit && task.protectionSource !== "user") {
      task.bufferBefore = 0;
      task.bufferAfter = 0;
      if (task.protectionSource === "semantic-medical") delete task.protectionSource;
    }
  }
  if (semantic.source === "user-confirmed" && semantic.purpose === "external") {
    task.tags = (task.tags || []).filter((tag) => tag !== "study");
    if (task.learning === true) task.learning = false;
    task.counted = false;
    task.learningWorkload = false;
    task.calendarClassification = { kind: "task", purpose: "external", source: "user-confirmed-purpose", evidence: clone(semantic.evidence),
      ...(typeof previousClassification?.manage === "boolean" ? { manage: previousClassification.manage } : {}),
      ...(previousClassification?.locked ? { locked: true } : {}) };
  }
  if (semantic.keepReadonly) {
    task.externalReadOnly = true;
    task.locked = true;
  }
}

function applyClosedDates(task, semantic, branch) {
  for (const closedDate of semantic.closedDates || []) {
    branch.settings ||= {};
    branch.settings.learningDates ||= {};
    const existing = branch.settings.learningDates[closedDate] || {};
    // A later explicit user correction is authoritative, not a repeated old description.
    const explicitlyConfirmed = semantic.confirmedClosedDates?.includes(closedDate);
    if (existing.closed === false && existing.source !== "calendar-description" && !explicitlyConfirmed) continue;
    const sources = new Set(existing.semanticEventIds || []);
    sources.add(identity(task));
    const baseRule = existing.semanticBaseRule || (!existing.semanticEventIds ? clone(existing) : null);
    branch.settings.learningDates[closedDate] = { ...existing, closed: true,
      source: explicitlyConfirmed ? "user-confirmed" : "calendar-description",
      evidence: clone(semantic.evidence), semanticEventIds: [...sources],
      ...(baseRule && Object.keys(baseRule).length ? { semanticBaseRule: baseRule } : {}) };
  }
}

function unifyJobPackages(branch) {
  branch.calendar ||= {};
  branch.calendar.semanticPackages ||= {};
  const groups = new Map();
  for (const [date, tasks] of Object.entries(branch.days || {})) {
    for (const task of tasks) {
      if (!learningTask(task) || task.planId !== "job-prepare") continue;
      const origin = task.packageOriginDate || date;
      const key = `job-prepare/${origin}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ task, date });
    }
  }
  for (const [key, entries] of groups) {
    const saved = branch.calendar.semanticPackages[key];
    entries.sort((a, b) => a.date.localeCompare(b.date) || a.task.start - b.task.start || a.task.id.localeCompare(b.task.id));
    const firstWithPackage = entries.find((entry) => entry.task.packageId);
    const canonical = saved?.packageId || firstWithPackage?.task.packageId;
    const order = saved?.packageOrder ?? firstWithPackage?.task.packageOrder;
    const aliases = new Set(saved?.aliases || []);
    const combiningOldPackages = new Set(entries.map(({ task }) => task.packageId).filter(Boolean)).size > 1;
    const memberOrders = { ...(saved?.memberOrders || {}) };
    for (const { task } of entries) {
      const originalPackageId = task.packageId;
      if (task.packageId && canonical && task.packageId !== canonical) {
        aliases.add(task.packageId);
        task.packageAliases = [...new Set([...(task.packageAliases || []), task.packageId])];
      }
      if (canonical) task.packageId = canonical;
      if (order != null) task.packageOrder = order;
      const uid = task.uid || task.id;
      if (combiningOldPackages || saved?.mergedCoursePackages) {
        if (memberOrders[uid] == null) {
          const used = new Set(Object.values(memberOrders));
          let nextOrder = 0;
          while (used.has(nextOrder)) nextOrder++;
          memberOrders[uid] = nextOrder;
        }
        if (task.packageTaskOrder != null && task.packageTaskOrder !== memberOrders[uid])
          task.packageOrderHistory = [...(task.packageOrderHistory || []), { packageId: originalPackageId, taskOrder: task.packageTaskOrder }];
        task.packageTaskOrder = memberOrders[uid];
      }
    }
    branch.calendar.semanticPackages[key] = { ...(saved || {}), ...(canonical ? { packageId: canonical } : {}),
      ...(order != null ? { packageOrder: order } : {}), aliases: [...aliases],
      ...(combiningOldPackages || saved?.mergedCoursePackages ? { mergedCoursePackages: true, memberOrders } : {}),
      source: "built-in-personal-rule" };
  }
  branch.days = normalizeLearningDays(branch.days);
  for (const [key, entries] of groups) {
    const normalized = Object.values(branch.days).flat().find((task) => task.id === entries[0].task.id);
    branch.calendar.semanticPackages[key].packageId = normalized.packageId;
    branch.calendar.semanticPackages[key].packageOrder = normalized.packageOrder;
  }
}

function addKnownDependencies(branch) {
  const entries = Object.entries(branch.days || {}).flatMap(([date, tasks]) => tasks.map((task) => ({ date, task })));
  const map = new Map();
  for (const { task } of entries) {
    const derived = new Set((task.semanticDependencies || []).filter((dep) => dep.source === "user-confirmed-course-order")
      .map((dep) => dep.predecessorId));
    // Rebuild only our derived, unchanged edges when remote lesson facts change.
    // Explicit user dependencies and user-modified intervals remain authoritative.
    if (!task.done) {
      if (derived.size) task.dependencies = (task.dependencies || []).filter((dep) => !derived.has(dep.id) || dep.gap !== 0);
      task.semanticDependencies = [];
    }
    map.set(task.id, task);
    if (task.uid) map.set(task.uid, task);
  }
  const warnings = [];
  for (const { task } of entries) if (task.semanticConflict?.source === "user-confirmed-course-order") delete task.semanticConflict;
  const reaches = (task, target) => {
    const pending = [task], visited = new Set();
    while (pending.length && visited.size <= entries.length) {
      const current = pending.pop();
      if (current === target) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const dep of current.dependencies || []) if (map.has(dep.id)) pending.push(map.get(dep.id));
    }
    return false;
  };
  for (const course of ["sql", "interface.ai"]) {
    const order = course === "sql" ? SQL_ORDER : ["module-1", "module-2", "module-3", "module-4", "assignment-a"];
    const recognized = entries.filter(({ task }) => learningTask(task) && task.planId === "job-prepare" &&
      task.semantic?.course === course && order.includes(task.semantic.lessonKey));
    const stage = { teaching: 0, practice: 1, homework: 2, block: 3 };
    recognized.sort((a, b) => order.indexOf(a.task.semantic.lessonKey) - order.indexOf(b.task.semantic.lessonKey) ||
      (stage[a.task.semantic.stage] ?? 3) - (stage[b.task.semantic.stage] ?? 3) ||
      (a.task.packageOrder || 0) - (b.task.packageOrder || 0) || a.date.localeCompare(b.date) || a.task.start - b.task.start);
    let previous = null;
    for (const { task } of recognized) {
      if (previous && previous !== task && !task.done && !task.dependencies?.some((dep) => dep.id === previous.id || dep.id === previous.uid)) {
        if (previous.deferred || reaches(previous, task)) {
          const message = previous.deferred ? "A verified prerequisite study item is deferred. Restore it or confirm how to handle it first."
            : "The verified study order conflicts with the current dependencies. Keep the dependencies and confirm the order first.";
          task.semanticConflict = { source: "user-confirmed-course-order", kind: previous.deferred ? "deferred-prerequisite" : "contradictory-prerequisite", ids: [previous.id, task.id], message };
          warnings.push({ id: task.id, ...task.semanticConflict });
        }
        else {
          task.dependencies ||= [];
          task.dependencies.push({ id: previous.id, gap: 0 });
          task.semanticDependencies ||= [];
          task.semanticDependencies.push({ predecessorId: previous.id, course, source: "user-confirmed-course-order",
            evidence: `${previous.semantic.lessonKey} → ${task.semantic.lessonKey}` });
        }
      }
      previous = task;
    }
  }
  branch.calendar.semanticWarnings = warnings;
}

export function ambiguousDecisions(branch, { date, limit = 3 } = {}) {
  const questions = [];
  const entries = Object.entries(branch.days || {}).sort(([a], [b]) => a.localeCompare(b));
  for (const [scheduledDate, tasks] of entries) {
    if (date && scheduledDate !== date) continue;
    for (const task of tasks) {
      if (task.done || task.deferred || task.semantic?.confidence !== "ambiguous") continue;
      const interview = /interview/i.test(task.title);
      const rest = task.semantic.purpose === "ambiguous-rest";
      const deadline = task.semantic.purpose === "ambiguous-deadline";
      const conflict = task.semantic.confirmationConflict;
      const labels = { learning: "Study", mock: "Mock interview practice", "interview-prep": "Interview preparation", "assessment-practice": "Assessment practice",
        interview: "Real interview", "hard-assessment": "Formal assessment", deadline: "Real deadline", medical: "Medical appointment", life: "Ordinary daily activity", rest: "Full rest day", outing: "Outing", external: "Keep the original time" };
      const phrases = { learning: "study", mock: "mock interview practice", "interview-prep": "interview preparation", "assessment-practice": "assessment practice",
        interview: "a real interview", "hard-assessment": "a formal assessment", deadline: "a real deadline", medical: "a medical appointment", life: "an ordinary daily activity", rest: "a full rest day", outing: "an outing", external: "keeping the original time" };
      const phrase = (purpose) => phrases[purpose] || purpose;
      const decisionDate = rest ? task.semantic.closedDateCandidates?.[0] || scheduledDate : null;
      questions.push({ id: identity(task), taskId: task.id, date: scheduledDate, title: task.title,
        ...(decisionDate ? { decisionDate, scope: "learning-date" } : {}),
        prompt: rest ? `Is ${decisionDate} a full day without study, or should only the event time be kept?`
          : conflict ? `This item now describes ${phrase(conflict.incomingPurpose)}. Keep treating it as ${phrase(conflict.previousPurpose)}, as you confirmed?`
          : deadline ? "Is this adjustable preparation or a reminder for a real submission deadline?" : interview ? "Is this mock practice or a real interview with a fixed time?" : "Is this practice or a real assessment with fixed requirements?",
        choices: rest ? [{ id: "rest", label: "Full day out or rest", scope: "learning-date", decisionDate, closedDate: decisionDate, explanation: `No study on ${decisionDate}. Other dates keep their own basis.` },
          { id: "life", label: "Keep only the event time", scope: "learning-date", decisionDate, explanation: `Confirm only that ${decisionDate} is not a full rest day. Other dates do not change.` },
          { id: "keep-readonly", label: "Leave it as it is for now", scope: "learning-date", decisionDate, explanation: "Keep only the event’s original time; this does not mark the entire date as a rest day." }]
          : conflict ? [{ id: conflict.previousPurpose, label: `Keep it as ${phrase(conflict.previousPurpose)}`, explanation: "Keep the previous purpose after reviewing the new description. This evidence will be remembered." },
            { id: conflict.incomingPurpose, label: labels[conflict.incomingPurpose] || conflict.incomingPurpose, explanation: "Use the new description while preserving the original event and completion record." },
            { id: "keep-readonly", label: "Keep the original time", explanation: "Keep this item out of automatic adjustments for now." }]
          : [{ id: deadline ? "learning" : interview ? "mock" : "assessment-practice", label: deadline ? "Preparation task" : interview ? "Mock interview" : "Practice assessment", explanation: "Count this toward the day’s study and group it by its original study day." },
          { id: deadline ? "deadline" : interview ? "interview" : "hard-assessment", label: deadline ? "Real deadline" : interview ? "Real interview" : "Real assessment", explanation: "Keep the original time rather than shifting it with study." },
          { id: "keep-readonly", label: "Keep the original time", explanation: "Keep this out of study adjustments for now." }] });
      if (questions.length >= Math.min(3, Math.max(1, limit))) return questions;
    }
  }
  return questions;
}

export function interpretationSummary(branch, date) {
  const entries = Object.entries(branch.days || {}).flatMap(([scheduledDate, tasks]) =>
    tasks.filter((task) => !task.deferred && (!date || scheduledDate === date)).map((task) => ({ date: scheduledDate, task })));
  const learning = entries.filter(({ task }) => studyPurposes.has(task.purpose)).length;
  const fixed = entries.filter(({ task }) => fixedPurposes.has(task.purpose)).length;
  const rest = date && branch.settings?.learningDates?.[date]?.closed === true;
  return { text: rest ? "Do not schedule study today. Preserve the original order of later study."
    : learning ? "Teaching, practice, and assignments are grouped by their original study day. Fixed events keep their original times." : "Keep the existing arrangements at their original times.",
    learningCount: learning, fixedCount: fixed, restDay: Boolean(rest),
    ambiguousDecisions: ambiguousDecisions(branch, { date }), warnings: branch.calendar?.semanticWarnings || [] };
}

/** No moves, no completion inference, no external writes; interpretation is not authorization. */
export function interpretCalendar(input, options = {}) {
  const data = clone(input);
  data.calendar ||= {};
  const decisions = data.calendar.semanticDecisions || {}, corrections = data.calendar.semanticCorrections || {};
  // Rebuild every event-derived closure, including user-confirmed event purpose.
  // A separately configured day rule is retained beneath the derived layer.
  for (const [date, rule] of Object.entries(data.settings?.learningDates || {})) {
    if (!Array.isArray(rule.semanticEventIds)) continue;
    let baseRule = rule.semanticBaseRule && clone(rule.semanticBaseRule);
    if (!baseRule) {
      baseRule = clone(rule);
      for (const field of ["closed", "evidence", "semanticEventIds", "semanticBaseRule", "source"]) delete baseRule[field];
      // Older data did not store the underlying rule. Preserve independently
      // configured fields rather than treating them as an event-only closure.
      if (rule.source === "user-confirmed" && Object.keys(baseRule).length) {
        baseRule.closed = rule.closed;
        baseRule.source = rule.source;
      }
    }
    if (Object.keys(baseRule).length) data.settings.learningDates[date] = baseRule;
    else delete data.settings.learningDates[date];
  }
  for (const [date, tasks] of Object.entries(data.days || {})) {
    for (const task of tasks) {
      if (task.calendarLink?.source !== "google" || task.calendarLink.remoteDeleted || task.deferred) continue;
      const semantic = interpretEvent(task, date, { decisions, corrections, timeZone: options.timeZone || data.settings?.timeZone });
      applyFacts(task, date, semantic, data);
    }
  }
  unifyJobPackages(data);
  addKnownDependencies(data);
  data.calendar.semanticVersion = VERSION;
  const summary = interpretationSummary(data, options.date || options.focusDate);
  return { data, summary, ambiguousDecisions: summary.ambiguousDecisions };
}

/** The current workspace asks one small purpose question; future identical titles remember it. */
export function applySemanticDecision(input, decisionId, choice, options = {}) {
  const data = clone(input);
  const entry = Object.entries(data.days || {}).flatMap(([date, tasks]) => tasks.map((task) => ({ date, task })))
    .find(({ task }) => identity(task) === decisionId || task.id === decisionId);
  if (!entry) throw new Error("This arrangement changed. Select it again.");
  const { task, date } = entry;
  const choiceId = typeof choice === "string" ? choice : choice.id || choice.purpose;
  if (![...studyPurposes, ...fixedPurposes, "keep-readonly", "external"].includes(choiceId))
    throw new Error("Select one of the purposes offered by the current question.");
  const closedDate = options.closedDate || typeof choice === "object" && choice.closedDate;
  if (closedDate && !validDate(closedDate)) throw new Error("The full rest-day date is invalid.");
  const scope = options.scope || typeof choice === "object" && choice.scope || "purpose";
  const decisionDate = options.decisionDate || typeof choice === "object" && choice.decisionDate;
  if (scope === "learning-date" && !validDate(decisionDate)) throw new Error("Select the specific date for this confirmation.");
  const timeZone = options.timeZone || data.settings?.timeZone;
  const rawRest = restIntent(plain(task.calendarSource?.description));
  const previous = data.calendar?.semanticDecisions?.[identity(task)] || {};
  const dateDecisions = clone(previous.dateDecisions || {});
  const originDate = eventRuleDate(task, date, timeZone);
  const localDate = scope === "learning-date" ? decisionDate : closedDate || task.semantic?.closedDateCandidates?.[0] ||
    (scope === "purpose" && dateDecisions[originDate]?.scope === "purpose-correction" ? originDate : null);
  if (validDate(localDate)) dateDecisions[localDate] = {
    scope: scope === "learning-date" ? "learning-date" : "purpose-correction", closed: choiceId === "rest" || choiceId === "outing" ? true : choiceId === "keep-readonly" ? null : false,
    ...(choiceId === "keep-readonly" ? { keepReadonly: true } : {}),
    evidenceFingerprint: dateEvidenceFingerprint(rawRest, localDate) };
  const decision = { purpose: choiceId === "keep-readonly" ? "external" : choiceId,
    label: typeof choice === "object" && choice.label || (choiceId === "keep-readonly" ? "Keep the original time as you selected." : "Use the event purpose you confirmed."),
    ...(typeof choice === "object" && choice.planId ? { planId: choice.planId } : {}),
    ...(choiceId === "keep-readonly" ? { keepReadonly: true } : {}),
    scope: "purpose", evidenceFingerprint: semanticEvidenceFingerprint(task, date, { timeZone }),
    ...(Object.keys(dateDecisions).length ? { dateDecisions } : {}), overrideDateReadonly: true, source: "user-confirmed" };
  data.calendar ||= {};
  data.calendar.semanticDecisions ||= {};
  data.calendar.semanticDecisions[identity(task)] = scope === "learning-date"
    ? { ...previous, scope: previous.purpose ? "purpose" : "learning-dates", dateDecisions }
    : decision;
  if (scope !== "learning-date" && !closedDate && options.remember !== false) {
    data.calendar.semanticCorrections ||= {};
    const template = clone(decision);
    delete template.dateDecisions;
    data.calendar.semanticCorrections[titleKey(task)] = template;
  }
  return interpretCalendar(data, options);
}

/** Two short correction steps, not a ten-category rule table. Group selection
 * belongs to the UI; these are the actual persistable semantic decisions.
 */
export function semanticCorrectionChoices(task, date, group = "life", options = {}) {
  const restDate = eventRuleDate(task, date, options.timeZone);
  return group === "learning"
    ? [{ id: "learning", label: "Job Prepare study", explanation: "Group by the original study day and include it in later study adjustments." },
      { id: "mock", label: "Mock interview practice", explanation: "Count this as study, not as a real interview." },
      { id: "assessment-practice", label: "Assessment practice", explanation: "Count this as study, not as a formal assessment." }]
    : [{ id: "medical", label: "Medical appointment", explanation: "Keep the original time and protect one hour before the appointment." },
      { id: "rest", label: "Full day out or rest", closedDate: restDate, explanation: `The event time stays the same, and there is no study on ${restDate}.` },
      { id: "life", label: "Ordinary fixed daily activity", explanation: "Keep the event time; other periods remain available for study." }];
}
