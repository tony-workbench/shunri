const formatters = new Map();
const instantCache = new Map();
const MINUTE = 60000;

function formatter(zone) {
  if (!formatters.has(zone))
    formatters.set(
      zone,
      new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }),
    );
  return formatters.get(zone);
}

export function validDate(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return false;
  const value = new Date(`${date}T12:00:00Z`);
  return (
    Number.isFinite(value.getTime()) &&
    value.toISOString().slice(0, 10) === date
  );
}

export function addDays(date, days) {
  if (!validDate(date) || !Number.isInteger(days))
    throw new Error("The date or number of days is invalid.");
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function dateParts(instant = Date.now(), zone = "America/Los_Angeles") {
  const parts = Object.fromEntries(
    formatter(zone)
      .formatToParts(new Date(instant))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minute: +parts.hour * 60 + +parts.minute,
    year: +parts.year,
    month: +parts.month,
    day: +parts.day,
    hour: +parts.hour,
    second: +parts.second,
  };
}

// Parse provider endpoints identically in the browser and service; never use host TZ.
export function calendarEndpointInstant(endpoint, zone) {
  if (endpoint?.date) {
    if (!validDate(endpoint.date)) throw new Error("The all-day event’s date is invalid.");
    return wallInstant(endpoint.date, 0, zone);
  }
  if (typeof endpoint?.dateTime !== "string")
    throw new Error("The event is missing a start or end time.");
  const value = endpoint.dateTime;
  if (!validDate(value.slice(0, 10))) throw new Error("The event’s date is invalid.");
  if (/([zZ]|[+-]\d\d:?\d\d)$/.test(value)) {
    const instant = Date.parse(value);
    if (!Number.isFinite(instant)) throw new Error("The event time is not recognized.");
    return instant;
  }
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d\d):(\d\d)(?::(\d\d)(?:\.(\d+))?)?$/.exec(value);
  if (!match || +match[2] > 23 || +match[3] > 59 || +(match[4] || 0) > 59)
    throw new Error("The event time is not recognized.");
  if (!endpoint.timeZone && !zone) throw new Error("The event has no explicit time zone.");
  return (
    wallInstant(
      match[1],
      +match[2] * 60 + +match[3],
      endpoint.timeZone || zone,
    ) +
    +(match[4] || 0) * 1000 +
    Number(`0.${match[5] || "0"}`) * 1000
  );
}

export function today(zone = "America/Los_Angeles") {
  return dateParts(Date.now(), zone).date;
}

// Match every plausible offset, not a fixed UTC offset. Both folds are rejected.
export function wallInstant(date, minutes, zone = "America/Los_Angeles") {
  if (!validDate(date) || !Number.isInteger(minutes))
    throw new Error("The date or local time is invalid.");
  date = addDays(date, Math.floor(minutes / 1440));
  minutes = ((minutes % 1440) + 1440) % 1440;
  const key = `${zone}/${date}/${minutes}`;
  if (instantCache.has(key)) {
    const cached = instantCache.get(key);
    if (typeof cached === "string") throw new Error(cached);
    return cached;
  }
  const [year, month, day] = date.split("-").map(Number);
  const naive = Date.UTC(
    year,
    month - 1,
    day,
    Math.floor(minutes / 60),
    minutes % 60,
  );
  const offsets = new Set();
  for (const hours of [-48, -24, -12, 0, 12, 24, 48]) {
    const sample = naive + hours * 3600000;
    const p = dateParts(sample, zone);
    const local = Date.UTC(
      p.year,
      p.month - 1,
      p.day,
      Math.floor(p.minute / 60),
      p.minute % 60,
      p.second,
    );
    offsets.add(local - sample);
  }
  const matches = [...offsets]
    .map((offset) => naive - offset)
    .filter((value) => {
      const p = dateParts(value, zone);
      return p.date === date && p.minute === minutes && p.second === 0;
    });
  if (matches.length !== 1) {
    const message = `${date} ${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")} is ${matches.length ? "ambiguous" : "unavailable"} in ${zone} because of a daylight-saving change. Choose another time.`;
    instantCache.set(key, message);
    throw new Error(message);
  }
  if (instantCache.size > 12000) instantCache.clear();
  instantCache.set(key, matches[0]);
  return matches[0];
}

