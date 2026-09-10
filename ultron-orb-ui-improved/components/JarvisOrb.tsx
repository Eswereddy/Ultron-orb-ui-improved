"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createOrbScene, THEME_NAMES, type OrbSceneApi, type ThemeName } from "@/lib/orbScene";
import { HandTracker, type TrackerStatus } from "@/lib/handTracker";
import { VoiceControl, isVoiceControlSupported, type VoiceCommand } from "@/lib/voiceControl";
import {
  askAI,
  extractAction,
  loadAIConfig,
  saveAIConfig,
  clearAIConfig,
  DEFAULT_MODELS,
  PROVIDER_LABELS,
  PROVIDER_KEY_URL,
  type AIConfig,
  type AIAction,
  type AIProvider,
  type ChatMessage,
} from "@/lib/aiChat";

type CameraState = "off" | "starting" | "on" | "error";

const MODE_LABEL: Record<TrackerStatus["mode"], string> = {
  idle: "STANDBY",
  spin: "SPIN",
  zoom: "ZOOM",
};

const THEME_LABEL: Record<ThemeName, string> = {
  ultron: "ULTRON",
  jarvis: "JARVIS",
  vibranium: "VIBRANIUM",
};

const THEME_STORAGE_KEY = "ultron-orb-theme";
const AUTO_ROTATE_STORAGE_KEY = "ultron-orb-autorotate";
const PROVIDERS: AIProvider[] = ["gemini", "groq", "openrouter"];

function isThemeName(value: string | null): value is ThemeName {
  return !!value && (THEME_NAMES as string[]).includes(value);
}

