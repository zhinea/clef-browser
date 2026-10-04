/**
 * test-transport.mjs — offline verification of the clef transport.
 *
 * Covers: request URL/body shape, Workers AI envelope parsing, answer
 * normalization (noul/choice/score), rejection of malformed answers, and
 * credential resolution. Makes NO network calls.
 *
 * Once CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID are set, a live smoke
 * test is one call away:
 *
 *   node -e "
 *     import('./src/clef-transport.mjs').then(async ({ createClefTransport }) => {
 *       const t = createClefTransport();
 *       const reply = await t.ask({
 *         state: 'A page shows a single button labeled Buy.',
 *         questions: { done: { type: 'noul', instructions: 'Is the goal done?' } },
 *         model: 'jev-latest',
 *         signal: AbortSignal.timeout(30000),
 *       });
 *       console.log(JSON.stringify(reply, null, 2));
 *     });"
 */
import assert from "node:assert/strict";
import {
  TRANSPORT_NAME,
  CLEF_MODEL_ID,
  readClefCreds,
  buildClefRequest,
  normalizeClefAnswer,
  parseClefResponse,
  createClefTransport,
} from "./src/clef-transport.mjs";

let passed = 0;
const ok = (name, fn) => {
  fn();
  passed++;
  console.log(`ok - ${name}`);
};
const throws = (name, fn, pattern) => {
  assert.throws(fn, pattern);
  passed++;
  console.log(`ok - ${name}`);
};

// ── 1. request shape ────────────────────────────────────────────────────────
ok("transport name is clef", () => {
  assert.equal(TRANSPORT_NAME, "clef");
  assert.equal(CLEF_MODEL_ID, "@cf/cloudflare/clef");
});

ok("buildClefRequest: URL + body per clef docs", () => {
  const state = { task: "buy milk", current_page: { url: "https://x.test" } };
  const questions = { action: { type: "choice", instructions: "?", criteria: { a: "A", b: "B" } } };
  const { url, body } = buildClefRequest("acct123", state, questions);
  assert.equal(url, "https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/@cf/cloudflare/clef");
  assert.equal(body.model, "clef"); // top-level, per docs
  assert.deepEqual(body.state, state);
  assert.deepEqual(body.questions, questions);
  assert.ok(!("input" in body), "clef takes state/questions top-level, not nested under input");
});

// ── 2. credential resolution ────────────────────────────────────────────────
ok("readClefCreds: JEV_ prefix takes precedence", () => {
  const c = readClefCreds({
    CLOUDFLARE_API_TOKEN: "plain",
    JEV_CLOUDFLARE_API_TOKEN: "jev-first",
    CLOUDFLARE_ACCOUNT_ID: "acct",
  });
  assert.equal(c.token, "jev-first");
  assert.equal(c.accountId, "acct");
});

ok("readClefCreds: falls back to CLOUDFLARE_API_TOKEN", () => {
  const c = readClefCreds({ CLOUDFLARE_API_TOKEN: "plain", CLOUDFLARE_ACCOUNT_ID: "acct" });
  assert.equal(c.token, "plain");
});

throws("readClefCreds: missing token throws", () => readClefCreds({ CLOUDFLARE_ACCOUNT_ID: "a" }), /CLOUDFLARE_API_TOKEN/);
throws("readClefCreds: missing account throws", () => readClefCreds({ CLOUDFLARE_API_TOKEN: "t" }), /CLOUDFLARE_ACCOUNT_ID/);
throws("createClefTransport: no creds -> clear error, no network", () => createClefTransport({}), /CLOUDFLARE_API_TOKEN/);

// ── 3. answer normalization ─────────────────────────────────────────────────
const choiceQ = { type: "choice", instructions: "?", criteria: { click_j1: "Buy", done: "Done" } };
const noulQ = { type: "noul", instructions: "?" };
const scoreQ = { type: "score", instructions: "?", criteria: ["low", "high"] };

ok("noul: bare probability number normalizes", () => {
  assert.deepEqual(normalizeClefAnswer("g", noulQ, 0.92), { type: "noul", noul: 0.92 });
});

ok("noul: {noul} object normalizes", () => {
  assert.deepEqual(normalizeClefAnswer("g", noulQ, { noul: 0.1 }), { type: "noul", noul: 0.1 });
});

throws("noul: out-of-range rejects", () => normalizeClefAnswer("g", noulQ, 1.5), /\[0,1\]/);

ok("choice: {choice, probabilities} normalizes (+confidence)", () => {
  const a = normalizeClefAnswer("a", choiceQ, {
    choice: "click_j1",
    probabilities: { click_j1: 0.7, done: 0.3 },
    confidence: 0.8,
  });
  assert.deepEqual(a, {
    type: "choice",
    choice: "click_j1",
    probabilities: { click_j1: 0.7, done: 0.3 },
    confidence: 0.8,
  });
});

throws("choice: missing probabilities rejects", () => normalizeClefAnswer("a", choiceQ, { choice: "done" }), /probabilities/);
throws("choice: bad probability rejects", () => normalizeClefAnswer("a", choiceQ, { choice: "done", probabilities: { click_j1: 2, done: -1 } }), /probability/);

ok("score: {score, probabilities} normalizes", () => {
  const a = normalizeClefAnswer("s", scoreQ, { score: 1, probabilities: { 0: 0.2, 1: 0.8 } });
  assert.equal(a.type, "score");
  assert.equal(a.score, 1);
  assert.equal(a.confidence, null);
});

throws("score: non-integer rejects", () => normalizeClefAnswer("s", scoreQ, { score: 1.5, probabilities: { 0: 0.5, 1: 0.5 } }), /integer/);

// ── 4. envelope parsing ─────────────────────────────────────────────────────
const dummyQuestions = {
  action: choiceQ,
  goal_done: noulQ,
  stuck: noulQ,
};

function dummyEnvelope(overrides = {}) {
  return {
    success: true,
    result: {
      answers: {
        action: { choice: "done", probabilities: { click_j1: 0.2, done: 0.8 } },
        goal_done: 0.95,
        stuck: { noul: 0.05 },
      },
      usage: { input_tokens: 1234, output_tokens: 56 },
      ...overrides,
    },
  };
}

ok("parseClefResponse: full envelope -> reply", () => {
  const reply = parseClefResponse(dummyEnvelope(), dummyQuestions);
  assert.equal(reply.model, "@cf/cloudflare/clef");
  assert.deepEqual(reply.usage, { input_tokens: 1234, output_tokens: 56 });
  assert.equal(reply.answers.action.type, "choice");
  assert.equal(reply.answers.goal_done.noul, 0.95);
  assert.equal(reply.answers.stuck.noul, 0.05);
});

ok("parseClefResponse: missing usage -> zeros", () => {
  const reply = parseClefResponse(dummyEnvelope({ usage: undefined }), dummyQuestions);
  assert.deepEqual(reply.usage, { input_tokens: 0, output_tokens: 0 });
});

throws("parseClefResponse: success=false rejects", () => parseClefResponse({ success: false, result: {} }, dummyQuestions), /success=false/);
throws("parseClefResponse: answers not an object rejects", () => parseClefResponse(dummyEnvelope({ answers: null }), dummyQuestions), /answers must be an object/);
throws("parseClefResponse: missing answer id rejects", () => {
  const env = dummyEnvelope();
  delete env.result.answers.stuck;
  parseClefResponse(env, dummyQuestions);
}, /missing answer/);

console.log(`\n${passed} assertions passed — transport format verified offline (no API calls made).`);
