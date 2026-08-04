# BenthicBloom

A GNOME Shell 50 extension that automatically rotates your wallpaper,
supports looping video (live) wallpapers, and includes built-in
protection against OLED burn-in.

## Features

- **Auto rotation** — pick one or more folders and BenthicBloom cycles
  through the images inside them on a timer, in sequential or shuffled
  order, with an optional crossfade between changes. The chosen wallpaper
  can also be applied to the lock screen.
- **Live wallpapers** — play a looping video *or animated GIF* as your
  desktop background. Frames are decoded with GStreamer and rendered
  directly by GNOME Shell's own Clutter stage (no external, incompatible
  Clutter build involved). Playback can automatically pause on battery
  power or while a window is fullscreen. Automatic rotation is
  automatically suspended while a live wallpaper is actually on screen
  (and resumes afterward), since changing the static wallpaper would
  otherwise repaint over the video.
- **OLED burn-in protection** — three independent, individually toggled
  techniques:
  - *Pixel shifting*: nudges the background a few pixels on a slow drift
    cycle so the same subpixels aren't lit continuously.
  - *Idle dimming*: fades the background to a configurable lower
    brightness after the system has been idle for a while, and restores
    it the moment you're back.
  - *Forced rotation*: guarantees the wallpaper changes after a maximum
    static duration, even if automatic rotation is otherwise switched
    off.
- A top-bar indicator for quick access to rotation, live wallpaper, and
  OLED protection toggles, plus a "Next Wallpaper" action, and a full
  libadwaita preferences window.

## Requirements

- GNOME Shell 50.
- For live wallpapers: GStreamer with its `good` and `base` plugin sets
  (e.g. `gstreamer1.0-plugins-good` and `gstreamer1.0-plugins-base`, or
  your distribution's equivalent) — the `good` set is also what provides
  animated GIF decoding. If these aren't installed, the live wallpaper
  toggle stays disabled and BenthicBloom's other features work normally.

## Installation

### From source

```sh
git clone https://github.com/quinta0/benthicbloom.git
cd benthicbloom
make install
```

Then reload GNOME Shell — press <kbd>Alt</kbd>+<kbd>F2</kbd>, type `r`,
press <kbd>Enter</kbd> on X11, or log out and back in on Wayland — and
enable the extension:

```sh
gnome-extensions enable benthicbloom@quinta0.github.io
```

### Packaging a zip

```sh
make pack
```

produces `dist/benthicbloom@quinta0.github.io.shell-extension.zip`,
installable via `gnome-extensions install <file>` or the Extensions app.

## Configuration

Open preferences from the panel indicator's "Wallpaper Settings…" entry,
or run:

```sh
gnome-extensions prefs benthicbloom@quinta0.github.io
```

- **General** — panel indicator visibility, lock screen syncing, debug
  logging, and the folders scanned for wallpapers.
- **Rotation** — enable/disable, interval, shuffle vs. sequential order,
  and crossfade transition settings.
- **Live Wallpaper** — enable/disable, video file, source folders to pick
  a video/GIF from, mute, playback speed, and power-saving pause behavior.
- **OLED Protection** — master switch plus independent controls for
  pixel shifting, idle dimming, and forced periodic rotation.

## Architecture

```
extension.js            Entry point: wires up the three managers + indicator
prefs.js                 libadwaita preferences window
lib/settingsKeys.js       GSettings key name constants
lib/logger.js             Small logging wrapper gated by the debug-logging setting
lib/wallpaperSource.js    Async folder scanning for image files
lib/shuffleBag.js         No-immediate-repeat random ordering for shuffle mode
lib/rotationManager.js    Timer-driven wallpaper rotation + crossfade overlay
lib/liveWallpaper.js      GStreamer video playback rendered onto a Clutter actor
lib/oledProtection.js     Pixel shifting, idle dimming, forced rotation
lib/indicator.js          Top-bar quick-access menu
icons/                     Bundled symbolic icons for the preferences window
schemas/                  GSettings schema
```

## Known limitations

- The live wallpaper currently renders across the full stage as a single
  layer, so on multi-monitor setups the video spans across all monitors
  as one canvas rather than being tiled per-monitor.
- Pixel shifting and idle dimming rely on GNOME Shell's private
  `Main.layoutManager._backgroundGroup` and `Meta.IdleMonitor` APIs, which
  are not part of the stable extension API and could change in future
  shell versions.

## Testing

This was developed and validated (JSON, GSettings schema compilation,
and JavaScript syntax) without a live GNOME Shell 50 session available in
the development environment. Before relying on it, test in a nested
session:

```sh
dbus-run-session -- gnome-shell --nested --wayland
```

or on a real GNOME 50 desktop, and please file an issue with any problems
you hit.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).
