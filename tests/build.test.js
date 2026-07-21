const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

test('build creates one offline HTML file with inline CSS and JavaScript', () => {
  execFileSync(process.execPath, ['scripts/build.mjs']);
  const html = fs.readFileSync('acoustic-room-simulator.html', 'utf8');

  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<style>[\s\S]+<\/style>/);
  assert.match(html, /<script>[\s\S]+<\/script>/);
  assert.doesNotMatch(html, /<(script|link)[^>]+(?:src|href)=/i);
  assert.doesNotMatch(html, /https?:\/\//i);
});
