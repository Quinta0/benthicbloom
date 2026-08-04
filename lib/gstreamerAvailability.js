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
    const [{default: Gst}, , {default: Cogl}] = await Promise.all([
        import('gi://Gst?version=1.0'),
        import('gi://GstApp?version=1.0'),
        import('gi://Cogl'),
    ]);

    if (!Gst.is_initialized())
        Gst.init(null);

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
    const [{default: Gst}] = await Promise.all([
        import('gi://Gst?version=1.0'),
        import('gi://GstApp?version=1.0'),
    ]);

    if (!Gst.is_initialized())
        Gst.init(null);
}

export const GSTREAMER_INSTALL_HINT =
    'Install GStreamer’s "base" and "good" plugin sets (with their GObject-Introspection data), ' +
    'which provide playback and GIF decoding:\n' +
    '• Arch: sudo pacman -S gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugins-ugly gst-libav\n' +
    '• Debian/Ubuntu: sudo apt install gstreamer1.0-plugins-base gstreamer1.0-plugins-good ' +
    'gir1.2-gst-plugins-base-1.0\n' +
    '• Fedora: sudo dnf install gstreamer1-plugins-base gstreamer1-plugins-good gobject-introspection\n' +
    'Then restart GNOME Shell (log out and back in on Wayland).';
