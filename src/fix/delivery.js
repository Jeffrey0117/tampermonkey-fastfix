'use strict';

// A delivery is one send and how far it got:
//   waiting    pushed (and the deploy asked for); the page does not show the new words yet
//   failed     pushed, but asking for the deploy went wrong
//   live       the page was seen showing the new words
//   dismissed  the person stopped waiting
// The page itself is checked by the userscript, which sees the site as the person does.

const LOOK_MARK = '（樣式）';
const OPEN = ['waiting', 'failed'];

const isLookEdit = (edit) => edit.to.startsWith(LOOK_MARK);

// Words to look for on the page. Words that a later edit replaced again never show up.
const replacedLater = (to, file, later) => later.some((e) => e.from === to && (!file || e.file === file));

function checksFor(edits, fallbackPage) {
  const words = edits.filter((e) => !isLookEdit(e));
  return words
    .filter((e, i) => !replacedLater(e.to, e.file, words.slice(i + 1)))
    .map((e) => ({ page: e.page || fallbackPage, to: e.to }));
}

function nextDelivery(previous, edits, { commit, page, error }) {
  const carried = previous && OPEN.includes(previous.status) ? previous.checks : [];
  const words = edits.filter((e) => !isLookEdit(e));
  return {
    at: new Date().toISOString(),
    commit,
    count: edits.length || (previous ? previous.count : 0),
    status: error ? 'failed' : 'waiting',
    error: error || '',
    checks: [...carried.filter((c) => !replacedLater(c.to, '', words)), ...checksFor(edits, page)],
  };
}

const openDelivery = (d) => (d && OPEN.includes(d.status)
  ? { status: d.status, at: d.at, error: d.error, count: d.count, checks: d.checks }
  : null);

const closeDelivery = (d, result) => ({ ...d, status: result, landedAt: new Date().toISOString() });

module.exports = { LOOK_MARK, isLookEdit, nextDelivery, openDelivery, closeDelivery };
