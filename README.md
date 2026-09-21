# Which Model Wrote This?

Ten outputs. Two models. Five prompts. You guess who wrote each one — and the answer is
often that there is nothing to guess.

The same five prompts go to two models. The ten answers are shuffled and shown one at a time
on a floating 3D card. You guess **Model A** or **Model B** for each. At the end the app
reveals the truth, scores your intuition, and tells you how often you were just flipping a
coin.

The result is genuinely surprising precisely because the two models are so often identical —
and your failure to tell them apart **is** the finding.

<img width="1846" height="1167" alt="Screenshot at Sep 21 14-09-28" src="https://github.com/user-attachments/assets/2a50b7b4-8ee8-48d2-8634-c4cd63445eaf" />
<img width="1845" height="1166" alt="Screenshot at Sep 21 14-10-08" src="https://github.com/user-attachments/assets/f750cc1a-dda5-47c6-9419-abc3424de1e5" />
<img width="1858" height="1509" alt="screencapture-localhost-5173-2026-09-21-14_10_35" src="https://github.com/user-attachments/assets/bc729046-8352-4509-89e0-cebbcf6e5f25" />

---

## Table of contents

- [The finding](#the-finding)
- [Multiple providers](#multiple-providers)
- [How it works](#how-it-works)
  - [Architecture](#architecture)
  - [The request lifecycle](#the-request-lifecycle)
  - [Ground truth is bound at call time](#ground-truth-is-bound-at-call-time)
  - [The pre-guess payload cannot leak](#the-pre-guess-payload-cannot-leak)
  - [Identical pairs are detected by sha256](#identical-pairs-are-detected-by-sha256)
  - [Reasoning is counted, never captured](#reasoning-is-counted-never-captured)
  - [Scoring](#scoring)
- [The 3D card](#the-3d-card)
- [Run it](#run-it)
- [Configuration](#configuration)
- [Verify it yourself](#verify-it-yourself)
- [API](#api)
- [Stack](#stack)
- [Project layout](#project-layout)
- [Fork it and contribute](#fork-it-and-contribute)
- [Ideas for new features](#ideas-for-new-features)
- [Non-goals](#non-goals)

**Writing about this project:** [`docs/blog.md`](docs/blog.md) is a full technical write-up
(the finding, the architecture, the decisions that make it trustworthy, and the local-runtime
bugs it surfaced). [`docs/launch-copy.md`](docs/launch-copy.md) holds the X thread and LinkedIn
post.

---

## The finding

This is not a rigged demo. It is a measurement, and on the default configuration the
measurement comes back brutal.

Running the default pair (`deepseek-v4-flash-0731` vs `deepseek-v4.1-flash`) at temperature
0, **all five prompts returned byte-identical text from both models**. Not similar —
identical, same sha256. The reveal stamps those rounds `IDENTICAL`, and the verdict line
tells you the truth: your guesses on those items could not have been anything but coin flips.

Two things are true at once here, and the app reports both:

1. **The two model ids are genuinely distinct.** The provider accepts both and rejects
   invented names (`totally-bogus-model-xyz` → `model_not_found`). So they are not the same
   string.
2. **On this endpoint they behaved as one model.** Every response came back self-reporting as
   `deepseek-v4.1-flash`, including the responses to requests for `deepseek-v4-flash-0731`.

The score screen prints this as a **Receipt** — requested model, provider-reported model,
reasoning tokens counted — so the claim is auditable rather than asserted. If the two ids
start diverging, the receipt and the identical-pair rate will show it immediately.

At **temperature 1.0** the models do diverge on 3 of the 5 prompts, which makes for a much
better game. The temperature control is in Settings for exactly this reason.

## Multiple providers

Model A and Model B are each bound to a **provider** — any OpenAI-compatible endpoint. Add as
many as you like; the two slots can even point at different ones.

Built-in presets: **Particle.ai**, **LM Studio**, **Ollama**, **llama.cpp / vLLM**,
**OpenAI**, **OpenRouter**, and a blank custom endpoint.

This matters, because the most interesting quiz is a cross-provider one. Measured here at
temperature 0:

| Configuration | Identical pairs (of 5) |
| --- | --- |
| `deepseek-v4-flash-0731` vs `deepseek-v4.1-flash`, both on Particle.ai | **5 / 5** |
| `deepseek-v4-flash-0731` (Particle.ai) vs `google/gemma-4-e4b` (local LM Studio) | **1 / 5** |

Same-provider sibling models were indistinguishable. Put a local model against a hosted one
and the game becomes genuinely playable.

**Test & list models** probes the endpoint's `GET /models` and fills a dropdown, so you never
type model ids from memory. That probe runs **server-side on purpose**: local runtimes
frequently send no CORS headers, so the browser cannot call them directly.

Local endpoints need no API key — the server omits the `Authorization` header entirely when
the key is blank, since some runtimes reject a malformed empty bearer token.

## How it works

### Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Browser — http://localhost:5173                                             │
│                                                                              │
│   React 18 + TypeScript                                                      │
│   ┌────────────────────┐  ┌──────────────────┐  ┌─────────────────────────┐  │
│   │  App.tsx           │  │ SettingsPanel    │  │ ScoreScreen             │  │
│   │  phase state       │  │ provider CRUD    │  │ score · breakdown       │  │
│   │  machine           │  │ presets · probe  │  │ receipt · share card    │  │
│   └─────────┬──────────┘  └──────────────────┘  └─────────────────────────┘  │
│             │                                                                │
│             │  QuizScene.ts  (three.js)                                      │
│             │  RoundedBoxGeometry card · real 3D flip · parallax tilt        │
│             │  glowing guess panels · pulsing verdict ring · IDENTICAL stamp │
│             │                                                                │
│             │  localStorage: wmwt.config.v2  (providers + models + settings) │
└─────────────┼────────────────────────────────────────────────────────────────┘
              │  fetch /api/*        (Vite dev proxy → 127.0.0.1:3001)
              ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  Quiz server — http://127.0.0.1:3001                                         │
│  Node + TypeScript + Hono                                                    │
│                                                                              │
│   index.ts        routes · CORS · the public-payload allowlist               │
│   quiz.ts         resolveConfig · generateQuiz · ground-truth binding        │
│   modelClient.ts  callModel · sha256 · listProviderModels · isLocalBaseUrl   │
│   store.ts        in-memory quiz store · shuffle · computeScore · JSONL log  │
│   prompts.ts      the 5 prompts · system prompt · provider presets           │
│   types.ts        the wire contract                                          │
│                                                                              │
│   Holds the truth: trueModel, trueModelName, sha256, identicalPair, calls    │
└──────┬───────────────────────────────────┬───────────────────────────────────┘
       │  POST {baseUrl}/chat/completions │  GET {baseUrl}/models
       │  plain fetch, no SDK              │  (model discovery, proxied)
       ▼                                   ▼
┌────────────────────────┐   ┌──────────────────────────────────────────────────┐
│  Provider A            │   │  Provider B                                      │
│  Particle.ai (hosted)  │   │  LM Studio / Ollama / llama.cpp / OpenAI / ...   │
│  needs an API key      │   │  local: no key, no CORS headers                  │
└────────────────────────┘   └──────────────────────────────────────────────────┘
       │
       ▼
  data/quiz-log.jsonl        append-only log, one line per completed quiz
  data/quiz-<id>.json        full per-item audit trail
  data/verification-report.json
```

The server is the only thing that ever knows which model wrote which text. The browser is
told the model *names* (they label the buttons) but never the per-item attribution until a
guess is recorded.

### The request lifecycle

```
1.  POST /api/quiz          { config: {providerA, modelA, providerB, modelB, temperature, maxTokens} }
                            └─ server calls both providers 5× each, 10 real HTTP requests
                            └─ binds trueModel at call time
                            └─ sha256 each output, flags identical pairs
                            └─ shuffles the 10 items
    ← 201 { quizId, items: [{itemId, prompt, text}], models, providers, settings }
                                                    ▲ no attribution

2.  GET  /api/quiz/:id      ← same shape, still no attribution

3.  POST /api/quiz/:id/guess  { itemId, guess }
    ← 200 { correct, trueModel, trueModelName, identicalPair }   ▲ truth for THIS item only

4.  POST /api/quiz/:id/finish
    ← 200 { score, percent, verdict, breakdown, truth[], calls[], providers, settings }
                            └─ score computed from stored guesses, not from the client
                            └─ appended to data/quiz-log.jsonl exactly once

5.  GET  /api/quiz/:id/export → full audit JSON on disk
```

### Ground truth is bound at call time

The single most important invariant: **the slot that produced a piece of text is the slot
recorded on that item.** Nothing downstream re-derives attribution, and nothing infers it
from the text.

```ts
// server/src/quiz.ts
const results = await Promise.all(
  (['A', 'B'] as const).map(async (slot) => {
    const model = slot === 'A' ? config.modelA : config.modelB;
    const provider = slot === 'A' ? config.providerA : config.providerB;
    const itemId = newId(9);

    const { text, record } = await callModel({
      config, provider, model, slot, prompt, promptIndex, itemId,
      log: (m) => log(`[quiz ${quizId}] ${m}`),
    });
    return { slot, model, itemId, text, record };
  }),
);

const [first, second] = results;

// Identical detection is a sha256 comparison of the exact output bytes.
const identical = first.record.sha256 === second.record.sha256;

results.forEach((r, index) => {
  items.push({
    itemId: r.itemId,
    prompt,
    text: r.text,
    trueModel: r.slot,          // ← bound here, at call time
    trueModelName: modelNames[r.slot],
    sha256: r.record.sha256,
    identicalPair: identical,
    pairId,
    pairSlot: index,
  });
});
```

### The pre-guess payload cannot leak

`GET /api/quiz/:id` builds its payload by **explicit allowlist** rather than by deleting
`trueModel`. This matters: if someone adds a field to `QuizItem` next year, the allowlist
keeps it private by default instead of leaking it by default.

```ts
// server/src/index.ts
function toPublicItem(item: QuizItem): { itemId: string; prompt: string; text: string } {
  return { itemId: item.itemId, prompt: item.prompt, text: item.text };
}

/** Provider identity is public — it labels the buttons. Attribution is not. */
function toPublicQuiz(quiz: StoredQuiz): PublicQuiz {
  return {
    quizId: quiz.quizId,
    createdAt: quiz.createdAt,
    total: quiz.items.length,
    items: quiz.items.map(toPublicItem),
    models: { A: quiz.config.modelA, B: quiz.config.modelB },
    providers: { A: toProviderSummary(quiz.config.providerA), B: toProviderSummary(quiz.config.providerB) },
    settings: { /* … */ },
  };
}
```

Verified: the quiz-creation response and the pre-guess `GET` expose exactly
`itemId`, `prompt`, `text` — nothing else.

### Identical pairs are detected by sha256

```ts
// server/src/modelClient.ts
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
```

Two outputs that hash the same are byte-identical, not merely similar. Identical items are
**kept** in the quiz and flagged on both members of the pair, because an identical round is
the most revealing round there is — the reveal stamps it `IDENTICAL` in amber and the verdict
line counts it.

### Reasoning is counted, never captured

Reasoning models return a `reasoning_content` field. The app reads it **only to confirm it
exists** and never returns, logs, stores, or renders it. Only the token count survives:

```ts
// server/src/modelClient.ts
interface ChatChoiceMessage {
  content?: unknown;
  /** Present on some providers. Read ONLY to prove we never surface it. */
  reasoning_content?: unknown;
}

// …
const reasoningTokens = numberOrZero(
  usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens,
);
```

This is a real distinction, and the app can prove it: with reasoning enabled the same
endpoint returns 35 reasoning tokens and 104 characters of `reasoning_content`; with it
disabled, zero and empty. A full quiz with reasoning on logged 2,146 reasoning tokens across
10 calls (per-call values 123–525) — and not one character of the reasoning text.

### Scoring

The score is computed server-side from the stored guess records — not from anything the
client reports back.

```ts
// server/src/store.ts
export function computeScore(quiz: StoredQuiz) {
  let score = 0;
  let identicalItemsGuessedCorrectly = 0;
  for (const item of quiz.items) {
    const guess = quiz.guesses.get(item.itemId);
    if (!guess) continue;
    if (guess.correct) {
      score += 1;
      if (item.identicalPair) identicalItemsGuessedCorrectly += 1;
    }
  }
  return { score, total: quiz.items.length, misses: quiz.guesses.size - score, identicalItemsGuessedCorrectly };
}

export function buildVerdict(score: number, total: number, identicalPairs: number): string {
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;
  const indistinguishable = 100 - pct;
  const pairNote = identicalPairs > 0
    ? ` ${identicalPairs} of the ${total} items were byte-identical from both models — those rounds were coin flips by construction.`
    : '';
  if (pct <= 50) return `You could not tell them apart — ${indistinguishable}% of your guesses were coin flips.${pairNote}`;
  if (pct <= 70) return `Barely a signal: ${indistinguishable}% of your guesses were coin flips, which is roughly what guessing would give you.${pairNote}`;
  return `You found a real signal — ${pct}% correct, well above chance.${pairNote}`;
}
```

Guessing is idempotent: re-guessing an item returns the stored verdict rather than
double-counting it.

## The 3D card

The card is a real 3D object, not a CSS transform. A `RoundedBoxGeometry` box carries six
materials — four sides plus a front face, with the rear face made invisible so the flip
reveals a separate back plate rotated π behind it.

```ts
// web/src/three/QuizScene.ts
const boxGeo = new RoundedBoxGeometry(CARD_W, CARD_H, CARD_D, 6, 0.16);
// BoxGeometry material order: +x, -x, +y, -y, +z (front), -z (back)
const boxMaterials = [side, side, side, side, frontMaterial, invisibleMaterial];

const backGeo = new THREE.PlaneGeometry(CARD_W - 0.08, CARD_H - 0.08);
const backPlate = new THREE.Mesh(backGeo, this.backMaterial);
backPlate.rotation.y = Math.PI;
backPlate.position.z = -CARD_D / 2 - 0.004;
```

The flip is an eased rotation on the card group, with pointer parallax fading out as the flip
progresses so the tilt does not fight the rotation:

```ts
this.flip += (this.targetFlip - this.flip) * Math.min(1, dt * 4.2);
const flipProgress = Math.min(1, this.flip / Math.PI);
const tiltFade = 1 - flipProgress;
this.cardGroup.rotation.y = this.flip + this.tilt.y * tiltFade;

// IDENTICAL stamp pops in once the flip is mostly done.
const stampGate = flipProgress > 0.55 ? this.stampTarget : 0;
```

Verified by pixel analysis of screenshots: the card face reads `rgb(185,185,201)` before the
flip and the back face averages luminance 37.6 after it (mean absolute delta 138/255), and
the amber `IDENTICAL` stamp covers 5,344 px — 0.72% of the card region — appearing **only**
after reveal. `OrbitControls` are disabled during play and enabled on the score screen.

## Run it

```bash
pnpm install
pnpm dev          # server on :3001, web on :5173
```

Open the web URL, click **Settings**, and paste your provider API key. Nothing is hardcoded;
the key is stored in your browser's localStorage and sent only to the provider you configure.

If port 3001 is already taken by something else on your machine, start the pieces separately
and point Vite at the right port:

```bash
PORT=3011 pnpm -F server start
QUIZ_API_PORT=3011 pnpm -F web dev
```

Vite prefers 5173 but will fall back to the next free port and print the real URL.

### Using a local model

Start LM Studio (or Ollama), enable its OpenAI-compatible server, then in **Settings**:
**+ Add provider → LM Studio (local)**. It auto-probes and lists your models. Point Model B at
it, pick a model, and save. No API key required.

## Configuration

Everything in the Settings panel persists to localStorage under `wmwt.config.v2`. A config
saved by an older build (`wmwt.config.v1`, single endpoint) is migrated automatically.

**Per provider**

| Field | Notes |
| --- | --- |
| Label | your name for it; shown on the guess buttons |
| Base URL | default `https://api.particle.ai/v1` |
| API Key | empty for local runtimes |
| Disable reasoning | sends `chat_template_kwargs: {"enable_thinking": false}` |

**Global**

| Field | Default |
| --- | --- |
| Model A | `deepseek-v4-flash-0731` @ Particle.ai |
| Model B | `deepseek-v4.1-flash` @ Particle.ai |
| Temperature | `0` |
| Max Tokens | `1600` |

Provider errors are shown verbatim — if your provider rejects the reasoning toggle, you see
its own words, not a generic failure.

### Notes from testing against local runtimes

LM Studio and friends do not always honour the reasoning toggle. Measured on LM Studio at
`max_tokens: 1600`:

| Model | Result |
| --- | --- |
| `google/gemma-4-e4b` | works — 76 chars of answer, 190 reasoning tokens |
| `qwen/qwen3.5-9b` | **empty content** — spent all 1599 tokens reasoning |
| `zai-org/glm-4.7-flash` | **empty content** — spent all 1599 tokens reasoning |

The server retries once with a doubled token budget when content comes back empty, and if
that still fails the error says so explicitly and tells you to raise Max Tokens or disable
reasoning. Pick a non-reasoning local model, or give it a much larger budget.

### Resilience

Transient provider failures (`408, 409, 425, 429, 500, 502, 503, 504, 529`) are retried up to
3 times with exponential backoff, honouring `Retry-After` when the provider sends it. This was
added after a live `429` from a hosted provider killed a quiz mid-run.

## Verify it yourself

With a server running and a key available:

```bash
cd server
PARTICLE_AI_API_KEY=... pnpm verify
```

To verify a **cross-provider** quiz (hosted slot A vs local slot B):

```bash
cd server
PARTICLE_AI_API_KEY=... \
VERIFY_BASE_URL_B='http://localhost:1234/v1' \
VERIFY_LABEL_B='LM Studio (local)' \
VERIFY_PROVIDER_B_ID='lmstudio' \
VERIFY_MODEL_B='google/gemma-4-e4b' \
VERIFY_DISABLE_REASONING_B='false' \
pnpm verify
```

It runs a real quiz end to end and asserts every claim above across 8 sections:

1. Generate a quiz from real model calls — including that each slot was served by the
   provider you configured.
2. Pre-guess payload does not leak the answer.
3. Play the quiz with deterministic guesses.
4. Finish: truth table, score, breakdown.
5. Attribution matches the actual call that produced each item — by sha256 **and** by
   endpoint.
6. Identical pairs detected by sha256 and flagged.
7. Reasoning is counted, never captured.
8. Export the audit log as JSON.

It writes `data/verification-report.json` and exits non-zero on any failure. Last run:
**49/49 passed**.

Every completed quiz is appended to `data/quiz-log.jsonl` with the player's score, and
`GET /api/quiz/:id/export` writes a full per-item audit trail to `data/quiz-<id>.json`.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Liveness and how many quizzes are in memory. |
| `POST /api/providers/models` | Probe an endpoint's `GET /models` and list what it serves. |
| `POST /api/quiz` | Generate a quiz: 5 prompts × 2 models, shuffled. Returns items **without** attribution. |
| `GET /api/quiz/:id` | The same shuffled items, still without attribution. |
| `POST /api/quiz/:id/guess` | `{ itemId, guess }` → correctness and the true model **for that item only**. Idempotent. |
| `POST /api/quiz/:id/finish` | Full truth table, score, per-model breakdown, verdict. Logs the quiz once. |
| `GET /api/quiz/:id/export` | Per-item audit trail as JSON. |
| `GET /api/log` | Every completed quiz from the JSONL log. |

Errors come back as `{ error, kind, status }` where `kind` is `config`, `provider`, or
`internal`. A `provider` error carries the upstream provider's own text.

## Stack

| Layer | Choice |
| --- | --- |
| Frontend | Vite 6, React 18, TypeScript 5.7 (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) |
| 3D | three.js 0.171 — `RoundedBoxGeometry`, `OrbitControls`, ACES tone mapping |
| Backend | Node, TypeScript, Hono 4 on `@hono/node-server` |
| Model calls | plain `fetch` to an OpenAI-compatible `/chat/completions` — **no SDK** |
| Dev tooling | pnpm workspaces, `tsx` for the server, `concurrently` for `pnpm dev` |
| Storage | in-memory quiz store + append-only JSONL; config in localStorage |

## Project layout

```
which-model-wrote-this/
├── package.json               pnpm workspace root — dev / build / typecheck / verify
├── pnpm-workspace.yaml
├── README.md
├── .gitignore
├── data/                      runtime output (gitignored except .gitkeep)
│   ├── quiz-log.jsonl
│   ├── quiz-<id>.json
│   └── verification-report.json
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts           Hono app, routes, public-payload allowlist
│       ├── quiz.ts            config resolution, generation, ground-truth binding
│       ├── modelClient.ts     callModel, sha256, retries, model discovery
│       ├── store.ts           quiz store, shuffle, scoring, verdict, JSONL log
│       ├── prompts.ts         5 prompts, system prompt, provider presets
│       ├── types.ts           the wire contract
│       └── verify.ts          the 8-section end-to-end verifier
└── web/
    ├── index.html
    ├── vite.config.ts         dev proxy /api → 127.0.0.1:${QUIZ_API_PORT ?? 3001}
    ├── tsconfig.json
    └── src/
        ├── main.tsx
        ├── App.tsx            phase state machine and layout
        ├── config.ts          provider presets, localStorage, legacy migration
        ├── api.ts             typed client + toServerConfig()
        ├── shareCard.ts       1200×630 canvas result card
        ├── types.ts           mirror of the server wire types
        ├── styles.css
        ├── three/QuizScene.ts the 3D card, flip, panels, ring, stamp
        └── components/
            ├── SettingsPanel.tsx   provider CRUD, presets, live model discovery
            └── ScoreScreen.tsx     score, breakdown, truth table, receipt, PNG
```

## Fork it and contribute

```bash
git clone https://github.com/<you>/which-model-wrote-this
cd which-model-wrote-this
pnpm install
pnpm dev
```

The repo is deliberately small and dependency-light — no build step for the server, no ORM,
no state library, no model SDK. You can read the whole thing in an afternoon.

**Before opening a PR:**

```bash
pnpm typecheck    # both packages, strict
pnpm build        # web production build
cd server && PARTICLE_AI_API_KEY=... pnpm verify   # 49 end-to-end assertions
```

### Invariants to preserve

These are the properties the project exists to demonstrate. A PR that breaks one of them
breaks the point of the app:

1. **Attribution is bound at call time.** Never infer which model wrote a text from the text.
2. **Public payloads are built by allowlist**, never by deleting private fields. Adding a
   field to `QuizItem` must not leak it.
3. **`reasoning_content` is never logged, stored, or rendered.** Only its token count.
4. **The score is computed server-side** from stored guesses.
5. **No API key is hardcoded** anywhere, ever.
6. **Provider errors surface verbatim.** Do not paraphrase what a provider said.
7. **Identical pairs are kept and flagged**, not filtered out.

### Good first issues

- **Add a provider preset** — one entry in `PROVIDER_PRESETS` in `web/src/config.ts`.
- **Add a prompt** — one string in `DEFAULT_PROMPTS` in `server/src/prompts.ts`. Keep prompts
  short and self-contained; long prompts let style bleed through and make the game trivial.
- **Improve the error copy** for a failure mode you actually hit.

### Where the seams are

- `callModel()` is the only place that talks HTTP to a provider. Anything provider-specific
  (auth styles, extra headers, non-OpenAI response shapes) belongs behind it.
- `toPublicItem()` / `toPublicQuiz()` are the only places that decide what the browser may
  see. Keep them boring and explicit.
- `QuizScene` is the only place that touches three.js. It exposes `showCard()`, `reveal()`,
  `flarePanel()`, `setOrbitEnabled()`, `setIdleMode()`, `setCardVisible()`, `dispose()` and
  nothing else.

## Ideas for new features

Roughly ordered from "a weekend" to "a project".

**Make the game better**

- **More than two models.** Run a 3-way or 5-way quiz and score it as a confusion matrix —
  which pairs actually get confused with each other. The server already keeps per-slot
  breakdowns; this generalises `ModelSlot` from `'A' | 'B'` to an array.
- **Adaptive difficulty.** If the player is above chance, raise the temperature; if they are
  at chance, lower it. Find each person's threshold of discrimination and report it as a
  number.
- **Multiplayer / audience mode.** A room code and a projector view: the audience votes on
  their phones, the big screen shows the live split, then the reveal. The backend is already
  stateless per quiz, so this is mostly a websocket fan-out plus a room store.
- **Human baseline rounds.** Mix in text written by a human and ask whether people can spot
  the human. The most interesting result is usually that they cannot.

**Make the evidence stronger**

- **Run-to-run stability.** Repeat the same prompt × model pair N times at temperature 0 and
  report the identical rate as a distribution, not a single sample. Right now one identical
  pair is one data point.
- **A public leaderboard of indistinguishability.** Aggregate `data/quiz-log.jsonl` across
  everyone who plays and rank model pairs by how often audiences fail to tell them apart.
  That is a genuinely novel benchmark, and it is audience-sourced rather than
  benchmark-sourced.
- **Statistical honesty.** Report a confidence interval on the score and say explicitly when
  10 items is too few to distinguish 50% from 60%. At n=10 the noise is large; the app should
  admit that rather than imply precision it does not have.
- **Prompt-sensitivity analysis.** Which of the 5 prompts discriminate best between two
  models? That tells you where model identity actually lives — probably in format and
  refusal behaviour, not content.
- **Diff view.** For near-identical pairs, show a character-level diff of the two outputs on
  the reveal. Seeing that two answers differ only in a trailing newline is more persuasive
  than a hash.

**Make it more useful**

- **Bring your own prompts.** A textarea in Settings, and per-quiz prompt sets saved to
  localStorage.
- **Persist to a database.** Swap the in-memory `Map` in `store.ts` for SQLite so quizzes
  survive restarts and can be resumed. The store is already isolated behind
  `putQuiz`/`getQuiz`.
- **Export a proper report.** A shareable HTML/PDF that includes the two outputs side by side,
  the hash comparison, and the audience score.
- **Model-comparison mode.** Skip the game and just show the two models' answers to your
  prompt side by side with the hash and diff. Useful as a plain eval tool.
- **Cost and latency panel.** Per-call latency and token counts are already recorded — chart
  them. "Model B is 4× slower and 3× more expensive, and you cannot tell them apart" is a
  strong sentence.

**Make it more robust**

- **Streaming responses** so the generating screen fills in token by token instead of
  showing a spinner for 30 seconds.
- **Cancellation** — an abort button that stops in-flight calls via `AbortController`.
- **Provider capability probing.** Some endpoints reject `chat_template_kwargs`, some reject
  `max_tokens` in favour of `max_completion_tokens`. Detect and adapt rather than failing.
- **A cached replay mode** for demos with no network: record one quiz and replay it. The
  audit export already contains everything needed.

### Publishing

```bash
git add -A
git commit -m "Which Model Wrote This?"
git remote add origin git@github.com:harishkotra/which-model-wrote-this.git
git push -u origin main
```

`.gitignore` already excludes `node_modules/`, build output, runtime data
(`data/*.json`, `data/*.jsonl`, `data/shots/`), logs, editor and OS cruft, and every `.env`
variant — so no API key and no local quiz log can be committed by accident.

## Non-goals

No auth, no database, no deployment, no multiplayer, no leaderboard service, no external APIs
or search. A quiz in, a score out.
