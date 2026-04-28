/**
 * Ground-level tactical hints from VenueMatchEntry ledger (not real-world pitch reports).
 * Optional LLM narrative: Google Gemini (free tier via AI Studio) and/or OpenAI — see enrichVenueInsightWithLLM.
 */

const classifyBowlingStyle = (styleStr) => {
  const s = (styleStr || '').toLowerCase();
  if (s.includes('spin')) return 'spin';
  if (s.includes('slow')) return 'spin';
  if (s.includes('medium') || s.includes('fast') || s.includes('pace')) return 'pace';
  return 'unknown';
};

/** Roster fields + rule-based class for the LLM (no name-guessing). */
const annotateBowlersForSnapshot = (bowlers) =>
  (bowlers || []).map((b) => ({
    name: b.name,
    role: b.role || null,
    styleFromRoster: b.style || null,
    wicketsAtVenue: b.wickets,
    bowlingType: classifyBowlingStyle(b.style),
  }));

/**
 * @param {object} params
 * @param {{ matches: number, avgRunsBattingFirst: number, avgRunsBattingSecond: number, batFirstWinRate: number }|null} [params.inningsOrderStats] from ledger when both teams have teamInningsOrder
 */
const tossLeanFromNumbers = ({
  avgTeamInnings,
  wktsPerTeamInnings,
  closeChaseRate,
  matches,
  inningsOrderStats = null,
}) => {
  if (!matches || matches < 2) {
    return {
      key: 'insufficient_data',
      label: 'Need more matches',
      summary:
        'With fewer than two completed games at this ground, toss trends are mostly guesswork — use your gut and conditions.',
      inningsOrder: null,
    };
  }

  const ios = inningsOrderStats;
  const iosOk = ios && ios.matches >= 2;

  let inningsPrefix = '';
  if (
    iosOk &&
    Number.isFinite(ios.avgRunsBattingFirst) &&
    Number.isFinite(ios.avgRunsBattingSecond)
  ) {
    const af = Math.round(ios.avgRunsBattingFirst);
    const asCh = Math.round(ios.avgRunsBattingSecond);
    inningsPrefix = `Across ${ios.matches} match(es) where batting order is known, first innings averaged ~${af} and the chase ~${asCh}. `;
    if (Number.isFinite(ios.batFirstWinRate)) {
      inningsPrefix += `The side batting first won ${Math.round(ios.batFirstWinRate * 100)}% of those games. `;
    }
  }

  let batFirstScore = 0;
  let bowlFirstScore = 0;

  if (avgTeamInnings >= 132) batFirstScore += 2;
  else if (avgTeamInnings <= 118) bowlFirstScore += 2;

  if (wktsPerTeamInnings >= 5) bowlFirstScore += 2;
  else if (wktsPerTeamInnings <= 3.2) batFirstScore += 1;

  if (closeChaseRate >= 0.35) {
    batFirstScore += 0.5;
    bowlFirstScore += 0.5;
  }

  if (iosOk) {
    const af = ios.avgRunsBattingFirst;
    const asCh = ios.avgRunsBattingSecond;
    if (Number.isFinite(af) && Number.isFinite(asCh)) {
      if (af >= asCh + 8) batFirstScore += 2;
      else if (asCh >= af + 8) bowlFirstScore += 2;
      else if (asCh > af + 3) bowlFirstScore += 1;
      else if (af > asCh + 3) batFirstScore += 1;
    }
    const wf = ios.batFirstWinRate;
    if (Number.isFinite(wf)) {
      if (wf >= 0.58) batFirstScore += 1.5;
      else if (wf <= 0.42) bowlFirstScore += 1.5;
      else if (wf >= 0.52) batFirstScore += 0.5;
      else if (wf <= 0.48) bowlFirstScore += 0.5;
    }
  }

  const inningsPayload =
    iosOk && Number.isFinite(ios.avgRunsBattingFirst)
      ? {
          matchesUsed: ios.matches,
          avgRunsBattingFirst: Number(ios.avgRunsBattingFirst.toFixed(1)),
          avgRunsBattingSecond: Number(ios.avgRunsBattingSecond.toFixed(1)),
          batFirstWinRate:
            ios.batFirstWinRate != null ? Number(ios.batFirstWinRate.toFixed(2)) : null,
        }
      : null;

  if (batFirstScore > bowlFirstScore + 0.5) {
    return {
      key: 'lean_bat_first',
      label: 'Lean: bat first',
      summary:
        inningsPrefix +
        'Scores, wicket rates, and (where known) innings splits suggest posting a total is often the safer play — especially if your batting is your strength.',
      inningsOrder: inningsPayload,
    };
  }
  if (bowlFirstScore > batFirstScore + 0.5) {
    return {
      key: 'lean_bowl_first',
      label: 'Lean: bowl first',
      summary:
        inningsPrefix +
        'The numbers — including chase vs first-innings totals where recorded — favour using the ball first or backing your chase.',
      inningsOrder: inningsPayload,
    };
  }
  return {
    key: 'neutral',
    label: 'Toss: flexible',
    summary:
      inningsPrefix +
      'The ledger does not strongly favour either innings — captain’s read on the day still matters.',
    inningsOrder: inningsPayload,
  };
};

