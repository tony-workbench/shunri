import {
  createHash,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink, chmod } from "node:fs/promises";
import { resolve, join } from "node:path";
import { interpretEvent } from "./calendar-semantics.js";
import { dateParts, calendarEndpointInstant } from "./time.js";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];
const API = "https://www.googleapis.com/calendar/v3";
const SESSION_IDLE_TTL = 24 * 60 * 60 * 1000;
const SESSION_CAPACITY = 256;
const SESSION_PREVIEW_CAPACITY = 4;
const PREVIEW_PLAN_CAPACITY = 64;
const CATALOG_PURPOSE = "job-prepare-catalog";
class TokenSaveError extends Error {}
const CATALOG_LEARNING_PURPOSES = new Set([
  "learning",
  "mock",
  "interview-prep",
  "assessment-practice",
]);
// Missing server settings: name the exact setting and the action to take.
export function setupMessage(names) {
  const label = { GOOGLE_CLIENT_ID: "Google client ID", GOOGLE_CLIENT_SECRET: "Google client secret" };
  const known = names.filter((name) => label[name]);
  const help = ` Help for the server owner: the setting names are ${names.join(" and ")}.`;
  if (!known.length || known.length < names.length) return `Google Calendar is not set up: some server settings are missing. Add the missing settings to the server, restart Shunri, then connect again.${help}`;
  return `Google Calendar is not set up: the ${known.map((name) => label[name]).join(" and ")} ${known.length > 1 ? "are" : "is"} missing. Add ${known.length > 1 ? "them" : "it"} to the server settings, restart Shunri, then connect again.${help}`;
}

const digest = (value) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const safeEqual = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function calendarSignature(task) {
  return digest(
    JSON.stringify([
      task.title,
      task.date,
      task.start,
      task.duration,
      task.timeZone || "America/Los_Angeles",
    ]),
  );
}
export function managedEventId(profileId, uid) {
  return `sd${digest(`${profileId}\0${uid}`)}`;
}

export function googleEventSignature(event, calendarTimeZone) {
  // Keep this independent of the application's date formatting. Recurring
  // instances, all-day events and multi-day events retain their Google identity.
  const fields = [
    event.summary || "",
    event.start?.dateTime || event.start?.date || null,
    event.end?.dateTime || event.end?.date || null,
    event.start?.timeZone || null,
    event.status || "confirmed",
  ];
  // Keep existing explicit-offset signatures unchanged. Offsetless endpoints
  // also need their resolved instants: changing end.timeZone changes meaning.
  if ([event.start, event.end].some((endpoint) => endpoint?.dateTime &&
    !/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(endpoint.dateTime))) {
    const zone = event.start?.timeZone || calendarTimeZone;
    try {
      fields.push(calendarEndpointInstant(event.start, zone), calendarEndpointInstant(event.end, zone));
    } catch {
      // Unresolvable events remain readable; eligibility separately forbids
      // managing them, and the browser reports an error for that item only.
      fields.push("unresolved", event.end?.timeZone || null, calendarTimeZone || null);
    }
  }
  return digest(JSON.stringify(fields));
}

function sameEventPayload(existing, planned, calendarTimeZone) {
  const zone = existing?.start?.timeZone || calendarTimeZone;
  return Boolean(
    existing &&
    existing.summary === planned.summary &&
    calendarEndpointInstant(existing.start, zone) === calendarEndpointInstant(planned.start, planned.start.timeZone) &&
    calendarEndpointInstant(existing.end, zone) === calendarEndpointInstant(planned.end, planned.start.timeZone),
  );
}

// Resolve a local wall time without silently choosing either side of a DST fold.
export function calendarInstant(date, minute, zone) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute >= 1440
  )
    throw new Error("The date or start time is invalid.");
  const [year, month, day] = date.split("-").map(Number);
  const wall = Date.UTC(
    year,
    month - 1,
    day,
    Math.floor(minute / 60),
    minute % 60,
  );
  if (
    new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== date
  )
    throw new Error("The date is invalid.");
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const offsets = new Set();
  const wallAt = (ms) => {
    const p = Object.fromEntries(
      formatter.formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
    );
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  };
  for (let h = -36; h <= 36; h += 3) {
    const ms = wall + h * 3600000;
    offsets.add(wallAt(ms) - ms);
  }
  const candidates = [...offsets]
    .map((offset) => wall - offset)
    .filter((ms) => wallAt(ms) === wall);
  if (candidates.length !== 1)
    throw new Error(
      candidates.length
        ? "This local time repeats at the end of daylight saving. Choose another time."
        : "This local time is skipped at the start of daylight saving. Choose another time.",
    );
  return candidates[0];
}