export function weekday(date) {
  if (!validDate(date)) throw new Error("The date is invalid.");
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

export { MINUTE };

// Bounded English time templates. Pure, offline, and independent of scheduling.
const clockText = minute => `${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`;
const need = message => ({status:'input',message});
// English templates share the same wall-clock/DST validation and result contract.
// Full-string matching prevents unsupported prose from silently changing a target.
function parseEnglishTimeExpression(text, { now, task, timeZone, answer }) {
  const input = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const example = 'Use an exact time, such as “tomorrow at 2pm” or “2026-10-15 14:30”.';
  if (!now || !validDate(now.date) || !Number.isInteger(now.minute) || now.minute < 0 || now.minute >= 1440)
    return need('The current time is unavailable. Choose an exact date and time.');
  const basis = { clock: { ...now }, task: task ? { date: task.date, start: task.start } : null, timeZone };
  let answered = false;
  const choose = (kind, question, choices) => {
    const id = `english-${kind}:${input}`;
    if (answer?.question === id && !answered) {
      const item = choices.find(choice => choice.id === answer.choice);
      if (item) { answered = true; return item.value; }
    }
    if (answer) throw need('The time is still ambiguous. Include the full date and AM/PM or a 24-hour time.');
    throw { status: 'clarify', id, question, choices: choices.map(({ id, label }) => ({ id, label })) };
  };
  const finish = (date, minute, explanation, startFromNow = false) => {
    if (!validDate(date) || !Number.isInteger(minute) || minute < 0 || minute >= 1440)
      return need('This date or time is invalid. Check it and try again.');
    try { wallInstant(date, minute, timeZone); }
    catch { return need(`This local date/time is unavailable or ambiguous in ${timeZone}. Choose another exact time.`); }
    return { status: 'target', date, minute, startFromNow, explanation, basis };
  };
  try {
    if (input === 'now')
      return finish(now.date, now.minute, `Find the next feasible arrangement from the app time ${now.date} ${clockText(now.minute)}.`, true);
    const relative = input.match(/^(?:in\s*(.+)|(.+)\s+from now|(.+)\s+(?:after the saved time|later than scheduled))$/);
    if (relative) {
      const duration = relative[1] || relative[2] || relative[3];
      const minutes = duration.match(/^(\d{1,4})\s*(?:minutes?|mins?)$/);
      const hours = duration.match(/^(\d{1,4})\s*(?:hours?|hrs?)$/);
      const combined = duration.match(/^(\d{1,4})\s*hours?\s+(?:and\s+)?(\d{1,4})\s*minutes?$/);
      const delta = duration === 'half an hour' ? 30 : minutes ? Number(minutes[1]) : hours ? Number(hours[1]) * 60 : combined ? Number(combined[1]) * 60 + Number(combined[2]) : NaN;
      if (!Number.isInteger(delta) || delta < 0 || delta > 10080)
        return need('Use whole minutes or hours, up to seven days, for example “in 30 minutes”.');
      const original = Boolean(relative[3]);
      const base = original ? { date: task?.date, minute: task?.start } : now;
      if (!validDate(base?.date) || !Number.isInteger(base.minute) || base.minute < 0 || base.minute >= 1440)
        return need('The selected task has no usable saved date and time.');
      const instant = original ? wallInstant(base.date, base.minute, timeZone) : Number.isFinite(now.instant) ? now.instant - now.instant % MINUTE : wallInstant(base.date, base.minute, timeZone);
      const target = dateParts(instant + delta * MINUTE, timeZone);
      return finish(target.date, target.minute, `${delta} minutes after ${original ? 'the task’s saved time' : 'the app time'} ${base.date} ${clockText(base.minute)}.`);
    }
    let date = now.date, clock = input, explicitDate = false;
    const iso = input.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+|t)(.+)$/);
    const relativeDate = input.match(/^(day after tomorrow|the day after tomorrow|dayaftertomorrow|tomorrow|today|next day|nextday)\s*(?:at\s*)?(.*)$/);
    if (iso) {
      date = `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
      clock = iso[4]; explicitDate = true;
    } else if (relativeDate) {
      const word = relativeDate[1];
      date = addDays(now.date, word === 'today' ? 0 : /after/.test(word) ? 2 : 1);
      clock = relativeDate[2]; explicitDate = true;
    }
    clock = clock.replace(/^at\s*/, '').trim();
    if (!validDate(date)) return need('This date does not exist. Check the month and day.');
    if (!clock) return need(`Include a specific time. ${example}`);
    const meridiem = clock.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/);
    const exact = clock.match(/^(\d{1,2}):(\d{2})$/);
    const bare = clock.match(/^(\d{1,2})$/);
    let hour, minute;
    if (clock === 'noon' || clock === 'midnight') {
      hour = clock === 'noon' ? 12 : 0; minute = 0;
    } else if (meridiem) {
      hour = Number(meridiem[1]); minute = Number(meridiem[2] || 0);
      if (hour < 1 || hour > 12 || minute > 59) return need('For AM/PM, use hours 1–12 and minutes 00–59.');
      hour = hour % 12 + (meridiem[3] === 'p' ? 12 : 0);
    } else if (exact) {
      hour = Number(exact[1]); minute = Number(exact[2]);
      if (hour > 23 || minute > 59) return need('Use a valid 24-hour time from 00:00 to 23:59.');
    } else if (bare && Number(bare[1]) >= 1 && Number(bare[1]) <= 12) {
      const value = Number(bare[1]), am = value % 12, pm = am + 12;
      minute = 0;
      hour = choose('period', `Do you mean ${clockText(am * 60)} (AM) or ${clockText(pm * 60)} (PM)?`, [
        { id: 'am', label: `${clockText(am * 60)} (AM)`, value: am },
        { id: 'pm', label: `${clockText(pm * 60)} (PM)`, value: pm },
      ]);
    } else return need(`This expression is not supported. ${example}`);
    minute += hour * 60;
    if (!explicitDate && minute < now.minute)
      date = choose('day', `Today’s ${clockText(minute)} has passed. Do you mean today or tomorrow?`, [
        { id: 'today', label: `Today ${now.date}`, value: now.date },
        { id: 'tomorrow', label: `Tomorrow ${addDays(now.date, 1)}`, value: addDays(now.date, 1) },
      ]);
    return finish(date, minute, explicitDate ? 'Use the date and time you entered.' : answered ? `Confirmed the date as ${date}.` : `No date was specified; use today, ${date}.`);
  } catch (error) {
    return error?.status ? error : need(`This time cannot be resolved safely. ${example}`);
  }
}

export function parseTimeExpression(raw, {now, task, timeZone='America/Los_Angeles', answer=null} = {}) {
  const text = String(raw || '').normalize('NFKC').trim().replace(/[,.!]+$/, '');
  if (!text) return need('For example: tomorrow at 2:30pm.');
  return parseEnglishTimeExpression(text, { now, task, timeZone, answer });
}
