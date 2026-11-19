/**
 * Fault injection / test tooling must be rejected when disabled. The same switch is forced OFF
 * when NODE_ENV=production (config/env.js: enabled = NODE_ENV !== 'production' && flag), so this
 * test exercises the production code path without pointing the test-suite at a real database.
 */
import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.FAULT_INJECTION_ENABLED = 'false';
const { config } = await import('../config/env.js');
const { requireTestingTools } = await import('../middleware/testingGuard.js');
const { installFaultInjection } = await import('../fault-injection/faultInjector.js');

test('testing tools are rejected and hooks are not installed when fault injection is disabled', () => {
  assert.equal(config.faultInjection.enabled, false);
  assert.throws(() => requireTestingTools({}, {}, () => {}), (err) => err.statusCode === 403 && err.code === 'TESTING_TOOLS_DISABLED');
  assert.equal(installFaultInjection(), false);
});
