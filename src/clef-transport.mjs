/**
 * clef-transport.mjs — JevTransport backed by Cloudflare Workers AI `clef`.
 *
 * clef is a 27B multimodal decision model that turns a state + a schema of
 * typed questions into decisions:
 *   POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/cloudflare/clef
 *   Authorization: Bearer {token}
 *   body: { model: "clef", state, questions }
 *   response envelope: { result: { answers, ... }, success: true }
 * (https://developers.cloudflare.com/workers-ai/models/clef/)
 *
 * This is a judgment transport for @jkudish/jev-browser: pass the object
 * returned by createClefTransport() as `transport` to navigate(). The
 * library's own ask() validates answers against the questions; the checks
 * here fail fast with clear errors before a browser step is spent.
 *
 * Credentials (env):
 *   CLOUDFLARE_API_TOKEN        Cloudflare API token (Workers AI read)
 *   JEV_CLOUDFLARE_API_TOKEN    same, takes precedence when both are set
 *   CLOUDFLARE_ACCOUNT_ID       Cloudflare account ID
 */

export const TRANSPORT_NAME = "clef";
export const CLEF_MODEL_ID = "@cf/cloudflare/clef"; // effective model reported in replies
const CLEF_BODY_MODEL = "clef"; // model field inside the request body, per docs

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

export function readClefCreds(env = process.env) {
  const token = env.JEV_CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) {
    throw new Error(
      "clef transport: set CLOUDFLARE_API_TOKEN (or JEV_CLOUDFLARE_API_TOKEN, which takes precedence) " +
        "and CLOUDFLARE_ACCOUNT_ID in the environment",
    );
  }
  return { token, accountId };
}

/** Build the exact HTTP request clef expects (pure — unit-testable). */
export function buildClefRequest(accountId, state, questions) {
  return {
    url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/clef`,
    body: { model: CLEF_BODY_MODEL, state, questions },
  };
}

function answerError(id, reason) {
  return new Error(`clef: answer "${id}": ${reason}`);
}

/**
 * Normalize one raw clef answer into a JevAnswer for the question's type.
 * clef returns noul answers as a bare probability number; choice/score
 * answers as objects carrying choice/score + probabilities.
 */
export function normalizeClefAnswer(id, question, raw) {
  const qtype = isRecord(question) ? question.type : undefined;
  if (qtype === "noul") {
    const p = isRecord(raw) ? raw.noul : raw;
    if (!isFiniteNumber(p) || p < 0 || p > 1) throw answerError(id, "noul must be a finite number in [0,1]");
    return { type: "noul", noul: p };
  }
  if (!isRecord(raw)) throw answerError(id, `expected an object for a ${qtype} answer`);
  const probabilities = raw.probabilities;
  if (!isRecord(probabilities) || Object.keys(probabilities).length === 0) {
    throw answerError(id, "probabilities must be a non-empty object");
  }
  for (const [key, value] of Object.entries(probabilities)) {
    if (!isFiniteNumber(value) || value < 0 || value > 1) {
      throw answerError(id, `probability for "${key}" must be a finite number in [0,1]`);
    }
  }
  const confidence = raw.confidence === undefined ? null : raw.confidence;
  if (confidence !== null && !isFiniteNumber(confidence)) {
    throw answerError(id, "confidence must be a finite number or omitted");
  }
  if (qtype === "choice") {
    if (typeof raw.choice !== "string" || raw.choice.length === 0) throw answerError(id, "choice must be a non-empty string");
    return { type: "choice", choice: raw.choice, probabilities, confidence };
  }
  if (qtype === "score") {
    if (!Number.isInteger(raw.score)) throw answerError(id, "score must be an integer");
    return { type: "score", score: raw.score, probabilities, confidence };
  }
  throw answerError(id, `unsupported question type "${String(qtype)}"`);
}

/**
 * Parse a Workers AI envelope into a JevTransportReply (pure — unit-testable).
 * Envelope: { result: { answers, usage?, ... }, success: true }.
 */
export function parseClefResponse(body, questions) {
  if (!isRecord(body) || !isRecord(body.result)) {
    throw new Error("clef: invalid response envelope (expected { result, success })");
  }
  if (body.success === false) throw new Error("clef: API reported success=false");
  const result = body.result;
  const answersRaw = result.answers;
  if (!isRecord(answersRaw)) throw new Error("clef: result.answers must be an object");
  const ids = Object.keys(questions ?? {});
  const answers = {};
  for (const id of ids) {
    if (!Object.hasOwn(answersRaw, id)) throw new Error(`clef: missing answer for question "${id}"`);
    answers[id] = normalizeClefAnswer(id, questions[id], answersRaw[id]);
  }
  const usage = result.usage;
  const pick = (key) =>
    isRecord(usage) && Number.isSafeInteger(usage[key]) && usage[key] >= 0 ? usage[key] : 0;
  return {
    answers,
    usage: { input_tokens: pick("input_tokens"), output_tokens: pick("output_tokens") },
    model: CLEF_MODEL_ID,
  };
}

/** Build a JevTransport. Throws with a clear message when credentials are missing. */
export function createClefTransport(env = process.env) {
  const { token, accountId } = readClefCreds(env);
  return {
    name: TRANSPORT_NAME,
    async ask({ state, questions, model, signal }) {
      const { url, body } = buildClefRequest(accountId, state, questions);
      let response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        throw new Error(`clef: request failed (network error): ${(err && err.message) || err}`);
      }
      const raw = await response.text().catch(() => {
        if (signal?.aborted) throw signal.reason;
        throw new Error(`clef: HTTP ${response.status} (body read error; 0 response bytes)`);
      });
      const bytes = Buffer.byteLength(raw);
      if (!response.ok) {
        // Attach numeric status so jev-agent-tools' ask() can classify
        // 429 / 5xx / other failures like it does for built-in transports.
        const err = new Error(`clef: HTTP ${response.status} (request failed; ${bytes} response bytes)`);
        err.status = response.status;
        throw err;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`clef: HTTP ${response.status} (invalid JSON; ${bytes} response bytes)`);
      }
      return parseClefResponse(parsed, questions);
    },
  };
}
