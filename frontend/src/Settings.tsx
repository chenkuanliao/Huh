import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioLines,
  Check,
  CircleCheck,
  Cpu,
  Download,
  ExternalLink,
  KeyRound,
  LayoutTemplate,
  LogIn,
  LogOut,
  NotebookPen,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { api, ChatGPTStatus, errorText, send, Settings as SettingsT, SttModels, Template } from './api';
import { OUTPUT_LANGUAGES, PROVIDERS, ProviderInfo, providerInfo, STT_MODELS } from './providers';
import { Badge, Callout, cx, Field, Segmented, Select, Spinner, Switch, useToast } from './ui';
import Templates from './Templates';
import { searchSettings, SECTION_LABELS, SettingEntry, SettingMatch, SettingsSection } from './settingsSearch';

export type { SettingsSection };

export default function Settings({
  templates,
  reloadTemplates,
  section,
  onSection,
  onSettingsChange,
}: {
  templates: Template[];
  reloadTemplates: () => Promise<void>;
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
  onSettingsChange?: (s: SettingsT) => void;
}) {
  const toast = useToast();
  const [settings, setSettings] = useState<SettingsT | null>(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    api<SettingsT>('/settings')
      .then(setSettings)
      .catch(e => setLoadError(errorText(e)));
  }, []);

  const save = useCallback(
    async (patch: Record<string, unknown>, success?: string) => {
      try {
        const next = await send<SettingsT>('/settings', patch, 'PUT');
        setSettings(next);
        onSettingsChange?.(next);
        if (success) toast(success, 'success');
        return next;
      } catch (e) {
        toast(errorText(e), 'error');
        throw e;
      }
    },
    [toast, onSettingsChange],
  );

  // A setting picked from search: scroll to it and highlight it once its section has rendered.
  const [target, setTarget] = useState<{ id: string; n: number } | null>(null);
  useEffect(() => {
    if (!target) return;
    let timer = 0;
    const started = performance.now();
    const find = () => {
      const el = document.querySelector<HTMLElement>(`[data-setting="${target.id}"]`);
      // Wait until the section has loaded its data, or the layout shifts after we scroll.
      if (!el || document.querySelector('.settings-content .loading-block')) {
        if (performance.now() - started < 10000) timer = window.setTimeout(find, 50);
        return;
      }
      if (el instanceof HTMLDetailsElement) el.open = true;
      el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      el.classList.remove('setting-flash');
      void el.offsetWidth; // restart the animation when the same result is picked twice
      el.classList.add('setting-flash');
      el.addEventListener('animationend', () => el.classList.remove('setting-flash'), { once: true });
    };
    timer = window.setTimeout(find, 0);
    return () => window.clearTimeout(timer);
  }, [target]);

  return (
    <div className="settings-page">
      <header className="page-header">
        <h1>Settings</h1>
      </header>
      <div className="settings-layout">
        <SettingsSidebar
          section={section}
          onSection={onSection}
          onPick={e => {
            onSection(e.section);
            setTarget(t => ({ id: e.id, n: (t?.n || 0) + 1 }));
          }}
        />
        <div className="settings-content">
          {loadError && <Callout tone="bad">{loadError}</Callout>}
          {!settings && !loadError && (
            <div className="loading-block">
              <Spinner /> Loading settings…
            </div>
          )}
          {settings && section === 'ai' && <AISettings settings={settings} save={save} />}
          {settings && section === 'transcription' && <TranscriptionSettings settings={settings} save={save} />}
          {section === 'templates' && <Templates templates={templates} reload={reloadTemplates} />}
          {settings && section === 'notes' && <NotesSettings settings={settings} save={save} />}
        </div>
      </div>
    </div>
  );
}

const SECTION_ICONS: Record<SettingsSection, (size: number) => React.ReactNode> = {
  ai: size => <Sparkles size={size} />,
  transcription: size => <AudioLines size={size} />,
  templates: size => <LayoutTemplate size={size} />,
  notes: size => <NotebookPen size={size} />,
};

const NAV: { id: SettingsSection; hint: string }[] = [
  { id: 'ai', hint: 'Provider & model' },
  { id: 'transcription', hint: 'Local speech model' },
  { id: 'templates', hint: 'Notes & AI formats' },
  { id: 'notes', hint: 'Editor, Back button, shortcuts' },
];

