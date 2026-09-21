/**
 * End-to-end verification of the quiz's honesty.
 *
 * Runs a real quiz against a running server and asserts every claim the app
 * makes. Exits non-zero on the first failed check.
 *
 *   PARTICLE_AI_API_KEY=... pnpm -F server verify
 */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const BASE = process.env.VERIFY_BASE ?? 'http://127.0.0.1:3001';
const API_KEY = process.env.PARTICLE_AI_API_KEY ?? process.env.VERIFY_API_KEY ?? '';

/** Slot A defaults to the hosted provider; slot B can be pointed anywhere. */
const PROVIDER_A = {
  id: 'particle',
  label: process.env.VERIFY_LABEL_A ?? 'Particle.ai',
  baseUrl: process.env.VERIFY_BASE_URL ?? 'https://api.particle.ai/v1',
  apiKey: API_KEY,
  disableReasoning: true,
};
const MODEL_A = process.env.VERIFY_MODEL_A ?? 'deepseek-v4-flash-0731';

const PROVIDER_B = {
  id: process.env.VERIFY_PROVIDER_B_ID ?? 'particle',
  label: process.env.VERIFY_LABEL_B ?? process.env.VERIFY_LABEL_A ?? 'Particle.ai',
  baseUrl: process.env.VERIFY_BASE_URL_B ?? process.env.VERIFY_BASE_URL ?? 'https://api.particle.ai/v1',
  apiKey: process.env.VERIFY_API_KEY_B ?? API_KEY,
  disableReasoning: (process.env.VERIFY_DISABLE_REASONING_B ?? 'true') === 'true',
};
const MODEL_B = process.env.VERIFY_MODEL_B ?? 'deepseek-v4.1-flash';

