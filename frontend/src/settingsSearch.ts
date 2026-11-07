/** Everything on the Settings page that search can find. */

export type SettingsSection = 'ai' | 'transcription' | 'templates' | 'notes';

export const SECTION_LABELS: Record<SettingsSection, string> = {
  ai: 'AI notes',
  transcription: 'Transcription',
  templates: 'Templates',
  notes: 'Notes & navigation',
};

export type SettingEntry = {
  /** Matches a `data-setting` attribute on the page, so a result can scroll to and highlight it. */
  id: string;
  section: SettingsSection;
  title: string;
  description: string;
  /** Other words people might search with. Not shown. */
  keywords: string;
};

export const SETTINGS_INDEX: SettingEntry[] = [
  // AI notes
  {
    id: 'ai-provider',
    section: 'ai',
    title: 'AI provider',
    description: 'Choose who writes your AI notes: ChatGPT, OpenAI, Anthropic, Gemini, OpenRouter, NVIDIA or your own server.',
    keywords: 'service llm claude gpt chatgpt openai anthropic google gemini openrouter opencode zen nvidia nim ollama local custom switch who writes summary summarize',
  },
  {
    id: 'ai-connect',
    section: 'ai',
    title: 'Connect / API key',
    description: 'Sign in with ChatGPT, paste an API key, or point to an OpenAI-compatible server.',
    keywords: 'login log in sign in sign out logout account token secret key password endpoint base url custom server ollama host connect disconnect remove replace',
  },
  {
    id: 'ai-model',
    section: 'ai',
    title: 'AI model',
    description: 'Pick the model that writes your notes, and send a test message to check it works.',
    keywords: 'llm gpt claude gemini choose select model id test reload refresh check works',
  },
  {
    id: 'ai-language',
    section: 'ai',
    title: 'Language of AI notes',
    description: 'Which language AI notes are written in.',
    keywords: 'output language english chinese 中文 繁體 简体 japanese korean spanish bilingual translate translation locale writing style',
  },
  {
    id: 'ai-instructions',
    section: 'ai',
    title: 'Extra instructions',
    description: 'Things the AI should always keep in mind, like names to spell a certain way.',
    keywords: 'system prompt custom instructions writing style tone format bullet points spelling names glossary rules',
  },

  // Transcription
  {
    id: 'stt-language',
    section: 'transcription',
    title: 'Spoken language',
    description: 'English, Chinese, auto-detect, or both mixed in one recording.',
    keywords: 'speech language english chinese 中文 mandarin mixed bilingual code switching auto detect transcription transcript recognise recognize',
  },
  {
    id: 'stt-traditional',
    section: 'transcription',
    title: 'Traditional Chinese (繁體)',
    description: 'Write Chinese in Traditional characters (繁體) instead of Simplified.',
    keywords: 'traditional simplified 繁體 简体 繁体 taiwan hong kong chinese characters convert opencc script',
  },
  {
    id: 'stt-model',
    section: 'transcription',
    title: 'Speech model',
    description: 'Larger models are more accurate but slower. Download and pick one.',
    keywords: 'whisper speech to text stt transcription model size accuracy speed fast slow download large medium small tiny turbo',
  },
  {
    id: 'stt-advanced',
    section: 'transcription',
    title: 'Processor and precision',
    description: 'Run transcription on the GPU or the CPU, and choose float16 or int8.',
    keywords: 'advanced gpu cpu cuda nvidia graphics card hardware performance speed precision compute type float16 int8 float32 quantization',
  },

  // Templates
  {
    id: 'tpl-kinds',
    section: 'templates',
    title: 'Note templates and AI templates',
    description: 'Note templates drop an outline into your notes; AI templates shape the notes the AI writes.',
    keywords: 'template outline format structure agenda layout preset',
  },
  {
    id: 'tpl-manage',
    section: 'templates',
    title: 'Create or edit a template',
    description: 'Add, rename, edit or delete templates, and set the default AI template.',
    keywords: 'new template create add edit rename delete remove default sections headings outline instructions focus',
  },

  // Notes & navigation
  {
    id: 'notes-open',
    section: 'notes',
    title: 'Notes open in Write or Preview',
    description: 'Whether My notes and AI notes start in writing mode or as formatted text.',
    keywords: 'editor edit mode view preview write markdown rendered formatted read reading default tab meeting opens my notes ai notes',
  },
  {
    id: 'notes-back',
    section: 'notes',
    title: 'Back button',
    description: 'Back goes up one level, or to the previous page you visited.',
    keywords: 'back navigation navigate history previous page up one level parent folder home browser mouse alt arrow return',
  },
  {
    id: 'notes-keys',
    section: 'notes',
    title: 'Keyboard shortcuts & formatting',
    description: 'Tab to indent, Enter to continue a list, checkboxes and headings in Markdown.',
    keywords: 'keyboard shortcuts hotkeys keys keybindings markdown formatting indent outdent tab shift enter esc escape checkbox task todo to-do heading list bullet',
  },
];

export type SettingMatch = { entry: SettingEntry; score: number; matched: number; tokens: number };

const normalize = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

/** How well one query word matches one piece of text: whole word > word start > anywhere. */
function wordScore(token: string, text: string): number {
  const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.includes(token)) return 3;
  if (words.some(w => w.startsWith(token))) return 2;
  // Substrings only count once the word is long enough to mean something (and always for CJK).
  if ((token.length >= 3 || /[^\x00-\x7f]/.test(token)) && text.includes(token)) return 1;
  return 0;
}

/**
 * Rank settings for a query. Every word should match somewhere; when no setting matches
 * every word, settings that match some of them come back as related results.
 */
export function searchSettings(query: string, index: SettingEntry[] = SETTINGS_INDEX): { results: SettingMatch[]; partial: boolean } {
  const tokens = [...new Set(normalize(query).split(/[^\p{L}\p{N}]+/u).filter(Boolean))];
  if (!tokens.length) return { results: [], partial: false };

  const scored = index.map(entry => {
    const title = normalize(entry.title);
    const section = normalize(SECTION_LABELS[entry.section]);
    const description = normalize(entry.description);
    const keywords = normalize(entry.keywords);
    let score = 0;
    let matched = 0;
    for (const t of tokens) {
      const s = Math.max(wordScore(t, title) * 4, wordScore(t, keywords) * 2, wordScore(t, section) * 1.5, wordScore(t, description));
      if (s > 0) matched++;
      score += s;
    }
    return { entry, score, matched, tokens: tokens.length };
  });

  const full = scored.filter(m => m.matched === tokens.length);
  const pick = full.length ? full : scored.filter(m => m.matched > 0);
  pick.sort((a, b) => b.matched - a.matched || b.score - a.score);
  return { results: pick, partial: !full.length && pick.length > 0 };
}
