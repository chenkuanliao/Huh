import { useEffect, useState } from 'react';
import { Bot, Check, Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import { api, errorText, send } from './api';
import { copyText } from './Markdown';
import { Callout, ConfirmDialog, Segmented, Spinner, useToast } from './ui';

type AgentToken = { id: string; name: string; hint: string; created_at: string; last_used_at: string | null };
type Client = 'claude' | 'codex' | 'opencode';

const CLIENTS: { value: Client; label: string }[] = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'opencode', label: 'OpenCode' },
];

/** How to add the notebook to each agent, with the URL and token filled in. */
export function setupSnippet(client: Client, url: string, token: string) {
  if (client === 'claude') return `claude mcp add --transport http --scope user huh ${url} --header "Authorization: Bearer ${token}"`;
  if (client === 'codex') return `# ~/.codex/config.toml\n[mcp_servers.huh]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer ${token}" }`;
  return JSON.stringify(
    { $schema: 'https://opencode.ai/config.json', mcp: { huh: { type: 'remote', url, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  );
}

const SNIPPET_HINT: Record<Client, string> = {
  claude: 'Run in a terminal on the computer the agent runs on.',
  codex: 'Add to ~/.codex/config.toml.',
  opencode: 'Merge into opencode.json (in the project, or ~/.config/opencode/).',
};

function ago(iso: string | null) {
  if (!iso) return 'never used';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 120) return 'used just now';
  if (s < 3600) return `used ${Math.round(s / 60)} min ago`;
  if (s < 86400) return `used ${Math.round(s / 3600)} h ago`;
  return `used ${new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

function CopyBlock({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'bad'>('idle');
  useEffect(() => setState('idle'), [text]);
  return (
    <div className="code-wrap agent-code">
      <pre aria-label={label}>
        <code>{text}</code>
      </pre>
      <button
        type="button"
        className="code-copy"
        aria-label={`Copy ${label}`}
        onClick={async () => {
          setState((await copyText(text)) ? 'ok' : 'bad');
          window.setTimeout(() => setState('idle'), 1600);
        }}
      >
        {state === 'ok' ? <><Check size={12} /> Copied</> : state === 'bad' ? 'Select & copy' : <><Copy size={12} /> Copy</>}
      </button>
    </div>
  );
}

export default function AgentSettings() {
  const toast = useToast();
  const url = `${window.location.origin}/mcp`;
  const [tokens, setTokens] = useState<AgentToken[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<(AgentToken & { token: string }) | null>(null);
  const [client, setClient] = useState<Client>('claude');
  const [revoking, setRevoking] = useState<AgentToken | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const local = /^(localhost|127\.|\[::1\])/.test(window.location.hostname);

  const load = () =>
    api<AgentToken[]>('/agent-tokens')
      .then(t => {
        setTokens(t);
        setLoadError('');
      })
      .catch(e => setLoadError(errorText(e)));
  useEffect(() => {
    void load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const t = await send<AgentToken & { token: string }>('/agent-tokens', { name: name.trim() });
      setFresh(t);
      setName('');
      await load();
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!revoking) return;
    setRevokeBusy(true);
    try {
      await send(`/agent-tokens/${revoking.id}`, {}, 'DELETE');
      if (fresh?.id === revoking.id) setFresh(null);
      toast(`“${revoking.name}” can no longer read your notebook.`);
      setRevoking(null);
      await load();
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setRevokeBusy(false);
    }
  }

  return (
    <div className="stack-lg">
      <section className="panel" data-setting="agents-connect">
        <div className="panel-head">
          <div>
            <h2>Connect an agent</h2>
            <p className="muted">
              Let Claude Code, Codex, OpenCode or any MCP client search and read your meetings: notes, AI notes, transcripts and to-dos. Agents can only read. They can’t change
              anything.
            </p>
          </div>
        </div>
        <div className="stack">
          <strong className="agent-label">Server address</strong>
          <CopyBlock text={url} label="MCP server address" />
          {local && <p className="hint">This is this computer’s address. For agents on other computers, open Huh at its Tailscale address and copy it from there.</p>}
        </div>
        <form className="row agent-create" onSubmit={create}>
          <input
            className="grow"
            maxLength={100}
            aria-label="Token name"
            placeholder="Name it after the agent or computer, e.g. Work laptop · Claude Code"
            value={name}
            onChange={e => setName(e.target.value)}
          />
          <button type="submit" className="primary" disabled={!name.trim() || busy}>
            {busy ? <Spinner size={15} /> : <Plus size={15} />} Create token
          </button>
        </form>
        {fresh && (
          <div className="agent-fresh" data-setting="agents-setup">
            <Callout tone="good" icon={<KeyRound size={16} />}>
              <strong>Token for “{fresh.name}”.</strong> Copy it now. It won’t be shown again.
            </Callout>
            <CopyBlock text={fresh.token} label="agent token" />
            <Segmented ariaLabel="Set up for" value={client} onChange={setClient} options={CLIENTS} />
            <p className="hint">{SNIPPET_HINT[client]}</p>
            <CopyBlock text={setupSnippet(client, url, fresh.token)} label={`${CLIENTS.find(c => c.value === client)!.label} setup`} />
            <button type="button" className="ghost sm agent-done" onClick={() => setFresh(null)}>
              Done, hide the token
            </button>
          </div>
        )}
      </section>

      <section className="panel" data-setting="agents-tokens">
        <div className="panel-head">
          <div>
            <h2>Agent tokens</h2>
            <p className="muted">Revoke a token to cut that agent off right away.</p>
          </div>
        </div>
        {loadError && <Callout tone="bad">{loadError}</Callout>}
        {!tokens && !loadError && (
          <div className="loading-block">
            <Spinner /> Loading tokens…
          </div>
        )}
        {tokens && !tokens.length && <p className="muted">No tokens yet. No agent can read your notebook.</p>}
        {tokens && !!tokens.length && (
          <ul className="agent-tokens">
            {tokens.map(t => (
              <li key={t.id}>
                <Bot size={17} className="agent-token-icon" />
                <span className="agent-token-text">
                  <strong>{t.name}</strong>
                  <span className="hint">
                    <code>{t.hint}…</code> · created {new Date(t.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} · {ago(t.last_used_at)}
                  </span>
                </span>
                <button type="button" className="ghost sm danger-text" onClick={() => setRevoking(t)}>
                  <Trash2 size={14} /> Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <ConfirmDialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        onConfirm={() => void revoke()}
        busy={revokeBusy}
        title={`Revoke “${revoking?.name}”?`}
        description="Any agent using this token loses access immediately. You can create a new token later."
        confirmLabel="Revoke"
      />
    </div>
  );
}
