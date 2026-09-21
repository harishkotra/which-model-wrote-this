import type { QuizResult } from './types';

const W = 1200;
const H = 630;

/**
 * Render the shareable result card to a canvas.
 * Pure canvas drawing so it exports to PNG with no DOM capture dependency.
 */
export function renderShareCard(result: QuizResult): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  // ------------------------------------------------------------ background
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#070a18');
  bg.addColorStop(0.55, '#0b1130');
  bg.addColorStop(1, '#140b28');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Soft glows
  const glowA = ctx.createRadialGradient(180, 120, 0, 180, 120, 460);
  glowA.addColorStop(0, 'rgba(79,125,255,0.34)');
  glowA.addColorStop(1, 'rgba(79,125,255,0)');
  ctx.fillStyle = glowA;
  ctx.fillRect(0, 0, W, H);

  const glowB = ctx.createRadialGradient(1040, 540, 0, 1040, 540, 480);
  glowB.addColorStop(0, 'rgba(255,63,164,0.28)');
  glowB.addColorStop(1, 'rgba(255,63,164,0)');
  ctx.fillStyle = glowB;
  ctx.fillRect(0, 0, W, H);

  // Grid dots
  ctx.fillStyle = 'rgba(140,165,255,0.16)';
  for (let x = 40; x < W; x += 44) {
    for (let y = 40; y < H; y += 44) {
      ctx.fillRect(x, y, 2, 2);
    }
  }

  const sans = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
  const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

  // ---------------------------------------------------------------- header
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 40px ${sans}`;
  ctx.fillText('Which Model Wrote This?', 64, 92);

  ctx.fillStyle = '#8ea2d8';
  ctx.font = `500 24px ${mono}`;
  const sameProvider = result.providers.A.baseUrl === result.providers.B.baseUrl;
  const vsLine = sameProvider
    ? `${result.models.A}  vs  ${result.models.B}`
    : `${result.models.A} (${result.providers.A.label})  vs  ${result.models.B} (${result.providers.B.label})`;
  ctx.fillText(vsLine.length > 78 ? `${vsLine.slice(0, 77)}…` : vsLine, 64, 132);

  // ------------------------------------------------------------------ score
  const scoreText = `${result.score}/${result.total}`;
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 172px ${sans}`;
  ctx.fillText(scoreText, 60, 330);

  const scoreWidth = ctx.measureText(scoreText).width;
  ctx.fillStyle = result.percent >= 70 ? '#4ade80' : result.percent > 50 ? '#fbbf24' : '#f87171';
  ctx.font = `700 60px ${sans}`;
  ctx.fillText(`${result.percent}%`, 68 + scoreWidth + 28, 330);

  ctx.fillStyle = '#9fb0e0';
  ctx.font = `500 26px ${sans}`;
  ctx.fillText('correct attributions', 68, 372);

  // -------------------------------------------------------------- breakdown
  const barX = 64;
  let barY = 420;
  const barW = 520;

  for (const row of result.breakdown) {
    const pct = Math.round(row.accuracy * 100);
    ctx.fillStyle = '#c8d4f5';
    ctx.font = `600 22px ${sans}`;
    const label = row.modelName.length > 30 ? `${row.modelName.slice(0, 29)}…` : row.modelName;
    ctx.fillText(`${label}`, barX, barY);

    ctx.fillStyle = '#8ea2d8';
    ctx.font = `500 20px ${mono}`;
    const stats = `${row.guessedCorrectly}/${row.authored} identified · chosen ${row.timesChosen}× · ${row.providerLocal ? 'local' : 'remote'}`;
    ctx.fillText(stats, barX + 300, barY);

    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath();
    ctx.roundRect(barX, barY + 14, barW, 14, 7);
    ctx.fill();

    ctx.fillStyle = row.slot === 'A' ? '#5b8cff' : '#ff3fa4';
    ctx.beginPath();
    ctx.roundRect(barX, barY + 14, Math.max(6, (barW * pct) / 100), 14, 7);
    ctx.fill();

    barY += 74;
  }

  // ---------------------------------------------------------------- verdict
  const verdictX = 640;
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.beginPath();
  ctx.roundRect(verdictX - 24, 404, 540, 176, 22);
  ctx.fill();
  ctx.strokeStyle = 'rgba(140,165,255,0.22)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = '#e8eeff';
  ctx.font = `600 27px ${sans}`;
  wrap(ctx, result.verdict, verdictX, 452, 492, 38);

  if (result.identicalPairs > 0) {
    ctx.fillStyle = '#fbbf24';
    ctx.font = `700 22px ${mono}`;
    ctx.fillText(
      `${result.identicalPairs} PAIR${result.identicalPairs === 1 ? '' : 'S'} BYTE-IDENTICAL`,
      verdictX,
      552,
    );
  }

  // ----------------------------------------------------------------- footer
  ctx.fillStyle = 'rgba(140,165,255,0.55)';
  ctx.font = `500 20px ${mono}`;
  ctx.fillText(
    `${result.calls.length} real model calls · temperature ${result.settings.temperature} · ` +
      `max ${result.settings.maxTokens} tokens · reasoning ${result.settings.disableReasoning ? 'off' : 'on'}`,
    64,
    596,
  );

  return canvas;
}

function wrap(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
): void {
  const words = text.split(/\s+/);
  let line = '';
  let cursorY = y;
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      ctx.fillText(line, x, cursorY);
      line = word;
      cursorY += lineHeight;
    } else {
      line = candidate;
    }
  }
  if (line) ctx.fillText(line, x, cursorY);
}

/** Trigger a PNG download of the result card. */
export function downloadShareCard(result: QuizResult): void {
  const canvas = renderShareCard(result);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `which-model-wrote-this-${result.quizId}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, 'image/png');
}