'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { grepFiles } = require('./git');
const { findInContent, longestPiece } = require('./match');

const TEXT_EXTENSIONS = new Set([
  '.html', '.htm', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.svelte', '.astro',
  '.md', '.mdx', '.json', '.yml', '.yaml', '.txt', '.ejs', '.hbs', '.njk', '.pug', '.php', '.py', '.liquid',
]);
const MAX_FILE_BYTES = 1024 * 1024;

// Every folder directly under a root that is a real git repository.
// A worktree (".git" is a file) is skipped: it is a second copy of a repo.
function listRepos(roots) {
  return roots.flatMap((root) => {
    let names = [];
    try { names = fs.readdirSync(root); } catch (_) { return []; }
    return names
      .map((name) => path.join(root, name))
      .filter((dir) => {
        try { return fs.statSync(path.join(dir, '.git')).isDirectory(); } catch (_) { return false; }
      });
  });
}

const isEditable = (file) => TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()) && !/\.min\.\w+$/i.test(file);

// Every place the text appears in one project's tracked text files.
async function matchesInRepo(repo, text) {
  let files = [];
  try { files = await grepFiles(repo, longestPiece(text)); } catch (_) { return []; }
  return files.filter(isEditable).flatMap((file) => {
    const full = path.join(repo, file);
    try {
      if (fs.statSync(full).size > MAX_FILE_BYTES) return [];
      return findInContent(fs.readFileSync(full, 'utf8'), text)
        .map((hit, nth) => ({ file, nth, ...hit }));
    } catch (_) {
      return [];
    }
  });
}

module.exports = { matchesInRepo, listRepos };
