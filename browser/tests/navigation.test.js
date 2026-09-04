import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('all public pages link to the creator and home under a GitHub Pages subpath', () => {
  const root = 'https://example.com/splat-local/';
  for (const [file, path] of [['../../site/index.html', ''], ['../../site/viewer.html', 'viewer.html'], ['../index.html', 'create/']]) {
    const html = readFileSync(new URL(file, import.meta.url), 'utf8');
    const links = [...html.matchAll(/href="([^"]+)"/g)].map(([, href]) => new URL(href, root + path).href);
    assert.ok(links.includes(root + 'create/'), `${file} links to creation`);
    assert.ok(links.includes(root), `${file} links home`);
    assert.ok(links.includes(root + 'viewer.html'), `${file} links to the viewer`);
  }
});
