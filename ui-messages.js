// Presentation helpers for backend messages and fixed-attribute reasons.
// Messages are plain English from the modules that produce them; callers escape rendered text.

/** A backend message without the server-owner help line. */
export function presentError(value) {
  return splitHelp(value).main;
}

const HELP_MARK = ' Help for the server owner';

/** Split a presented message into its plain text and the server-owner help line, so a screen can show them apart. */
export function splitHelp(text) {
  if (typeof text !== 'string') return { main: text, help: '' };
  const at = text.indexOf(HELP_MARK);
  return at < 0 ? { main: text, help: '' } : { main: text.slice(0, at), help: text.slice(at + 1) };
}

/** Markup for a presented message: the plain text in its own element and the help line in a separate one. */
export function messageHtml(text, escapeHtml, attrs = '') {
  const { main, help } = splitHelp(text);
  return `<p${attrs}>${escapeHtml(main)}</p>` + (help ? `<p class="help-line"><small>${escapeHtml(help)}</small></p>` : '');
}

// Plain-English reasons shown in the preview when a task's fixed attributes shaped the plan.
export function attributeMessage(kind, names = "") {
  return {
    buffer: `Includes a 25–30% buffer on the estimate: ${names}.`,
    tiring: `Recovery time (30 minutes) is added after a tiring task: ${names}.`,
    habit: `Left unscheduled because no time fits its habit window: ${names}.`,
    late: `Past its deadline: ${names}.`,
    adjacent: `Two tiring tasks now follow each other; move one by hand if you can: ${names}.`,
    locked: "Locked: you moved this, so it keeps its new time.",
  }[kind] || "";
}
