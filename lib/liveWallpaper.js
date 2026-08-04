import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {SettingsKey} from './settingsKeys.js';
import {loadGstreamerModules, GSTREAMER_INSTALL_HINT} from './gstreamerAvailability.js';

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
    constructor(settings, logger, {onActiveChanged} = {}) {
        this._settings = settings;
        this._logger = logger;
        this._onActiveChanged = onActiveChanged ?? (() => {});

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

        this._frameCount = 0;
        this._pollCount = 0;
        this._pollTimeoutId = 0;
        this._noFrameWatchdogId = 0;
    }

    get isAvailable() {
        return this._available;
    }

    get isActive() {
        return this._active;
    }

    _setActive(active) {
        if (this._active === active)
            return;
        this._active = active;
        this._onActiveChanged(active);
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
            const {Gst, Cogl} = await loadGstreamerModules();
            this._Gst = Gst;
            this._Cogl = Cogl;
            this._available = true;
        } catch (e) {
            this._available = false;
            this._logger.warn(
                `Live wallpaper unavailable: GStreamer/Cogl introspection bindings could not be loaded (${e.message ?? e}).\n${GSTREAMER_INSTALL_HINT}`);
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

    /**
     * Builds videoconvert ! videoscale ! capsfilter(RGBA) ! appsink using
     * explicit element creation, linking, and a ghost pad, rather than
     * Gst.parse_bin_from_description()'s gst-launch mini-language. Both
     * are meant to be equivalent, but a user's testing showed the
     * string-parsed version's appsink never fired 'new-sample' even once
     * inside gnome-shell's process while an equivalent standalone
     * gst-launch-1.0 pipeline worked fine — this removes the string
     * parsing (and its automatic ghost-pad detection) as a variable, and
     * surfaces link() failures explicitly instead of failing silently.
     */
    _buildSinkBin() {
        const Gst = this._Gst;

        const videoconvert = Gst.ElementFactory.make('videoconvert', 'benthicbloom-convert');
        const videoscale = Gst.ElementFactory.make('videoscale', 'benthicbloom-scale');
        const capsfilter = Gst.ElementFactory.make('capsfilter', 'benthicbloom-capsfilter');
        const appsink = Gst.ElementFactory.make('appsink', 'benthicbloom-appsink');

        if (!videoconvert || !videoscale || !capsfilter || !appsink) {
            throw new Error(
                'Failed to create one or more GStreamer elements ' +
                '(videoconvert/videoscale/capsfilter/appsink) — a required plugin is likely missing');
        }

        capsfilter.set_property('caps', Gst.Caps.from_string('video/x-raw,format=RGBA'));
        // emit-signals is deliberately left off: appsink's 'new-sample' fires
        // from GStreamer's streaming thread, not gnome-shell's main thread,
        // and a cross-thread call into the JS engine can be silently dropped
        // rather than invoked. We poll with try_pull_sample() from a main
        // thread GLib timer instead, which is safe to call from any thread.
        appsink.set_property('max-buffers', 2);
        appsink.set_property('drop', true);
        appsink.set_property('sync', true);

        const sinkBin = new Gst.Bin({name: 'benthicbloom-sinkbin'});
        sinkBin.add(videoconvert);
        sinkBin.add(videoscale);
        sinkBin.add(capsfilter);
        sinkBin.add(appsink);

        if (!videoconvert.link(videoscale))
            throw new Error('Failed to link videoconvert -> videoscale');
        if (!videoscale.link(capsfilter))
            throw new Error('Failed to link videoscale -> capsfilter');
        if (!capsfilter.link(appsink))
            throw new Error('Failed to link capsfilter -> appsink');

        const sinkPad = videoconvert.get_static_pad('sink');
        const ghostPad = Gst.GhostPad.new('sink', sinkPad);
        if (!ghostPad)
            throw new Error('Failed to create ghost pad for live wallpaper sink bin');
        ghostPad.set_active(true);
        sinkBin.add_pad(ghostPad);

        this._appsink = appsink;
        return sinkBin;
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

            const sinkBin = this._buildSinkBin();

            this._playbin = Gst.ElementFactory.make('playbin', 'benthicbloom-live-wallpaper');
            this._playbin.set_property('video-sink', sinkBin);
            this._playbin.set_property('uri', GLib.filename_to_uri(path, null));

            const bus = this._playbin.get_bus();
            bus.add_signal_watch();
            this._busWatchId = bus.connect('message', (_bus, message) => this._onBusMessage(message));

            this._applyMute();
            const stateChangeResult = this._playbin.set_state(Gst.State.PLAYING);
            this._logger.debug(`playbin.set_state(PLAYING) returned ${stateChangeResult}`);

            this._frameCount = 0;
            this._pollCount = 0;
            // ~30fps polling of the appsink from the main thread. See the
            // comment on appsink's properties above for why this replaces
            // a 'new-sample' signal handler.
            this._pollTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => this._pollForSample());

            this._noFrameWatchdogId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
                this._noFrameWatchdogId = 0;
                if (this._active && this._frameCount === 0) {
                    this._logger.warn(
                        `Live wallpaper: no frames received 4s after starting playback ` +
                        `(polled appsink ${this._pollCount} times). If that count is 0, the poll timer ` +
                        'itself never ran; if it is nonzero, try_pull_sample() keeps returning nothing ' +
                        '— check for a "Failed to poll live wallpaper frame" error above.');
                }
                return GLib.SOURCE_REMOVE;
            });

            this._setActive(true);
            this._paused = false;
            this._connectPowerWatches();
            this._logger.debug(`Live wallpaper started: ${path}`);
        } catch (e) {
            this._logger.error(e, 'Failed to start live wallpaper');
            this._stop();
        }
    }

    _pollForSample() {
        if (!this._appsink)
            return GLib.SOURCE_REMOVE;

        const Gst = this._Gst;
        this._pollCount++;
        if (this._pollCount === 1)
            this._logger.debug('Live wallpaper: appsink polling started');

        try {
            const sample = this._appsink.try_pull_sample(0);
            if (!sample)
                return GLib.SOURCE_CONTINUE;

            const buffer = sample.get_buffer();
            const structure = sample.get_caps().get_structure(0);
            const [, width] = structure.get_int('width');
            const [, height] = structure.get_int('height');

            const [ok, mapInfo] = buffer.map(Gst.MapFlags.READ);
            if (!ok) {
                this._logger.debug('Live wallpaper: buffer.map() failed');
                return GLib.SOURCE_CONTINUE;
            }

            try {
                this._updateFrame(mapInfo.data, width, height);
                this._frameCount++;
                if (this._frameCount === 1)
                    this._logger.debug(`Live wallpaper: first frame received (${width}x${height})`);
                else if (this._frameCount % 120 === 0)
                    this._logger.debug(`Live wallpaper: ${this._frameCount} frames rendered so far`);
            } finally {
                buffer.unmap(mapInfo);
            }
        } catch (e) {
            this._logger.error(e, 'Failed to poll live wallpaper frame');
        }

        return GLib.SOURCE_CONTINUE;
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
            const [error, debug] = message.parse_error();
            this._logger.error(error, `Live wallpaper playback error (${debug ?? 'no debug info'})`);
            this._stop();
            break;
        }
        case Gst.MessageType.WARNING: {
            const [warning, debug] = message.parse_warning();
            this._logger.warn(`Live wallpaper GStreamer warning: ${warning.message} (${debug ?? 'no debug info'})`);
            break;
        }
        case Gst.MessageType.STATE_CHANGED:
            if (message.src === this._playbin) {
                const [, newState] = message.parse_state_changed();
                this._logger.debug(`Live wallpaper pipeline state changed to ${this._stateName(newState)}`);
            }
            break;
        }
    }

    _stateName(state) {
        const Gst = this._Gst;
        return Object.keys(Gst.State).find(name => Gst.State[name] === state) ?? String(state);
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

        if (this._noFrameWatchdogId) {
            GLib.source_remove(this._noFrameWatchdogId);
            this._noFrameWatchdogId = 0;
        }

        if (this._pollTimeoutId) {
            GLib.source_remove(this._pollTimeoutId);
            this._pollTimeoutId = 0;
        }

        if (this._playbin) {
            const Gst = this._Gst;
            const bus = this._playbin.get_bus();
            if (this._busWatchId) {
                bus.disconnect(this._busWatchId);
                this._busWatchId = 0;
            }
            bus.remove_signal_watch();

            this._playbin.set_state(Gst.State.NULL);
            // Block briefly for the (normally fast) transition to actually
            // finish before dropping our reference — otherwise the element
            // can get disposed mid-transition, which GStreamer logs as
            // "Trying to dispose element ..., but it is in PLAYING instead
            // of the NULL state".
            this._playbin.get_state(200 * Gst.MSECOND);

            this._playbin = null;
            this._appsink = null;
        }

        this._actor?.destroy();
        this._actor = null;
        this._image = null;
        this._videoWidth = 0;
        this._videoHeight = 0;

        this._setActive(false);
        this._paused = false;
    }
}