export function createCalendarService({
  origin = "http://localhost:3000",
  fetchImpl = globalThis.fetch,
  env = process.env,
  dataDir = resolve(".local-data/calendar"),
  allowedWriteUids = null,
  sessionNow = Date.now,
} = {}) {
  const originUrl = new URL(origin);
  origin = originUrl.origin;
  const allowedHosts = new Set([originUrl.host]);
  if (!originUrl.port)
    allowedHosts.add(`${originUrl.hostname}:${originUrl.protocol === "https:" ? 443 : 80}`);
  if (
    allowedWriteUids !== null &&
    !(Array.isArray(allowedWriteUids) || allowedWriteUids instanceof Set)
  )
    throw new Error("The write-verification scope must be a task-UID array or Set.");
  const writeAllowlist =
    allowedWriteUids === null ? null : new Set(allowedWriteUids);
  if (
    writeAllowlist &&
    [...writeAllowlist].some((uid) => typeof uid !== "string" || !uid)
  )
    throw new Error("The write-verification scope contains an invalid task UID.");
  const redirectUri =
    env.GOOGLE_REDIRECT_URI || `${origin}/api/calendar/callback`;
  const missing = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"].filter(
    (name) => !env[name],
  );
  const configured = missing.length === 0;
  const writesEnabled = env.CALENDAR_WRITES_ENABLED === "true";
  const sessions = new Map(),
    plans = new Map(),
    unsavedTokens = new WeakMap(),
    tokenRequests = new WeakMap();
  let connection = null,
    loadError = false,
    key,
    busy = false,
    authState = "disconnected",
    persistence = Promise.resolve();
  const ready = (async () => {
    try {
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      await chmod(dataDir, 0o700);
      try {
        key = await readFile(join(dataDir, "key"));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
        key = randomBytes(32);
        await writeFile(join(dataDir, "key"), key, { mode: 0o600, flag: "wx" });
      }
      await chmod(join(dataDir, "key"), 0o600);
      try {
        const bytes = await readFile(join(dataDir, "connection.enc"));
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          bytes.subarray(0, 12),
        );
        decipher.setAuthTag(bytes.subarray(12, 28));
        connection = JSON.parse(
          Buffer.concat([
            decipher.update(bytes.subarray(28)),
            decipher.final(),
          ]).toString(),
        );
        authState =
          connection.accessToken || connection.refreshToken
            ? "connected"
            : "disconnected";
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    } catch {
      loadError = true;
      authState = "storage_error";
    }
  })();
  async function persistNow(snapshot = connection) {
    if (loadError || !key) throw new Error("Authorization storage is unavailable. The original data was retained. Check that the server’s data folder is writable, restart Shunri, then reconnect.");
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(snapshot)),
      cipher.final(),
    ]);
    const tmp = join(dataDir, `connection-${token()}.tmp`);
    try {
      await writeFile(tmp, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), {
        mode: 0o600,
      });
      await rename(tmp, join(dataDir, "connection.enc"));
    } catch (error) {
      // A failed write can leave a partial file, and a failed rename leaves a
      // complete one. Remove only this attempt's temporary file; retain the
      // original storage error even if cleanup is unavailable too.
      await unlink(tmp).catch(() => {});
      throw error;
    }
  }
  function persist(snapshot) {
    // Overlapping reads can refresh authorization while an adoption is saved.
    // Serialize snapshots/renames so an older save cannot erase newer mappings.
    const next = persistence.then(() => persistNow(snapshot));
    persistence = next.catch(() => {});
    return next;
  }
  function removeSession(id) {
    sessions.delete(id);
    for (const [planId, plan] of plans)
      if (plan.sessionId === id) plans.delete(planId);
  }
  function session(req, res) {
    const now = sessionNow();
    for (const [id, item] of sessions)
      if (now - item.lastSeen >= SESSION_IDLE_TTL) removeSession(id);
    let id = /(?:^|;\s*)shunri_session=([^;]+)/.exec(
      req.headers.cookie || "",
    )?.[1];
    const replaced = Boolean(id) && !sessions.has(id);
    if (!sessions.has(id)) {
      // TTL alone cannot bound a burst of clients that never reuse cookies.
      // Map order tracks recent use; expired/evicted identities are never reused.
      while (sessions.size >= SESSION_CAPACITY)
        removeSession(sessions.keys().next().value);
      id = token();
      sessions.set(id, { id, csrf: token(), lastSeen: now });
      res.setHeader(
        "Set-Cookie",
        `shunri_session=${id}; HttpOnly; SameSite=Lax; Path=/${origin.startsWith("https:") ? "; Secure" : ""}`,
      );
    }
    const item = sessions.get(id);
    item.lastSeen = now;
    sessions.delete(id);
    sessions.set(id, item);
    // Keep request-local renewal context separate from the shared record;
    // OAuth state mutations must still update the original stored session.
    return { record: item, replaced };
  }
  function json(res, code, value) {
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  }
  async function body(req) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 512000) throw new Error("The request is too large. Select fewer tasks and try again.");
      chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8") || "{}");
  }
  function assertCurrentConnection(expected) {
    if (connection !== expected)
      throw new Error("Authorization changed. Repeat the action.");
  }
  async function saveRefreshedTokens(authorization) {
    const revision = unsavedTokens.get(authorization);
    try {
      await persist();
    } catch (error) {
      throw new TokenSaveError(error.message, { cause: error });
    }
    assertCurrentConnection(authorization);
    // A later refresh may rotate credentials while this save is in flight.
    // Only acknowledge the revision this request attempted to save.
    if (unsavedTokens.get(authorization) === revision)
      unsavedTokens.delete(authorization);
  }
  async function accessToken() {
    const authorization = connection;
    if (!authorization) throw new Error("Google Calendar is not connected. Choose Connect Google Calendar, sign in to Google, then try again.");
    if (tokenRequests.has(authorization)) return tokenRequests.get(authorization);
    // Share refresh and persistence through completion. A duplicate refresh
    // could spend a rotated token and overwrite connected state with failure.
    const request = acquireAccessToken(authorization);
    tokenRequests.set(authorization, request);
    try {
      return await request;
    } finally {
      tokenRequests.delete(authorization);
    }
  }
  async function acquireAccessToken(authorization) {
    if (authorization.accessToken && authorization.expiresAt > Date.now() + 30000) {
      if (unsavedTokens.has(authorization)) {
        await saveRefreshedTokens(authorization);
        authState = "connected";
      }
      return authorization.accessToken;
    }
    if (!authorization.refreshToken) {
      authState = "expired";
      throw new Error("Authorization expired. Reconnect Google Calendar.");
    }
    let response;
    try {
      response = await fetchImpl("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          refresh_token: authorization.refreshToken,
          grant_type: "refresh_token",
        }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      assertCurrentConnection(authorization);
      authState = "network";
      throw new Error("Google could not be reached. Check the network and try again.");
    }
    const result = await response.json();
    assertCurrentConnection(authorization);
    if (!response.ok) {
      authState = response.status >= 500 ? "network" : "expired";
      throw new Error(
        authState === "expired"
          ? "Authorization expired. Reconnect Google Calendar."
          : "Google is temporarily unavailable. Try again in a few minutes.",
      );
    }
    if (!result.access_token) {
      authState = "expired";
      throw new Error("The authorization response is invalid. Reconnect Google Calendar.");
    }
    authorization.accessToken = result.access_token;
    authorization.expiresAt =
      Date.now() + Number(result.expires_in || 3600) * 1000;
    if (result.refresh_token) authorization.refreshToken = result.refresh_token;
    // Keep rotated credentials in memory after a failed save, but retry their
    // durable save before a fresh access token can take the fast path.
    unsavedTokens.set(authorization, {});
    await saveRefreshedTokens(authorization);
    authState = "connected";
    return authorization.accessToken;
  }
  async function api(path, options = {}) {
    const authorization = connection;
    const auth = await accessToken();
    assertCurrentConnection(authorization);
    let response;
    try {
      response = await fetchImpl(`${API}${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${auth}`,
          "Content-Type": "application/json",
          ...options.headers,
        },
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      assertCurrentConnection(authorization);
      authState = "network";
      throw new Error("The Google Calendar network request failed. Try again.");
    }
    assertCurrentConnection(authorization);
    if (response.status === 401) {
      authState = "expired";
      throw new Error("Authorization expired. Reconnect Google Calendar.");
    }
    if (response.status >= 500) authState = "network";
    if (response.ok) authState = "connected";
    // Body consumption is asynchronous too: a reconnect may finish after the
    // headers arrive but before the old account's JSON is available.
    return {
      ok: response.ok,
      status: response.status,
      async json() {
        const data = await response.json();
        assertCurrentConnection(authorization);
        return data;
      },
    };
  }
  async function readableCalendars() {
    const authorization = connection;
    const items = new Map();
    let pageToken = "";
    const seen = new Set();
    for (let page = 0; page < 100; page++) {
      const response = await api(
        `/users/me/calendarList?minAccessRole=reader&maxResults=250${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
      );
      if (!response.ok) throw new Error("The calendar list could not be read.");
      const data = await response.json();
      assertCurrentConnection(authorization);
      for (const x of data.items || []) {
        if (
          !x.id ||
          !["reader", "writer", "writerWithoutPrivateAccess", "owner"].includes(
            x.accessRole,
          )
        )
          continue;
        items.set(x.id, {
          id: x.id,
          summary: x.summary || x.id,
          accessRole: x.accessRole,
          timeZone: x.timeZone,
          primary: Boolean(x.primary),
          colorId: x.colorId,
          backgroundColor: x.backgroundColor,
        });
      }
      pageToken = data.nextPageToken;
      if (!pageToken) return [...items.values()];
      if (seen.has(pageToken)) throw new Error("The calendar-list page repeated. Try again.");
      seen.add(pageToken);
    }
    throw new Error("The calendar list exceeds the safe read limit.");
  }
  async function ownedCalendars() {
    return (await readableCalendars()).filter((c) => c.accessRole === "owner");
  }
  const eventPath = (calendarId, eventId) =>
    `/calendars/${encodeURIComponent(calendarId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ""}`;
  async function resolveEventCalendar(calendar, event) {
    if (event.start?.timeZone || calendar.timeZone) return calendar;
    // No display-zone parameter: use provider calendar metadata, never a
    // client-supplied zone or a cache that could survive an account change.
    const response = await api(`${eventPath(calendar.id)}?maxResults=1&fields=timeZone`);
    if (!response.ok) throw new Error("The calendar time zone could not be verified. Read the calendar again.");
    const data = await response.json();
    if (!data.timeZone) throw new Error("A verified calendar time zone is missing. Read the calendar again.");
    new Intl.DateTimeFormat("en-CA", { timeZone: data.timeZone }).format(0);
    calendar.timeZone = data.timeZone;
    return calendar;
  }
  const owned = (event, profileId, uid) =>
    event.extendedProperties?.private?.shunriOwner === profileId &&
    event.extendedProperties?.private?.shunriTask === uid;
  const mappingKey = (profileId, uid, calendarId) => JSON.stringify([profileId, uid, calendarId]);
  function assertTaskCalendar(profileId, uid, calendarId, eventId) {
    if (Object.entries(connection?.mappings || {}).some(([key, mapping]) =>
      (mapping.calendarId !== calendarId || (eventId && mapping.eventId !== eventId)) &&
      key === mappingKey(profileId, uid, mapping.calendarId)))
      throw new Error(eventId
        ? "This task is linked to another Google event. Read it again and restore the original link; it will not be overwritten or duplicated."
        : "This task is linked to another Google calendar. Read it again and restore the original link; no new event will be created.");
  }
  function eligibleImportedEvent(event, calendar) {
    if (
      calendar?.accessRole !== "owner" ||
      event.status === "cancelled" ||
      event.organizer?.self !== true ||
      (event.eventType && event.eventType !== "default") ||
      !event.start?.dateTime ||
      !event.end?.dateTime
    )
      return false;
    const zone = event.start.timeZone || calendar.timeZone;
    if (!zone) return false;
    let start, end, localDate;
    try {
      start = calendarEndpointInstant(event.start, zone);
      end = calendarEndpointInstant(event.end, zone);
      localDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      });
    } catch {
      return false;
    }
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start ||
      end - start > 1440 * 60000
    )
      return false;
    // An imported multi-day activity stays one immutable Google constraint.
    return (
      localDate.format(new Date(start)) === localDate.format(new Date(end - 1))
    );
  }
  function mappedTo(mapping, calendarId, eventId) {
    return mapping?.calendarId === calendarId && mapping?.eventId === eventId;
  }
  function mapForEvent(calendarId, eventId) {
    return Object.entries(connection?.mappings || {}).find(([, mapping]) =>
      mappedTo(mapping, calendarId, eventId),
    );
  }
  async function readEvents(params) {
    const authorization = connection;
    const from = params.get("from"),
      to = params.get("to"),
      timeZone = params.get("timeZone") || "America/Los_Angeles";
    const purpose = params.get("purpose"),
      catalog = purpose === CATALOG_PURPOSE,
      chosenId = params.get("calendarId");
    if (purpose && !catalog) throw new Error("The calendar-read purpose is not recognized.");
    if (catalog && !chosenId)
      throw new Error("Select the calendar containing your own study for the background study catalog.");
    const min = calendarInstant(from || "", 0, timeZone),
      maxDate = new Date(`${to}T12:00:00Z`);
    if (
      !to ||
      Number.isNaN(maxDate.getTime()) ||
      maxDate.toISOString().slice(0, 10) !== to
    )
      throw new Error("The read end date is invalid.");
    maxDate.setUTCDate(maxDate.getUTCDate() + 1);
    const max = calendarInstant(
      maxDate.toISOString().slice(0, 10),
      0,
      timeZone,
    );
    if (max <= min || max - min > 3660 * 86400000)
      throw new Error("The read range is invalid or exceeds ten years. Browse a smaller range.");
    const calendars = await readableCalendars();
    const selected = chosenId
      ? calendars.filter((c) => c.id === chosenId)
      : calendars;
    if (chosenId && !selected.length)
      throw new Error("This calendar is outside the authorized read scope.");
    if (catalog && selected[0].accessRole !== "owner")
      throw new Error(
        "The background study catalog can only read your owned anchor calendar. Other calendars require a separate complete constraint read.",
      );
    const events = new Map(),
      errors = [],
      completedCalendarIds = [];
    let scannedEventCount = 0;
    for (const calendar of selected) {
      let pageToken = "";
      const seen = new Set();
      try {
        for (let page = 0; ; page++) {
          if (page >= 1000)
            throw new Error(
              "This calendar exceeds 1,000 pages. Reduce the read range; events already read are retained.",
            );
          const query = new URLSearchParams({
            timeMin: new Date(min).toISOString(),
            timeMax: new Date(max).toISOString(),
            singleEvents: "true",
            showDeleted: "true",
            maxResults: "2500",
            ...(pageToken ? { pageToken } : {}),
          });
          const response = await api(`${eventPath(calendar.id)}?${query}`);
          if (!response.ok) {
            if (response.status === 403) {
              const error = new Error(
                "Event-read permission is insufficient. Existing authorization is retained. Reconnect to grant the additional read-only permission.",
              );
              error.permissionRequired = true;
              throw error;
            }
            throw new Error(
              `The calendar read failed (HTTP ${response.status}). Try again.`,
            );
          }
          const data = await response.json();
          const eventCalendar = { ...calendar, timeZone: data.timeZone || calendar.timeZone };
          for (const event of data.items || []) {
            if (!event.id) continue;
            scannedEventCount++;
            if (catalog) {
              let instant;
              try {
                if (event.start?.dateTime)
                  instant = calendarEndpointInstant(event.start, event.start.timeZone || eventCalendar.timeZone);
              } catch { /* Keep malformed/ambiguous entries isolated, as in ordinary reads. */ }
              const eventDate =
                event.start?.date ||
                (Number.isFinite(instant)
                  ? dateParts(instant, timeZone).date
                  : event.start?.dateTime?.slice(0, 10) ||
                    event.originalStartTime?.date ||
                    from);
              const semantic = interpretEvent(
                {
                  title: event.summary || "",
                  externalReadOnly: true,
                  calendarLink: { calendarId: calendar.id, eventId: event.id },
                  calendarSource: {
                    summary: event.summary || "",
                    description: event.description || "",
                    calendarName: calendar.summary || "",
                    organizer: event.organizer,
                    creator: event.creator,
                  },
                },
                eventDate,
              );
              if (
                semantic.confidence !== "clear" ||
                semantic.planId !== "job-prepare" ||
                !CATALOG_LEARNING_PURPOSES.has(semantic.purpose)
              ) {
                // Do not retain thousands of recurring meals and other everyday events in memory,
                // and do not leave an earlier-page classification after a change.
                events.delete(`${calendar.id}\0${event.id}`);
                continue;
              }
            }
            const candidate = mapForEvent(calendar.id, event.id);
            // A pending create receipt is recovery evidence for this app's
            // event, never consent for a different event occupying that ID.
            const entry = candidate?.[1]?.pendingWrite && !candidate[1].imported &&
              !owned(event, candidate[1].profileId, candidate[1].uid) ? null : candidate,
              mapping = entry?.[1];
            const ownedProfile = event.extendedProperties?.private?.shunriOwner;
            const ownedUid = event.extendedProperties?.private?.shunriTask;
            const fields = [
              "etag",
              "updated",
              "status",
              "summary",
              "description",
              "location",
              "colorId",
              "start",
              "end",
              "recurringEventId",
              "originalStartTime",
              "organizer",
              "creator",
              "extendedProperties",
              "eventType",
              "transparency",
              "htmlLink",
              "iCalUID",
            ];
            const item = Object.fromEntries(
              fields
                .filter((k) => event[k] !== undefined)
                .map((k) => [k, event[k]]),
            );
            events.set(`${calendar.id}\0${event.id}`, {
              ...item,
              eventId: event.id,
              calendarId: calendar.id,
              calendarName: calendar.summary,
              accessRole: calendar.accessRole,
              calendarTimeZone: eventCalendar.timeZone,
              remoteSignature: googleEventSignature(event, eventCalendar.timeZone),
              // Private markers identify a past app event, not current consent.
              managed: Boolean(mapping),
              managedUid: mapping?.uid || ownedUid,
              managedProfileId: mapping?.profileId || ownedProfile,
              baselineEtag: mapping?.etag,
              canManage: eligibleImportedEvent(event, eventCalendar),
            });
          }
          pageToken = data.nextPageToken;
          if (!pageToken) {
            completedCalendarIds.push(calendar.id);
            break;
          }
          if (seen.has(pageToken))
            throw new Error("The Google event page repeated. Try again; events already read are retained.");
          seen.add(pageToken);
        }
      } catch (error) {
        errors.push({
          calendarId: calendar.id,
          calendarName: calendar.summary,
          message: error.message,
          permissionRequired: Boolean(error.permissionRequired),
        });
      }
    }
    // A stale page must not become a successful partial read containing data
    // from the previous account, including pages collected before reconnect.
    assertCurrentConnection(authorization);
    return {
      events: [...events.values()],
      calendars: selected,
      completedCalendarIds,
      complete:
        errors.length === 0 && completedCalendarIds.length === selected.length,
      readScope: catalog ? CATALOG_PURPOSE : "all-events",
      ...(catalog
        ? {
            catalog: {
              planId: "job-prepare",
              scannedEventCount,
              filteredEventCount: events.size,
            },
          }
        : {}),
      range: {
        from,
        to,
        timeZone,
        timeMin: new Date(min).toISOString(),
        timeMax: new Date(max).toISOString(),
        catalog,
        fullOccupationCoverage:
          !catalog &&
          errors.length === 0 &&
          completedCalendarIds.length === selected.length,
      },
      partial: errors.length > 0,
      errors,
    };
  }
  function validateTask(task) {
    if (
      typeof task.uid !== "string" ||
      !task.uid ||
      typeof task.id !== "string" ||
      !task.id ||
      typeof task.title !== "string" ||
      !task.title.trim() ||
      !Number.isInteger(task.duration) ||
      task.duration <= 0 ||
      task.duration > 1440
    )
      throw new Error("The task information is incomplete or invalid.");
    const start = calendarInstant(
      task.date,
      task.start,
      task.timeZone || "America/Los_Angeles",
    );
    return {
      summary: task.title,
      start: {
        dateTime: new Date(start).toISOString(),
        timeZone: task.timeZone || "America/Los_Angeles",
      },
      end: {
        dateTime: new Date(start + task.duration * 60000).toISOString(),
        timeZone: task.timeZone || "America/Los_Angeles",
      },
    };
  }
  async function handle(req, res, url) {
    if (!url.pathname.startsWith("/api/calendar/")) return false;
    await ready;
    const route = url.pathname.slice("/api/calendar/".length);
    try {
      // Host validation protects a loopback server from DNS-rebinding requests.
      if (!allowedHosts.has(req.headers.host)) {
        json(res, 403, { error: "The request address does not match." });
        return true;
      }
      if (req.method === "GET" && ["status", "calendars", "events"].includes(route) &&
        (["cross-site", "same-site"].includes(req.headers["sec-fetch-site"]) ||
          (req.headers.origin !== undefined && req.headers.origin !== origin))) {
        json(res, 403, { error: "Read Google Calendar from the Shunri page." });
        return true;
      }
      const { record: s, replaced } = session(req, res);
      if (
        req.method === "POST" &&
        (req.headers.origin !== origin ||
          !safeEqual(req.headers["x-shunri-csrf"], s.csrf))
      ) {
        const operationSessionChanged = replaced && req.headers.origin === origin &&
          (route === "preview" || route === "execute");
        json(res, 403, { error: operationSessionChanged
          ? "The operation session changed. Refresh the full page, preview again, and then confirm."
          : "The request origin or security check is invalid. Refresh the page." });
        return true;
      }
      if (route === "status" && req.method === "GET") {
        let tokenSaveFailed = false;
        if (configured && connection && authState !== "storage_error") {
          const authorization = connection;
          try {
            await accessToken();
          } catch (error) {
            tokenSaveFailed = connection === authorization && error instanceof TokenSaveError;
          }
        }
        json(res, 200, {
          state: !configured ? "unconfigured" : tokenSaveFailed ? "storage_error" : authState,
          storageRetryable: tokenSaveFailed,
          configured,
          missing,
          writesEnabled,
          csrfToken: s.csrf,
          busy,
          message: !configured
            ? setupMessage(missing)
            : loadError
              ? "Authorization storage could not be read. The original data was retained. Check that the server’s data folder is readable, restart Shunri, then reconnect."
              : tokenSaveFailed
                ? "The authorization update has not been saved, so Calendar cannot be read yet. Check local storage and try again."
              : !writesEnabled
                ? "Calendar writes are off. You can connect and preview; no events will be created or updated. A local save in Shunri is kept apart from a Google write. Writes stay off until the owner separately approves turning them on. Help for the server owner: the setting name is CALENDAR_WRITES_ENABLED."
                : "Sync only confirmed changes entrusted to Shunri. Google events will not be deleted.",
        });
        return true;
      }
      if (!configured) {
        json(res, 503, {
          error: setupMessage(missing),
          state: "unconfigured",
        });
        return true;
      }
      if (loadError) throw new Error("Authorization storage is unavailable. The original data was retained. Check that the server’s data folder is writable, restart Shunri, then reconnect.");
      if (route === "connect" && req.method === "GET") {
        if (busy) throw new Error("Sync is in progress. Wait for it to finish before reconnecting.");
        if (req.headers["sec-fetch-site"] === "cross-site")
          throw new Error("Start the connection from the Shunri page.");
        s.oauth = {
          state: token(),
          verifier: token(),
          expiresAt: Date.now() + 600000,
        };
        const query = new URLSearchParams({
          client_id: env.GOOGLE_CLIENT_ID,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: SCOPES.join(" "),
          access_type: "offline",
          prompt: "consent",
          state: s.oauth.state,
          code_challenge: createHash("sha256")
            .update(s.oauth.verifier)
            .digest("base64url"),
          code_challenge_method: "S256",
          include_granted_scopes: "true",
        });
        res.writeHead(302, {
          Location: `https://accounts.google.com/o/oauth2/v2/auth?${query}`,
          "Cache-Control": "no-store",
        });
        res.end();
        return true;
      }
      if (route === "callback" && req.method === "GET") {
        if (busy) throw new Error("Sync is in progress. Wait for it to finish before reconnecting.");
        const oauth = s.oauth;
        delete s.oauth;
        if (
          !oauth ||
          oauth.expiresAt < Date.now() ||
          !safeEqual(url.searchParams.get("state"), oauth.state) ||
          !url.searchParams.get("code") ||
          url.searchParams.has("error")
        )
          throw new Error("Authorization was cancelled or its security check failed. Reconnect Google Calendar.");
        const response = await fetchImpl(
          "https://oauth2.googleapis.com/token",
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: env.GOOGLE_CLIENT_ID,
              client_secret: env.GOOGLE_CLIENT_SECRET,
              redirect_uri: redirectUri,
              code: url.searchParams.get("code"),
              code_verifier: oauth.verifier,
              grant_type: "authorization_code",
            }),
            signal: AbortSignal.timeout(15000),
          },
        );
        const result = await response.json();
        if (!response.ok || !result.access_token)
          throw new Error("Google authorization exchange failed. Reconnect Google Calendar.");
        // An OAuth exchange can select another account. Without a verified
        // account identity, credentials and adoption consent cannot be reused.
        if (busy) throw new Error("Sync is in progress. Wait for it to finish before reconnecting.");
        const authorization = {
          accessToken: result.access_token,
          refreshToken: result.refresh_token || null,
          expiresAt: Date.now() + Number(result.expires_in || 3600) * 1000,
          grantedScope: result.scope || null,
          mappings: {},
        };
        // Publish a new account only after its encrypted snapshot is saved.
        // Reserve the same lock as execution while this replacement is pending.
        busy = true;
        try {
          await persist(authorization);
          connection = authorization;
          plans.clear();
          authState = "connected";
        } finally {
          busy = false;
        }
        res.writeHead(302, {
          Location: "/?calendar=connected",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        });
        res.end();
        return true;
      }
      if (route === "calendars" && req.method === "GET") {
        json(res, 200, { calendars: await readableCalendars() });
        return true;
      }
      if (route === "events" && req.method === "GET") {
        json(res, 200, await readEvents(url.searchParams));
        return true;
      }
      if (route === "adopt" && req.method === "POST") {
        if (busy) throw new Error("Sync is in progress. Wait for it to finish before changing management permission.");
        const authorization = connection;
        const payload = await body(req);
        if (payload.mode !== "personal")
          throw new Error("The example schedule cannot connect to or manage a real calendar.");
        if (
          !payload.profileId ||
          typeof payload.profileId !== "string" ||
          !Array.isArray(payload.tasks) ||
          !payload.tasks.length ||
          payload.tasks.length > 5000
        )
          throw new Error("Select valid events to entrust to Shunri.");
        const calendars = await ownedCalendars(),
          results = [],
          ids = new Set();
        for (const task of payload.tasks) {
          try {
            if (!task.uid || !task.id || ids.has(task.uid))
              throw new Error("A task identity is invalid or duplicated.");
            ids.add(task.uid);
            const link = task.calendarLink,
              calendar = calendars.find((c) => c.id === link?.calendarId);
            if (!calendar || !link.eventId || !link.etag)
              throw new Error("Only events you own with a previously read version can be managed.");
            const response = await api(
              eventPath(link.calendarId, link.eventId),
            );
            if (!response.ok) throw new Error("The original event could not be read. Reload the calendar.");
            const existing = await response.json();
            assertCurrentConnection(authorization);
            await resolveEventCalendar(calendar, existing);
            assertCurrentConnection(authorization);
            if (
              (existing.extendedProperties?.private?.shunriOwner &&
                existing.extendedProperties.private.shunriOwner !==
                  payload.profileId) ||
              (existing.extendedProperties?.private?.shunriTask &&
                existing.extendedProperties.private.shunriTask !== task.uid)
            )
              throw new Error(
                "This event belongs to another app profile or task and cannot be registered as the current task.",
              );
            if (!eligibleImportedEvent(existing, calendar))
              throw new Error(
                "Fixed, all-day, cross-day, externally organized, or special-type events are read-only constraints and cannot be moved by Shunri.",
              );
            if (existing.etag !== link.etag)
              throw new Error("The Google event changed. Read its latest version before confirming management permission.");
            const event = validateTask(task);
            if (!sameEventPayload(existing, event, calendar.timeZone))
              throw new Error(
                "The local and Google versions differ. Resolve the changes before confirming management permission.",
              );
            const calendarLink = {
              source: "google",
              managed: true,
              calendarId: link.calendarId,
              eventId: link.eventId,
              etag: existing.etag,
              signature: calendarSignature(task),
              remoteSignature: googleEventSignature(existing, calendar.timeZone),
              syncedAt: new Date().toISOString(),
            };
            const id = mappingKey(payload.profileId, task.uid, link.calendarId);
            const mapping = {
              ...calendarLink,
              uid: task.uid,
              profileId: payload.profileId,
              imported: true,
            };
            if (busy) throw new Error("Sync is in progress. Wait for it to finish before changing management permission.");
            busy = true;
            try {
              // Build at dequeue time so other successful saves are retained.
              // Publish only this consent entry, and only after its save succeeds.
              const saved = persistence.then(async () => {
                assertCurrentConnection(authorization);
                assertTaskCalendar(payload.profileId, task.uid, link.calendarId, link.eventId);
                const oldEntry = mapForEvent(link.calendarId, link.eventId);
                if (oldEntry &&
                  (oldEntry[1].profileId !== payload.profileId || oldEntry[1].uid !== task.uid))
                  throw new Error("The original event is linked to another task and will not be managed twice.");
                await persistNow({
                  ...authorization,
                  mappings: { ...authorization.mappings, [id]: mapping },
                });
                assertCurrentConnection(authorization);
                authorization.mappings ||= {};
                authorization.mappings[id] = mapping;
              });
              persistence = saved.catch(() => {});
              await saved;
            } finally {
              busy = false;
            }
            results.push({
              uid: task.uid,
              id: task.id,
              ok: true,
              calendarLink,
            });
          } catch (error) {
            results.push({
              uid: task.uid,
              id: task.id,
              ok: false,
              message: error.message,
            });
          }
        }
        assertCurrentConnection(authorization);
        plans.clear();
        json(res, 200, {
          results,
          partial: results.some((x) => x.ok) && results.some((x) => !x.ok),
        });
        return true;
      }
      if (route === "preview" && req.method === "POST") {
        const authorization = connection;
        const payload = await body(req);
        if (payload.mode !== "personal")
          throw new Error("The example schedule cannot sync to a real calendar.");
        if (
          typeof payload.profileId !== "string" ||
          !payload.profileId ||
          (payload.calendarId !== undefined &&
            typeof payload.calendarId !== "string") ||
          !Array.isArray(payload.tasks) ||
          !payload.tasks.length ||
          payload.tasks.length > 5000
        )
          throw new Error("Select a calendar and valid tasks.");
        if (
          writeAllowlist &&
          payload.tasks.some((task) => !writeAllowlist.has(task?.uid))
        ) {
          json(res, 403, {
            error: "Only the specified task UIDs are authorized for this verification. Other tasks will not be previewed for writes or modified.",
          });
          return true;
        }
        const calendars = await ownedCalendars(),
          calendar = calendars.find((c) => c.id === payload.calendarId);
        if (payload.calendarId && !calendar)
          throw new Error("Sync is limited to calendars you own.");
        const ids = new Set(),
          eventIds = new Set(),
          items = [];
        for (const task of payload.tasks) {
          if (ids.has(task.uid)) throw new Error("The same task was selected more than once. Remove the duplicate and try again.");
          ids.add(task.uid);
          const item = {
            uid: task.uid,
            id: task.id,
            title: task.title,
            date: task.date,
            start: task.start,
            duration: task.duration,
            calendarId: task.calendarLink?.calendarId || payload.calendarId,
          };
          try {
            const target = calendars.find((c) => c.id === item.calendarId);
            if (!target)
              throw new Error("The task’s target calendar is not writable. Other people’s calendars stay unchanged.");
            item.calendarName = target.summary;
            assertTaskCalendar(payload.profileId, task.uid, item.calendarId);
            const mapping =
              connection.mappings?.[
                mappingKey(payload.profileId, task.uid, item.calendarId)
              ];
            const link = task.calendarLink;
            if (
              mapping &&
              (task.locked ||
                task.timeLocked ||
                task.externalReadOnly ||
                task.type === "activity" ||
                task.done ||
                task.deferred)
            )
              throw new Error(
                "Fixed, locked, or completed imported events stay unchanged. Google will not be modified.",
              );
            if (
              link?.source === "google" &&
              !mappedTo(mapping, item.calendarId, link.eventId)
            )
              throw new Error(
                "This Google event has not been entrusted to Shunri. It will not be copied or changed.",
              );
            if (link?.managed === false)
              throw new Error("This event is read-only and will not be changed.");
            if (
              link?.eventId &&
              !mapping &&
              link.eventId !== managedEventId(payload.profileId, task.uid)
            )
              throw new Error("The original event link is unverified. It will not be copied into another event.");
            const event = validateTask(task),
              signature = calendarSignature(task),
              eventId =
                mapping?.eventId || managedEventId(payload.profileId, task.uid);
            const eventKey = `${item.calendarId}\0${eventId}`;
            if (eventIds.has(eventKey))
              throw new Error("The same original event was selected more than once. It will not be updated twice.");
            eventIds.add(eventKey);
            event.id = eventId;
            event.extendedProperties = {
              private: {
                shunriOwner: payload.profileId,
                shunriTask: task.uid,
                shunriSignature: signature,
              },
            };
            const response = await api(eventPath(item.calendarId, eventId));
            let existing;
            if (response.ok) existing = await response.json();
            else if (response.status !== 404)
              throw new Error("The existing event could not be checked.");
            if (existing) await resolveEventCalendar(target, existing);
            if (existing?.organizer?.self === false)
              throw new Error("Someone else organizes this event. It remains a scheduling constraint and will not be changed.");
            if (
              existing &&
              ((existing.extendedProperties?.private?.shunriOwner &&
                existing.extendedProperties.private.shunriOwner !==
                  payload.profileId) ||
                (existing.extendedProperties?.private?.shunriTask &&
                  existing.extendedProperties.private.shunriTask !== task.uid))
            )
              throw new Error(
                "The original event belongs to another app profile or task and will not be changed.",
              );
            if (
              existing &&
              (!(
                owned(existing, payload.profileId, task.uid) ||
                (mapping?.imported &&
                  mappedTo(mapping, item.calendarId, eventId) &&
                  eligibleImportedEvent(existing, target))
              ) ||
                existing.status === "cancelled")
            )
              throw new Error("The event ownership does not match, or it was deleted. It will not be changed.");
            if ((mapping?.imported || link?.source === "google") && !existing)
              throw new Error("The original Google event was deleted. No replacement event will be created.");
            const samePayload = sameEventPayload(existing, event, target.timeZone);
            const remotePayloadChanged =
              !mapping?.remoteSignature ||
              !existing ||
              mapping.remoteSignature !== googleEventSignature(existing, target.timeZone);
            if (
              mapping?.etag &&
              existing?.etag !== mapping.etag &&
              remotePayloadChanged &&
              !samePayload
            )
              throw new Error(
                "Google has newer changes that conflict with the local version. Read them again and choose which version to keep; nothing will be silently overwritten.",
              );
            Object.assign(item, {
              action: existing ? (samePayload ? "skip" : "update") : "create",
              signature,
              eventId,
              event,
              etag: existing?.etag,
              imported: Boolean(mapping?.imported || link?.source === "google"),
              calendarTimeZone: target.timeZone,
            });
          } catch (error) {
            item.action = "error";
            item.reason = error.message;
          }
          items.push(item);
        }
        assertCurrentConnection(authorization);
        const planId = token(),
          expiresAt = Date.now() + 600000;
        for (const [id, plan] of plans)
          if (plan.expiresAt < Date.now()) plans.delete(id);
        // Keep a few recent tab previews, and bound even late completions
        // from requests whose session was evicted while awaiting the provider.
        const sessionPlanIds = [...plans]
          .filter(([, plan]) => plan.sessionId === s.id)
          .map(([id]) => id);
        while (sessionPlanIds.length >= SESSION_PREVIEW_CAPACITY)
          plans.delete(sessionPlanIds.shift());
        while (plans.size >= PREVIEW_PLAN_CAPACITY)
          plans.delete(plans.keys().next().value);
        plans.set(planId, {
          sessionId: s.id,
          profileId: payload.profileId,
          calendarId: payload.calendarId,
          items,
          expiresAt,
        });
        const dates = items.map((x) => x.date).sort();
        json(res, 200, {
          planId,
          expiresAt,
          calendarId: calendar?.id || null,
          calendarName: calendar?.summary || "Sync to each item’s original calendar",
          dateRange: [dates[0], dates.at(-1)],
          items: items.map(
            ({ event, signature, etag, eventId, imported, calendarTimeZone, ...item }) => item,
          ),
          canExecute: writesEnabled && !items.some((x) => x.action === "error"),
          writesEnabled,
        });
        return true;
      }
      if (route === "execute" && req.method === "POST") {
        if (!writesEnabled) {
          json(res, 403, {
            error: "Calendar writes are off. No create or update requests were sent, and your change is kept in Shunri only. A local save in Shunri is kept apart from a Google write. Writes stay off until the owner separately approves turning them on. Help for the server owner: the setting name is CALENDAR_WRITES_ENABLED.",
          });
          return true;
        }
        if (busy) {
          json(res, 409, { error: "Sync is in progress. Wait for it to finish." });
          return true;
        }
        const { planId } = await body(req);
        if (busy) {
          json(res, 409, { error: "Sync is in progress. Wait for it to finish." });
          return true;
        }
        const plan = plans.get(planId);
        if (!plan || plan.sessionId !== s.id || plan.expiresAt < Date.now())
          throw new Error("The preview expired. Preview again.");
        if (plan.items.some((x) => x.action === "error"))
          throw new Error("The preview still has errors and cannot run.");
        if (
          writeAllowlist &&
          plan.items.some((item) => !writeAllowlist.has(item.uid))
        ) {
          json(res, 403, {
            error: "The preview includes tasks outside the authorized verification scope. No create or update requests were sent.",
          });
          return true;
        }
        plans.delete(planId);
        busy = true;
        const results = [];
        let executionCalendars;
        try {
          for (const item of plan.items) {
            try {
              const targetCalendarId = item.calendarId || plan.calendarId;
              assertTaskCalendar(plan.profileId, item.uid, targetCalendarId);
              const mapping =
                connection.mappings?.[
                  mappingKey(plan.profileId, item.uid, targetCalendarId)
                ];
              const path = eventPath(targetCalendarId, item.eventId);
              let response = await api(path),
                existing;
              if (response.ok) existing = await response.json();
              else if (response.status !== 404)
                throw new Error("The existing event could not be checked again.");
              if (item.imported && existing && !existing.start?.timeZone) {
                executionCalendars ||= await ownedCalendars();
                const calendar = executionCalendars.find((entry) => entry.id === targetCalendarId);
                if (!calendar) throw new Error("Calendar management permission changed. Preview again.");
                await resolveEventCalendar(calendar, existing);
                if (calendar.timeZone !== item.calendarTimeZone)
                  throw new Error("The calendar time zone changed. Read the calendar and preview again.");
              }
              if (existing?.organizer?.self === false)
                throw new Error("Someone else now organizes the original event. It will not be changed.");
              if (
                existing &&
                ((existing.extendedProperties?.private?.shunriOwner &&
                  existing.extendedProperties.private.shunriOwner !==
                    plan.profileId) ||
                  (existing.extendedProperties?.private?.shunriTask &&
                    existing.extendedProperties.private.shunriTask !==
                      item.uid))
              )
                throw new Error(
                  "The original event ownership changed. Events belonging to another app profile or task will not be changed.",
                );
              if (
                existing &&
                (!(
                  owned(existing, plan.profileId, item.uid) ||
                  (item.imported &&
                    mapping?.imported &&
                    mappedTo(mapping, targetCalendarId, item.eventId) &&
                    eligibleImportedEvent(existing, {
                      accessRole: "owner",
                      timeZone: item.calendarTimeZone,
                    }))
                ) ||
                  existing.status === "cancelled")
              )
                throw new Error("The event ownership does not match, or it was deleted. No change was made.");
              if (item.action !== "create" && !existing)
                throw new Error("The event was deleted. Preview again.");
              if (
                item.action === "create" &&
                existing &&
                (existing.extendedProperties?.private?.shunriSignature !==
                  item.signature || !sameEventPayload(existing, item.event, item.calendarTimeZone))
              )
                throw new Error("Another sync changed this task. Preview again.");
              if (item.etag && existing?.etag !== item.etag)
                throw new Error("The Google event changed. Preview again before confirming.");
              // A create plan never observed this event's version. An identical
              // retry is safe to acknowledge, but must never become an update.
              let action = item.action === "create" && existing ? "skip" : item.action;
              if (existing && action !== "skip" && !existing.etag)
                throw new Error("The event version is missing, so it cannot be safely updated. Preview again.");
              if (action !== "skip") {
                const id = mappingKey(plan.profileId, item.uid, targetCalendarId);
                const intended = {
                  ...mapping,
                  source: item.imported ? "google" : "app",
                  managed: true,
                  calendarId: targetCalendarId,
                  eventId: item.eventId,
                  uid: item.uid,
                  profileId: plan.profileId,
                  imported: Boolean(item.imported),
                  // Preserve the last verified baseline until a remote response
                  // is saved. A restart can still identify a committed write.
                  pendingWrite: { signature: item.signature },
                };
                connection.mappings ||= {};
                connection.mappings[id] = intended;
                try {
                  await persist();
                } catch (error) {
                  if (connection.mappings[id] === intended) {
                    if (mapping) connection.mappings[id] = mapping;
                    else delete connection.mappings[id];
                  }
                  throw error;
                }
              }
              let savedEvent = existing;
              if (!existing) {
                if (item.imported)
                  throw new Error("The original Google event was deleted. No replacement event will be created.");
                response = await api(eventPath(targetCalendarId), {
                  method: "POST",
                  body: JSON.stringify(item.event),
                });
                if (response.status === 409) {
                  const check = await api(path);
                  if (!check.ok) throw new Error("The duplicate-event check failed.");
                  existing = await check.json();
                  if (
                    !owned(existing, plan.profileId, item.uid) ||
                    existing.status === "cancelled" ||
                    existing.organizer?.self === false
                  )
                    throw new Error("The event ID conflicts with another event. Other events were not changed.");
                  if (
                    existing.extendedProperties?.private?.shunriSignature !==
                    item.signature || !sameEventPayload(existing, item.event, item.calendarTimeZone)
                  )
                    throw new Error("Another sync changed this task. Preview again.");
                  action = "skip";
                  savedEvent = existing;
                } else if (!response.ok)
                  throw new Error("Creation failed. Preview again and try once more.");
                else savedEvent = await response.json();
              }
              if (existing && action !== "skip") {
                const merged = {
                  ...existing,
                  ...item.event,
                  extendedProperties: {
                    ...existing.extendedProperties,
                    private: {
                      ...existing.extendedProperties?.private,
                      ...item.event.extendedProperties.private,
                    },
                  },
                };
                response = await api(path, {
                  method: "PUT",
                  headers: { "If-Match": existing.etag },
                  body: JSON.stringify(merged),
                });
                if (!response.ok)
                  throw new Error(
                    response.status === 412
                      ? "The event was just changed. Preview again."
                      : "The update failed. Preview again and try once more.",
                  );
                savedEvent = await response.json();
                action = "update";
              }
              const calendarLink = {
                source: item.imported ? "google" : "app",
                managed: true,
                calendarId: targetCalendarId,
                eventId: item.eventId,
                signature: item.signature,
                etag: savedEvent?.etag || existing?.etag,
                remoteSignature: savedEvent
                  ? googleEventSignature(savedEvent, item.calendarTimeZone)
                  : undefined,
                syncedAt: new Date().toISOString(),
              };
              connection.mappings ||= {};
              connection.mappings[
                mappingKey(plan.profileId, item.uid, targetCalendarId)
              ] = {
                ...calendarLink,
                uid: item.uid,
                profileId: plan.profileId,
                imported: Boolean(item.imported),
              };
              await persist();
              results.push({
                uid: item.uid,
                id: item.id,
                ok: true,
                action,
                calendarLink,
              });
            } catch (error) {
              results.push({
                uid: item.uid,
                id: item.id,
                ok: false,
                action: item.action,
                message: error.message,
              });
            }
          }
        } finally {
          busy = false;
        }
        json(res, 200, {
          results,
          partial: results.some((x) => x.ok) && results.some((x) => !x.ok),
        });
        return true;
      }
      json(res, 404, { error: "This Calendar route does not exist." });
      return true;
    } catch (error) {
      if (route === "callback") {
        res.writeHead(302, {
          Location: "/?calendar=error",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        });
        res.end();
      } else json(res, 400, { error: error.message, state: authState });
      return true;
    }
  }
  return { handle };
}