export default function JarvisOrb() {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<OrbSceneApi | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);
  const voiceRef = useRef<VoiceControl | null>(null);

  const [camera, setCamera] = useState<CameraState>("off");
  const [status, setStatus] = useState<TrackerStatus>({ hands: 0, mode: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [theme, setThemeState] = useState<ThemeName>("ultron");
  const [autoRotate, setAutoRotateState] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);
  const [heard, setHeard] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [showPerf, setShowPerf] = useState(false);
  const [fps, setFps] = useState<number | null>(null);

  // ——— AI CHAT ———
  const [aiConfig, setAiConfig] = useState<AIConfig | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsProvider, setSettingsProvider] = useState<AIProvider>("gemini");
  const [settingsApiKey, setSettingsApiKey] = useState("");
  const [settingsModel, setSettingsModel] = useState(DEFAULT_MODELS.gemini);
  const [showChat, setShowChat] = useState(false);
  const [chatLog, setChatLog] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [revealKey, setRevealKey] = useState(false);
  const chatLogRef = useRef<HTMLDivElement>(null);
  const dispatchActionRef = useRef<(action: AIAction) => void>(() => {});
  const toggleVoiceRef = useRef<() => void>(() => {});

  // ——— SCENE LIFECYCLE ———
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    const initialTheme: ThemeName = isThemeName(savedTheme) ? savedTheme : "ultron";
    const initialAutoRotate = window.localStorage.getItem(AUTO_ROTATE_STORAGE_KEY) === "1";

    const scene = createOrbScene(container, {
      theme: initialTheme,
      onFps: setFps,
    });
    scene.setAutoRotate(initialAutoRotate);
    sceneRef.current = scene;
    setThemeState(scene.getTheme());
    setAutoRotateState(initialAutoRotate);

    return () => {
      trackerRef.current?.stop();
      trackerRef.current = null;
      voiceRef.current?.stop();
      voiceRef.current = null;
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  // Reflect the active theme on <body> so the HUD's CSS variables follow the orb.
  useEffect(() => {
    document.body.dataset.theme = theme;
  }, [theme]);

  // ——— AI CONFIG (loaded once from localStorage) ———
  useEffect(() => {
    const saved = loadAIConfig();
    if (saved) {
      setAiConfig(saved);
      setSettingsProvider(saved.provider);
      setSettingsApiKey(saved.apiKey);
      setSettingsModel(saved.model);
    }
  }, []);

  useEffect(() => {
    chatLogRef.current?.scrollTo({ top: chatLogRef.current.scrollHeight });
  }, [chatLog, aiBusy]);

  const speak = useCallback((text: string) => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.02;
    window.speechSynthesis.speak(utter);
  }, []);

  const sendToAI = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (!aiConfig) {
        setAiError("NO AI KEY CONFIGURED — OPEN AI SETUP");
        setShowSettings(true);
        return;
      }
      setShowChat(true);
      setAiError(null);
      setChatLog((prev) => {
        const next = [...prev, { role: "user" as const, content: trimmed }];
        setAiBusy(true);
        askAI(aiConfig, next)
          .then((reply) => {
            const action = extractAction(reply);
            const spoken = action ? action.reply : reply;
            setChatLog((cur) => [...cur, { role: "assistant", content: spoken }]);
            if (action) dispatchActionRef.current(action);
            speak(spoken);
          })
          .catch((err: unknown) => {
            setAiError(err instanceof Error ? err.message : "AI REQUEST FAILED");
          })
          .finally(() => setAiBusy(false));
        return next;
      });
    },
    [aiConfig, speak],
  );

  const handleChatSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      sendToAI(chatInput);
      setChatInput("");
    },
    [chatInput, sendToAI],
  );

  const saveSettings = useCallback(() => {
    const config: AIConfig = {
      provider: settingsProvider,
      apiKey: settingsApiKey.trim(),
      model: settingsModel.trim() || DEFAULT_MODELS[settingsProvider],
    };
    if (!config.apiKey) {
      setAiError("ENTER AN API KEY FIRST");
      return;
    }
    saveAIConfig(config);
    setAiConfig(config);
    setAiError(null);
    setShowSettings(false);
  }, [settingsProvider, settingsApiKey, settingsModel]);

  const forgetSettings = useCallback(() => {
    clearAIConfig();
    setAiConfig(null);
    setSettingsApiKey("");
  }, []);

  useEffect(() => {
    const onFsChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  // ——— GESTURES ———
  const stopGestures = useCallback(() => {
    trackerRef.current?.stop();
    trackerRef.current = null;
    setCamera("off");
    setStatus({ hands: 0, mode: "idle" });
  }, []);

  const startGestures = useCallback(async () => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay || trackerRef.current) return;

    setCamera("starting");
    setError(null);

    const tracker = new HandTracker(video, overlay, {
      onRotate: (dt, dp) => sceneRef.current?.rotateBy(dt, dp),
      onZoom: (factor) => sceneRef.current?.zoomBy(factor),
      onReset: () => sceneRef.current?.resetView(),
      onFist: () => {
        setShowChat(true);
        if (!voiceRef.current) toggleVoiceRef.current();
      },
      onStatus: setStatus,
    });
    trackerRef.current = tracker;

    try {
      await tracker.start();
      setCamera("on");
    } catch (err) {
      trackerRef.current = null;
      tracker.stop();
      setCamera("error");
      setError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "CAMERA ACCESS DENIED"
          : "TRACKING INIT FAILED",
      );
    }
  }, []);

  const toggleGestures = useCallback(() => {
    if (trackerRef.current) stopGestures();
    else void startGestures();
  }, [startGestures, stopGestures]);

  // ——— THEME ———
  const applyTheme = useCallback((next: ThemeName) => {
    sceneRef.current?.setTheme(next);
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
    setThemeState(next);
  }, []);

  const cycleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next = THEME_NAMES[(THEME_NAMES.indexOf(prev) + 1) % THEME_NAMES.length];
      sceneRef.current?.setTheme(next);
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
      return next;
    });
  }, []);

  // ——— AUTO-ROTATE ———
  const applyAutoRotate = useCallback((enabled: boolean) => {
    sceneRef.current?.setAutoRotate(enabled);
    window.localStorage.setItem(AUTO_ROTATE_STORAGE_KEY, enabled ? "1" : "0");
    setAutoRotateState(enabled);
  }, []);

  const toggleAutoRotate = useCallback(() => {
    setAutoRotateState((prev) => {
      const next = !prev;
      sceneRef.current?.setAutoRotate(next);
      window.localStorage.setItem(AUTO_ROTATE_STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  // ——— CAPTURE ———
  const captureScreenshot = useCallback(() => {
    const dataUrl = sceneRef.current?.captureImage();
    if (!dataUrl) return;
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = `ultron-orb-${Date.now()}.png`;
    link.click();
  }, []);

  // ——— FULLSCREEN ———
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen?.().catch(() => {
        setError("FULLSCREEN UNAVAILABLE");
      });
    }
  }, []);

  // ——— AI ACTION DISPATCH (lets the AI itself control the orb) ———
  const dispatchAIAction = useCallback(
    (action: AIAction) => {
      switch (action.action) {
        case "zoomIn":
          sceneRef.current?.zoomIn();
          break;
        case "zoomOut":
          sceneRef.current?.zoomOut();
          break;
        case "reset":
          sceneRef.current?.resetView();
          break;
        case "capture":
          captureScreenshot();
          break;
        case "gestures":
          if (action.value) void startGestures();
          else stopGestures();
          break;
        case "autoRotate":
          applyAutoRotate(Boolean(action.value));
          break;
        case "theme":
          if (typeof action.value === "string" && isThemeName(action.value)) {
            applyTheme(action.value);
          }
          break;
        case "fullscreen":
          if (action.value) {
            void document.documentElement.requestFullscreen?.().catch(() => {
              setError("FULLSCREEN UNAVAILABLE");
            });
          } else if (document.fullscreenElement) {
            void document.exitFullscreen();
          }
          break;
      }
    },
    [captureScreenshot, startGestures, stopGestures, applyAutoRotate, applyTheme],
  );

  useEffect(() => {
    dispatchActionRef.current = dispatchAIAction;
  }, [dispatchAIAction]);

  // ——— VOICE ———
  const handleVoiceCommand = useCallback(
    (command: VoiceCommand) => {
      switch (command.type) {
        case "zoomIn":
          sceneRef.current?.zoomIn();
          break;
        case "zoomOut":
          sceneRef.current?.zoomOut();
          break;
        case "reset":
          sceneRef.current?.resetView();
          break;
        case "capture":
          captureScreenshot();
          break;
        case "gestures":
          if (command.enabled) void startGestures();
          else stopGestures();
          break;
        case "autoRotate":
          applyAutoRotate(command.enabled);
          break;
        case "theme":
          applyTheme(command.name);
          break;
      }
    },
    [captureScreenshot, startGestures, stopGestures, applyAutoRotate, applyTheme],
  );

  const toggleVoice = useCallback(() => {
    if (voiceRef.current) {
      voiceRef.current.stop();
      voiceRef.current = null;
      setVoiceOn(false);
      setHeard(null);
      return;
    }
    setError(null);
    const control = new VoiceControl({
      onCommand: handleVoiceCommand,
      onHeard: setHeard,
      onUnmatched: sendToAI,
      onError: (message) => {
        setError(message);
        setVoiceOn(false);
        voiceRef.current = null;
      },
    });
    const started = control.start();
    if (started) {
      voiceRef.current = control;
      setVoiceOn(true);
    } else if (!isVoiceControlSupported()) {
      setError("VOICE CONTROL NOT SUPPORTED");
    }
  }, [handleVoiceCommand, sendToAI]);

  useEffect(() => {
    toggleVoiceRef.current = toggleVoice;
  }, [toggleVoice]);

  // ——— KEYBOARD SHORTCUTS ———
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      switch (e.key) {
        case "+":
        case "=":
          sceneRef.current?.zoomIn();
          break;
        case "-":
        case "_":
          sceneRef.current?.zoomOut();
          break;
        case "r":
        case "R":
          sceneRef.current?.resetView();
          break;
        case "g":
        case "G":
          toggleGestures();
          break;
        case "t":
        case "T":
          cycleTheme();
          break;
        case "a":
        case "A":
          toggleAutoRotate();
          break;
        case "c":
        case "C":
          captureScreenshot();
          break;
        case "f":
        case "F":
          toggleFullscreen();
          break;
        case "v":
        case "V":
          toggleVoice();
          break;
        case "p":
        case "P":
          setShowPerf((prev) => !prev);
          break;
        case "k":
        case "K":
          setShowChat((prev) => !prev);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleGestures, cycleTheme, toggleAutoRotate, captureScreenshot, toggleFullscreen, toggleVoice]);

  const cameraOn = camera === "on";

  return (
    <>
      <div ref={containerRef} className="orb-root" />

      <div className="overlay-vignette" />
      <div className="overlay-grain" />
      <div className="overlay-scanlines" />

      <div className="hud hud-title">
        U.L.T.R.O.N.
        <span className="hud-title-theme">{THEME_LABEL[theme]}</span>
      </div>

      {showPerf && fps !== null && <div className="hud hud-perf">{fps} FPS</div>}

      <div className="hud hud-hint">
        <div>
          <span className="key">DRAG</span> spin&nbsp;&nbsp;
          <span className="key">SCROLL</span> zoom
        </div>
        {cameraOn ? (
          <div>
            <span className="key">PINCH + MOVE</span> spin&nbsp;&nbsp;
            <span className="key">PINCH BOTH HANDS ± SPREAD</span> zoom&nbsp;&nbsp;
            <span className="key">OPEN PALM</span> reset&nbsp;&nbsp;
            <span className="key">FIST</span> ask ULTRON
          </div>
        ) : (
          <div>
            <span className="key">G</span> gestures&nbsp;&nbsp;
            <span className="key">R</span> reset&nbsp;&nbsp;
            <span className="key">+/−</span> zoom&nbsp;&nbsp;
            <span className="key">T</span> theme&nbsp;&nbsp;
            <span className="key">A</span> auto-rotate&nbsp;&nbsp;
            <span className="key">C</span> capture&nbsp;&nbsp;
            <span className="key">F</span> fullscreen&nbsp;&nbsp;
            <span className="key">V</span> voice&nbsp;&nbsp;
            <span className="key">K</span> ask ultron
          </div>
        )}
      </div>

      <div className="hud hud-controls">
        <div className={`camera-panel${cameraOn ? " visible" : ""}`}>
          {/* Mirrored preview so it behaves like a mirror */}
          <video ref={videoRef} muted playsInline className="camera-video" />
          <canvas ref={overlayRef} width={208} height={156} className="camera-overlay" />
          <div className="camera-status">
            {status.hands > 0
              ? `${status.hands} HAND${status.hands > 1 ? "S" : ""} · ${MODE_LABEL[status.mode]}`
              : "SHOW HANDS"}
          </div>
        </div>

        {error && <div className="hud-error">{error}</div>}
        {voiceOn && heard && <div className="hud-heard">HEARD: &ldquo;{heard}&rdquo;</div>}

        <div className="hud-row">
          <button
            type="button"
            className="hud-btn"
            aria-pressed={cameraOn}
            onClick={toggleGestures}
            disabled={camera === "starting"}
          >
            {camera === "starting" ? "INITIALIZING…" : cameraOn ? "GESTURES ON" : "GESTURES OFF"}
          </button>
        </div>
        <div className="hud-row">
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomIn()} aria-label="Zoom in">
            +
          </button>
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomOut()} aria-label="Zoom out">
            −
          </button>
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.resetView()}>
            RESET
          </button>
        </div>
        <div className="hud-row">
          <button type="button" className="hud-btn" onClick={cycleTheme} title="Cycle color theme (T)">
            {THEME_LABEL[theme]}
          </button>
          <button
            type="button"
            className="hud-btn"
            aria-pressed={autoRotate}
            onClick={toggleAutoRotate}
            title="Auto-rotate when idle (A)"
          >
            AUTO
          </button>
        </div>
        <div className="hud-row">
          <button type="button" className="hud-btn" onClick={captureScreenshot} title="Save a screenshot (C)">
            CAPTURE
          </button>
          <button
            type="button"
            className="hud-btn"
            aria-pressed={fullscreen}
            onClick={toggleFullscreen}
            title="Toggle fullscreen (F)"
          >
            {fullscreen ? "EXIT FS" : "FULLSCREEN"}
          </button>
        </div>
        <div className="hud-row">
          <button
            type="button"
            className="hud-btn"
            aria-pressed={voiceOn}
            onClick={toggleVoice}
            title="Voice commands (V)"
          >
            {voiceOn ? "VOICE ON" : "VOICE OFF"}
          </button>
        </div>
        <div className="hud-row">
          <button
            type="button"
            className="hud-btn"
            aria-pressed={showChat}
            onClick={() => setShowChat((v) => !v)}
            title="Talk to ULTRON"
          >
            ASK ULTRON
          </button>
          <button
            type="button"
            className="hud-btn"
            aria-pressed={showSettings}
            onClick={() => setShowSettings((v) => !v)}
            title="Configure AI provider & API key"
          >
            {aiConfig ? "AI: " + PROVIDER_LABELS[aiConfig.provider].split(" ")[0] : "AI SETUP"}
          </button>
        </div>
      </div>

      {showSettings && (
        <div className="hud panel ai-settings">
          <div className="panel-title">AI SETUP</div>
          {aiConfig && (
            <div className="panel-note current-config">
              Currently saved: {PROVIDER_LABELS[aiConfig.provider]} · {aiConfig.model}
            </div>
          )}
          <div className="panel-row provider-row">
            {PROVIDERS.map((p) => (
              <button
                key={p}
                type="button"
                className="hud-btn small"
                aria-pressed={settingsProvider === p}
                onClick={() => {
                  setSettingsProvider(p);
                  setSettingsModel(DEFAULT_MODELS[p]);
                }}
              >
                {PROVIDER_LABELS[p]}
              </button>
            ))}
          </div>
          <label className="panel-label" htmlFor="ai-key-input">
            API KEY {settingsApiKey && `(${settingsApiKey.length} chars)`}
          </label>
          <div className="key-input-row">
            <input
              id="ai-key-input"
              type={revealKey ? "text" : "password"}
              className="panel-input"
              value={settingsApiKey}
              onChange={(e) => setSettingsApiKey(e.target.value)}
              placeholder="paste your free API key"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="hud-btn small"
              onClick={() => setRevealKey((v) => !v)}
              title="Show/hide key"
            >
              {revealKey ? "HIDE" : "SHOW"}
            </button>
          </div>
          <label className="panel-label" htmlFor="ai-model-input">
            MODEL
          </label>
          <input
            id="ai-model-input"
            type="text"
            className="panel-input"
            value={settingsModel}
            onChange={(e) => setSettingsModel(e.target.value)}
            spellCheck={false}
          />
          <a
            className="panel-link"
            href={PROVIDER_KEY_URL[settingsProvider]}
            target="_blank"
            rel="noreferrer"
          >
            GET A FREE {PROVIDER_LABELS[settingsProvider]} KEY →
          </a>
          <div className="panel-row">
            <button type="button" className="hud-btn small" onClick={saveSettings}>
              SAVE
            </button>
            <button type="button" className="hud-btn small" onClick={forgetSettings}>
              FORGET KEY
            </button>
            <button type="button" className="hud-btn small" onClick={() => setShowSettings(false)}>
              CLOSE
            </button>
          </div>
          <div className="panel-note">
            Stored only in this browser&apos;s local storage. Never sent anywhere except the
            provider you picked above.
          </div>
        </div>
      )}

      {showChat && (
        <div className="hud panel ai-chat">
          <div className="panel-title">
            ASK ULTRON
            <button
              type="button"
              className="panel-close"
              onClick={() => setShowChat(false)}
              aria-label="Close chat"
            >
              ×
            </button>
          </div>
          <div className="chat-log" ref={chatLogRef}>
            {chatLog.length === 0 && !aiBusy && (
              <div className="chat-empty">
                {aiConfig
                  ? "Type a question, or just talk while VOICE is on."
                  : "Open AI SETUP and add a free API key to start."}
              </div>
            )}
            {chatLog.map((m, i) => (
              <div key={i} className={`chat-msg chat-${m.role}`}>
                <span className="chat-role">{m.role === "user" ? "YOU" : "ULTRON"}</span>
                {m.content}
              </div>
            ))}
            {aiBusy && <div className="chat-msg chat-assistant chat-thinking">THINKING…</div>}
          </div>
          {aiError && <div className="hud-error chat-error">{aiError}</div>}
          <form className="chat-input-row" onSubmit={handleChatSubmit}>
            <input
              type="text"
              className="panel-input"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder="ask something…"
              autoComplete="off"
            />
            <button type="submit" className="hud-btn small" disabled={aiBusy || !chatInput.trim()}>
              SEND
            </button>
          </form>
        </div>
      )}
    </>
  );
}
