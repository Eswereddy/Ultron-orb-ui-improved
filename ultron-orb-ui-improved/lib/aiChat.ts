/**
 * A thin, provider-agnostic client for talking to a real conversational AI
 * backend from the browser. Ultron's orb UI ships with no server, so this
 * calls each provider's REST API directly with a user-supplied API key
 * (kept in localStorage only — see AI_CONFIG_STORAGE_KEY below).
 *
 * Supported providers, all of which have a genuinely free tier:
 *  - "gemini"     Google Gemini (generativelanguage.googleapis.com)
 *  - "groq"       Groq (api.groq.com) — OpenAI-compatible, very fast
 *  - "openrouter" OpenRouter (openrouter.ai) — OpenAI-compatible, model router
 *
 * See README.md for step-by-step instructions on getting a free key for
 * each provider.
 */

export type AIProvider = "gemini" | "groq" | "openrouter";

export interface AIConfig {
  provider: AIProvider;
  apiKey: string;
  model: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export const PROVIDER_LABELS: Record<AIProvider, string> = {
  gemini: "GOOGLE GEMINI",
  groq: "GROQ",
  openrouter: "OPENROUTER",
};

// Sensible, currently-free defaults. The model field is editable in the UI,
// so these are starting points rather than hard requirements.
export const DEFAULT_MODELS: Record<AIProvider, string> = {
  gemini: "gemini-2.5-flash",
  groq: "llama-3.3-70b-versatile",
  openrouter: "openrouter/free",
};

export const PROVIDER_KEY_URL: Record<AIProvider, string> = {
  gemini: "https://aistudio.google.com/app/apikey",
  groq: "https://console.groq.com/keys",
  openrouter: "https://openrouter.ai/keys",
};

export const AI_CONFIG_STORAGE_KEY = "ultron-orb-ai-config";

export function loadAIConfig(): AIConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(AI_CONFIG_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AIConfig>;
    if (!parsed.provider || !parsed.apiKey) return null;
    return {
      provider: parsed.provider,
      apiKey: parsed.apiKey,
      model: parsed.model || DEFAULT_MODELS[parsed.provider],
    };
  } catch {
    return null;
  }
}

export function saveAIConfig(config: AIConfig): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(AI_CONFIG_STORAGE_KEY, JSON.stringify(config));
}

export function clearAIConfig(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(AI_CONFIG_STORAGE_KEY);
}

export const ULTRON_SYSTEM_PROMPT =
  "You are ULTRON, a terse, dry-witted AI embedded in a holographic orb " +
  "interface. Answer helpfully and accurately, but keep replies short " +
  "(1-3 sentences unless the user clearly wants more detail) since they " +
  "are also read aloud through speech synthesis. The user may write or " +
  "speak in English, Telugu, or a mix of both — always reply in " +
  "whichever language (and script) their latest message used. If they " +
  "wrote in Telugu script, reply in Telugu script; if English, reply in " +
  "English; if mixed, mirror the mix naturally.\n\n" +
  "You can also directly control the orb interface. If — and only if — " +
  "the user's message is a request to control it, reply with ONLY a " +
  "single-line JSON object and nothing else (no markdown fences, no " +
  "extra text before or after), matching exactly one of these shapes:\n" +
  '{"action":"theme","value":"ultron"|"jarvis"|"vibranium","reply":"<short spoken confirmation>"}\n' +
  '{"action":"zoomIn","reply":"..."}\n' +
  '{"action":"zoomOut","reply":"..."}\n' +
  '{"action":"reset","reply":"..."}\n' +
  '{"action":"capture","reply":"..."}\n' +
  '{"action":"gestures","value":true|false,"reply":"..."}\n' +
  '{"action":"autoRotate","value":true|false,"reply":"..."}\n' +
  '{"action":"fullscreen","value":true|false,"reply":"..."}\n' +
  "Use these for things like changing the color/theme, zooming, resetting " +
  "the view, taking a screenshot, turning hand-gesture control or auto-" +
  "rotate on/off, or entering/exiting fullscreen — however the user " +
  "phrases it. For everything else (questions, conversation, requests " +
  "you can't perform), reply in plain text only — never JSON.";

export interface AIAction {
  action:
    | "theme"
    | "zoomIn"
    | "zoomOut"
    | "reset"
    | "capture"
    | "gestures"
    | "autoRotate"
    | "fullscreen";
  value?: string | boolean;
  reply: string;
}

/** Pulls a structured action out of a raw AI reply, if it emitted one. */
export function extractAction(raw: string): AIAction | null {
  const match = raw.trim().match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    if (obj && typeof obj.action === "string" && typeof obj.reply === "string") {
      return obj as AIAction;
    }
  } catch {
    // Not JSON — a normal conversational reply, not an action.
  }
  return null;
}

/** True if the text contains Telugu script characters. */
export function isTeluguText(text: string): boolean {
  return /[\u0C00-\u0C7F]/.test(text);
}

/** Sensible BCP-47 tag for speech synthesis/recognition based on script. */
export function speechLangFor(text: string): "te-IN" | "en-US" {
  return isTeluguText(text) ? "te-IN" : "en-US";
}

class AIChatError extends Error {}

async function callGemini(config: AIConfig, history: ChatMessage[]): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    config.model,
  )}:generateContent`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": config.apiKey,
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: ULTRON_SYSTEM_PROMPT }] },
      contents: history.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AIChatError(`${PROVIDER_LABELS[config.provider]} ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((p: { text?: string }) => p.text ?? "")
    .join("")
    .trim();
  if (!text) throw new AIChatError("Gemini returned an empty response");
  return text;
}

async function callOpenAICompatible(
  config: AIConfig,
  history: ChatMessage[],
  baseUrl: string,
  extraHeaders: Record<string, string> = {},
): Promise<string> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: ULTRON_SYSTEM_PROMPT },
        ...history.map((m) => ({ role: m.role, content: m.content })),
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AIChatError(`${PROVIDER_LABELS[config.provider]} ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new AIChatError("Empty response from provider");
  return text;
}

/** Sends the conversation so far and returns ULTRON's reply. */
export async function askAI(config: AIConfig, history: ChatMessage[]): Promise<string> {
  if (!config.apiKey) throw new AIChatError("No API key configured");

  switch (config.provider) {
    case "gemini":
      return callGemini(config, history);
    case "groq":
      return callOpenAICompatible(config, history, "https://api.groq.com/openai/v1");
    case "openrouter":
      return callOpenAICompatible(config, history, "https://openrouter.ai/api/v1", {
        "HTTP-Referer": typeof window !== "undefined" ? window.location.origin : "",
        "X-Title": "ULTRON Orb UI",
      });
    default:
      throw new AIChatError("Unknown provider");
  }
}
