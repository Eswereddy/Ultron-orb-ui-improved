/**
 * Thin wrapper around the (still vendor-prefixed) Web Speech API so the
 * orb can be driven by simple spoken commands, e.g. "zoom in", "reset",
 * "gestures on", "theme jarvis", "capture". Feature-detected: on browsers
 * without SpeechRecognition support, `isSupported()` returns false and
 * nothing else in the app depends on this module.
 */

export type VoiceCommand =
  | { type: "zoomIn" }
  | { type: "zoomOut" }
  | { type: "reset" }
  | { type: "gestures"; enabled: boolean }
  | { type: "autoRotate"; enabled: boolean }
  | { type: "capture" }
  | { type: "theme"; name: "ultron" | "jarvis" | "vibranium" };

export interface VoiceControlCallbacks {
  onCommand(command: VoiceCommand): void;
  /** Raw heard phrase, useful for a small "heard: ..." debug readout. */
  onHeard?(text: string): void;
  /** Fired instead of onCommand when the phrase didn't match a known
   *  command — a good place to forward it to a conversational AI. */
  onUnmatched?(text: string): void;
  onError?(message: string): void;
}

// Minimal shape of the SpeechRecognition API — not consistently present in
// TypeScript's DOM lib, so it's declared locally rather than depending on
// @types/dom-speech-recognition.
interface SpeechRecognitionAlternative {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  0: SpeechRecognitionAlternative;
  isFinal: boolean;
}
interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: Event & { error?: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isVoiceControlSupported(): boolean {
  return getRecognitionCtor() !== null;
}

const THEME_WORDS: Record<string, "ultron" | "jarvis" | "vibranium"> = {
  ultron: "ultron",
  jarvis: "jarvis",
  vibranium: "vibranium",
};

function parseCommand(phrase: string): VoiceCommand | null {
  const p = phrase.toLowerCase();

  if (p.includes("zoom in")) return { type: "zoomIn" };
  if (p.includes("zoom out")) return { type: "zoomOut" };
  if (p.includes("reset")) return { type: "reset" };
  if (p.includes("capture") || p.includes("screenshot")) return { type: "capture" };

  if (p.includes("gesture")) {
    if (p.includes("off") || p.includes("stop")) return { type: "gestures", enabled: false };
    if (p.includes("on") || p.includes("start")) return { type: "gestures", enabled: true };
  }

  if (p.includes("rotate")) {
    if (p.includes("off") || p.includes("stop")) return { type: "autoRotate", enabled: false };
    if (p.includes("on") || p.includes("start")) return { type: "autoRotate", enabled: true };
  }

  if (p.includes("theme")) {
    for (const word of Object.keys(THEME_WORDS)) {
      if (p.includes(word)) return { type: "theme", name: THEME_WORDS[word] };
    }
  }

  return null;
}

export class VoiceControl {
  private recognition: SpeechRecognitionLike | null = null;
  private callbacks: VoiceControlCallbacks;
  private shouldRun = false;

  constructor(callbacks: VoiceControlCallbacks) {
    this.callbacks = callbacks;
  }

  start(): boolean {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      this.callbacks.onError?.("VOICE CONTROL NOT SUPPORTED");
      return false;
    }

    this.shouldRun = true;
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result.isFinal) continue;
        const text = result[0].transcript.trim();
        if (!text) continue;
        this.callbacks.onHeard?.(text);
        const command = parseCommand(text);
        if (command) this.callbacks.onCommand(command);
        else this.callbacks.onUnmatched?.(text);
      }
    };

    recognition.onerror = (event) => {
      this.callbacks.onError?.(event.error ?? "VOICE ERROR");
    };

    // Some browsers stop the recognizer after a period of silence even in
    // continuous mode — restart it automatically while the feature is on.
    recognition.onend = () => {
      if (this.shouldRun) {
        try {
          recognition.start();
        } catch {
          // ignore — a stop() call may have raced this restart
        }
      }
    };

    this.recognition = recognition;
    try {
      recognition.start();
    } catch {
      this.callbacks.onError?.("VOICE INIT FAILED");
      return false;
    }
    return true;
  }

  stop(): void {
    this.shouldRun = false;
    this.recognition?.stop();
    this.recognition = null;
  }
}
