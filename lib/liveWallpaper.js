import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {SettingsKey} from './settingsKeys.js';

/**
 * Plays a video or animated GIF file as a looping animated background.
 * `playbin` typefinds the source by content rather than extension, so GIFs
 * are decoded through GStreamer's own GIF element (from the "good" plugin
 * set) and handled exactly like any other video stream below this point.
 *
 * Mutter embeds its own private copy of Clutter, so GStreamer video sinks
 * that hand back a Clutter actor from a *different* Clutter instance (e.g.
 * clutterglsink / ClutterGst) cannot be attached to the shell's stage. To
 * stay inside gnome-shell's own Clutter, this decodes frames with a plain
 * GStreamer `appsink` (raw pixels only cross that boundary) and uploads
 * each frame into a `Clutter.Image` set as the content of a normal actor
 * that belongs to gnome-shell itself.
 */
export class LiveWallpaperManager {
    constructor(settings, logger) {
        this._settings = settings;
        this._logger = logger;

        this._available = false;
        this._active = false;
        this._paused = false;
        this._onBattery = false;
        this._fullscreenActive = false;

        this._Gst = null;
        this._Cogl = null;

        this._playbin = null;
        this._appsink = null;
        this._actor = null;
        this._image = null;
        this._videoWidth = 0;
        this._videoHeight = 0;

        this._settingsSignals = [];
        this._busWatchId = 0;
        this._monitorsChangedId = 0;
        this._fullscreenChangedId = 0;
        this._upowerProxy = null;
        this._upowerSignalId = 0;
    }

    get isAvailable() {
        return this._available;
    }

    get isActive() {
        return this._active;
    }

    async enable() {
        await this._loadGstreamer();

        this._settingsSignals.push(
            this._settings.connect(`changed::${SettingsKey.LIVE_WALLPAPER_ENABLED}`, () => this._sync()),
            this._settings.connect(`changed::${SettingsKey.LIVE_WALLPAPER_PATH}`, () => this._sync()),
            this._settings.connect(`changed::${SettingsKey.LIVE_WALLPAPER_MUTED}`, () => this._applyMute()),
            this._settings.connect(`changed::${SettingsKey.LIVE_WALLPAPER_PLAYBACK_RATE}`, () => this._applyPlaybackRate()),
            this._settings.connect(`changed::${SettingsKey.LIVE_WALLPAPER_PAUSE_ON_BATTERY}`, () => this._updatePauseState()),
            this._settings.connect(`changed::${SettingsKey.LIVE_WALLPAPER_PAUSE_WHEN_FULLSCREEN}`, () => this._updatePauseState())
        );

        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => this._layoutActor());

