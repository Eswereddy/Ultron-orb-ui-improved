# ULTRON Orb UI

An Iron Man–inspired holographic orb built with **Next.js**, **Three.js**, and **MediaPipe** hand tracking — control it with your bare hands, your voice, or your mouse.

> 🔮 This is the open-source **interface** of [ULTRON](https://sagartamang.com/projects/ultron) — my AI that talks in real time and controls Android devices by itself. **[Read the write-up](https://sagartamang.com/projects/ultron)** or **[the X post](https://x.com/sagar_builds/status/2077277583646101921)**

> 📱 **[Watch the demo on Instagram](https://www.instagram.com/p/DayJ17OTwvx/)**

![ULTRON orb UI](docs/screenshot.png)

https://github.com/user-attachments/assets/91578a83-9a27-44e8-84b0-96defcfd7366

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Controls

### Mouse / touch

| Input | Action |
| --- | --- |
| Drag | Spin the orb |
| Scroll / pinch | Zoom in & out |

### Hand gestures (webcam)

Click **GESTURES OFF** (or press `G`) and allow camera access, then:

| Gesture | Action |
| --- | --- |
| Pinch (thumb + index) one hand and move it | Spin the orb |
| Pinch with **both** hands, spread apart / bring together | Zoom in / out |
| Open palm, held for a moment | Reset the view |

### Voice (experimental)

Click **VOICE OFF** (or press `V`) and allow microphone access. Chrome-family
browsers work best — support is feature-detected and the button will tell you
if your browser doesn't implement the Web Speech API.

Say things like: *"zoom in"*, *"zoom out"*, *"reset"*, *"gestures on"* /
*"gestures off"*, *"auto rotate on"* / *"auto rotate off"*, *"capture"*, or
*"theme jarvis"* / *"theme vibranium"* / *"theme ultron"*.

### Keyboard

| Key | Action |
| --- | --- |
| `G` | Toggle hand gestures |
| `R` | Reset the view |
| `+` / `−` | Zoom in / out |
| `T` | Cycle color theme (Ultron / Jarvis / Vibranium) |
| `A` | Toggle idle auto-rotate |
| `C` | Save a screenshot (PNG) |
| `F` | Toggle fullscreen |
| `V` | Toggle voice commands |
| `P` | Toggle the FPS readout |

## Features

- **Three color themes** — Ultron (amber), Jarvis (cyan), and Vibranium
  (violet). The choice persists across visits and also re-tints the
  post-processing color grade, not just the wireframe.
- **Idle auto-rotate** — after a few seconds of no input, the orb starts a
  slow rotation; any interaction cancels it immediately.
- **Screenshot capture** — grabs a clean PNG of the current frame (HUD
  overlays excluded) and downloads it.
- **Fullscreen toggle**.
- **Voice commands**, feature-detected, with graceful fallback messaging.
- **Open-palm gesture** resets the camera without touching a keyboard.
- **Adaptive performance** — device cores, memory, and pointer type are used
  to pick a quality tier (particle counts, bloom resolution, antialiasing)
  so the orb stays smooth on phones and low-power laptops, not just
  desktops. `prefers-reduced-motion` is respected: continuous motion and
  panel flicker are toned down automatically.
- **Render pauses while the tab is hidden** and the orbiting debris field is
  drawn with instanced meshes, so the scene is much cheaper to run than a
  naive per-object implementation.

## How it works

- **`lib/orbScene.ts`** — the Three.js scene: layered wireframe shells, a
  spiral inner core, floating code-text sprites, instanced orbiting debris,
  dust particles, scan rings, and a themeable bloom + chromatic-aberration
  post-processing stack. Every colored material is tagged with a role
  (bright/mid/dim/faint/hot) in a small registry, so `setTheme()` can retint
  the whole orb without rebuilding any geometry.
- **`lib/handTracker.ts`** — MediaPipe HandLandmarker running on the webcam
  feed. Pinch detection with hysteresis: one pinched hand spins the orb, two
  pinched hands zoom by spreading apart or together, and an open palm resets
  the camera.
- **`lib/voiceControl.ts`** — a small, dependency-free wrapper around the Web
  Speech API for the voice command feature.
- **`components/JarvisOrb.tsx`** — the HUD and glue between the scene, the
  tracker, voice control, and your inputs. Theme and auto-rotate preferences
  are persisted to `localStorage`.

## License

MIT
