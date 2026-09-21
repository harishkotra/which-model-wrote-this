import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createQuiz, exportQuiz, finishQuiz, sendGuess } from './api';
import { ScoreScreen } from './components/ScoreScreen';
import { SettingsPanel } from './components/SettingsPanel';
import { loadConfig, providerFor, saveConfig, shortHost } from './config';
import { QuizScene } from './three/QuizScene';
import type { RevealKind } from './three/QuizScene';
import { ApiError } from './types';
import { isLocalUrl } from './config';
import type { GuessVerdict, ModelSlot, PublicQuiz, QuizConfig, QuizResult } from './types';

type Phase = 'idle' | 'generating' | 'playing' | 'revealed' | 'finished' | 'error';

const GENERATING_STEPS = [
  'Sending the same 5 prompts to both models…',
  'Collecting 10 real completions…',
  'Hashing every output to find identical pairs…',
  'Shuffling the deck so the order tells you nothing…',
];

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<QuizScene | null>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  const [config, setConfig] = useState<QuizConfig>(() => loadConfig());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quiz, setQuiz] = useState<PublicQuiz | null>(null);
  const [index, setIndex] = useState(0);
  const [verdict, setVerdict] = useState<GuessVerdict | null>(null);
  const [result, setResult] = useState<QuizResult | null>(null);
  const [error, setError] = useState<{ message: string; kind: string } | null>(null);
  const [guesses, setGuesses] = useState<{ itemId: string; guess: ModelSlot; correct: boolean }[]>(
    [],
  );
  const [generatingStep, setGeneratingStep] = useState(0);
  const [exportNote, setExportNote] = useState<string | null>(null);

  // ------------------------------------------------------------- three.js
  useEffect(() => {
    if (!canvasRef.current) return;
    const scene = new QuizScene({ canvas: canvasRef.current });
    sceneRef.current = scene;
    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    saveConfig(config);
  }, [config]);

  useEffect(() => {
    if (phase !== 'generating') return;
    setGeneratingStep(0);
    const timer = window.setInterval(() => {
      setGeneratingStep((s) => Math.min(s + 1, GENERATING_STEPS.length - 1));
    }, 1600);
    return () => window.clearInterval(timer);
  }, [phase]);

  const currentItem = quiz?.items[index] ?? null;

  // Drive the scene whenever the visible item changes.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (phase === 'playing' && currentItem) {
      scene.setCardVisible(true);
      scene.setOrbitEnabled(false);
      scene.setIdleMode(false);
      scene.showCard(currentItem.prompt, currentItem.text);
    }
  }, [phase, currentItem]);

  // Score screen: hide the card, unlock the camera.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (phase === 'finished') {
      scene.setCardVisible(false);
      scene.hidePanels();
      scene.setOrbitEnabled(true);
      scene.setIdleMode(false);
    }
  }, [phase]);

  // ---------------------------------------------------------------- actions
  const startQuiz = useCallback(async () => {
    setError(null);
    setResult(null);
    setVerdict(null);
    setGuesses([]);
    setIndex(0);
    setQuiz(null);
    setExportNote(null);
    setPhase('generating');

    try {
      const fresh = await createQuiz(config);
      setQuiz(fresh);
      sceneRef.current?.setOrbitEnabled(false);
      sceneRef.current?.setIdleMode(false);
      setPhase('playing');
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      setError({
        message: err instanceof Error ? err.message : String(err),
        kind: apiErr?.kind ?? 'internal',
      });
      setPhase('error');
    }
  }, [config]);

  const guess = useCallback(
    async (slot: ModelSlot) => {
      if (!quiz || !currentItem || phase !== 'playing') return;
      const scene = sceneRef.current;
      scene?.flarePanel(slot);

      try {
        const v = await sendGuess(quiz.quizId, currentItem.itemId, slot);
        setVerdict(v);
        setGuesses((prev) => [
          ...prev,
          { itemId: v.itemId, guess: v.guess, correct: v.correct },
        ]);
        const kind: RevealKind = v.identicalPair ? 'identical' : v.correct ? 'correct' : 'wrong';
        const sub = v.identicalPair
          ? 'both models, same text'
          : v.correct
            ? 'you called it'
            : `you said Model ${v.guess}`;
        scene?.reveal(v.trueModelName, sub, kind);
        setPhase('revealed');
      } catch (err) {
        setError({
          message: err instanceof Error ? err.message : String(err),
          kind: err instanceof ApiError ? err.kind : 'internal',
        });
        setPhase('error');
      }
    },
    [quiz, currentItem, phase],
  );

  const next = useCallback(async () => {
    if (!quiz) return;
    const isLast = index >= quiz.items.length - 1;
    setVerdict(null);
    if (!isLast) {
      setIndex((i) => i + 1);
      setPhase('playing');
      return;
    }
    try {
      const finished = await finishQuiz(quiz.quizId);
      setResult(finished);
      setPhase('finished');
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : String(err),
        kind: err instanceof ApiError ? err.kind : 'internal',
      });
      setPhase('error');
    }
  }, [quiz, index]);

  const onExport = useCallback(async () => {
    if (!quiz) return;
    try {
      const res = await exportQuiz(quiz.quizId);
      setExportNote(`Saved to ${res.path}`);
    } catch (err) {
      setExportNote(err instanceof Error ? err.message : String(err));
    }
  }, [quiz]);

  const modelName = useMemo(() => {
    if (!quiz) return { A: config.modelA, B: config.modelB };
    return quiz.models;
  }, [quiz, config]);

  /** Where each slot is served — shown on the buttons and in the header. */
  const providerInfo = useMemo(() => {
    if (quiz) return quiz.providers;
    return {
      A: {
        id: config.providerAId,
        label: providerFor(config, 'A').label,
        baseUrl: providerFor(config, 'A').baseUrl,
        local: false,
      },
      B: {
        id: config.providerBId,
        label: providerFor(config, 'B').label,
        baseUrl: providerFor(config, 'B').baseUrl,
        local: false,
      },
    };
  }, [quiz, config]);

  const sameProvider = providerInfo.A.baseUrl === providerInfo.B.baseUrl;

  const missingKeyFor = useMemo(() => {
    const missing: string[] = [];
    for (const slot of ['A', 'B'] as const) {
      const p = providerFor(config, slot);
      if (!p.apiKey.trim() && !isLocalUrl(p.baseUrl)) missing.push(p.label);
    }
    return [...new Set(missing)];
  }, [config]);

  const runningScore = guesses.filter((g) => g.correct).length;

  return (
    <div className="app">
      <canvas ref={canvasRef} className="scene-canvas" />

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">?</span>
          <div>
            <h1>Which Model Wrote This?</h1>
            <p className="brand-sub">
              {modelName.A} <span className="vs">vs</span> {modelName.B}
              {!sameProvider && (
                <span className="brand-providers">
                  {' '}
                  · {providerInfo.A.label} / {providerInfo.B.label}
                </span>
              )}
            </p>
          </div>
        </div>

        <div className="topbar-right">
          {phase !== 'idle' && quiz && phase !== 'finished' && (
            <div className="progress">
              <span className="progress-label">
                item {Math.min(index + 1, quiz.total)} of {quiz.total}
              </span>
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ width: `${((index + (phase === 'revealed' ? 1 : 0)) / quiz.total) * 100}%` }}
                />
              </div>
              <span className="progress-score">{runningScore} correct</span>
            </div>
          )}
          <button className="ghost-btn" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
        </div>
      </header>

      {/* ------------------------------------------------------- idle screen */}
      {phase === 'idle' && (
        <div className="overlay center">
          <div className="hero">
            <h2 className="hero-title">
              Ten outputs. Two models. Five prompts.
              <br />
              <span className="hero-accent">Can you tell them apart?</span>
            </h2>
            <p className="hero-line">
              The same five prompts go to <strong>{modelName.A}</strong> ({providerInfo.A.label}) and{' '}
              <strong>{modelName.B}</strong> ({providerInfo.B.label}). You see the ten answers
              shuffled, guess who wrote each one, and find out whether the difference is something
              you can actually feel.
            </p>
            <div className="hero-actions">
              <button className="primary-btn big" onClick={startQuiz}>
                Start the quiz
              </button>
              <button className="ghost-btn" onClick={() => setSettingsOpen(true)}>
                Configure models
              </button>
            </div>
            {missingKeyFor.length > 0 && (
              <p className="warn-line">
                No API key set for {missingKeyFor.join(' and ')} — open Settings and paste one. Keys
                are stored in your browser only.
              </p>
            )}
          </div>
        </div>
      )}

      {/* ------------------------------------------------- generating screen */}
      {phase === 'generating' && (
        <div className="overlay center">
          <div className="generating">
            <div className="spinner" />
            <h2>Generating a real quiz…</h2>
            <ul className="gen-steps">
              {GENERATING_STEPS.map((step, i) => (
                <li key={step} className={i <= generatingStep ? 'done' : ''}>
                  <span className="gen-dot" />
                  {step}
                </li>
              ))}
            </ul>
            <p className="gen-note">
              10 live calls to {shortHost(providerInfo.A.baseUrl)}
              {sameProvider ? '' : ` and ${shortHost(providerInfo.B.baseUrl)}`} — local models can
              take a while to load.
            </p>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------- error screen */}
      {phase === 'error' && error && (
        <div className="overlay center">
          <div className="error-card">
            <h2>
              {error.kind === 'config'
                ? 'Configuration problem'
                : error.kind === 'provider'
                  ? 'The provider refused the request'
                  : error.kind === 'network'
                    ? 'Cannot reach the quiz server'
                    : 'Something went wrong'}
            </h2>
            <pre className="error-text">{error.message}</pre>
            <div className="hero-actions">
              <button className="primary-btn" onClick={startQuiz}>
                Try again
              </button>
              <button className="ghost-btn" onClick={() => setSettingsOpen(true)}>
                Open settings
              </button>
              <button className="ghost-btn" onClick={() => setPhase('idle')}>
                Back to start
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------- guess buttons */}
      {(phase === 'playing' || phase === 'revealed') && currentItem && (
        <div className="guess-bar">
          <button
            className={`guess-btn slot-a ${verdict?.guess === 'A' ? 'chosen' : ''} ${
              phase === 'revealed' && verdict?.trueModel === 'A' ? 'is-truth' : ''
            }`}
            disabled={phase !== 'playing'}
            onClick={() => guess('A')}
          >
            <span className="guess-tag">Model A · {providerInfo.A.label}</span>
            <span className="guess-name">{modelName.A}</span>
          </button>

          <button
            className={`guess-btn slot-b ${verdict?.guess === 'B' ? 'chosen' : ''} ${
              phase === 'revealed' && verdict?.trueModel === 'B' ? 'is-truth' : ''
            }`}
            disabled={phase !== 'playing'}
            onClick={() => guess('B')}
          >
            <span className="guess-tag">Model B · {providerInfo.B.label}</span>
            <span className="guess-name">{modelName.B}</span>
          </button>
        </div>
      )}

      {/* ------------------------------------------------- reveal footer */}
      {phase === 'revealed' && verdict && (
        <div className="reveal-bar">
          <div className={`reveal-verdict ${verdict.identicalPair ? 'identical' : verdict.correct ? 'ok' : 'bad'}`}>
            {verdict.identicalPair ? (
              <>
                <strong>IDENTICAL.</strong> Both models produced byte-identical text — this round
                was a coin flip by construction.
              </>
            ) : verdict.correct ? (
              <>
                <strong>Correct.</strong> {verdict.trueModelName} wrote this one.
              </>
            ) : (
              <>
                <strong>Wrong.</strong> {verdict.trueModelName} wrote this one — you said Model{' '}
                {verdict.guess}.
              </>
            )}
          </div>
          <button className="primary-btn" onClick={next}>
            {quiz && index >= quiz.items.length - 1 ? 'See the verdict' : 'Next →'}
          </button>
        </div>
      )}

      {/* --------------------------------------------------- score screen */}
      {phase === 'finished' && result && (
        <ScoreScreen
          result={result}
          onPlayAgain={() => {
            void startQuiz();
          }}
        />
      )}

      {exportNote && (
        <div className="toast" onClick={() => setExportNote(null)}>
          {exportNote}
        </div>
      )}

      {settingsOpen && (
        <SettingsPanel
          config={config}
          onChange={setConfig}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {quiz && phase !== 'idle' && phase !== 'generating' && phase !== 'finished' && (
        <button className="export-link" onClick={onExport}>
          export quiz JSON
        </button>
      )}

      <footer className="app-footer">
        <span>
          Built by{' '}
          <a href="https://harishkotra.me" target="_blank" rel="noreferrer noopener">
            Harish Kotra
          </a>
        </span>
        <span className="footer-sep">·</span>
        <a href="https://dailybuild.xyz" target="_blank" rel="noreferrer noopener">
          Checkout my other builds
        </a>
      </footer>
    </div>
  );
}