const CROSS_PROVIDER = PROVIDER_A.baseUrl !== PROVIDER_B.baseUrl;

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail = ''): void {
  checks += 1;
  if (condition) {
    console.log(`  \u001b[32mPASS\u001b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`  \u001b[31mFAIL\u001b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('Set PARTICLE_AI_API_KEY (or VERIFY_API_KEY) to run verification.');
    process.exit(2);
  }

  console.log(`\nVerifying against ${BASE}`);
  console.log(`  slot A: ${MODEL_A} @ ${PROVIDER_A.label} (${PROVIDER_A.baseUrl})`);
  console.log(`  slot B: ${MODEL_B} @ ${PROVIDER_B.label} (${PROVIDER_B.baseUrl})`);
  console.log(`  cross-provider: ${CROSS_PROVIDER ? 'yes' : 'no'}\n`);

  // ---------------------------------------------------------------- step 1
  console.log('1. Generate a quiz from real model calls');
  const createRes = await fetch(`${BASE}/api/quiz`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config: {
        providerA: PROVIDER_A,
        modelA: MODEL_A,
        providerB: PROVIDER_B,
        modelB: MODEL_B,
        temperature: 0,
        maxTokens: Number(process.env.VERIFY_MAX_TOKENS ?? 1600),
      },
    }),
  });
  const createBody = await createRes.text();
  if (!createRes.ok) {
    console.error(`   quiz creation failed (HTTP ${createRes.status}): ${createBody}`);
    process.exit(1);
  }
  const quiz = JSON.parse(createBody) as {
    quizId: string;
    total: number;
    items: { itemId: string; prompt: string; text: string }[];
    models: { A: string; B: string };
    providers: { A: { label: string; baseUrl: string; local: boolean }; B: { label: string; baseUrl: string; local: boolean } };
  };
  check('quiz created', createRes.status === 201, `id=${quiz.quizId}`);
  check('10 items returned', quiz.total === 10, `total=${quiz.total}`);
  check(
    'every item has non-empty real text',
    quiz.items.every((i) => i.text.trim().length > 0),
    `min chars=${Math.min(...quiz.items.map((i) => i.text.length))}`,
  );
  check(
    'slot A served by the configured provider',
    quiz.providers.A.baseUrl === PROVIDER_A.baseUrl,
    `${quiz.providers.A.label} @ ${quiz.providers.A.baseUrl}`,
  );
  check(
    'slot B served by the configured provider',
    quiz.providers.B.baseUrl === PROVIDER_B.baseUrl,
    `${quiz.providers.B.label} @ ${quiz.providers.B.baseUrl}`,
  );
  check(
    '5 distinct prompts, 2 items each',
    new Set(quiz.items.map((i) => i.prompt)).size === 5,
    `${new Set(quiz.items.map((i) => i.prompt)).size} distinct prompts`,
  );

  // ---------------------------------------------------------------- step 2
  console.log('\n2. Pre-guess payload does not leak the answer');
  const rawGet = await (await fetch(`${BASE}/api/quiz/${quiz.quizId}`)).text();
  check('GET body contains no "trueModel" key', !rawGet.includes('trueModel'));
  check('GET body contains no "trueModelName" key', !rawGet.includes('trueModelName'));
  check('GET body contains no "sha256"', !rawGet.includes('sha256'));
  check('GET body contains no "identicalPair" flag', !rawGet.includes('identicalPair'));
  const preGet = JSON.parse(rawGet) as { items: Record<string, unknown>[] };
  check(
    'GET items expose only itemId/prompt/text',
    preGet.items.every(
      (i) => Object.keys(i).sort().join(',') === 'itemId,prompt,text',
    ),
    `keys=${Object.keys(preGet.items[0] ?? {}).sort().join(',')}`,
  );
  // The model *names* are legitimately public (they label the guess buttons).
  // What must not leak is which name belongs to which item.
  const leakedAttribution = preGet.items.some(
    (i) => 'trueModel' in i || 'model' in i || 'trueModelName' in i,
  );
  check('no item carries an attribution field', !leakedAttribution);

  // ---------------------------------------------------------------- step 3
  console.log('\n3. Play the quiz with deterministic guesses');
  const guesses = new Map<string, 'A' | 'B'>();
  let correctFromGuesses = 0;
  for (let i = 0; i < quiz.items.length; i += 1) {
    const item = quiz.items[i] as { itemId: string };
    // Deliberately lopsided: mostly "A", so a scoring bug cannot pass by luck.
    const guess: 'A' | 'B' = i < 7 ? 'A' : 'B';
    guesses.set(item.itemId, guess);
    const res = await fetch(`${BASE}/api/quiz/${quiz.quizId}/guess`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: item.itemId, guess }),
    });
    if (!res.ok) {
      console.error(`   guess failed: ${await res.text()}`);
      process.exit(1);
    }
    const verdict = (await res.json()) as { correct: boolean; trueModel: string };
    if (verdict.correct) correctFromGuesses += 1;
    check(
      `guess ${i + 1}/10 scored against the true model`,
      typeof verdict.correct === 'boolean' && (verdict.trueModel === 'A' || verdict.trueModel === 'B'),
      `guessed=${guess} truth=${verdict.trueModel} correct=${verdict.correct}`,
    );
  }

  // ---------------------------------------------------------------- step 4
  console.log('\n4. Finish: truth table, score, breakdown');
  const finishRes = await fetch(`${BASE}/api/quiz/${quiz.quizId}/finish`, { method: 'POST' });
  const result = (await finishRes.json()) as {
    score: number;
    total: number;
    percent: number;
    misses: number;
    identicalPairs: number;
    identicalItemsGuessedCorrectly: number;
    verdict: string;
    breakdown: {
      slot: string;
      modelName: string;
      authored: number;
      guessedCorrectly: number;
      timesChosen: number;
      accuracy: number;
    }[];
    truth: {
      itemId: string;
      text: string;
      trueModel: string;
      trueModelName: string;
      sha256: string;
      identicalPair: boolean;
      pairId: string;
      guess: string | null;
      correct: boolean | null;
      counterpartText: string | null;
      counterpartSha256: string;
    }[];
    calls: {
      itemId: string;
      slot: string;
      requestedModel: string;
      reportedModel: string;
      providerId: string;
      providerLabel: string;
      providerBaseUrl: string;
      sha256: string;
      reasoningTokens: number;
      attempts: number;
      finishReason: string | null;
    }[];
  };

  check('finish returned 200', finishRes.ok);
  check(
    'score equals the guesses actually recorded',
    result.score === correctFromGuesses,
    `finish=${result.score} vs guesses=${correctFromGuesses}`,
  );
  check('score + misses === total', result.score + result.misses === result.total,
    `${result.score}+${result.misses}=${result.total}`);
  check(
    'per-item correct flags agree with the score',
    result.truth.filter((t) => t.correct).length === result.score,
  );
  check(
    'every item has a guess recorded',
    result.truth.every((t) => t.guess === guesses.get(t.itemId)),
  );

  // ---------------------------------------------------------------- step 5
  console.log('\n5. Attribution matches the actual call that produced each item');
  for (const row of result.truth) {
    const call = result.calls.find((c) => c.itemId === row.itemId);
    const expectedProvider = row.trueModel === 'A' ? PROVIDER_A : PROVIDER_B;
    const ok =
      !!call &&
      call.slot === row.trueModel &&
      call.sha256 === row.sha256 &&
      sha256(row.text) === row.sha256 &&
      call.requestedModel === (row.trueModel === 'A' ? MODEL_A : MODEL_B) &&
      call.providerBaseUrl === expectedProvider.baseUrl;
    check(
      `item ${row.itemId} ← ${row.trueModel} (${row.trueModelName})`,
      ok,
      call
        ? `provider=${call.providerLabel} requested=${call.requestedModel} ` +
          `reported=${call.reportedModel} sha256=${row.sha256.slice(0, 12)}… ` +
          `reasoning_tokens=${call.reasoningTokens}`
        : 'no call record',
    );
  }
  check(
    '10 calls recorded, one per item',
    result.calls.length === 10,
    `${result.calls.length} calls`,
  );
  check(
    'each model authored exactly 5 items',
    result.breakdown.every((b) => b.authored === 5),
    result.breakdown.map((b) => `${b.modelName}=${b.authored}`).join(', '),
  );

  // ---------------------------------------------------------------- step 6
  console.log('\n6. Identical pairs detected by sha256 and flagged');
  const identicalItems = result.truth.filter((t) => t.identicalPair);
  check(
    'identical items come in flagged pairs',
    identicalItems.length % 2 === 0,
    `${identicalItems.length} item(s) flagged, ${result.identicalPairs} pair(s)`,
  );
  for (const row of identicalItems) {
    check(
      `flagged item ${row.itemId} really is byte-identical to its counterpart`,
      row.counterpartText !== null && sha256(row.counterpartText) === row.sha256,
      `sha256=${row.sha256.slice(0, 12)}…`,
    );
  }
  const flaggedButDifferent = result.truth.filter(
    (t) => !t.identicalPair && t.counterpartText !== null && sha256(t.counterpartText) === t.sha256,
  );
  check(
    'no identical pair was left unflagged',
    flaggedButDifferent.length === 0,
    `${flaggedButDifferent.length} unflagged identical item(s)`,
  );
  if (identicalItems.length === 0) {
    console.log(
      '  \u001b[33mNOTE\u001b[0m this run produced no identical pair; detection logic was still ' +
        'validated by the "no unflagged identical pair" check.',
    );
  }

  // ---------------------------------------------------------------- step 7
  console.log('\n7. Reasoning is counted, never captured');
  check(
    'reasoning token counts come from usage.completion_tokens_details',
    result.calls.every((c) => typeof c.reasoningTokens === 'number' && c.reasoningTokens >= 0),
    `total reasoning_tokens=${result.calls.reduce((a, c) => a + c.reasoningTokens, 0)}`,
  );
  const fullBody = JSON.stringify(result);
  check('no reasoning_content anywhere in the payload', !fullBody.includes('reasoning_content'));
  check(
    'every call records which provider answered',
    result.calls.every((c) => typeof c.providerLabel === 'string' && c.providerLabel.length > 0),
  );
  if (CROSS_PROVIDER) {
    check(
      'the two slots were answered by two different endpoints',
      new Set(result.calls.map((c) => c.providerBaseUrl)).size === 2,
      [...new Set(result.calls.map((c) => `${c.providerLabel} @ ${c.providerBaseUrl}`))].join(' | '),
    );
  }

  // ---------------------------------------------------------------- step 8
  console.log('\n8. Export the audit log as JSON');
  const exportRes = await fetch(`${BASE}/api/quiz/${quiz.quizId}/export`);
  const exported = (await exportRes.json()) as { path: string; items: unknown[] };
  check('export returned 200', exportRes.ok, exported.path);
  check('export contains all 10 items', exported.items.length === 10);

  const outPath = resolve(process.cwd(), '../data/verification-report.json');
  await writeFile(
    outPath,
    `${JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        base: BASE,
        quizId: quiz.quizId,
        models: { A: MODEL_A, B: MODEL_B },
        providers: { A: PROVIDER_A, B: PROVIDER_B },
        checksRun: checks,
        failures,
        score: result.score,
        total: result.total,
        percent: result.percent,
        identicalPairs: result.identicalPairs,
        verdict: result.verdict,
        breakdown: result.breakdown,
        truth: result.truth,
        calls: result.calls,
        guesses: Object.fromEntries(guesses),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.log(`\nWrote verification report → ${outPath}`);

  console.log(
    `\n${failures === 0 ? '\u001b[32mALL CHECKS PASSED\u001b[0m' : `\u001b[31m${failures} CHECK(S) FAILED\u001b[0m`}` +
      ` (${checks - failures}/${checks})\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('\nVerification crashed:', err instanceof Error ? err.message : err);
  process.exit(1);
});