const spinPaceFromBowlers = (bowlers) => {
  let spinWkts = 0;
  let paceWkts = 0;
  let unkWkts = 0;
  for (const b of bowlers) {
    const w = b.wickets || 0;
    if (w <= 0) continue;
    const t = classifyBowlingStyle(b.style);
    if (t === 'spin') spinWkts += w;
    else if (t === 'pace') paceWkts += w;
    else unkWkts += w;
  }
  const known = spinWkts + paceWkts;
  if (known < 3) {
    return {
      recommendation: 'insufficient_data',
      label: 'Spin vs pace',
      summary:
        'Not enough wickets from bowlers with a spin/pace style on file — once the ledger grows, this split will sharpen.',
      spinWicketShare: known ? spinWkts / known : null,
      paceWicketShare: known ? paceWkts / known : null,
    };
  }
  const spinShare = spinWkts / known;
  const paceShare = paceWkts / known;
  if (spinShare >= 0.58) {
    return {
      recommendation: 'lean_spin',
      label: 'Lean: more spin',
      summary:
        'Wickets in your saved games skew toward spinners — an extra turn option (or part-timer) is often worth it here.',
      spinWicketShare: spinShare,
      paceWicketShare: paceShare,
    };
  }
  if (paceShare >= 0.58) {
    return {
      recommendation: 'lean_pace',
      label: 'Lean: more pace',
      summary:
        'Pace bowlers have done more damage in the ledger — keep your quicker options in the plan.',
      spinWicketShare: spinShare,
      paceWicketShare: paceShare,
    };
  }
  return {
    recommendation: 'mixed',
    label: 'Spin vs pace',
    summary:
      'Spinners and quicks both take wickets in your saved games — pick on form and match-ups rather than one default type.',
    spinWicketShare: spinShare,
    paceWicketShare: paceShare,
  };
};