function Mark({ text, query }: { text: string; query: string }) {
  const tokens = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!tokens.length) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (let i = 0; i < text.length; ) {
    const t = tokens.find(t => lower.startsWith(t, i) && (i === 0 || !/[\p{L}\p{N}]/u.test(lower[i - 1]) || /[^\x00-\x7f]/.test(t)));
    if (t) {
      parts.push(text.slice(at, i), <mark key={i}>{text.slice(i, i + t.length)}</mark>);
      i += t.length;
      at = i;
    } else i++;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

function SettingsSidebar({ section, onSection, onPick }: { section: SettingsSection; onSection: (s: SettingsSection) => void; onPick: (e: SettingEntry) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const { results, partial } = useMemo(() => searchSettings(query), [query]);
  const searching = !!query.trim();

  useEffect(() => {
    setActive(0);
    setPicked(null);
  }, [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  // "/" jumps to the search box, like most settings pages.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pick = (m: SettingMatch) => {
    setPicked(m.entry.id);
    onPick(m.entry);
  };

  return (
    <aside className="settings-side">
      <label className="search settings-search">
        <Search size={15} />
        <input
          ref={input}
          type="search"
          value={query}
          placeholder="Search settings"
          aria-label="Search settings"
          aria-controls="settings-results"
          autoComplete="off"
          spellCheck={false}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape' && query) {
              e.preventDefault();
              e.stopPropagation();
              setQuery('');
            } else if (!results.length) return;
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive(a => (a + 1) % results.length);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive(a => (a - 1 + results.length) % results.length);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              pick(results[active]);
            }
          }}
        />
        {searching ? (
          <button type="button" className="icon-button settings-search-clear" aria-label="Clear search" onClick={() => { setQuery(''); input.current?.focus(); }}>
            <X size={14} />
          </button>
        ) : (
          <kbd className="settings-search-key" aria-hidden>/</kbd>
        )}
      </label>

      {searching ? (
        <div className="settings-results" id="settings-results" ref={list} role="listbox" aria-label="Matching settings">
          {!results.length ? (
            <p className="settings-results-empty">
              No settings match “{query.trim()}”. Try a different word, like <em>language</em>, <em>model</em> or <em>keyboard</em>.
            </p>
          ) : (
            <>
              {partial && <p className="settings-results-note">No exact match — these look related:</p>}
              {results.map((m, i) => (
                <button
                  key={m.entry.id}
                  type="button"
                  role="option"
                  data-index={i}
                  aria-selected={i === active}
                  className={cx('settings-result', i === active && 'active', picked === m.entry.id && 'picked')}
                  onMouseMove={() => setActive(i)}
                  onClick={() => pick(m)}
                >
                  <span className="settings-result-icon">{SECTION_ICONS[m.entry.section](15)}</span>
                  <span className="settings-result-text">
                    <span className="settings-result-title">
                      <Mark text={m.entry.title} query={query} />
                    </span>
                    <span className="settings-result-desc">
                      <Mark text={m.entry.description} query={query} />
                    </span>
                    <span className="settings-result-where">{SECTION_LABELS[m.entry.section]}</span>
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      ) : (
        <nav className="settings-nav" aria-label="Settings sections">
          {NAV.map(n => (
            <button key={n.id} type="button" aria-current={section === n.id ? 'page' : undefined} className={cx('settings-nav-item', section === n.id && 'on')} onClick={() => onSection(n.id)}>
              {SECTION_ICONS[n.id](17)}
              <span>
                <span className="settings-nav-label">{SECTION_LABELS[n.id]}</span>
                <small>{n.hint}</small>
              </span>
            </button>
          ))}
        </nav>
      )}
    </aside>
  );
}

type Save = (patch: Record<string, unknown>, success?: string) => Promise<SettingsT>;
type ModelList = { loading: boolean; error?: string; models: { id: string; name: string }[] };

/* =================================================================== AI */

function AISettings({ settings, save }: { settings: SettingsT; save: Save }) {
  const toast = useToast();
  const [viewing, setViewing] = useState(settings.provider);
  const [chatgpt, setChatgpt] = useState<ChatGPTStatus | null>(null);
  const [models, setModels] = useState<Record<string, ModelList>>({});
  const info = providerInfo(viewing);

  const refreshChatgpt = useCallback(async () => {
    const s = await api<ChatGPTStatus>('/chatgpt/status');
    setChatgpt(s);
    return s;
  }, []);
  useEffect(() => {
    refreshChatgpt().catch(() => {});
  }, [refreshChatgpt]);

  const connected = useCallback(
    (p: string) => {
      const i = providerInfo(p);
      if (i.auth === 'chatgpt') return !!chatgpt?.signed_in;
      if (i.auth === 'custom') return !!settings.base_url;
      return !!settings.api_key_status?.[p];
    },
    [chatgpt, settings],
  );

  const loadModels = useCallback(async (p: string) => {
    setModels(m => ({ ...m, [p]: { loading: true, models: m[p]?.models || [] } }));
    try {
      const r = await api<{ models: { id: string; name: string }[] }>(`/models?provider=${encodeURIComponent(p)}`);
      setModels(m => ({ ...m, [p]: { loading: false, models: r.models } }));
      return r.models;
    } catch (e) {
      setModels(m => ({ ...m, [p]: { loading: false, models: [], error: errorText(e) } }));
      return null;
    }
  }, []);

  // Load the model list automatically as soon as a provider is connected.
  const isConnected = connected(viewing);
  useEffect(() => {
    if (isConnected && !models[viewing]) void loadModels(viewing);
  }, [viewing, isConnected]); // eslint-disable-line react-hooks/exhaustive-deps

  // The active provider is connected but has no model yet: pick the first available one automatically.
  const autoPicked = useRef(false);
  const activeList = models[settings.provider]?.models;
  useEffect(() => {
    if (autoPicked.current || settings.model || !activeList?.length || !connected(settings.provider)) return;
    autoPicked.current = true;
    void save({ provider: settings.provider, model: activeList[0].id }, `AI notes will use ${activeList[0].id}. You can change it below.`).catch(() => {});
  }, [activeList, settings.model, settings.provider, connected, save]);
  useEffect(() => {
    if (connected(settings.provider) && !models[settings.provider]) void loadModels(settings.provider);
  }, [settings.provider, chatgpt]); // eslint-disable-line react-hooks/exhaustive-deps

  const modelFor = (p: string) => settings.provider_models?.[p] || (settings.provider === p ? settings.model : '');

  async function chooseModel(p: string, model: string) {
    await save({ provider: p, model }, `AI notes will use ${model} via ${providerInfo(p).name}.`);
  }

  async function activate(p: string) {
    let model = modelFor(p);
    if (!model) {
      const list = models[p]?.models?.length ? models[p].models : await loadModels(p);
      model = list?.[0]?.id || '';
    }
    await save({ provider: p, model }, `${providerInfo(p).name} is now writing your AI notes.`);
  }

  // After connecting: pick a sensible model automatically if none is chosen yet.
  async function afterConnect(p: string) {
    const list = await loadModels(p);
    if (list === null) return;
    const current = modelFor(p);
    const model = current || list[0]?.id || '';
    if (settings.provider === p || !connected(settings.provider)) {
      await save({ provider: p, model });
      toast(`${providerInfo(p).name} connected${model ? ` — using ${model}` : ''}.`, 'success');
    } else {
      toast(`${providerInfo(p).name} connected. Pick a model to start using it.`, 'success');
    }
  }

  const active = providerInfo(settings.provider);

  return (
    <div className="stack-lg">
      <section className="panel" data-setting="ai-provider">
        <div className="panel-head">
          <div>
            <h2>Who writes your AI notes</h2>
            <p className="muted">
              Currently <strong>{active.name}</strong>
              {settings.model ? (
                <>
                  {' '}
                  · <code>{settings.model}</code>
                </>
              ) : (
                ' · no model selected'
              )}
              {!connected(settings.provider) && <span className="warn-text"> · not connected</span>}
            </p>
          </div>
        </div>
        <div className="provider-grid">
          {PROVIDERS.map(p => {
            const isActive = settings.provider === p.id;
            const ok = connected(p.id);
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={viewing === p.id}
                className={cx('provider-card', viewing === p.id && 'viewing', isActive && 'active')}
                onClick={() => setViewing(p.id)}
              >
                <ProviderMark info={p} />
                <span className="provider-card-text">
                  <strong>{p.name}</strong>
                  <small>{p.tagline}</small>
                </span>
                <span className="provider-card-status">
                  {isActive ? (
                    <Badge tone="accent">
                      <Check size={12} /> In use
                    </Badge>
                  ) : ok ? (
                    <Badge tone="good">Connected</Badge>
                  ) : (
                    <Badge>Set up</Badge>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="panel" aria-label={`${info.name} setup`}>
        <div className="panel-head">
          <div className="provider-title">
            <ProviderMark info={info} large />
            <div>
              <h2>{info.name}</h2>
              <p className="muted">{info.tagline}</p>
            </div>
          </div>
          {settings.provider === info.id ? (
            <Badge tone="accent">
              <Check size={12} /> Writing your AI notes
            </Badge>
          ) : (
            <button type="button" className="primary" disabled={!isConnected} title={isConnected ? undefined : 'Connect first'} onClick={() => void activate(info.id).catch(() => {})}>
              Use {info.name}
            </button>
          )}
        </div>

        <div className="step" data-setting="ai-connect">
          <div className="step-label">
            <span className={cx('step-dot', isConnected && 'done')}>{isConnected ? <Check size={13} /> : 1}</span>
            Connect
          </div>
          <div className="step-body">
            {info.auth === 'chatgpt' && <ChatGPTConnect status={chatgpt} refresh={refreshChatgpt} onConnected={() => void afterConnect('chatgpt')} />}
            {info.auth === 'key' && <KeyConnect info={info} stored={!!settings.api_key_status?.[info.id]} save={save} onConnected={() => void afterConnect(info.id)} onRemoved={() => setModels(m => ({ ...m, [info.id]: undefined as any }))} />}
            {info.auth === 'custom' && <CustomConnect settings={settings} save={save} onConnected={() => void afterConnect('custom')} />}
          </div>
        </div>

        <div className={cx('step', !isConnected && 'locked')} data-setting="ai-model">
          <div className="step-label">
            <span className={cx('step-dot', isConnected && !!modelFor(info.id) && 'done')}>{isConnected && modelFor(info.id) ? <Check size={13} /> : 2}</span>
            Choose a model
          </div>
          <div className="step-body">
            <ModelPicker
              provider={info}
              enabled={isConnected}
              list={models[info.id]}
              value={modelFor(info.id)}
              onReload={() => void loadModels(info.id)}
              onChange={m => void chooseModel(info.id, m).catch(() => {})}
            />
          </div>
        </div>
      </section>

      <WritingStyle settings={settings} save={save} />
    </div>
  );
}

export function ProviderMark({ info, large }: { info: ProviderInfo; large?: boolean }) {
  return (
    <span className={cx('provider-mark', large && 'large')} style={{ background: info.color }} aria-hidden>
      {info.id === 'custom' ? <Cpu size={large ? 20 : 16} /> : info.monogram}
    </span>
  );
}

function ChatGPTConnect({ status, refresh, onConnected }: { status: ChatGPTStatus | null; refresh: () => Promise<ChatGPTStatus>; onConnected: () => void }) {
  const toast = useToast();
  const [waiting, setWaiting] = useState(false);
  const [callback, setCallback] = useState('');
  const [busy, setBusy] = useState(false);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const done = useRef(onConnected);
  done.current = onConnected;

  // Poll while the user finishes signing in in the other tab.
  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    const timer = setInterval(async () => {
      try {
        const s = await refresh();
        if (s.signed_in) {
          setWaiting(false);
          done.current();
        }
      } catch {}
      if (Date.now() - started > 15 * 60 * 1000) setWaiting(false);
    }, 2000);
    return () => clearInterval(timer);
  }, [waiting, refresh]);

  async function start() {
    // Open the tab synchronously so popup blockers allow it.
    const tab = window.open('about:blank', '_blank');
    setBusy(true);
    try {
      const r = await send<{ authorize_url: string }>('/chatgpt/sign-in');
      if (tab) tab.location.href = r.authorize_url;
      else window.open(r.authorize_url, '_blank', 'noopener');
      setWaiting(true);
    } catch (e) {
      tab?.close();
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setBusy(true);
    try {
      await send('/chatgpt/callback', { url: callback.trim() });
      setCallback('');
      const s = await refresh();
      setWaiting(false);
      if (s.signed_in) onConnected();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (!status) return <Spinner />;

  if (status.signed_in) {
    return (
      <div className="stack">
        <div className="connected-row">
          <CircleCheck size={18} className="good-text" />
          <span>
            Signed in{status.email ? (
              <>
                {' '}
                as <strong>{status.email}</strong>
              </>
            ) : null}
          </span>
          <span className="spacer" />
          {status.usage_url && (
            <a className="button ghost sm" href={status.usage_url} target="_blank" rel="noreferrer">
              Usage <ExternalLink size={13} />
            </a>
          )}
          <button
            type="button"
            className="ghost sm"
            onClick={async () => {
              try {
                await send('/chatgpt/sign-out');
                await refresh();
                toast('Signed out of ChatGPT.');
              } catch (e) {
                toast(errorText(e), 'error');
              }
            }}
          >
            <LogOut size={14} /> Sign out
          </button>
        </div>
        {!status.plan_enabled && <Callout tone="warn">Your account signed in, but plan access wasn’t granted. Sign out and sign in again, approving all requested access.</Callout>}
      </div>
    );
  }

  return (
    <div className="stack">
      {!waiting ? (
        <div className="row wrap">
          <button type="button" className="primary" disabled={busy} onClick={() => void start()}>
            {busy ? <Spinner size={15} /> : <LogIn size={16} />} Sign in with ChatGPT
          </button>
          <span className="hint">No API key needed — notes use your ChatGPT plan’s allowance.</span>
        </div>
      ) : (
        <div className="signin-wait">
          <div className="row">
            <Spinner />
            <strong>Finish signing in in the new tab…</strong>
            <span className="spacer" />
            <button type="button" className="ghost sm" onClick={() => setWaiting(false)}>
              Cancel
            </button>
          </div>
          {local ? (
            <p className="hint">This page will update automatically once you approve access.</p>
          ) : (
            <ol className="signin-steps">
              <li>Approve access on the ChatGPT page.</li>
              <li>
                That tab then shows <em>“This site can’t be reached”</em>. That’s expected — the sign-in is meant for the server PC.
              </li>
              <li>Copy the full address from that tab’s address bar and paste it below.</li>
            </ol>
          )}
          <div className="row">
            <input
              className="grow"
              type="text"
              autoComplete="off"
              spellCheck={false}
              aria-label="Callback address"
              placeholder="http://127.0.0.1:1457/auth/callback?code=…"
              value={callback}
              onChange={e => setCallback(e.target.value)}
            />
            <button type="button" className="primary" disabled={!callback.trim() || busy} onClick={() => void finish()}>
              Finish
            </button>
          </div>
        </div>
      )}
      {status.last_error && !waiting && <Callout tone="bad">Last sign-in attempt failed: {status.last_error}</Callout>}
    </div>
  );
}

function KeyConnect({ info, stored, save, onConnected, onRemoved }: { info: ProviderInfo; stored: boolean; save: Save; onConnected: () => void; onRemoved: () => void }) {
  const toast = useToast();
  const [key, setKey] = useState('');
  const [editing, setEditing] = useState(!stored);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setEditing(!stored);
    setKey('');
  }, [info.id, stored]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim()) return;
    setBusy(true);
    try {
      await save({ api_keys: { [info.id]: key.trim() } });
      setKey('');
      setEditing(false);
      onConnected();
    } catch {
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {!editing ? (
        <div className="connected-row">
          <KeyRound size={17} className="good-text" />
          <span>
            API key saved <span className="muted">•••••••• (stored encrypted on the server)</span>
          </span>
          <span className="spacer" />
          <button type="button" className="ghost sm" onClick={() => setEditing(true)}>
            Replace
          </button>
          <button
            type="button"
            className="ghost sm danger-text"
            onClick={async () => {
              try {
                await save({ api_keys: { [info.id]: null } });
                onRemoved();
                toast('API key removed.');
              } catch {}
            }}
          >
            <Trash2 size={14} /> Remove
          </button>
        </div>
      ) : (
        <form className="row" onSubmit={submit}>
          <input
            className="grow"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            aria-label={`${info.name} API key`}
            placeholder={`Paste your API key${info.keyHint ? ` (${info.keyHint})` : ''}`}
            value={key}
            onChange={e => setKey(e.target.value)}
          />
          <button type="submit" className="primary" disabled={!key.trim() || busy}>
            {busy ? <Spinner size={15} /> : null} Connect
          </button>
          {stored && (
            <button type="button" className="ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
          )}
        </form>
      )}
      <p className="hint">
        {info.keyUrl && (
          <>
            <a href={info.keyUrl} target="_blank" rel="noreferrer">
              Get a key <ExternalLink size={11} />
            </a>
            {' · '}
          </>
        )}
        Endpoint set automatically: <code>{info.endpoint}</code>
      </p>
    </div>
  );
}

function CustomConnect({ settings, save, onConnected }: { settings: SettingsT; save: Save; onConnected: () => void }) {
  const [url, setUrl] = useState(settings.base_url || '');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const dirty = url.trim() !== (settings.base_url || '') || !!key.trim();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await save({ base_url: url.trim().replace(/\/+$/, ''), ...(key.trim() ? { api_keys: { custom: key.trim() } } : {}) });
      setKey('');
      onConnected();
    } catch {
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="stack" onSubmit={submit}>
      <Field label="Server address" hint={<>Must be OpenAI-compatible (ending in <code>/v1</code>). For a server on this PC, use <code>http://host.docker.internal:PORT/v1</code> — e.g. Ollama: <code>http://host.docker.internal:11434/v1</code>.</>}>
        <input type="url" spellCheck={false} placeholder="http://host.docker.internal:11434/v1" value={url} onChange={e => setUrl(e.target.value)} aria-label="Server address" />
      </Field>
      <Field label={<>API key <span className="muted">(optional)</span></>} hint={settings.api_key_status?.custom ? 'A key is saved. Leave blank to keep it.' : undefined}>
        <input type="password" autoComplete="new-password" placeholder={settings.api_key_status?.custom ? '•••••••• saved' : 'Only if your server requires one'} value={key} onChange={e => setKey(e.target.value)} aria-label="Custom API key" />
      </Field>
      <div>
        <button type="submit" className="primary" disabled={!url.trim() || !dirty || busy}>
          {busy && <Spinner size={15} />} Save & connect
        </button>
      </div>
    </form>
  );
}

function ModelPicker({
  provider,
  enabled,
  list,
  value,
  onReload,
  onChange,
}: {
  provider: ProviderInfo;
  enabled: boolean;
  list?: ModelList;
  value: string;
  onReload: () => void;
  onChange: (model: string) => void;
}) {
  const [test, setTest] = useState<{ ok: boolean; message: string } | 'running' | null>(null);
  useEffect(() => setTest(null), [provider.id, value]);
  const options = useMemo(() => {
    const opts = (list?.models || []).map(m => ({ value: m.id, label: m.name && m.name !== m.id ? m.name : m.id, description: m.name && m.name !== m.id ? m.id : undefined }));
    if (value && !opts.some(o => o.value === value)) opts.unshift({ value, label: value, description: 'Entered manually' });
    return opts;
  }, [list, value]);

  if (!enabled) return <p className="hint">Connect {provider.name} first — available models will load automatically.</p>;

  return (
    <div className="stack">
      <div className="row">
        <div className="grow">
          <Select
            ariaLabel="Model"
            value={value}
            options={options}
            onChange={onChange}
            searchable
            searchPlaceholder="Search models or type an ID…"
            allowCustom
            customLabel={q => `Use model ID “${q}”`}
            loading={list?.loading}
            placeholder={list?.loading ? 'Loading models…' : 'Choose a model'}
            emptyText="No models found. Type a model ID to use it anyway."
          />
        </div>
        <button type="button" className="icon-button bordered" aria-label="Reload models" title="Reload models" onClick={onReload} disabled={list?.loading}>
          <RefreshCw size={16} className={list?.loading ? 'spin' : undefined} />
        </button>
      </div>
      {list?.error && (
        <Callout tone="bad">
          Couldn’t load models: {list.error}. You can still type a model ID above.
        </Callout>
      )}
      {!list?.loading && !list?.error && list?.models && <p className="hint">{list.models.length} models available.</p>}
      {value && (
        <div className="row wrap">
          <button
            type="button"
            className="ghost sm"
            disabled={test === 'running'}
            onClick={async () => {
              setTest('running');
              try {
                setTest(await send('/settings/test', { provider: provider.id, model: value }));
              } catch (e) {
                setTest({ ok: false, message: errorText(e) });
              }
            }}
          >
            {test === 'running' ? <Spinner size={14} /> : <Zap size={14} />} Send a test message
          </button>
          {test && test !== 'running' && <span className={test.ok ? 'good-text' : 'danger-text'}>{test.ok ? 'Works — the model replied.' : test.message}</span>}
        </div>
      )}
    </div>
  );
}

function WritingStyle({ settings, save }: { settings: SettingsT; save: Save }) {
  const [prompt, setPrompt] = useState(settings.system_prompt || '');
  useEffect(() => setPrompt(settings.system_prompt || ''), [settings.system_prompt]);
  const languageOptions = useMemo(() => {
    const opts = OUTPUT_LANGUAGES.map(o => ({ ...o }));
    if (settings.output_language && !opts.some(o => o.value === settings.output_language)) opts.push({ value: settings.output_language, label: settings.output_language });
    return opts;
  }, [settings.output_language]);
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Writing style</h2>
          <p className="muted">Applies to every AI note, whichever provider writes it.</p>
        </div>
      </div>
      <div className="stack">
        <div data-setting="ai-language">
        <Field label="Language of AI notes">
          <Select
            ariaLabel="Language of AI notes"
            value={settings.output_language}
            options={languageOptions}
            onChange={v => void save({ output_language: v }, 'Note language updated.').catch(() => {})}
            searchable
            allowCustom
            customLabel={q => `Use “${q}”`}
          />
        </Field>
        </div>
        <div data-setting="ai-instructions">
        <Field label="Extra instructions" hint="Optional. For example: “Use bullet points. Spell my lab’s name as ‘K-Lab’.”">
          <textarea rows={3} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Anything the AI should always keep in mind…" aria-label="Extra instructions" />
        </Field>
        </div>
        {prompt !== (settings.system_prompt || '') && (
          <div className="row">
            <button type="button" className="primary sm" onClick={() => void save({ system_prompt: prompt }, 'Instructions saved.').catch(() => {})}>
              Save instructions
            </button>
            <button type="button" className="ghost sm" onClick={() => setPrompt(settings.system_prompt || '')}>
              Discard
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

/* ======================================================== Transcription */

function TranscriptionSettings({ settings, save }: { settings: SettingsT; save: Save }) {
  const toast = useToast();
  const [stt, setStt] = useState<SttModels | null>(null);
  const [downloads, setDownloads] = useState<Record<string, { job: string; progress: number }>>({});
  const refresh = useCallback(async () => setStt(await api<SttModels>('/stt/models')), []);
  useEffect(() => {
    refresh().catch(e => toast(errorText(e), 'error'));
  }, [refresh, toast]);

  // Track download jobs until the worker finishes them.
  useEffect(() => {
    const entries = Object.entries(downloads);
    if (!entries.length) return;
    const timer = setInterval(async () => {
      for (const [model, d] of entries) {
        try {
          const job = await api<{ status: string; progress: number; error?: string }>(`/jobs/${d.job}`);
          if (job.status === 'completed' || job.status === 'failed') {
            setDownloads(x => {
              const { [model]: _, ...rest } = x;
              return rest;
            });
            await refresh();
            if (job.status === 'failed') toast(`Download of ${STT_MODELS[model]?.label || model} failed${job.error ? `: ${job.error}` : ''}.`, 'error');
            else toast(`${STT_MODELS[model]?.label || model} is downloaded and ready.`, 'success');
          } else setDownloads(x => (x[model] ? { ...x, [model]: { ...x[model], progress: job.progress || 0 } } : x));
        } catch {}
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [downloads, refresh, toast]);

  async function download(model: string) {
    try {
      const job = await send<{ id: string }>('/stt/models/download', { model });
      setDownloads(x => ({ ...x, [model]: { job: job.id, progress: 0 } }));
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  async function choose(model: string) {
    await save({ stt_model: model }, `Transcription will use ${STT_MODELS[model]?.label || model}.`).catch(() => {});
    const m = stt?.models.find(x => x.id === model);
    if (m && !m.downloaded && !downloads[model]) void download(model);
  }

  const gpu = stt?.cuda_available;
  const order = Object.keys(STT_MODELS);
  const models = [...(stt?.models || [])].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const languageHelp: Record<string, string> = {
    auto: 'Detects one language for the whole recording.',
    en: 'Everything is transcribed as English.',
    zh: 'Everything is transcribed as Chinese.',
    mixed: 'Detects the language sentence by sentence — best when people switch between English and 中文.',
  };

  return (
    <div className="stack-lg">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Speech-to-text</h2>
            <p className="muted">Runs privately on this PC. Audio never leaves your machine for transcription.</p>
          </div>
          {stt &&
            (gpu ? (
              <Badge tone="good">
                <Zap size={12} /> NVIDIA GPU ready
              </Badge>
            ) : gpu === false ? (
              <Badge tone="warn">No GPU detected</Badge>
            ) : (
              <Badge>Worker starting…</Badge>
            ))}
        </div>

        <div data-setting="stt-language">
        <Field label="Spoken language">
          <Segmented
            ariaLabel="Spoken language"
            value={settings.stt_language as 'auto' | 'en' | 'zh' | 'mixed'}
            onChange={v => void save({ stt_language: v }).catch(() => {})}
            options={[
              { value: 'mixed', label: 'English + 中文' },
              { value: 'auto', label: 'Auto-detect' },
              { value: 'en', label: 'English' },
              { value: 'zh', label: '中文' },
            ]}
          />
          <p className="hint">{languageHelp[settings.stt_language]}</p>
        </Field>
        </div>

        <div data-setting="stt-traditional">
        <Switch
          checked={settings.traditional_chinese}
          onChange={v => void save({ traditional_chinese: v }).catch(() => {})}
          label="Write Chinese in Traditional characters (繁體)"
          description="Converts transcripts and AI notes. The original output is kept."
        />
        </div>
      </section>

      <section className="panel" data-setting="stt-model">
        <div className="panel-head">
          <div>
            <h2>Speech model</h2>
            <p className="muted">Larger models are more accurate but slower. Models download once and stay on this PC.</p>
          </div>
          <button type="button" className="icon-button bordered" aria-label="Refresh model status" title="Refresh" onClick={() => void refresh()}>
            <RefreshCw size={16} />
          </button>
        </div>
        {!stt ? (
          <div className="loading-block">
            <Spinner /> Checking models…
          </div>
        ) : (
          <div className="model-list" role="radiogroup" aria-label="Speech model">
            {models.map(m => {
              const meta = STT_MODELS[m.id] || { label: m.name, size: '', description: '' };
              const selected = settings.stt_model === m.id;
              const dl = downloads[m.id];
              return (
                <div key={m.id} className={cx('model-row', selected && 'selected')}>
                  <button type="button" role="radio" aria-checked={selected} className="model-pick" onClick={() => void choose(m.id)}>
                    <span className="radio-dot" />
                    <span className="option-text">
                      <span className="model-name">
                        {meta.label} {meta.recommended && <Badge tone="accent">Recommended</Badge>}
                        {meta.englishOnly && settings.stt_language !== 'en' && <Badge tone="warn">English only</Badge>}
                      </span>
                      <span className="option-description">{meta.description}</span>
                    </span>
                  </button>
                  <span className="model-status">
                    <span className="muted">{meta.size}</span>
                    {m.downloaded ? (
                      <Badge tone="good">
                        <Check size={12} /> Ready
                      </Badge>
                    ) : dl ? (
                      <Badge>
                        <Spinner size={12} /> Downloading{dl.progress ? ` ${Math.round(dl.progress * 100)}%` : '…'}
                      </Badge>
                    ) : (
                      <button type="button" className="ghost sm" onClick={() => void download(m.id)}>
                        <Download size={14} /> Download
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {stt && !models.find(m => m.id === settings.stt_model)?.downloaded && !downloads[settings.stt_model] && (
          <Callout tone="warn">The selected model isn’t downloaded yet. It will download automatically the first time you transcribe, or click Download now.</Callout>
        )}
      </section>

      <details className="panel disclosure" data-setting="stt-advanced">
        <summary>
          <span>
            <strong>Advanced</strong>
            <span className="muted"> · processor and precision</span>
          </span>
        </summary>
        <div className="stack">
          <Field label="Processor">
            <Segmented
              ariaLabel="Processor"
              value={settings.stt_device as 'cuda' | 'cpu'}
              onChange={v => void save({ stt_device: v, stt_compute_type: v === 'cuda' ? 'float16' : 'int8' }, v === 'cuda' ? 'Using the GPU.' : 'Using the CPU.').catch(() => {})}
              options={[
                { value: 'cuda', label: 'GPU (CUDA)', icon: <Zap size={14} /> },
                { value: 'cpu', label: 'CPU', icon: <Cpu size={14} /> },
              ]}
            />
          </Field>
          <Field label="Precision" hint="Automatic picks float16 on GPU and int8 on CPU. Change only if you know you need to.">
            <Select
              ariaLabel="Precision"
              value={settings.stt_compute_type}
              onChange={v => void save({ stt_compute_type: v }).catch(() => {})}
              options={[
                { value: settings.stt_device === 'cuda' ? 'float16' : 'int8', label: 'Automatic (recommended)', description: settings.stt_device === 'cuda' ? 'float16' : 'int8' },
                ...(settings.stt_device === 'cuda' ? ['int8_float16', 'float32'] : ['int8_float32', 'float32']).map(v => ({ value: v, label: v })),
              ]}
            />
          </Field>
        </div>
      </details>
    </div>
  );
}

/* ================================================================ Notes */

function NotesSettings({ settings, save }: { settings: SettingsT; save: Save }) {
  const views = [
    { value: 'write' as const, label: 'Write' },
    { value: 'preview' as const, label: 'Preview' },
  ];
  const keys: [string, string][] = [
    ['Tab', 'Indent the line (nests a list item)'],
    ['Shift + Tab', 'Outdent the line'],
    ['Enter', 'Continue the list; on an empty item, end it'],
    ['Esc', 'Leave the editor (then Tab moves focus)'],
    ['- [ ] task', 'Checkbox — click it in Preview to tick it'],
    ['# / ## Heading', 'Headings'],
  ];
  return (
    <div className="stack-lg">
      <section className="panel" data-setting="notes-open">
        <div className="panel-head">
          <div>
            <h2>When a meeting opens</h2>
            <p className="muted">Choose whether each tab starts in writing mode or as formatted text. You can always switch.</p>
          </div>
        </div>
        <div className="setting-line">
          <div>
            <strong>My notes</strong>
            <p className="hint">Your own notes, usually typed live.</p>
          </div>
          <Segmented ariaLabel="My notes open in" value={settings.notes_view} onChange={v => void save({ notes_view: v }).catch(() => {})} options={views} />
        </div>
        <div className="setting-line">
          <div>
            <strong>AI notes</strong>
            <p className="hint">Generated notes, mostly read.</p>
          </div>
          <Segmented ariaLabel="AI notes open in" value={settings.ai_notes_view} onChange={v => void save({ ai_notes_view: v }).catch(() => {})} options={views} />
        </div>
      </section>
      <section className="panel" data-setting="notes-back">
        <div className="panel-head">
          <div>
            <h2>Going back</h2>
            <p className="muted">What the Back button does — and your browser’s back button, mouse back button and Alt+← too.</p>
          </div>
        </div>
        <div className="setting-line">
          <div>
            <strong>Back goes to</strong>
            <p className="hint">
              {settings.back_behavior === 'history'
                ? 'The page you were on before, in the order you visited them — even if you jumped around from the sidebar.'
                : 'One level up: a meeting goes to its folder (or Home if it isn’t in one), a folder goes to Home.'}
            </p>
          </div>
          <Segmented
            ariaLabel="Back goes to"
            value={settings.back_behavior}
            onChange={v => void save({ back_behavior: v }).catch(() => {})}
            options={[
              { value: 'up' as const, label: 'Up one level' },
              { value: 'history' as const, label: 'Previous page' },
            ]}
          />
        </div>
      </section>
      <section className="panel" data-setting="notes-keys">
        <div className="panel-head">
          <div>
            <h2>Keyboard & formatting</h2>
            <p className="muted">Notes are Markdown.</p>
          </div>
        </div>
        <dl className="shortcuts">
          {keys.map(([k, v]) => (
            <div key={k}>
              <dt>
                <kbd>{k}</kbd>
              </dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
