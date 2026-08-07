# BenthicBloom

A GNOME Shell 50 extension that rotates your wallpaper, supports looping
video (live) wallpapers, and protects OLED displays from burn-in.

## Features

- **Auto rotation**: pick one or more folders and BenthicBloom cycles
  through the images inside them on a timer, sequential or shuffled, with
  an optional crossfade. Can also apply to the lock screen.
- **Live wallpapers**: play a looping video or animated GIF as your
  desktop background. Frames are decoded with GStreamer and rendered
  directly on GNOME Shell's own Clutter stage. Playback can pause on
  battery power or while a window is fullscreen. Auto rotation suspends
  while a live wallpaper is on screen and resumes after.
- **OLED burn-in protection**, three independent toggles:
  - *Pixel shifting*: nudges the background a few pixels on a slow drift
    cycle so the same subpixels aren't lit continuously.
  - *Idle dimming*: fades the background after the system has been idle
    for a while, restores it when you're back.
  - *Forced rotation*: guarantees a wallpaper change after a maximum
    static duration, even if auto rotation is off.
- A top-bar indicator for quick access to rotation, live wallpaper, and
  OLED protection toggles, a "Next Wallpaper" action, and a full
  libadwaita preferences window.

## Requirements

- GNOME Shell 50.
- For live wallpapers: GStreamer's `base` and `good` plugin sets (the
  `good` set also provides GIF decoding), with GObject-Introspection data.
  Without them the live wallpaper toggle stays disabled; everything else
  works normally.

```sh
# Arch
sudo pacman -S gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugins-ugly gst-libav

# Debian/Ubuntu
sudo apt install gstreamer1.0-plugins-base gstreamer1.0-plugins-good gir1.2-gst-plugins-base-1.0

# Fedora
sudo dnf install gstreamer1-plugins-base gstreamer1-plugins-good gobject-introspection
```

Restart GNOME Shell after installing (log out and back in on Wayland).

## Installation

### From source

```sh
git clone https://github.com/quinta0/benthicbloom.git
cd benthicbloom
make install
```

Reload GNOME Shell (<kbd>Alt</kbd>+<kbd>F2</kbd>, type `r`, <kbd>Enter</kbd>
on X11; log out and back in on Wayland), then enable the extension:

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

Open preferences from the panel indicator's "Wallpaper Settings..." entry,
or run:

```sh
gnome-extensions prefs benthicbloom@quinta0.github.io
```

- **General**: panel indicator visibility, lock screen syncing, debug
  logging, and the folders scanned for wallpapers.
- **Rotation**: enable/disable, interval, shuffle vs. sequential order,
  crossfade settings.
- **Live Wallpaper**: enable/disable, video file, source folders, mute,
  playback speed, power-saving pause behavior.
- **OLED Protection**: master switch plus independent controls for pixel
  shifting, idle dimming, and forced periodic rotation.

## Architecture

```
extension.js                  Entry point: wires up the three managers + indicator
prefs.js                      libadwaita preferences window
lib/settingsKeys.js           GSettings key name constants
lib/logger.js                 Small logging wrapper gated by the debug-logging setting
lib/wallpaperSource.js        Async folder scanning for image files
lib/shuffleBag.js             No-immediate-repeat random ordering for shuffle mode
lib/rotationManager.js        Timer-driven wallpaper rotation + crossfade overlay
lib/gstreamerAvailability.js  Non-blocking GStreamer init/registry check + availability probe
lib/liveWallpaper.js          GStreamer video playback rendered onto a Clutter actor
lib/oledProtection.js         Pixel shifting, idle dimming, forced rotation
lib/indicator.js              Top-bar quick-access menu
icons/                        Bundled symbolic icons for the preferences window
schemas/                      GSettings schema
```

## Known limitations

- The live wallpaper renders across the full stage as a single layer, so
  on multi-monitor setups the video spans all monitors as one canvas
  instead of being tiled per-monitor.
- Pixel shifting and idle dimming rely on GNOME Shell's private
  `Main.layoutManager._backgroundGroup` and `Meta.IdleMonitor` APIs, not
  part of the stable extension API, and could change in future shell
  versions.
- GStreamer's registry scan is skipped (trusting the existing cache)
  unless no cache exists yet, to avoid blocking gnome-shell's main thread,
  and therefore the whole screen, for several seconds right after login.
  A background subprocess refreshes the cache afterward so newly
  installed plugins still become visible eventually.

## Testing

This was developed and validated (JSON, GSettings schema compilation, and
JavaScript syntax) without a live GNOME Shell 50 session available in the
development environment. Before relying on it, test in a nested session:

```sh
dbus-run-session -- gnome-shell --nested --wayland
```

or on a real GNOME 50 desktop, and please file an issue with any problems
you hit.

## License

GPL-3.0-or-later, see [LICENSE](LICENSE).
