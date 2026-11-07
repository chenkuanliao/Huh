export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch('/api' + path, {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(30000),
    ...options,
    headers: {
      ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = await response.json();
      message = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
    } catch {}
    throw new ApiError(response.status, message);
  }
  return response.status === 204
    ? (undefined as T)
    : response.headers.get('content-type')?.includes('json')
      ? response.json()
      : (undefined as T);
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
  status: string;
  created_at: string;
  updated_at: string;
};
export type Folder = { id: string; name: string; color: string | null; icon: string | null; created_at: string };
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
export type Job = { id: string; kind: string; status: string; progress: number | null; error?: string | null; created_at: string };
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
  provider_models: Record<string, string>;
  notes_view: 'write' | 'preview';
  ai_notes_view: 'write' | 'preview';
  back_behavior: 'up' | 'history';
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
