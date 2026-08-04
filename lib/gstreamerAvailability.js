/**
 * Loads the GObject-Introspection bindings the live wallpaper feature needs
 * (Gst, GstApp for the appsink signals, Cogl for uploading decoded frames)
 * and initializes GStreamer. Shared by extension.js (to actually run the
 * pipeline) and prefs.js (to tell the user up front why the feature is
 * greyed out), since either process may be missing the system packages
 * that provide these typelibs.
 *
 * Throws with a descriptive message on failure; never caches a *failure*,
 * since the user may install the missing packages and reopen preferences
 * without restarting the shell.
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

export const GSTREAMER_INSTALL_HINT =
    'Install GStreamer’s "base" and "good" plugin sets (with their GObject-Introspection data), ' +
    'which provide playback and GIF decoding:\n' +
    '• Arch: sudo pacman -S gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugins-ugly gst-libav\n' +
    '• Debian/Ubuntu: sudo apt install gstreamer1.0-plugins-base gstreamer1.0-plugins-good ' +
    'gir1.2-gst-plugins-base-1.0\n' +
    '• Fedora: sudo dnf install gstreamer1-plugins-base gstreamer1-plugins-good gobject-introspection\n' +
    'Then restart GNOME Shell (log out and back in on Wayland).';
