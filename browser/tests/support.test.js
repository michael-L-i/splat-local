import test from 'node:test';
import assert from 'node:assert/strict';
import { explainSupport } from '../src/support.js';

const agents = {
  chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
};
const all = { secure: true, hasGpu: true, hasAdapter: true, hasSubgroups: true, hasStorage: true, userAgent: agents.chrome };

test('a capable browser is accepted', () => assert.deepEqual(explainSupport(all), { ok: true }));

test('each missing capability gets its own named reason and fix', () => {
  const cases = [
    [{ secure: false, hasGpu: false }, 'insecure-context', /HTTPS/],
    [{ hasGpu: false, userAgent: agents.firefox }, 'no-webgpu', /Firefox.*Chrome or Edge/s],
    [{ hasGpu: false }, 'no-webgpu', /Chrome 140.*hardware acceleration/s],
    [{ hasAdapter: false, hasSubgroups: false }, 'no-adapter', /hardware acceleration/],
    [{ hasSubgroups: false, userAgent: agents.safari }, 'no-subgroups', /Safari.*subgroups.*Chrome or Edge/s],
    [{ hasSubgroups: false, userAgent: agents.iphone, mobile: true }, 'no-subgroups', /phones and tablets.*desktop or laptop/s],
    [{ hasSubgroups: false }, 'no-subgroups', /Update the browser and graphics driver/],
    [{ hasStorage: false }, 'no-storage', /private\/incognito/],
  ];
  for (const [facts, reason, text] of cases) {
    const result = explainSupport({ ...all, ...facts });
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
    assert.match(result.status, text);
  }
});
