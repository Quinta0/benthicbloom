import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * True if a GStreamer plugin registry cache already exists for this user.
 * A plain local directory listing — fast, unlike the scan below.
 */
function hasGstRegistryCache() {
    const cacheDir = Gio.File.new_for_path(
        GLib.build_filenamev([GLib.get_user_cache_dir(), 'gstreamer-1.0']));
    try {
        const enumerator = cacheDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        const hasEntry = enumerator.next_file(null) !== null;
        enumerator.close(null);
        return hasEntry;
    } catch (e) {
        return false;
    }
}

/**
 * Gst.init() has no async variant. If its plugin registry cache is stale
 * (e.g. right after a system update touched GStreamer packages), it
 * synchronously rescans every plugin — spawning gst-plugin-scanner per
 * plugin, and probing hardware for codec plugins — which can block
 * gnome-shell's single main thread (it *is* the compositor) for many
 * seconds, exactly the conditions right after login. That froze the entire
 * screen the same way the blocking UPower proxy lookup did.
 *
 * GST_REGISTRY_UPDATE=no makes Gst.init() trust the existing cache
 * unconditionally instead of validating it, so it returns immediately. Only
 * set when a cache already exists — an extension-lifetime-first-ever
 * GStreamer run on this machine still needs one real scan to have anything
 * to trust.
 */
function keepGstInitFast() {
    if (hasGstRegistryCache())
        GLib.setenv('GST_REGISTRY_UPDATE', 'no', true);
}

/**
 * Refreshes the on-disk registry cache in a throwaway subprocess, so a
 * stale cache (skipped above) doesn't stay stale forever and newly
 * installed plugins eventually become visible. Runs fully out-of-process:
 * even if a hardware probe inside it hangs, gnome-shell is unaffected.
 */
function refreshGstRegistryInBackground() {
    try {
        const launcher = new Gio.SubprocessLauncher(
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        launcher.setenv('GST_REGISTRY_UPDATE', 'yes', true);
        const proc = launcher.spawnv(['gst-inspect-1.0', '--exists', 'playbin']);
        proc.wait_check_async(null, (source, result) => {
            try {
                source.wait_check_finish(result);
            } catch (e) {
                // Best-effort refresh; a missing binary or nonzero exit just leaves the cache as-is.
            }
        });
    } catch (e) {
        // Best-effort refresh; a missing gst-inspect-1.0 just leaves the cache as-is.
    }
}

/**
 * Loads the GObject-Introspection bindings the live wallpaper feature needs
 * (Gst, GstApp for the appsink signals, Cogl for uploading decoded frames)
 * and initializes GStreamer. Used by liveWallpaper.js, which only ever runs
 * inside the gnome-shell process itself.
 *
 * Cogl is Mutter's *private* library: its typelib is only reachable from
 * gnome-shell's own process (which gets a private search path), never from
 * an ordinary GTK application. Do NOT reuse this for a diagnostic check in
 * prefs.js — that runs in a separate, plain GTK4 process where importing
 * Cogl will *always* fail regardless of whether live wallpapers actually
 * work, producing a false "not found" report. Use
 * checkGstreamerBaseAvailable() there instead.
 */
export async function loadGstreamerModules() {
    keepGstInitFast();

    const [{default: Gst}, , {default: Cogl}] = await Promise.all([
        import('gi://Gst?version=1.0'),
        import('gi://GstApp?version=1.0'),
        import('gi://Cogl'),
    ]);

    if (!Gst.is_initialized())
        Gst.init(null);

    refreshGstRegistryInBackground();

    return {Gst, Cogl};
}

/**
 * Lighter check for prefs.js: confirms the system-wide GStreamer packages
 * (Gst core + the "app" plugin providing GstApp) are installed, without
 * touching Cogl. This can't fully confirm live wallpapers will work (that
 * also needs Cogl, only checkable from inside gnome-shell itself), but a
 * failure here is a genuine, actionable problem, unlike a Cogl probe.
 */
export async function checkGstreamerBaseAvailable() {
    keepGstInitFast();

    const [{default: Gst}] = await Promise.all([
        import('gi://Gst?version=1.0'),
        import('gi://GstApp?version=1.0'),
    ]);

    if (!Gst.is_initialized())
        Gst.init(null);

    refreshGstRegistryInBackground();
}

export const GSTREAMER_INSTALL_HINT =
    'Install GStreamer’s "base" and "good" plugin sets (with their GObject-Introspection data), ' +
    'which provide playback and GIF decoding:\n' +
    '• Arch: sudo pacman -S gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugins-ugly gst-libav\n' +
    '• Debian/Ubuntu: sudo apt install gstreamer1.0-plugins-base gstreamer1.0-plugins-good ' +
    'gir1.2-gst-plugins-base-1.0\n' +
    '• Fedora: sudo dnf install gstreamer1-plugins-base gstreamer1-plugins-good gobject-introspection\n' +
    'Then restart GNOME Shell (log out and back in on Wayland).';
