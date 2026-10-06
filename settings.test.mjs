import test from 'node:test';
import assert from 'node:assert/strict';
import { receiverSettings } from './merge-notifier.mjs';

test('the receiver requires an explicit repository and validates its port', () => {
  for (const env of [{}, {MERGE_NOTIFIER_REPOSITORY:'*'}, {MERGE_NOTIFIER_REPOSITORY:'owner/repo;command'}, {MERGE_NOTIFIER_REPOSITORY:'owner/repo',MERGE_NOTIFIER_PORT:'80'}, {MERGE_NOTIFIER_REPOSITORY:'owner/repo',MERGE_NOTIFIER_PORT:'8028.5'}]) {
    assert.throws(() => receiverSettings(env));
  }
});

test('the same receiver can be configured for another repository and localhost port', () => {
  assert.deepEqual(receiverSettings({MERGE_NOTIFIER_REPOSITORY:'another-owner/another_repo',MERGE_NOTIFIER_PORT:'9042'}), {repository:'another-owner/another_repo',port:9042});
  assert.deepEqual(receiverSettings({MERGE_NOTIFIER_REPOSITORY:'owner/repo'}), {repository:'owner/repo',port:8028});
});
