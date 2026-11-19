'use strict';
const { splitToken, tokenFamily } = require('./style');

// A delivery is one send and how far it got:
//   waiting    pushed (and the deploy asked for); the page does not show the new words yet
//   failed     pushed, but asking for the deploy went wrong
//   live       the page was seen showing the new words
//   dismissed  the person stopped waiting
// The page itself is checked by the userscript, which sees the site as the person does.

const LOOK_MARK = '（樣式）';
const OPEN = ['waiting', 'failed'];

const isLookEdit = (edit) => edit.to.startsWith(LOOK_MARK);

// What to look for on the page after a send, one entry per changed spot:
//   words  { page, path, from, to }     from = what the page showed before any of it
//   look   { page, path, text, look, classes? }   look = the CSS the spot should show;
//          classes = the classes that were written for it (Tailwind projects), which is what gets checked
// path is where the spot is on that page (a selector the userscript worked out).
// A newer class of the same kind at the same screen size takes the older one's place.
const kindOf = (token) => { const { variants, base } = splitToken(token); return `${variants.join(':')}|${tokenFamily(base) || base}`; };
const mergeClasses = (older, newer) => [...older.filter((t) => !newer.some((n) => kindOf(n) === kindOf(t))), ...newer];

function addCheck(checks, edit, fallbackPage) {
  const page = edit.page || fallbackPage;
  const path = edit.path || '';
  if (isLookEdit(edit)) {
    if (!path || !edit.look) return checks;               // nothing to recognise it by
    if (edit.classes && !edit.classes.length) return checks;   // the classes were already there: nothing new to see
    const same = (c) => c.look && c.page === page && c.path === path;
    const earlier = checks.find(same);
    const classes = edit.classes ? mergeClasses((earlier && earlier.classes) || [], edit.classes) : null;
    return [...checks.filter((c) => !same(c)),
      { page, path, text: edit.from, look: { ...(earlier ? earlier.look : {}), ...edit.look }, ...(classes ? { classes } : {}) }];
  }
  // words changed again before they went live: one check, from the very first words to the last
  const earlier = checks.find((c) => !c.look && c.to === edit.from);
  return [...checks.filter((c) => c !== earlier),
    { page, path: path || (earlier ? earlier.path : ''), from: earlier ? earlier.from : edit.from, to: edit.to }];
}

function nextDelivery(previous, edits, { commit, page, error }) {
  const carried = previous && OPEN.includes(previous.status) ? previous.checks : [];
  return {
    at: new Date().toISOString(),
    commit,
    count: edits.length || (previous ? previous.count : 0),
    status: error ? 'failed' : 'waiting',
    error: error || '',
    checks: edits.reduce((checks, e) => addCheck(checks, e, page), carried),
  };
}

const openDelivery = (d) => (d && OPEN.includes(d.status)
  ? { status: d.status, at: d.at, error: d.error, count: d.count, checks: d.checks }
  : null);

const closeDelivery = (d, result) => ({ ...d, status: result, landedAt: new Date().toISOString() });

module.exports = { LOOK_MARK, isLookEdit, nextDelivery, openDelivery, closeDelivery };
