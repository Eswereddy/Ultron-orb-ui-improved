"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createOrbScene, THEME_NAMES, type OrbSceneApi, type ThemeName } from "@/lib/orbScene";
import { HandTracker, type TrackerStatus } from "@/lib/handTracker";
import { VoiceControl, isVoiceControlSupported, type VoiceCommand } from "@/lib/voiceControl";

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
  }, [handleVoiceCommand]);

  // ——— KEYBOARD SHORTCUTS ———
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
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
            <span className="key">OPEN PALM</span> reset
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
            <span className="key">V</span> voice
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
      </div>
    </>
  );
}
