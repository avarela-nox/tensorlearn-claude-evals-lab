import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../../evals/assert.mjs';
import {observe as good} from '../../references/good.mjs';
import {observe as broken} from '../../references/broken.mjs';

const requests = JSON.parse(readFileSync(new URL('../../fixtures/workload.json', import.meta.url), 'utf8'));
const requirements = {maxRequestsPerSecond: 50, cacheTtlMs: 30000, forbiddenLogFragments: ['clinicalPayload', 'diagnosis', 'glucose']};
const calls = (customerCode, times) => times.map((atMs) => ({customerCode, atMs}));
const observation = (upstreamCalls, logs = ['request batch completed'], reqs = upstreamCalls) => ({
  requests: reqs.length ? reqs : [{customerCode: 'CUS-000123', atMs: 0}],
  upstreamCalls,
  responses: [],
  logs,
  requirements,
});
const spread = (n, step) => Array.from({length: n}, (_, i) => i * step);

test('good reference passes', () => {
  assert.deepEqual(evaluate(good(requests)), {pass: true, violations: []});
});

test('broken reference fails with violations naming requirements', () => {
  const result = evaluate(broken(requests));
  assert.equal(result.pass, false);
  assert.ok(result.violations.length > 0);
  assert.ok(result.violations.some((v) => v.startsWith('CACHE-1')));
});

test('result has exactly pass and violations', () => {
  assert.deepEqual(Object.keys(evaluate(good(requests))).sort(), ['pass', 'violations']);
  assert.deepEqual(Object.keys(evaluate(broken(requests))).sort(), ['pass', 'violations']);
});

test('valid refactor: different harmless log text still passes', () => {
  const obs = good(requests);
  obs.logs = ['all requests completed successfully with version 2', 'cache hit for CUS-000123'];
  assert.equal(evaluate(obs).pass, true);
});

test('valid refactor: unsorted upstream calls and different response shape pass', () => {
  const obs = observation([...calls('CUS-000123', [30000, 0]), ...calls('CUS-000456', [5])]);
  assert.equal(evaluate(obs).pass, true);
});

test('cache: refresh exactly at the TTL is valid, 1 ms earlier fails', () => {
  assert.equal(evaluate(observation(calls('CUS-000123', [0, 30000]))).pass, true);
  const result = evaluate(observation(calls('CUS-000123', [0, 29999])));
  assert.equal(result.pass, false);
  assert.ok(result.violations[0].startsWith('CACHE-1'));
});

test('cache: different customers have separate entries', () => {
  const obs = observation([...calls('CUS-000123', [0]), ...calls('CUS-000456', [10])]);
  assert.equal(evaluate(obs).pass, true);
});

test('cache: a second upstream call for the same customer inside the TTL fails', () => {
  const obs = observation([...calls('CUS-000123', [0]), ...calls('CUS-000456', [5]), ...calls('CUS-000123', [10])]);
  assert.equal(evaluate(obs).pass, false);
});

test('rate: 60 requests answered with one upstream call pass', () => {
  assert.equal(evaluate(observation(calls('CUS-000123', [0]), undefined, requests)).pass, true);
});

test('rate: 50 upstream calls in one second pass, 51 fail', () => {
  const fifty = [];
  const fiftyOne = [];
  for (let i = 0; i < 51; i++) {
    const call = {customerCode: `CUS-${i}`, atMs: i * 10};
    if (i < 50) fifty.push(call);
    fiftyOne.push(call);
  }
  assert.equal(evaluate(observation(fifty)).pass, true);
  const result = evaluate(observation(fiftyOne));
  assert.equal(result.pass, false);
  assert.ok(result.violations.some((v) => v.startsWith('RATE-1')));
});

test('rate: calls spread over more than a second pass', () => {
  const obs = observation(spread(100, 20).map((atMs, i) => ({customerCode: `CUS-${i}`, atMs})));
  assert.equal(evaluate(obs).pass, true);
});

test('rate: breach in the middle of the run is found on a rolling window', () => {
  const burst = spread(51, 5).map((atMs, i) => ({customerCode: `CUS-${i}`, atMs: 1700 + atMs}));
  const quiet = [{customerCode: 'CUS-A', atMs: 0}, {customerCode: 'CUS-B', atMs: 900}];
  assert.equal(evaluate(observation([...quiet, ...burst])).pass, false);
});

test('privacy: each forbidden fragment inside a log line fails', () => {
  for (const fragment of requirements.forbiddenLogFragments) {
    const result = evaluate(observation(calls('CUS-000123', [0]), ['ok', `lookup result ${fragment}=high`]));
    assert.equal(result.pass, false, fragment);
    assert.ok(result.violations.some((v) => v.startsWith('PRIVACY-1')));
  }
});

test('malformed or insufficient observations fail with a violation', () => {
  const bad = [
    undefined,
    null,
    {},
    'text',
    {...good(requests), requirements: undefined},
    {...good(requests), requests: []},
    {...good(requests), upstreamCalls: 'none'},
    {...good(requests), logs: [42]},
    {...good(requests), upstreamCalls: [{customerCode: 'CUS-000123', atMs: 'soon'}]},
  ];
  for (const obs of bad) {
    const result = evaluate(obs);
    assert.equal(result.pass, false);
    assert.ok(result.violations.length > 0 && result.violations.every((v) => typeof v === 'string' && v !== ''));
  }
});

test('evaluate does not change the observation', () => {
  const obs = observation([...calls('CUS-000123', [30000, 0])]);
  const before = JSON.stringify(obs);
  evaluate(obs);
  assert.equal(JSON.stringify(obs), before);
});
