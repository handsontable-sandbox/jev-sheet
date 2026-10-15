// jev-sheet Worker: the classifier API behind the JevSheet demo on demos.handsontable.com.
// It proxies /api/classify to Jev, serves the share image, and redirects every other path to the
// demo. No logging, no storage. The only thing this Worker holds is JEV_API_KEY.

// ---------------------------------------------------------------------------
// Jev (TypeSafe AI) API — verified against https://docs.typesafe.ai/api and
// live calls on 2026-10-07. Everything the app knows about Jev lives here.
// ---------------------------------------------------------------------------
const JEV = {
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  model: 'jev-latest', // alias → jev-1.13.0
  authHeader: (key) => `Bearer ${key}`,
  // Request:  { model, state: string|object|array, questions: { [id]: Question } }
  // Question: { type: 'noul'|'score'|'choice' (lowercase!), instructions, criteria }
  //   noul   criteria?: { true: desc, false: desc }
  //   choice criteria:  { [option]: desc|null }        (2..255 options)
  //   score  criteria:  [level0, level1, ...]          (2..10 ordered levels, low → high)
  // Response: { model, answers: { [id]: Answer }, usage: { input_tokens, output_tokens } }
  //   noul   { type:'noul',   noul: 0..1 }                               (no confidence field)
  //   choice { type:'choice', choice, probabilities, confidence: 0..1 }
  //   score  { type:'score',  score: 0..levels-1 (fractional), legend, probabilities, confidence: 0..1 }
  // Errors:   { detail: { error_type, message } } with 400 / 401 / 422 / 429 / 529
  maxChoiceOptions: 255,
  minScoreLevels: 2,
  maxScoreLevels: 10,
};

// Per-request limits. The rows-per-column cap lives in the front end (demo/index.js,
// MAX_ROWS_PER_COLUMN), since each row is its own request; the per-caller rate limit in
// wrangler.jsonc bounds the total.
const MAX_ROW_BYTES = 4096;
const MAX_PROMPT_CHARS = 2000;
const MAX_OPTION_CHARS = 120;
// Fallback only: the front end always sends explicit levels (and shows them in the config grid).
const DEFAULT_SCORE_LEVELS = ['Very low', 'Low', 'Medium', 'High', 'Very high'];
const TYPES = new Set(['noul', 'score', 'choice']);

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === '/api/classify') {
      // Browsers send Origin on every cross-origin request and every POST. Only pages on an allowed
      // origin may call the classifier: this Worker's own and those in ALLOWED_ORIGINS.
      const origin = request.headers.get('Origin');
      if (!allowedOrigins(request, env).has(origin)) return withHeaders(json({ error: 'Forbidden' }, 403));
      const cors = (res) => withCors(withHeaders(res), origin, request);
      if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
      if (request.method !== 'POST') return cors(json({ error: 'Method not allowed' }, 405));
      // Per-caller rate limit (RATE_LIMITER binding in wrangler.jsonc). Counted per Cloudflare
      // location and approximate; the IP is the only caller id a public page has.
      if (env.RATE_LIMITER) {
        const { success } = await env.RATE_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' });
        if (!success) return cors(json({ error: 'Too many requests, slow down' }, 429));
      }
      return cors(await classify(request, env));
    }
    if (pathname.startsWith('/api/')) return withHeaders(json({ error: 'Not found' }, 404));
    // The share image is referenced by the demo's link-preview tags.
    if (pathname === '/og.png') return withHeaders(await env.ASSETS.fetch(request));
    // The app itself lives on demos.handsontable.com now; old links land there.
    return withHeaders(Response.redirect(env.DEMO_URL, 302));
  },
};

async function classify(request, env) {
  if (!env.JEV_API_KEY) return json({ error: 'Server is not configured' }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON' }, 400);
  }

  const parsed = validate(body);
  if (parsed.error) return json({ error: parsed.error }, 400);
  const { type, prompt, options, row } = parsed;

  const question = { type, instructions: prompt };
  let levels;
  if (type === 'choice') {
    question.criteria = Object.fromEntries(options.map((o) => [o, null]));
  } else if (type === 'score') {
    levels = options && options.length ? options : DEFAULT_SCORE_LEVELS;
    question.criteria = levels;
  }

  let upstream;
  try {
    upstream = await fetch(JEV.endpoint, {
      method: 'POST',
      headers: {
        Authorization: JEV.authHeader(env.JEV_API_KEY),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: JEV.model, state: row, questions: { q: question } }),
    });
  } catch {
    return json({ error: 'Could not reach the classifier' }, 502);
  }

  if (!upstream.ok) {
    // Never forward Jev's body: it is not needed and we don't want to leak anything.
    if (upstream.status === 429) return json({ error: 'Rate limited, try again shortly' }, 429);
    if (upstream.status === 529) return json({ error: 'Classifier is overloaded, try again shortly' }, 503);
    if (upstream.status === 401) return json({ error: 'Classifier rejected the server credentials' }, 502);
    if (upstream.status >= 400 && upstream.status < 500) return json({ error: 'Classifier rejected the request' }, 400);
    return json({ error: 'Classifier error' }, 502);
  }

  let data;
  try {
    data = await upstream.json();
  } catch {
    return json({ error: 'Unreadable classifier response' }, 502);
  }
  const answer = data && data.answers && data.answers.q;
  if (!answer || answer.type !== type) return json({ error: 'Unexpected classifier response' }, 502);

  return json(normalize(answer, levels));
}

