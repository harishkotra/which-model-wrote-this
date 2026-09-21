import { useCallback, useEffect, useState } from 'react';
import { probeProvider } from '../api';
import {
  PROVIDER_PRESETS,
  isLocalUrl,
  makeProvider,
  shortHost,
  type ProviderPreset,
} from '../config';
import type { ProviderConfig, QuizConfig } from '../types';

interface Props {
  config: QuizConfig;
  onChange: (config: QuizConfig) => void;
  onClose: () => void;
}

interface ProbeState {
  status: 'idle' | 'loading' | 'ok' | 'error';
  models: string[];
  error?: string;
  latencyMs?: number;
  keyless?: boolean;
}

export function SettingsPanel({ config, onChange, onClose }: Props) {
  const [draft, setDraft] = useState<QuizConfig>(config);
  const [revealedKeys, setRevealedKeys] = useState<Record<string, boolean>>({});
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});
  const [addingPreset, setAddingPreset] = useState(false);

  const setDraftField = <K extends keyof QuizConfig>(key: K, value: QuizConfig[K]): void => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const updateProvider = (id: string, patch: Partial<ProviderConfig>): void => {
    setDraft((prev) => ({
      ...prev,
      providers: prev.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }));
    // A changed endpoint invalidates whatever we last learned about it.
    if (patch.baseUrl !== undefined || patch.apiKey !== undefined) {
      setProbes((prev) => ({ ...prev, [id]: { status: 'idle', models: [] } }));
    }
  };

  const addProvider = (preset: ProviderPreset): void => {
    const id = `${preset.key}-${Math.random().toString(36).slice(2, 6)}`;
    const provider = makeProvider(preset, id);
    setDraft((prev) => ({ ...prev, providers: [...prev.providers, provider] }));
    setAddingPreset(false);
    // Local runtimes are cheap to probe and the user almost always wants the
    // model list straight away, so ask now rather than making them click.
    if (provider.baseUrl && isLocalUrl(provider.baseUrl)) void runProbe(provider);
  };

  const removeProvider = (id: string): void => {
    setDraft((prev) => {
      const providers = prev.providers.filter((p) => p.id !== id);
      if (providers.length === 0) return prev; // always keep one
      const fallback = providers[0] as ProviderConfig;
      return {
        ...prev,
        providers,
        providerAId: prev.providerAId === id ? fallback.id : prev.providerAId,
        providerBId: prev.providerBId === id ? fallback.id : prev.providerBId,
      };
    });
  };

  const runProbe = useCallback(async (provider: ProviderConfig) => {
    setProbes((prev) => ({ ...prev, [provider.id]: { status: 'loading', models: [] } }));
    try {
      const result = await probeProvider(provider);
      setProbes((prev) => ({
        ...prev,
        [provider.id]: {
          status: 'ok',
          models: result.models.map((m) => m.id),
          latencyMs: result.latencyMs,
          keyless: result.keyless,
        },
      }));
    } catch (err) {
      setProbes((prev) => ({
        ...prev,
        [provider.id]: {
          status: 'error',
          models: [],
          error: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  }, []);

  // Probe local providers on open, so their models are ready to pick.
  useEffect(() => {
    for (const p of config.providers) {
      if (isLocalUrl(p.baseUrl)) void runProbe(p);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apply = (): void => {
    onChange(draft);
    onClose();
  };

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-panel wide" onClick={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <h2>Providers &amp; models</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        </header>

        <p className="settings-note">
          Add any OpenAI-compatible endpoint — a local runtime such as LM Studio or Ollama, or a
          hosted API. Model A and Model B can come from <em>different</em> providers. Everything is
          stored in your browser's localStorage.
        </p>

        {/* ------------------------------------------------------- providers */}
        <section className="settings-section">
          <div className="section-head">
            <h3>Providers</h3>
            <button className="ghost-btn small" onClick={() => setAddingPreset((v) => !v)}>
              {addingPreset ? 'Cancel' : '+ Add provider'}
            </button>
          </div>

          {addingPreset && (
            <div className="preset-grid">
              {PROVIDER_PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  className="preset-card"
                  onClick={() => addProvider(preset)}
                >
                  <span className="preset-label">{preset.label}</span>
                  <span className="preset-url">{preset.baseUrl || 'you supply the URL'}</span>
                  <span className="preset-hint">{preset.hint}</span>
                </button>
              ))}
            </div>
          )}

          {draft.providers.map((provider) => {
            const probe: ProbeState = probes[provider.id] ?? { status: 'idle', models: [] };
            const local = isLocalUrl(provider.baseUrl);
            const needsKey = !local && provider.apiKey.trim().length === 0;
            return (
              <div className="provider-card" key={provider.id}>
                <div className="provider-card-head">
                  <input
                    className="provider-label-input"
                    value={provider.label}
                    spellCheck={false}
                    onChange={(e) => updateProvider(provider.id, { label: e.target.value })}
                    aria-label="Provider label"
                  />
                  <span className={`provider-badge ${local ? 'local' : 'remote'}`}>
                    {local ? 'LOCAL' : 'REMOTE'}
                  </span>
                  {draft.providers.length > 1 && (
                    <button
                      className="icon-btn"
                      onClick={() => removeProvider(provider.id)}
                      aria-label={`Remove ${provider.label}`}
                      title="Remove provider"
                    >
                      ✕
                    </button>
                  )}
                </div>

                <div className="provider-grid">
                  <label className="field">
                    <span>Base URL</span>
                    <input
                      type="text"
                      value={provider.baseUrl}
                      spellCheck={false}
                      placeholder="http://localhost:1234/v1"
                      onChange={(e) => updateProvider(provider.id, { baseUrl: e.target.value })}
                    />
                  </label>

                  <label className="field">
                    <span>
                      API Key {local && <em>(optional for local)</em>}
                    </span>
                    <div className="key-row">
                      <input
                        type={revealedKeys[provider.id] ? 'text' : 'password'}
                        value={provider.apiKey}
                        spellCheck={false}
                        autoComplete="off"
                        placeholder={local ? 'not needed' : 'paste your key'}
                        onChange={(e) => updateProvider(provider.id, { apiKey: e.target.value })}
                      />
                      <button
                        type="button"
                        className="ghost-btn"
                        onClick={() =>
                          setRevealedKeys((prev) => ({
                            ...prev,
                            [provider.id]: !prev[provider.id],
                          }))
                        }
                      >
                        {revealedKeys[provider.id] ? 'Hide' : 'Show'}
                      </button>
                    </div>
                  </label>
                </div>

                <div className="provider-actions">
                  <label className="inline-check">
                    <input
                      type="checkbox"
                      checked={provider.disableReasoning}
                      onChange={(e) =>
                        updateProvider(provider.id, { disableReasoning: e.target.checked })
                      }
                    />
                    <span>
                      Disable reasoning <code>enable_thinking: false</code>
                    </span>
                  </label>

                  <button
                    className="ghost-btn"
                    disabled={probe.status === 'loading' || !provider.baseUrl}
                    onClick={() => void runProbe(provider)}
                  >
                    {probe.status === 'loading' ? 'Testing…' : 'Test & list models'}
                  </button>
                </div>

                {needsKey && (
                  <p className="provider-warn">
                    Remote endpoint with no API key — requests will likely fail.
                  </p>
                )}

                {probe.status === 'ok' && (
                  <p className="provider-ok">
                    Reachable — {probe.models.length} model
                    {probe.models.length === 1 ? '' : 's'} in {probe.latencyMs}ms
                    {probe.keyless ? ' (no key sent)' : ''}.
                  </p>
                )}
                {probe.status === 'error' && <pre className="provider-error">{probe.error}</pre>}
                {probe.status === 'ok' && probe.models.length > 0 && (
                  <p className="provider-models">
                    {probe.models.slice(0, 8).join(' · ')}
                    {probe.models.length > 8 ? ` … +${probe.models.length - 8} more` : ''}
                  </p>
                )}
              </div>
            );
          })}
        </section>

        {/* ----------------------------------------------------- model slots */}
        <section className="settings-section">
          <h3>Model slots</h3>
          <div className="slot-grid">
            {(['A', 'B'] as const).map((slot) => {
              const providerIdKey = slot === 'A' ? 'providerAId' : 'providerBId';
              const modelKey = slot === 'A' ? 'modelA' : 'modelB';
              const currentProviderId = draft[providerIdKey];
              const probe: ProbeState = probes[currentProviderId] ?? { status: 'idle', models: [] };
              const modelListId = `models-${slot}`;
              return (
                <div className={`slot-card slot-${slot.toLowerCase()}`} key={slot}>
                  <div className="slot-head">
                    <span className={`slot-dot slot-${slot.toLowerCase()}`} />
                    <strong>Model {slot}</strong>
                    <span className="slot-role">
                      {slot === 'A' ? 'the older one' : 'the newer one'}
                    </span>
                  </div>

                  <label className="field">
                    <span>Provider</span>
                    <select
                      value={currentProviderId}
                      onChange={(e) => setDraftField(providerIdKey, e.target.value)}
                    >
                      {draft.providers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label} — {shortHost(p.baseUrl)}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="field">
                    <span>Model</span>
                    <input
                      type="text"
                      value={draft[modelKey]}
                      spellCheck={false}
                      list={probe.models.length > 0 ? modelListId : undefined}
                      onChange={(e) => setDraftField(modelKey, e.target.value)}
                      placeholder="model id"
                    />
                    {probe.models.length > 0 && (
                      <datalist id={modelListId}>
                        {probe.models.map((m) => (
                          <option key={m} value={m} />
                        ))}
                      </datalist>
                    )}
                  </label>
                </div>
              );
            })}
          </div>
          <p className="settings-hint">
            Tip: put the two models on <em>different</em> providers — a local LM Studio model against
            a hosted one — for a quiz that is genuinely hard to call.
          </p>
        </section>

        {/* ------------------------------------------------------- generation */}
        <section className="settings-section">
          <h3>Generation</h3>
          <div className="field-row">
            <label className="field">
              <span>Temperature</span>
              <input
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={draft.temperature}
                onChange={(e) => setDraftField('temperature', Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span>Max Tokens</span>
              <input
                type="number"
                min={1}
                step={50}
                value={draft.maxTokens}
                onChange={(e) => setDraftField('maxTokens', Number(e.target.value))}
              />
            </label>
          </div>
          <p className="settings-hint">
            Local reasoning models often spend the whole budget thinking and return nothing. If that
            happens, raise Max Tokens or tick "Disable reasoning" for that provider.
          </p>
        </section>

        <footer className="settings-foot">
          <button className="ghost-btn" onClick={() => setDraft(config)}>
            Revert changes
          </button>
          <button className="primary-btn" onClick={apply}>
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}