        this._sync();
    }

    disable() {
        for (const id of this._settingsSignals)
            this._settings.disconnect(id);
        this._settingsSignals = [];

        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }

        this._stop();
    }

    async _loadGstreamer() {
        try {
            // GstApp's binding itself is unused, but importing it registers
            // GstApp.AppSink with GJS so appsink elements expose 'new-sample'
            // and the 'pull-sample' action signal instead of being wrapped
            // as a generic, capability-less Gst.Element.
            const [{default: Gst}, , {default: Cogl}] = await Promise.all([
                import('gi://Gst?version=1.0'),
                import('gi://GstApp?version=1.0'),
                import('gi://Cogl'),
            ]);

            this._Gst = Gst;
            this._Cogl = Cogl;

            if (!Gst.is_initialized())
                Gst.init(null);

            this._available = true;
        } catch (e) {
            this._available = false;
            this._logger.warn(
                'Live wallpaper unavailable: GStreamer/Cogl introspection bindings could not be loaded ' +
                `(${e.message ?? e}). Install GStreamer with its "good"/"base" plugin sets to enable this feature.`);
        }
    }

    _sync() {
        const shouldRun = this._available &&
            this._settings.get_boolean(SettingsKey.LIVE_WALLPAPER_ENABLED) &&
            this._settings.get_string(SettingsKey.LIVE_WALLPAPER_PATH) !== '';

        if (shouldRun)
            this._active ? this._restart() : this._start();
        else if (this._active)
            this._stop();
    }

    _restart() {
        this._stop();
        this._start();
    }

    _start() {
        const path = this._settings.get_string(SettingsKey.LIVE_WALLPAPER_PATH);
        if (!this._available || !path)
            return;

        const Gst = this._Gst;

        try {
            this._actor = new Clutter.Actor({
                content_gravity: Clutter.ContentGravity.RESIZE_ASPECT,
                reactive: false,
            });
            Main.layoutManager._backgroundGroup.add_child(this._actor);
            this._layoutActor();

            const sinkBin = Gst.parse_bin_from_description(
                'videoconvert ! videoscale ! video/x-raw,format=RGBA ! ' +
                'appsink name=benthicbloom_sink emit-signals=true max-buffers=2 drop=true sync=true',
                true);
            this._appsink = sinkBin.get_by_name('benthicbloom_sink');
            this._appsink.connect('new-sample', sink => this._onNewSample(sink));

            this._playbin = Gst.ElementFactory.make('playbin', 'benthicbloom-live-wallpaper');
            this._playbin.set_property('video-sink', sinkBin);
            this._playbin.set_property('uri', GLib.filename_to_uri(path, null));

            const bus = this._playbin.get_bus();
            bus.add_signal_watch();
            this._busWatchId = bus.connect('message', (_bus, message) => this._onBusMessage(message));

            this._applyMute();
            this._playbin.set_state(Gst.State.PLAYING);

            this._active = true;
            this._paused = false;
            this._connectPowerWatches();
            this._logger.debug(`Live wallpaper started: ${path}`);
        } catch (e) {
            this._logger.error(e, 'Failed to start live wallpaper');
            this._stop();
        }
    }

    _onNewSample(sink) {
        const Gst = this._Gst;
        const sample = sink.emit('pull-sample');
        if (!sample)
            return Gst.FlowReturn.OK;

        try {
            const buffer = sample.get_buffer();
            const structure = sample.get_caps().get_structure(0);
            const [, width] = structure.get_int('width');
            const [, height] = structure.get_int('height');

            const [ok, mapInfo] = buffer.map(Gst.MapFlags.READ);
            if (!ok)
                return Gst.FlowReturn.OK;

            try {
                this._updateFrame(mapInfo.data, width, height);
            } finally {
                buffer.unmap(mapInfo);
            }
        } catch (e) {
            this._logger.error(e, 'Failed to process live wallpaper frame');
        }

        return Gst.FlowReturn.OK;
    }

    _updateFrame(data, width, height) {
        if (!this._actor)
            return;

        if (!this._image || this._videoWidth !== width || this._videoHeight !== height) {
            this._image = new Clutter.Image();
            this._videoWidth = width;
            this._videoHeight = height;
        }

        try {
            this._image.set_data(data, this._Cogl.PixelFormat.RGBA_8888, width, height, width * 4);
            this._actor.set_content(this._image);
        } catch (e) {
            this._logger.error(e, 'Failed to upload live wallpaper frame');
        }
    }

    _onBusMessage(message) {
        const Gst = this._Gst;
        switch (message.type) {
        case Gst.MessageType.EOS:
            this._playbin.seek_simple(
                Gst.Format.TIME, Gst.SeekFlags.FLUSH | Gst.SeekFlags.KEY_UNIT, 0);
            break;
        case Gst.MessageType.ERROR: {
            const [error] = message.parse_error();
            this._logger.error(error, 'Live wallpaper playback error');
            this._stop();
            break;
        }
        }
    }

    _applyMute() {
        if (this._playbin)
            this._playbin.set_property('mute', this._settings.get_boolean(SettingsKey.LIVE_WALLPAPER_MUTED));
    }

    _applyPlaybackRate() {
        if (!this._playbin || !this._active)
            return;

        const Gst = this._Gst;
        const rate = this._settings.get_double(SettingsKey.LIVE_WALLPAPER_PLAYBACK_RATE);
        const [ok, position] = this._playbin.query_position(Gst.Format.TIME);
        if (!ok)
            return;

        this._playbin.seek(
            rate, Gst.Format.TIME, Gst.SeekFlags.FLUSH | Gst.SeekFlags.ACCURATE,
            Gst.SeekType.SET, position, Gst.SeekType.NONE, -1);
    }

    _layoutActor() {
        if (!this._actor)
            return;
        this._actor.set_position(0, 0);
        this._actor.set_size(global.stage.width, global.stage.height);
    }

    _connectPowerWatches() {
        this._disconnectPowerWatches();

        try {
            this._fullscreenChangedId = global.display.connect('in-fullscreen-changed', () => this._checkFullscreen());
            this._checkFullscreen();
        } catch (e) {
            this._logger.debug(`Fullscreen tracking unavailable, pause-when-fullscreen disabled (${e.message ?? e})`);
        }

        try {
            this._upowerProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                'org.freedesktop.UPower', '/org/freedesktop/UPower', 'org.freedesktop.UPower', null);
            this._upowerSignalId = this._upowerProxy.connect(
                'g-properties-changed', () => this._checkBattery());
            this._checkBattery();
        } catch (e) {
            this._logger.debug(`UPower unavailable, pause-on-battery disabled (${e.message ?? e})`);
        }
    }

    _disconnectPowerWatches() {
        if (this._fullscreenChangedId) {
            global.display.disconnect(this._fullscreenChangedId);
            this._fullscreenChangedId = 0;
        }
        if (this._upowerProxy && this._upowerSignalId) {
            this._upowerProxy.disconnect(this._upowerSignalId);
            this._upowerSignalId = 0;
        }
        this._upowerProxy = null;
        this._onBattery = false;
        this._fullscreenActive = false;
    }

    _checkFullscreen() {
        try {
            const nMonitors = global.display.get_n_monitors();
            this._fullscreenActive = Array.from({length: nMonitors}, (_, i) => i)
                .some(i => global.display.get_monitor_in_fullscreen(i));
        } catch (e) {
            this._fullscreenActive = false;
        }
        this._updatePauseState();
    }

    _checkBattery() {
        const value = this._upowerProxy?.get_cached_property('OnBattery');
        this._onBattery = value ? value.get_boolean() : false;
        this._updatePauseState();
    }

    _updatePauseState() {
        const shouldPause =
            (this._settings.get_boolean(SettingsKey.LIVE_WALLPAPER_PAUSE_ON_BATTERY) && this._onBattery) ||
            (this._settings.get_boolean(SettingsKey.LIVE_WALLPAPER_PAUSE_WHEN_FULLSCREEN) && this._fullscreenActive);
        this._setPaused(shouldPause);
    }

    _setPaused(paused) {
        if (!this._playbin || this._paused === paused)
            return;
        this._paused = paused;
        this._playbin.set_state(paused ? this._Gst.State.PAUSED : this._Gst.State.PLAYING);
    }

    _stop() {
        this._disconnectPowerWatches();

        if (this._playbin) {
            const bus = this._playbin.get_bus();
            if (this._busWatchId) {
                bus.disconnect(this._busWatchId);
                this._busWatchId = 0;
            }
            bus.remove_signal_watch();
            this._playbin.set_state(this._Gst.State.NULL);
            this._playbin = null;
            this._appsink = null;
        }

        this._actor?.destroy();
        this._actor = null;
        this._image = null;
        this._videoWidth = 0;
        this._videoHeight = 0;

        this._active = false;
        this._paused = false;
    }
}
