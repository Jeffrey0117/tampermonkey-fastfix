'use strict';

// A delivery is one send and how far it got:
//   waiting    pushed (and the deploy asked for); the page does not show the new words yet
//   failed     pushed, but asking for the deploy went wrong
//   live       the page was seen showing the new words
//   dismissed  the person stopped waiting
// The page itself is checked by the userscript, which sees the site as the person does.

const OPEN = ['waiting', 'failed'];

// What to look for on the page after a send, one entry per changed spot:
//   { page, path, from, to }     from = what the page showed before any of it
// path is where the spot is on that page (a selector the userscript worked out).
function addCheck(checks, edit, fallbackPage) {
  const page = edit.page || fallbackPage;
  const path = edit.path || '';
  // words changed again before they went live: one check, from the very first words to the last
  const earlier = checks.find((c) => c.to === edit.from);
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

module.exports = {nextDelivery, openDelivery, closeDelivery };
