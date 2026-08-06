import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {SettingsKey} from './settingsKeys.js';
import {loadGstreamerModules, GSTREAMER_INSTALL_HINT} from './gstreamerAvailability.js';

Gio._promisify(Gio.DBusProxy, 'new_for_bus', 'new_for_bus_finish');

/**
 * Ways to get a decoded frame onto an actor, tried in order and "pinned"
 * once one works. `new Clutter.Image()` failed with "is not a constructor"
 * in real-world testing (Clutter.Image is apparently no longer directly
 * constructible from GJS in current Mutter); St.ImageContent — the same
 * mechanism gnome-shell's own code uses for uploading raw pixel buffers —
 * is tried first, with the legacy Clutter.Image/set_data path kept only as
 * a fallback for older shells.
 *
 * St.ImageContent.set_bytes() takes a Cogl.Context as its first argument
 * (see js/ui/screenshot.js upstream) — omitting it is what produced
 * "At least 6 arguments required, but only 5 passed".
 */
const FRAME_IMAGE_STRATEGIES = [
    {
        name: 'St.ImageContent',
        create: (width, height) => St.ImageContent.new_with_preferred_size(width, height),
        upload: (image, Cogl, data, width, height) =>
            image.set_bytes(
                global.stage.context.get_backend().get_cogl_context(),
                GLib.Bytes.new(data), Cogl.PixelFormat.RGBA_8888, width, height, width * 4),
    },
    {
        name: 'Clutter.Image',
        create: () => new Clutter.Image(),
        upload: (image, Cogl, data, width, height) =>
            image.set_data(data, Cogl.PixelFormat.RGBA_8888, width, height, width * 4),
    },
];

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
        this._powerWatchGeneration = 0;

        this._frameCount = 0;
        this._pollCount = 0;
        this._pollTimeoutId = 0;
        this._noFrameWatchdogId = 0;
        this._imageStrategyIndex = 0;
        this._frameErrorCount = 0;

        this._transitionOverlay = null;
        this._fadeInPending = false;
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
            this._settings.connect(`changed::${SettingsKey.LIVE_WALLPAPER_DISPLAY_MODE}`, () => this._applyDisplayMode()),
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
        this._clearTransition();
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
            this._stop({animate: true});
    }

    /**
     * Switching to a different file while already active. If transitions
     * are on, the outgoing actor (already showing the old file's last
     * frame) is detached before _stop() would destroy it, so it can be
     * kept on screen and eased away by _playTransition() after _start()
     * has the new one playing underneath — a crossfade between the two.
     */
    _restart() {
        const transitionsOn = this._settings.get_boolean(SettingsKey.TRANSITION_ENABLED);
        const outgoingActor = transitionsOn ? this._actor : null;
        if (outgoingActor)
            this._actor = null;

        this._stop();
        this._start();

        if (outgoingActor)
            this._playTransition(outgoingActor);
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
                reactive: false,
                pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            });
            Main.layoutManager._backgroundGroup.add_child(this._actor);
            this._applyDisplayMode();

            this._fadeInPending = this._settings.get_boolean(SettingsKey.TRANSITION_ENABLED);
            if (this._fadeInPending)
                this._actor.opacity = 0;

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
            this._imageStrategyIndex = 0;
            this._frameErrorCount = 0;
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
                if (this._frameCount === 1) {
                    this._logger.debug(`Live wallpaper: first frame received (${width}x${height})`);
                    if (this._fadeInPending) {
                        this._fadeInPending = false;
                        this._actor.ease({
                            opacity: 255,
                            duration: this._settings.get_uint(SettingsKey.TRANSITION_DURATION_MS),
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        });
                    }
                } else if (this._frameCount % 120 === 0)
                    this._logger.debug(`Live wallpaper: ${this._frameCount} frames rendered so far`);
            } finally {
                buffer.unmap(mapInfo);
            }
        } catch (e) {
            // Rate-limited: this runs at ~30fps, so logging every failure
            // would flood the journal (and this loop keeps retrying every
            // frame, e.g. while cycling through FRAME_IMAGE_STRATEGIES).
            this._frameErrorCount++;
            if (this._frameErrorCount === 1 || this._frameErrorCount % 300 === 0) {
                this._logger.error(
                    e, `Failed to poll live wallpaper frame (${this._frameErrorCount} failures so far)`);
            }
        }

        return GLib.SOURCE_CONTINUE;
    }

    _updateFrame(data, width, height) {
        if (!this._actor)
            return;

        const needsNewImage = !this._image || this._videoWidth !== width || this._videoHeight !== height;

        while (this._imageStrategyIndex < FRAME_IMAGE_STRATEGIES.length) {
            const strategy = FRAME_IMAGE_STRATEGIES[this._imageStrategyIndex];
            try {
                if (needsNewImage) {
                    this._image = strategy.create(width, height);
                    this._videoWidth = width;
                    this._videoHeight = height;
                    this._layoutActor();
                }
                strategy.upload(this._image, this._Cogl, data, width, height);
                this._actor.set_content(this._image);
                return;
            } catch (e) {
                this._logger.warn(
                    `Live wallpaper: frame image strategy "${strategy.name}" failed ` +
                    `(${e.message ?? e}), trying the next one`);
                this._imageStrategyIndex++;
                this._image = null;
            }
        }

        throw new Error('All live wallpaper frame image strategies failed');
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

    /**
     * Clutter's ContentGravity enum covers fit/stretch/center natively, but
     * has no "cover" (scale-and-crop) value, so "fill" mode is done by hand:
     * the actor is overscanned to the smallest size that fully covers the
     * stage while preserving the video's aspect ratio, centered, and then
     * clipped back down to the stage bounds.
     */
    _applyDisplayMode() {
        if (!this._actor)
            return;

        const mode = this._settings.get_string(SettingsKey.LIVE_WALLPAPER_DISPLAY_MODE);
        switch (mode) {
        case 'stretch':
            this._actor.content_gravity = Clutter.ContentGravity.RESIZE_FILL;
            break;
        case 'center':
            this._actor.content_gravity = Clutter.ContentGravity.CENTER;
            break;
        case 'fill':
            this._actor.content_gravity = Clutter.ContentGravity.RESIZE_FILL;
            break;
        case 'fit':
        default:
            this._actor.content_gravity = Clutter.ContentGravity.RESIZE_ASPECT;
            break;
        }

        this._layoutActor();
    }

    _layoutActor() {
        if (!this._actor)
            return;

        const stageWidth = global.stage.width;
        const stageHeight = global.stage.height;
        const mode = this._settings.get_string(SettingsKey.LIVE_WALLPAPER_DISPLAY_MODE);

        if (mode === 'fill' && this._videoWidth > 0 && this._videoHeight > 0) {
            const scale = Math.max(stageWidth / this._videoWidth, stageHeight / this._videoHeight);
            const scaledWidth = this._videoWidth * scale;
            const scaledHeight = this._videoHeight * scale;
            const offsetX = (stageWidth - scaledWidth) / 2;
            const offsetY = (stageHeight - scaledHeight) / 2;

            this._actor.set_position(offsetX, offsetY);
            this._actor.set_size(scaledWidth, scaledHeight);
            this._actor.set_clip(-offsetX, -offsetY, stageWidth, stageHeight);
            return;
        }

        this._actor.remove_clip();
        this._actor.set_position(0, 0);
        this._actor.set_size(stageWidth, stageHeight);
    }

    _connectPowerWatches() {
        this._disconnectPowerWatches();

        try {
            this._fullscreenChangedId = global.display.connect('in-fullscreen-changed', () => this._checkFullscreen());
            this._checkFullscreen();
        } catch (e) {
            this._logger.debug(`Fullscreen tracking unavailable, pause-when-fullscreen disabled (${e.message ?? e})`);
        }

        // Deliberately async: the *_sync() variant blocks gnome-shell's
        // single main thread (it *is* the compositor) until the system bus
        // replies, which can take many seconds — or the full ~25s GDBus
        // timeout — if upowerd is still starting up or the bus is busy,
        // exactly the conditions right after login. That froze the entire
        // screen (and could make the session look hung/crashed) since this
        // runs every time live wallpaper starts, including automatically
        // at login whenever it was left enabled.
        const watchGeneration = ++this._powerWatchGeneration;
        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
            'org.freedesktop.UPower', '/org/freedesktop/UPower', 'org.freedesktop.UPower', null)
            .then(proxy => {
                if (watchGeneration !== this._powerWatchGeneration)
                    return; // Superseded by a _stop()/_connectPowerWatches() while this was in flight.
                this._upowerProxy = proxy;
                this._upowerSignalId = proxy.connect('g-properties-changed', () => this._checkBattery());
                this._checkBattery();
            })
            .catch(e => {
                this._logger.debug(`UPower unavailable, pause-on-battery disabled (${e.message ?? e})`);
            });
    }

    _disconnectPowerWatches() {
        this._powerWatchGeneration++;

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

    /**
     * `animate: true` is for a user-visible stop (toggling the setting off,
     * or the path being cleared) — the last frame stays on screen and eases
     * away per the shared Transitions setting, revealing the static
     * wallpaper beneath. Left off for restarts (which hand the actor to
     * _playTransition() themselves, see _restart()), errors, and
     * disable(), where an immediate teardown is what's wanted.
     */
    _stop({animate = false} = {}) {
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

        if (animate && this._actor && this._settings.get_boolean(SettingsKey.TRANSITION_ENABLED)) {
            this._playTransition(this._actor);
            this._actor = null;
        } else {
            this._actor?.destroy();
            this._actor = null;
        }
        this._image = null;
        this._videoWidth = 0;
        this._videoHeight = 0;
        this._fadeInPending = false;

        this._setActive(false);
        this._paused = false;
    }

    /**
     * Eases `overlay` — an actor that was just detached from active duty,
     * still showing its last frame — off screen per the Transitions
     * setting (fade/slide/zoom/random, same styles and duration as static
     * rotation), then destroys it. Raising it above everything else first
     * means this works whether it's revealing a freshly started live
     * wallpaper actor underneath (switch) or the static desktop background
     * (stop) — both are already in place by the time this runs.
     */
    _playTransition(overlay) {
        this._transitionOverlay?.destroy();
        this._transitionOverlay = overlay;

        Main.layoutManager._backgroundGroup.set_child_above_sibling(overlay, null);

        const durationMs = this._settings.get_uint(SettingsKey.TRANSITION_DURATION_MS);
        let style = this._settings.get_string(SettingsKey.TRANSITION_STYLE);
        if (style === 'random')
            style = ['fade', 'slide', 'zoom'][Math.floor(Math.random() * 3)];

        const onComplete = () => {
            if (this._transitionOverlay === overlay)
                this._transitionOverlay = null;
            overlay.destroy();
        };

        switch (style) {
        case 'slide':
            overlay.ease({
                x: overlay.x - overlay.width,
                duration: durationMs,
                mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                onComplete,
            });
            break;
        case 'zoom':
            overlay.ease({
                scale_x: 1.15,
                scale_y: 1.15,
                opacity: 0,
                duration: durationMs,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete,
            });
            break;
        case 'fade':
        default:
            overlay.ease({
                opacity: 0,
                duration: durationMs,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete,
            });
            break;
        }
    }

    _clearTransition() {
        this._transitionOverlay?.destroy();
        this._transitionOverlay = null;
    }
}