const buildHeuristicNarrative = ({
  venueStr,
  totals,
  toss,
  spinPace,
  assets,
  closeChaseRate,
  matches,
}) => {
  const parts = [
    `**${venueStr}** — from ${matches || 0} match(es) in your ledger.`,
    toss.summary,
  ];
  if (spinPace.recommendation === 'lean_spin' || spinPace.recommendation === 'lean_pace') {
    parts.push(spinPace.summary);
  }
  if (assets?.batters?.length) {
    parts.push(
      `Stand-out batters here: ${assets.batters.map((b) => `${b.name} (${b.runs} runs)`).join(', ')}.`
    );
  }
  if (assets?.bowlers?.length) {
    parts.push(
      `Bowling threats: ${assets.bowlers.map((b) => `${b.name} (${b.wickets} wkts)`).join(', ')}.`
    );
  }
  if (matches >= 2 && closeChaseRate != null) {
    parts.push(
      `${Math.round(closeChaseRate * 100)}% of two-team games were “tight” (loser within ~85% of winner) — margins can stay small.`
    );
  }
  parts.push(
    '_This is analytics on your league scorecards only — not a real pitch report. Use it as a conversation starter, not gospel._'
  );
  return parts.join('\n\n');
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const VENUE_AI_SYSTEM_PROMPT = `You are a T20 tactics assistant for a fantasy auction league.

The JSON may include inningsOrder: { matchesUsed, avgRunsBattingFirst, avgRunsBattingSecond, batFirstWinRate } from scorecards where batting order was recorded — use it for toss advice when present.

CRITICAL — bowler type (spinner vs pace):
- Each player’s bowling type comes ONLY from the JSON fields styleFromRoster and bowlingType (spin | pace | unknown).
- bowlingType is computed at request time from the league database field Player.style (not from your training data).
- If bowlingType is "unknown", say roster data doesn’t classify them — do NOT infer from player names, famous cricketers, or external knowledge.
- Spin vs pace *tactical* advice must agree with wicket totals at this venue combined with those classifications.

You ONLY use the JSON facts given — no invented stadium or weather. Output 4–7 short bullet points in Markdown: toss, spin vs pace (name who is spin vs pace only when bowlingType allows), main assets, one caveat. Friendly, humble tone.`;

const getMaxLlmAttempts = () =>
  Math.min(
    5,
    Math.max(
      1,
      parseInt(
        process.env.VENUE_AI_MAX_ATTEMPTS || process.env.OPENAI_VENUE_MAX_ATTEMPTS || '2',
        10
      ) || 2
    )
  );

/** auto → Gemini if GEMINI_API_KEY set, else OpenAI. Explicit gemini|openai forces provider. */
const resolveVenueAiProvider = () => {
  const raw = (process.env.VENUE_AI_PROVIDER || 'auto').toLowerCase().trim();
  const geminiKey = process.env.GEMINI_API_KEY && String(process.env.GEMINI_API_KEY).trim();
  const openaiKey = process.env.OPENAI_API_KEY && String(process.env.OPENAI_API_KEY).trim();
  if (raw === 'gemini') return geminiKey ? 'gemini' : null;
  if (raw === 'openai') return openaiKey ? 'openai' : null;
  if (geminiKey) return 'gemini';
  if (openaiKey) return 'openai';
  return null;
};

const inferOpenAIErrorKind = (e) => {
  const status = e.response?.status;
  if (status === 401) return 'auth';
  if (status === 429) {
    const errBody = (e.response?.data?.error?.message || '').toLowerCase();
    const quota =
      errBody.includes('quota') ||
      errBody.includes('billing') ||
      errBody.includes('exceeded your current') ||
      errBody.includes('insufficient_quota');
    return quota ? 'quota' : 'rate_limit';
  }
  if (status === 503 || status === 502) return 'unavailable';
  return 'other';
};

/**
 * Short user-facing errors (avoid long banners on every page load).
 */
const formatOpenAIError = (e) => {
  const status = e.response?.status;
  const data = e.response?.data;
  const apiMsg =
    data?.error?.message ||
    data?.error?.code ||
    data?.message ||
    null;
  if (status === 429) {
    const lower = (apiMsg || '').toLowerCase();
    const isQuota =
      lower.includes('quota') ||
      lower.includes('billing') ||
      lower.includes('exceeded your current') ||
      lower.includes('insufficient_quota');
    if (isQuota) {
      return 'OpenAI quota or billing — add credits at platform.openai.com/account/billing';
    }
    return 'OpenAI rate limit — wait a minute and try again';
  }
  if (status === 401) {
    return 'Invalid OpenAI API key (check .env)';
  }
  if (status === 402 || status === 403) {
    return `OpenAI returned ${status} — check model access and billing`;
  }
  if (status === 503 || status === 502) {
    return 'OpenAI temporarily unavailable — try again later';
  }
  if (apiMsg) return apiMsg.length > 120 ? `${apiMsg.slice(0, 117)}…` : apiMsg;
  return e.message || 'OpenAI request failed';
};

const inferGeminiErrorKind = (e) => {
  const status = e.response?.status;
  const err = e.response?.data?.error || {};
  const msg = (err.message || '').toLowerCase();
  const statusField = (err.status || '').toLowerCase();
  if (status === 401 || status === 403) return 'auth';
  if (status === 429 || statusField === 'resource_exhausted') {
    if (
      statusField === 'resource_exhausted' ||
      msg.includes('quota') ||
      msg.includes('exceeded') ||
      msg.includes('billing')
    ) {
      return 'quota';
    }
    return 'rate_limit';
  }
  if (msg.includes('rate limit') || msg.includes('too many requests')) return 'rate_limit';
  if (status === 503 || status === 502) return 'unavailable';
  return 'other';
};

const formatGeminiError = (e) => {
  const status = e.response?.status;
  const apiMsg = e.response?.data?.error?.message || null;
  const kind = inferGeminiErrorKind(e);
  if (kind === 'quota') {
    return apiMsg && apiMsg.length < 180
      ? apiMsg
      : 'Daily free-tier or project quota reached for this Gemini key.';
  }
  if (kind === 'rate_limit') return 'Gemini rate limit — wait a minute';
  if (kind === 'auth') return 'Invalid Gemini API key — get one at aistudio.google.com/app/apikey';
  if (kind === 'unavailable') return 'Gemini temporarily unavailable — try again later';
  if (apiMsg) return apiMsg.length > 120 ? `${apiMsg.slice(0, 117)}…` : apiMsg;
  return e.message || 'Gemini request failed';
};

/** Model IDs change; Google returns 404 if a name is retired for your key. */
const isGeminiModelNotFound = (e) => {
  const status = e.response?.status;
  const msg = (e.response?.data?.error?.message || '').toLowerCase();
  if (status === 404) return true;
  if (msg.includes('not found') && msg.includes('model')) return true;
  if (msg.includes('not supported for generatecontent')) return true;
  if (msg.includes('call listmodels')) return true;
  return false;
};

/**
 * Ordered list: env first (if set), then current API defaults that support generateContent.
 * @see https://ai.google.dev/api/rest/v1beta/models/list
 */
const geminiModelCandidates = () => {
  const fromEnv = (process.env.GEMINI_VENUE_MODEL || '').trim();
  const chain = fromEnv
    ? [
        fromEnv,
        'gemini-2.0-flash',
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
        'gemini-1.5-flash-8b',
      ]
    : [
        'gemini-2.0-flash',
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
        'gemini-1.5-flash-8b',
        'gemini-1.5-flash',
      ];
  return [...new Set(chain.filter(Boolean))];
};

/**
 * Google Gemini (Developer API) — generous free tier via Google AI Studio.
 * @see https://aistudio.google.com/app/apikey
 */
const enrichWithGemini = async ({ axios, apiKey, snapshot }) => {
  if (!apiKey || !axios) return null;
  const maxAttempts = getMaxLlmAttempts();
  const models = geminiModelCandidates();

  const body = {
    systemInstruction: { parts: [{ text: VENUE_AI_SYSTEM_PROMPT }] },
    contents: [
      {
        role: 'user',
        parts: [{ text: JSON.stringify(snapshot) }],
      },
    ],
    generationConfig: {
      temperature: 0.45,
      maxOutputTokens: 512,
    },
  };

  let lastErr = null;

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent`;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const res = await axios.post(url, body, {
          params: { key: apiKey },
          headers: { 'Content-Type': 'application/json' },
          timeout: 25000,
        });
        const cand = res.data?.candidates?.[0];
        const reason = cand?.finishReason;
        if (reason && reason !== 'STOP' && reason !== 'MAX_TOKENS') {
          if (reason === 'SAFETY') {
            return {
              error: 'Gemini declined to respond (safety filter).',
              kind: 'other',
            };
          }
          return { error: `Gemini returned no usable text (${reason}).`, kind: 'other' };
        }
        const parts = cand?.content?.parts || [];
        const text = parts.map((p) => p.text || '').join('').trim();
        if (!text) {
          return { error: 'Gemini returned no text', kind: 'other' };
        }
        return text;
      } catch (e) {
        lastErr = e;
        if (isGeminiModelNotFound(e)) {
          break;
        }
        const kind = inferGeminiErrorKind(e);
        if (kind === 'quota' || kind === 'auth') {
          return { error: formatGeminiError(e), kind };
        }
        const status = e.response?.status;
        const errData = e.response?.data?.error || {};
        const errBody = (errData.message || '').toLowerCase();
        const errStatus = String(errData.status || '').toLowerCase();
        const quotaHit =
          status === 429 &&
          (errStatus === 'resource_exhausted' ||
            errBody.includes('quota') ||
            errBody.includes('exceeded') ||
            errBody.includes('billing'));
        const retryable = status === 503 || (status === 429 && !quotaHit);
        if (retryable && attempt < maxAttempts - 1) {
          const waitMs = Math.min(8000, 2000 * (attempt + 1));
          await sleep(waitMs);
          continue;
        }
        return { error: formatGeminiError(e), kind };
      }
    }
  }

  if (lastErr) {
    return { error: formatGeminiError(lastErr), kind: inferGeminiErrorKind(lastErr) };
  }
  return { error: 'No Gemini model worked for this key — list models at ai.google.dev/api/rest/v1beta/models', kind: 'other' };
};

/**
 * @param {object} params
 * @param {import('axios').default} params.axios
 * @param {string} [params.apiKey]
 * @param {object} params.snapshot - compact JSON-safe insight snapshot
 */
const enrichWithOpenAI = async ({ axios, apiKey, snapshot }) => {
  if (!apiKey || !axios) return null;

  const maxAttempts = getMaxLlmAttempts();

  const body = {
    model: process.env.OPENAI_VENUE_MODEL || 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: VENUE_AI_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: JSON.stringify(snapshot),
      },
    ],
    max_tokens: 350,
    temperature: 0.45,
  };

  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await axios.post('https://api.openai.com/v1/chat/completions', body, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 25000,
      });
      const text = res.data?.choices?.[0]?.message?.content;
      return typeof text === 'string' ? text.trim() : null;
    } catch (e) {
      lastErr = e;
      const status = e.response?.status;
      const errBody = (e.response?.data?.error?.message || '').toLowerCase();
      const quota429 =
        status === 429 &&
        (errBody.includes('quota') ||
          errBody.includes('billing') ||
          errBody.includes('exceeded your current') ||
          errBody.includes('insufficient_quota'));
      const retryable =
        status === 503 || (status === 429 && !quota429);
      if (retryable && attempt < maxAttempts - 1) {
        const headerRa = e.response?.headers?.['retry-after'];
        const retryAfterSec = parseInt(headerRa, 10);
        const waitMs = Number.isFinite(retryAfterSec)
          ? Math.min(60000, Math.max(1000, retryAfterSec * 1000))
          : Math.min(8000, 2000 * (attempt + 1));
        await sleep(waitMs);
        continue;
      }
      return { error: formatOpenAIError(e), kind: inferOpenAIErrorKind(e) };
    }
  }
  return { error: formatOpenAIError(lastErr), kind: inferOpenAIErrorKind(lastErr) };
};

/** When VENUE_AI_PROVIDER=auto, try OpenAI after Gemini quota/rate-limit (default on). */
const venueAiAutoOpenAiFallback = () => {
  const v = process.env.VENUE_AI_AUTO_OPENAI_FALLBACK;
  if (v !== undefined && String(v).trim() !== '') {
    return !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
  }
  return true;
};

const geminiFailureWarrantsOpenAiFallback = (kind) =>
  kind === 'quota' || kind === 'rate_limit';

/**
 * Pick Gemini (default when GEMINI_API_KEY set) or OpenAI per VENUE_AI_PROVIDER.
 * In auto mode with both keys, OpenAI runs if Gemini returns quota or rate-limit (unless disabled).
 * @returns {Promise<{ text: string, provider: 'gemini'|'openai' }|{ error: string, kind: string, provider: 'gemini'|'openai' }|null>}
 */
const enrichVenueInsightWithLLM = async ({ axios, snapshot }) => {
  if (!axios) return null;
  const raw = (process.env.VENUE_AI_PROVIDER || 'auto').toLowerCase().trim();
  const geminiKey = process.env.GEMINI_API_KEY && String(process.env.GEMINI_API_KEY).trim();
  const openaiKey = process.env.OPENAI_API_KEY && String(process.env.OPENAI_API_KEY).trim();

  const runOpenAi = async () => {
    if (!openaiKey) return null;
    const r = await enrichWithOpenAI({ axios, apiKey: openaiKey, snapshot });
    if (typeof r === 'string') return { text: r, provider: 'openai' };
    return { ...r, provider: 'openai' };
  };

  const runGemini = async () => {
    if (!geminiKey) return null;
    const r = await enrichWithGemini({ axios, apiKey: geminiKey, snapshot });
    if (typeof r === 'string') return { text: r, provider: 'gemini' };
    return { ...r, provider: 'gemini' };
  };

  if (raw === 'openai') {
    return runOpenAi();
  }

  if (raw === 'gemini') {
    return runGemini();
  }

  // auto
  if (geminiKey) {
    const g = await runGemini();
    if (g?.text) return g;
    const fallbackOk =
      venueAiAutoOpenAiFallback() &&
      openaiKey &&
      geminiFailureWarrantsOpenAiFallback(g?.kind);
    if (fallbackOk) {
      const o = await runOpenAi();
      if (o?.text) return o;
      if (o?.error) return o;
    }
    return g;
  }

  if (openaiKey) {
    return runOpenAi();
  }

  return null;
};

module.exports = {
  classifyBowlingStyle,
  annotateBowlersForSnapshot,
  tossLeanFromNumbers,
  spinPaceFromBowlers,
  buildHeuristicNarrative,
  enrichWithOpenAI,
  enrichWithGemini,
  enrichVenueInsightWithLLM,
  resolveVenueAiProvider,
  inferOpenAIErrorKind,
};
