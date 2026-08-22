# ReSync

A small Windows desktop app for recording your D&D actual-play sessions:
add each camera and each mic as its own "source," hit **Arm & Record**,
and get one separate video or audio file per source, all started and
stopped together — ready to drop straight into an editor as a
multitrack timeline. ("ReSync" = **Re**cord and **Sync**hronize.)

Built with Electron. This is a starting point tuned for a table with a
handful of cameras (webcams / GoPros over a capture device) and a mix
of an audio interface plus USB/lav mics — not a general-purpose
broadcast tool.

## What it does

- Detects your video and audio input devices (anything Windows exposes
  as a camera or microphone, including GoPros through an HDMI capture
  card, and each mic on your Focusrite/interface).
- Each added source gets a tile with a live preview (video thumbnail or
  an audio level meter) and an editable label.
- Each camera has its own **resolution** and **bitrate** dropdowns
  right under its preview. Resolution requests are "ideal," not
  "exact" — the tile shows what the device actually negotiated, since
  it won't always match what you asked for.
- **Arm & Record** runs a 3-2-1 countdown with a screen flash and an
  audible click, *then* starts every source's recorder in the same
  pass, and **Stop** stops them all together.
- Each source is written to its own file, streamed to disk as it
  records (not buffered in memory), so a multi-hour session won't blow
  up RAM.
- A `sync-log.json` is written into each session folder recording the
  exact millisecond offset each source actually started at relative to
  the arm signal.

## Why there's a countdown click

Software timers on separate `MediaRecorder` instances don't guarantee
frame-accurate hardware sync — expect drift on the order of a few
milliseconds up to a few dozen ms, not sample-accurate. The click
during the countdown is picked up acoustically by every open mic in
the room (and the flash by every camera), so you have one unambiguous
moment to line tracks up on in your editor even if the software start
times weren't perfectly simultaneous. `sync-log.json` gives you the
software-side numbers too, in case you want to cross-check.

## A known uncertainty: multi-channel interfaces

The "Add Each Channel Separately" button is **experimental**. It asks
Chromium for up to 8 channels from a device and, if it gets them,
splits them into separate mono sources using the Web Audio API
(`ChannelSplitterNode`). I built this because it's a legitimate,
documented technique — but I'm not fully certain your specific
Focusrite + Windows driver combination will actually hand Chromium
more than 2 channels through `getUserMedia`; some Windows audio
drivers cap browser-facing capture at stereo regardless of the
interface's real channel count, and this is genuinely inconsistent
across hardware/driver versions. The app checks `track.getSettings().
channelCount` and tells you what it actually got. If it only ever
reports 2, the reliable fallback is to add each mic as its own device
via **+ Add Mic** instead (works regardless of this limitation, as
long as Windows lists each mic as a separate input device).

## Output format

Files are `.webm` — video tracks use VP9 (falling back to VP8) with no
audio track; audio-only sources use Opus. Most modern NLEs (DaVinci
Resolve, Premiere with a plugin, etc.) handle webm/VP9/Opus fine. If
your editor of choice doesn't, batch-converting afterward with
`ffmpeg` (e.g. `ffmpeg -i in.webm -c:v libx264 out.mp4` or
`ffmpeg -i in.webm out.wav` for audio) is a clean extra step — that's
not built in yet, to keep this first version simple.

## Setup (development)

Requires [Node.js](https://nodejs.org) (LTS) installed.

```bash
npm install
npm start
```

The first launch will prompt for camera/microphone permission — allow
it, then click **Refresh Device List** if anything's missing.

## Building a Windows installer

```bash
npm run dist
```

This uses `electron-builder` and produces an installer (`.exe`, NSIS)
in `release/`. That's the file you'd attach to a GitHub Release for a
one-click download — the app itself doesn't need Node.js installed on
the machine that runs it, only on the machine that builds it.

## Publishing to GitHub

This repo already has a GitHub Actions workflow
(`.github/workflows/release.yml`) that does this for you:

1. Push a tag like `v0.1.1` (`git tag v0.1.1 && git push origin v0.1.1`).
2. GitHub's own Windows runner checks out the code, installs
   dependencies, and runs `electron-builder --win --publish always`.
3. That creates a **draft** GitHub Release with the installer attached.
   Go to the repo's Releases page and publish it (or ask for the draft
   step to be removed if you'd rather it publish automatically).

You can also trigger a build manually from the Actions tab
(`workflow_dispatch`) without pushing a new tag.

## Known limitations / good next steps

- No audio-only "solo/mute while recording" — the meter is for
  monitoring, not gain staging; ride your interface's gain before you
  hit record.
- No built-in transcode step (see Output format above).
- Tile drag-to-reorder is cosmetic only — it doesn't change filenames
  or recording order, just how sources are arranged on screen while
  you're setting up.
- If a device is unplugged mid-recording, that source's `MediaRecorder`
  will error out silently in the current version — worth hardening
  before you rely on this for a real session with people in the room.
- Not tested yet on your actual hardware (GoPro capture device, the
  8-channel interface) — the multi-channel caveat above is the biggest
  open question. Worth a short dry run, the same way you're already
  planning to soak-test the lav battery life.
