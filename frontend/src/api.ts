import type { AIEntry, AINotice } from './aiOrder';
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Recent GET results, kept in memory only (API responses are no-store, so nothing reaches the disk cache).
 * The server tags JSON with an ETag; sending it back turns an unchanged poll into an empty 304, so a
 * phone on Tailscale isn't re-downloading a whole transcript every few seconds, and an unchanged result
 * keeps the same object, so React skips re-rendering it.
 */
type Cached = { etag: string; data: unknown; at: number };
const cache = new Map<string, Cached>();
const CACHE_MAX = 24;
const inflight = new Map<string, Promise<unknown>>();

function remember(path: string, entry: Cached) {
  cache.delete(path); // re-insert so the Map stays in least-recently-used order
  cache.set(path, entry);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

/** The last result fetched for `path`, if any (may be a few seconds old). */
export function peek<T>(path: string): T | undefined {
  return cache.get(path)?.data as T | undefined;
}

/** Forget cached results whose path starts with `prefix` (or everything). */
export function forget(prefix = '') {
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key);
}

/** Warm the cache for `path` in the background unless it was fetched in the last `fresh` ms. */
export function prefetch(path: string, fresh = 10000) {
  const hit = cache.get(path);
  if (inflight.has(path) || (hit && Date.now() - hit.at < fresh)) return;
  void api(path).catch(() => {});
}

export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const read = !options.method || options.method === 'GET';
  if (!read) return request<T>(path, options);
  // Share one request between callers asking for the same thing at once (e.g. a prefetch and the page).
  if (!options.signal) {
    const pending = inflight.get(path);
    if (pending) return pending as Promise<T>;
  }
  const p = request<T>(path, options, true);
  if (!options.signal) {
    inflight.set(path, p);
    p.then(
      () => inflight.delete(path),
      () => inflight.delete(path),
    );
  }
  return p;
}

async function request<T>(path: string, options: RequestInit, read = false): Promise<T> {
  const hit = read ? cache.get(path) : undefined;
  const response = await fetch('/api' + path, {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(30000),
    ...options,
    headers: {
      ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...(hit ? { 'If-None-Match': hit.etag } : {}),
      ...options.headers,
    },
  });
  if (response.status === 304 && hit) {
    hit.at = Date.now();
    remember(path, hit);
    return hit.data as T;
  }
  if (!response.ok) {
    if (read) cache.delete(path);
    let message = response.statusText;
    try {
      const body = await response.json();
      message = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
    } catch {}
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  if (!response.headers.get('content-type')?.includes('json')) return undefined as T;
  const data = await response.json();
  const etag = read && response.headers.get('etag');
  if (etag) remember(path, { etag, data, at: Date.now() });
  return data;
}

export const send = <T = any>(path: string, body: unknown = {}, method = 'POST') =>
  api<T>(path, { method, body: JSON.stringify(body) });

/** Human-readable message for any thrown value (no "Error:" prefixes). */
export function errorText(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'The server took too long to respond.';
    if (e.message === 'Failed to fetch' || e.message.startsWith('NetworkError')) return 'Cannot reach the notebook server.';
    return e.message;
  }
  return String(e);
}

export type Meeting = {
  id: string;
  title: string;
  notes: string;
  notes_revision: number;
  enhanced_notes: string;
  enhanced_revision: number;
  template_id: string | null;
  language: string;
  /** Main language of this meeting's AI notes; null follows Settings. */
  notes_language: string | null;
  folder_id: string | null;
  archived: boolean;
  glossary?: GlossaryEntry[];
  status: string;
  created_at: string;
  updated_at: string;
};
/** A name, term, acronym or spelling the AI should know when it writes notes. */
export type GlossaryEntry = { term: string; meaning: string };
export type Folder = { id: string; name: string; color: string | null; icon: string | null; glossary?: GlossaryEntry[]; created_at: string };
export type Device = {
  id: string;
  name: string;
  ready: boolean;
  online: boolean;
  backup_enabled: boolean;
  meeting_id: string;
  recording_id?: string;
  last_seen?: string;
};
export type RecordingState = {
  user_paused?: boolean;
  status: string;
  active_device_id: string | null;
  pending_device_id: string | null;
  message: string | null;
  backup_order: string[];
  auto_fallback: boolean;
};
export type Recording = {
  id: string;
  meeting_id: string;
  device_id?: string;
  label: string;
  mime_type: string;
  status: string;
  created_at: string;
  duration?: number;
  bytes: number;
  chunk_count: number;
};
export type Segment = { id: string; recording_id: string; start: number; end: number; text: string; language?: string };
export type Generation = {
  id: string;
  content: string;
  created_at: string;
  provider: string;
  model: string;
  template_name: string;
  notes_revision: number;
  output_language?: string | null;
};
export type Job = { id: string; kind: string; status: string; progress: number | null; error?: string | null; created_at: string; notices?: AINotice[] };
export type Detail = Meeting & {
  recordings: Recording[];
  transcript: Segment[];
  generations: Generation[];
  jobs: Job[];
  recording_state: RecordingState;
};
export type TemplateKind = 'ai' | 'notes';
export type Template = {
  id: string;
  name: string;
  instructions: string;
  structure: string;
  is_default?: boolean;
  kind: TemplateKind;
};
export type Settings = {
  provider: string;
  model: string;
  base_url: string;
  system_prompt: string;
  output_language: string;
  stt_model: string;
  stt_language: string;
  stt_device: string;
  stt_compute_type: string;
  traditional_chinese: boolean;
  /** After a recording finishes, transcribe and write AI notes right away (otherwise wait for a tap). */
  auto_process: boolean;
  provider_models: Record<string, string>;
  notes_view: 'write' | 'preview';
  ai_notes_view: 'write' | 'preview';
  back_behavior: 'up' | 'history';
  glossary: GlossaryEntry[];
  /** Ranked models: AI notes use the first one that works and fall back down the list. */
  ai_order: AIEntry[];
  api_key_status: Record<string, boolean>;
};
export type ChatGPTStatus = {
  signed_in: boolean;
  plan_enabled: boolean;
  email?: string | null;
  pending?: boolean;
  usage_url?: string;
  last_error?: string | null;
};
export type SttModels = { models: { id: string; name: string; downloaded: boolean }[]; device: string; cuda_available?: boolean | null };
