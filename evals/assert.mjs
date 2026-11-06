const WINDOW_MS = 1000;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isEvent = (event) =>
  isObject(event) && typeof event.customerCode === 'string' && typeof event.atMs === 'number' && Number.isFinite(event.atMs);
const isCount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// Malformed or insufficient evidence: returns messages, never throws.
function malformed(observation) {
  if (!isObject(observation)) return ['MALFORMED: observation must be an object'];
  const problems = [];
  const {requests, upstreamCalls, logs, requirements} = observation;
  if (!isObject(requirements)) {
    problems.push('MALFORMED: requirements is missing');
  } else {
    if (!isCount(requirements.maxRequestsPerSecond)) problems.push('MALFORMED: requirements.maxRequestsPerSecond must be a non-negative number');
    if (!isCount(requirements.cacheTtlMs)) problems.push('MALFORMED: requirements.cacheTtlMs must be a non-negative number');
    const fragments = requirements.forbiddenLogFragments;
    if (!Array.isArray(fragments) || fragments.some((f) => typeof f !== 'string')) {
      problems.push('MALFORMED: requirements.forbiddenLogFragments must be an array of strings');
    }
  }
  if (!Array.isArray(requests) || requests.length === 0) {
    problems.push('MALFORMED: requests must be a non-empty array (no evidence to evaluate)');
  } else if (!requests.every(isEvent)) {
    problems.push('MALFORMED: every request needs a string customerCode and a numeric atMs');
  }
  if (!Array.isArray(upstreamCalls)) {
    problems.push('MALFORMED: upstreamCalls must be an array');
  } else if (!upstreamCalls.every(isEvent)) {
    problems.push('MALFORMED: every upstream call needs a string customerCode and a numeric atMs');
  }
  if (!Array.isArray(logs) || logs.some((line) => typeof line !== 'string')) {
    problems.push('MALFORMED: logs must be an array of strings');
  }
  return problems;
}

// RATE-1: no half-open one-second window [t, t + 1000) holds more upstream calls than allowed.
function rateViolations(upstreamCalls, max) {
  const times = upstreamCalls.map((call) => call.atMs).sort((a, b) => a - b);
  let end = 0;
  let worst = 0;
  let worstStart = 0;
  for (let start = 0; start < times.length; start++) {
    if (end < start) end = start;
    while (end < times.length && times[end] < times[start] + WINDOW_MS) end++;
    if (end - start > worst) {
      worst = end - start;
      worstStart = times[start];
    }
  }
  if (worst <= max) return [];
  return [`RATE-1: ${worst} upstream calls within one second starting at ${worstStart} ms (limit ${max})`];
}

// CACHE-1: per customer, consecutive upstream calls are at least cacheTtlMs apart.
function cacheViolations(upstreamCalls, ttlMs) {
  const byCustomer = new Map();
  for (const call of upstreamCalls) {
    if (!byCustomer.has(call.customerCode)) byCustomer.set(call.customerCode, []);
    byCustomer.get(call.customerCode).push(call.atMs);
  }
  const violations = [];
  for (const [customerCode, times] of byCustomer) {
    times.sort((a, b) => a - b);
    let early = 0;
    let first = '';
    for (let i = 1; i < times.length; i++) {
      const gap = times[i] - times[i - 1];
      if (gap < ttlMs) {
        if (early === 0) first = `after ${gap} ms at ${times[i]} ms`;
        early++;
      }
    }
    if (early > 0) {
      violations.push(`CACHE-1: ${customerCode} called upstream ${early} time(s) inside the ${ttlMs} ms cache TTL, first ${first}`);
    }
  }
  return violations;
}

// PRIVACY-1: no log line contains a forbidden fragment.
function privacyViolations(logs, fragments) {
  const violations = [];
  logs.forEach((line, index) => {
    for (const fragment of fragments) {
      if (fragment !== '' && line.includes(fragment)) {
        violations.push(`PRIVACY-1: log line ${index} contains forbidden fragment "${fragment}"`);
      }
    }
  });
  return violations;
}

export function evaluate(observation) {
  const problems = malformed(observation);
  if (problems.length > 0) return {pass: false, violations: problems};

  const {upstreamCalls, logs, requirements} = observation;
  const violations = [
    ...cacheViolations(upstreamCalls, requirements.cacheTtlMs),
    ...rateViolations(upstreamCalls, requirements.maxRequestsPerSecond),
    ...privacyViolations(logs, requirements.forbiddenLogFragments),
  ];
  return {pass: violations.length === 0, violations};
}
