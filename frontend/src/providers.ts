/** Display metadata for note-generation providers. Endpoints are fixed server-side except for Custom. */
export type ProviderInfo = {
  id: string;
  name: string;
  tagline: string;
  auth: 'chatgpt' | 'key' | 'custom';
  endpoint?: string;
  keyUrl?: string;
  keyHint?: string;
  color: string;
  monogram: string;
};

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    tagline: 'Use your ChatGPT plan. Just sign in.',
    auth: 'chatgpt',
    color: '#10a37f',
    monogram: 'C',
  },
  {
    id: 'openai',
    name: 'OpenAI API',
    tagline: 'Pay-as-you-go OpenAI API key',
    auth: 'key',
    endpoint: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'sk-…',
    color: '#1f1f1f',
    monogram: 'O',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    tagline: 'Claude models with an API key',
    auth: 'key',
    endpoint: 'https://api.anthropic.com/v1',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'sk-ant-…',
    color: '#c46a45',
    monogram: 'A',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    tagline: 'Gemini models with an AI Studio key',
    auth: 'key',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    keyHint: 'AIza…',
    color: '#3f7ee8',
    monogram: 'G',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    tagline: 'Many model vendors, one key',
    auth: 'key',
    endpoint: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/settings/keys',
    keyHint: 'sk-or-…',
    color: '#6b5bd2',
    monogram: 'R',
  },
  {
    id: 'opencode',
    name: 'OpenCode Zen',
    tagline: 'Curated coding-grade models',
    auth: 'key',
    endpoint: 'https://opencode.ai/zen/v1',
    keyUrl: 'https://opencode.ai/auth',
    color: '#2b2b2b',
    monogram: 'Z',
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    tagline: 'Hosted open models from NVIDIA',
    auth: 'key',
    endpoint: 'https://integrate.api.nvidia.com/v1',
    keyUrl: 'https://build.nvidia.com/settings/api-keys',
    keyHint: 'nvapi-…',
    color: '#76b900',
    monogram: 'N',
  },
  {
    id: 'custom',
    name: 'Custom / local',
    tagline: 'Any OpenAI-compatible server (Ollama, LM Studio, vLLM…)',
    auth: 'custom',
    color: '#5f6b62',
    monogram: '·',
  },
];

export const providerInfo = (id: string) => PROVIDERS.find(p => p.id === id) || PROVIDERS[PROVIDERS.length - 1];

export const STT_MODELS: Record<string, { label: string; size: string; description: string; recommended?: boolean; englishOnly?: boolean }> = {
  'large-v3-turbo': { label: 'Large v3 Turbo', size: '1.6 GB', description: 'Fast and accurate. Best for English, 中文 and mixed meetings.', recommended: true },
  'large-v3': { label: 'Large v3', size: '3.1 GB', description: 'Most accurate, about 3× slower than Turbo.' },
  'distil-large-v3': { label: 'Distil Large v3', size: '1.5 GB', description: 'Very fast, English only.', englishOnly: true },
  medium: { label: 'Medium', size: '1.5 GB', description: 'Older mid-size model. Turbo is usually better.' },
  small: { label: 'Small', size: '480 MB', description: 'Light and quick. Fine for clear audio.' },
  base: { label: 'Base', size: '145 MB', description: 'Very light. Lower accuracy.' },
  tiny: { label: 'Tiny', size: '75 MB', description: 'For testing only.' },
};

export const OUTPUT_LANGUAGES = [
  { value: 'auto', label: 'Match the meeting', description: 'Write in the language that was spoken' },
  { value: 'English', label: 'English' },
  { value: 'Traditional Chinese (繁體中文)', label: '繁體中文', description: 'Traditional Chinese' },
  { value: 'Simplified Chinese (简体中文)', label: '简体中文', description: 'Simplified Chinese' },
  { value: 'English and Traditional Chinese', label: 'English + 繁體中文', description: 'Bilingual notes' },
  { value: 'Japanese', label: '日本語' },
  { value: 'Korean', label: '한국어' },
  { value: 'Spanish', label: 'Español' },
];