function normalize(answer, levels) {
  switch (answer.type) {
    case 'noul': {
      const p = clamp01(answer.noul);
      // Jev returns a single probability of "yes"; that is the value. Its docs suggest |2p - 1| as a
      // confidence-style number (0 at 50/50, 1 at either extreme).
      return { value: round(p), confidence: round(Math.abs(2 * p - 1)) };
    }
    case 'score': {
      const top = Math.max(1, levels.length - 1);
      // The most likely level (highest probability) is the label a person would pick from the list.
      let best = null;
      let bestP = -1;
      for (const [idx, p] of Object.entries(answer.probabilities || {})) {
        if (typeof p === 'number' && p > bestP) {
          bestP = p;
          best = idx;
        }
      }
      const label = (answer.legend && answer.legend[best]) || levels[Number(best)] || null;
      return { value: round(clamp01(answer.score / top)), confidence: round(clamp01(answer.confidence)), label };
    }
    case 'choice':
      return { value: String(answer.choice), confidence: round(clamp01(answer.confidence)) };
    default:
      return { value: null, confidence: 0 };
  }
}

function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Invalid request shape' };
  const { type, prompt, options, row } = body;

  if (!TYPES.has(type)) return { error: 'type must be noul, score, or choice' };
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_CHARS) {
    return { error: `prompt must be a non-empty string up to ${MAX_PROMPT_CHARS} characters` };
  }
  if (!row || typeof row !== 'object' || Array.isArray(row)) return { error: 'row must be an object' };
  if (JSON.stringify(row).length > MAX_ROW_BYTES) return { error: `row exceeds ${MAX_ROW_BYTES} bytes` };
  for (const v of Object.values(row)) {
    if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) {
      return { error: 'row values must be strings, numbers, booleans, or null' };
    }
  }

  let cleanOptions;
  if (options !== undefined) {
    if (!Array.isArray(options) || !options.every((o) => typeof o === 'string')) {
      return { error: 'options must be an array of strings' };
    }
    cleanOptions = [...new Set(options.map((o) => o.trim()).filter(Boolean))];
    if (cleanOptions.some((o) => o.length > MAX_OPTION_CHARS)) {
      return { error: `each option must be at most ${MAX_OPTION_CHARS} characters` };
    }
  }

  if (type === 'choice') {
    if (!cleanOptions || cleanOptions.length < 2 || cleanOptions.length > JEV.maxChoiceOptions) {
      return { error: `choice needs between 2 and ${JEV.maxChoiceOptions} distinct options` };
    }
  } else if (type === 'score') {
    if (cleanOptions && cleanOptions.length) {
      if (cleanOptions.length < JEV.minScoreLevels || cleanOptions.length > JEV.maxScoreLevels) {
        return { error: `score levels must be between ${JEV.minScoreLevels} and ${JEV.maxScoreLevels}` };
      }
    } else {
      cleanOptions = undefined;
    }
  } else {
    cleanOptions = undefined;
  }

  return { type, prompt: prompt.trim(), options: cleanOptions, row };
}

function allowedOrigins(request, env) {
  const extra = String(env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
  return new Set([new URL(request.url).origin, ...extra]);
}

// CORS headers for a caller on another allowed origin. Same-origin callers need none.
function withCors(res, origin, request) {
  if (origin === new URL(request.url).origin) return res;
  res.headers.set('Access-Control-Allow-Origin', origin);
  res.headers.set('Vary', 'Origin');
  if (request.method === 'OPTIONS') {
    res.headers.set('Access-Control-Allow-Methods', 'POST');
    res.headers.set('Access-Control-Allow-Headers', 'Content-Type');
    res.headers.set('Access-Control-Max-Age', '86400');
  }
  return res;
}

function withHeaders(res) {
  const out = new Response(res.body, res);
  out.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return out;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const round = (n) => Math.round(n * 1000) / 1000;
