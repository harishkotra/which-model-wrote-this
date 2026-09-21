import { useEffect, useMemo, useRef } from 'react';
import { downloadShareCard, renderShareCard } from '../shareCard';
import type { QuizResult } from '../types';

interface Props {
  result: QuizResult;
  onPlayAgain: () => void;
}

export function ScoreScreen({ result, onPlayAgain }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const { totalCompletionTokens, totalReasoningTokens, reportedModels } = useMemo(() => {
    let completion = 0;
    let reasoning = 0;
    const reported = new Map<string, string>();
    for (const call of result.calls) {
      completion += call.completionTokens;
      reasoning += call.reasoningTokens;
      reported.set(call.slot, call.reportedModel);
    }
    return {
      totalCompletionTokens: completion,
      totalReasoningTokens: reasoning,
      reportedModels: (['A', 'B'] as const).map((slot) => ({
        slot,
        requested: slot === 'A' ? result.models.A : result.models.B,
        reported: reported.get(slot) ?? '—',
        provider: slot === 'A' ? result.providers.A : result.providers.B,
      })),
    };
  }, [result]);

  // Render the shareable card into the DOM so it is visible and exportable.
  useEffect(() => {
    const target = canvasRef.current;
    if (!target) return;
    const source = renderShareCard(result);
    target.width = source.width;
    target.height = source.height;
    const ctx = target.getContext('2d');
    ctx?.drawImage(source, 0, 0);
  }, [result]);

  return (
    <div className="score-overlay">
      <div className="score-card">
        <div className="score-top">
          <div className="score-number">
            <span className="score-value">{result.score}</span>
            <span className="score-slash">/ {result.total}</span>
          </div>
          <div className="score-verdict">
            <p className="verdict-line">{result.verdict}</p>
            {result.identicalPairs > 0 && (
              <p className="verdict-sub">
                {result.identicalPairs} of 5 prompt
                {result.identicalPairs === 1 ? '' : 's'} produced byte-identical text from both
                models — {result.identicalItemsGuessedCorrectly} of those{' '}
                {result.identicalPairs * 2} items went your way, which is what a coin flip looks
                like.
              </p>
            )}
          </div>
        </div>

        <div className="breakdown">
          {result.breakdown.map((row) => (
            <div className="breakdown-row" key={row.slot}>
              <div className="breakdown-head">
                <span className={`slot-dot slot-${row.slot.toLowerCase()}`} />
                <span className="breakdown-name">{row.modelName}</span>
                <span className="breakdown-tag">Model {row.slot}</span>
                <span className={`provider-chip ${row.providerLocal ? 'local' : 'remote'}`}>
                  {row.providerLabel}
                </span>
              </div>
              <div className="breakdown-bar">
                <div
                  className={`breakdown-fill slot-${row.slot.toLowerCase()}`}
                  style={{ width: `${Math.round(row.accuracy * 100)}%` }}
                />
              </div>
              <div className="breakdown-stats">
                <span>
                  you identified <strong>{row.guessedCorrectly}</strong> of {row.authored}
                </span>
                <span>
                  you blamed it <strong>{row.timesChosen}</strong> time
                  {row.timesChosen === 1 ? '' : 's'}
                </span>
              </div>
            </div>
          ))}
        </div>

        <div className="truth-table">
          <h3>The truth table</h3>
          <div className="truth-scroll">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Prompt</th>
                  <th>Written by</th>
                  <th>You said</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {result.truth.map((row, i) => (
                  <tr key={row.itemId} className={row.identicalPair ? 'row-identical' : ''}>
                    <td className="mono">{i + 1}</td>
                    <td className="truth-prompt">{row.prompt}</td>
                    <td>
                      <span className={`pill slot-${row.trueModel.toLowerCase()}`}>
                        {row.trueModelName}
                      </span>
                    </td>
                    <td className="mono">
                      {row.guess === null ? '—' : `Model ${row.guess}`}
                    </td>
                    <td>
                      {row.correct === null ? (
                        <span className="mark mark-none">?</span>
                      ) : row.correct ? (
                        <span className="mark mark-ok">✓</span>
                      ) : (
                        <span className="mark mark-bad">✕</span>
                      )}
                      {row.identicalPair && <span className="identical-chip">IDENTICAL</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="receipt">
          <h3>Receipt</h3>
          <ul>
            <li>
              <strong>{result.calls.length}</strong> live calls to the provider — every item above
              came from one of them.
            </li>
            <li>
              <strong>{totalCompletionTokens.toLocaleString()}</strong> completion tokens,{' '}
              <strong>{totalReasoningTokens.toLocaleString()}</strong> of them reasoning tokens
              (counted from <code>usage.completion_tokens_details.reasoning_tokens</code>; the
              reasoning text itself is never stored or shown).
            </li>
            {reportedModels.map(({ slot, requested, reported, provider }) => (
              <li key={slot}>
                Model {slot} on <strong>{provider.label}</strong> ({provider.baseUrl}
                {provider.local ? ', local' : ''}): requested <code>{requested}</code>, provider
                reported <code>{reported}</code>
                {requested !== reported && (
                  <span className="receipt-warn">
                    {' '}
                    — the provider did not echo the model you asked for
                  </span>
                )}
              </li>
            ))}
            {reportedModels.length === 2 &&
              reportedModels[0]?.provider.baseUrl === reportedModels[1]?.provider.baseUrl &&
              reportedModels[0]?.reported === reportedModels[1]?.reported &&
              reportedModels[0]?.requested !== reportedModels[1]?.requested && (
                <li className="receipt-warn">
                  Both requests went to the same endpoint and were answered under the same
                  reported model name. The two model ids are distinct and both are accepted, but
                  on this endpoint they behaved as one model — which is itself the finding.
                </li>
              )}
          </ul>
        </div>

        <div className="share-block">
          <canvas ref={canvasRef} className="share-canvas" />
          <div className="share-actions">
            <button className="primary-btn" onClick={() => downloadShareCard(result)}>
              Download result card (PNG)
            </button>
            <button className="ghost-btn" onClick={onPlayAgain}>
              Play again
            </button>
          </div>
          <p className="share-hint">
            Drag to orbit — the score screen unlocks the camera.
          </p>
        </div>
      </div>
    </div>
  );
}