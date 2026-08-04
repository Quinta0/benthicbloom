import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {SettingsKey} from './settingsKeys.js';

// A slow, small drift pattern rather than a simple back-and-forth, so the
// same pixels aren't re-lit on a short, predictable cycle.
const SHIFT_PATTERN = [
    [0, 0], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1],
];

const FORCE_ROTATION_CHECK_SECONDS = 60;

/**
 * Reduces OLED burn-in risk through three independent techniques:
 *  - pixel shifting: nudges the background actors a few px on a slow cycle
 *  - idle dimming: fades in a black overlay after prolonged inactivity
 *  - forced rotation: guarantees the wallpaper changes periodically even if
 *    automatic rotation is otherwise switched off
 */
export class OledProtectionManager {
    constructor(settings, logger, {forceNextWallpaper} = {}) {
        this._settings = settings;
        this._logger = logger;
        this._forceNextWallpaper = forceNextWallpaper ?? (() => {});

        this._settingsSignals = [];

        this._shiftTimeoutId = 0;
        this._shiftStep = 0;

        this._forceRotationTimeoutId = 0;

        this._idleMonitor = null;
        this._idleWatchId = 0;
        this._activeWatchId = 0;
        this._dimOverlays = [];
        this._dimmed = false;
    }

    enable() {
        this._settingsSignals.push(
            this._settings.connect(`changed::${SettingsKey.OLED_PROTECTION_ENABLED}`, () => this._syncAll()),
            this._settings.connect(`changed::${SettingsKey.OLED_PIXEL_SHIFT_ENABLED}`, () => this._syncPixelShift()),
            this._settings.connect(`changed::${SettingsKey.OLED_PIXEL_SHIFT_INTERVAL_SECONDS}`, () => this._syncPixelShift()),
            this._settings.connect(`changed::${SettingsKey.OLED_DIM_ON_IDLE_ENABLED}`, () => this._syncIdleWatch()),
            this._settings.connect(`changed::${SettingsKey.OLED_DIM_IDLE_DELAY_SECONDS}`, () => this._syncIdleWatch()),
            this._settings.connect(`changed::${SettingsKey.OLED_FORCE_ROTATION_ENABLED}`, () => this._syncForceRotation())
        );

        this._syncAll();
    }

    disable() {
        for (const id of this._settingsSignals)
            this._settings.disconnect(id);
        this._settingsSignals = [];

        this._stopPixelShift();
        this._stopForceRotation();
        this._stopIdleWatch();
        this._clearDimOverlays();
    }

    get isEnabled() {
        return this._settings.get_boolean(SettingsKey.OLED_PROTECTION_ENABLED);
    }

    _syncAll() {
        this._syncPixelShift();
        this._syncIdleWatch();
        this._syncForceRotation();
    }

    // --- Pixel shifting --------------------------------------------------

    _syncPixelShift() {
        this._stopPixelShift();
        if (this.isEnabled && this._settings.get_boolean(SettingsKey.OLED_PIXEL_SHIFT_ENABLED))
            this._startPixelShift();
        else
            this._resetShift();
    }

    _startPixelShift() {
        const interval = Math.max(5, this._settings.get_uint(SettingsKey.OLED_PIXEL_SHIFT_INTERVAL_SECONDS));
        this._shiftTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._applyPixelShiftStep();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPixelShift() {
        if (this._shiftTimeoutId) {
            GLib.source_remove(this._shiftTimeoutId);
            this._shiftTimeoutId = 0;
        }
    }

    _applyPixelShiftStep() {
        const amount = this._settings.get_uint(SettingsKey.OLED_PIXEL_SHIFT_AMOUNT_PX);
        this._shiftStep = (this._shiftStep + 1) % SHIFT_PATTERN.length;
        const [dx, dy] = SHIFT_PATTERN[this._shiftStep];

        for (const actor of this._backgroundActors()) {
            actor.ease({
                translation_x: dx * amount,
                translation_y: dy * amount,
                duration: 2000,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            });
        }
    }

    _resetShift() {
        this._shiftStep = 0;
        for (const actor of this._backgroundActors()) {
            actor.ease({
                translation_x: 0,
                translation_y: 0,
                duration: 500,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    _backgroundActors() {
        // Private API: the group holding each monitor's background actor
        // (and our own live-wallpaper/crossfade actors, which harmlessly
        // shift along with it).
        try {
            return Main.layoutManager._backgroundGroup.get_children();
        } catch (e) {
            return [];
        }
    }

    // --- Idle dimming ------------------------------------------------------

    _syncIdleWatch() {
        this._stopIdleWatch();
        if (this.isEnabled && this._settings.get_boolean(SettingsKey.OLED_DIM_ON_IDLE_ENABLED))
            this._startIdleWatch();
        else
            this._undim();
    }

    _startIdleWatch() {
        try {
            this._idleMonitor = global.backend?.get_core_idle_monitor
                ? global.backend.get_core_idle_monitor()
                : Meta.IdleMonitor.get_core();
        } catch (e) {
            this._logger.debug(`Idle monitor unavailable, idle dimming disabled (${e.message ?? e})`);
            return;
        }

        this._armIdleWatch();
    }

    _armIdleWatch() {
        if (!this._idleMonitor)
            return;

        const delayMs = Math.max(5, this._settings.get_uint(SettingsKey.OLED_DIM_IDLE_DELAY_SECONDS)) * 1000;
        this._idleWatchId = this._idleMonitor.add_idle_watch(delayMs, () => {
            this._dim();
            this._activeWatchId = this._idleMonitor.add_user_active_watch(() => {
                this._undim();
                this._activeWatchId = 0;
                this._armIdleWatch();
            });
        });
    }

    _stopIdleWatch() {
        if (this._idleMonitor) {
            if (this._idleWatchId)
                this._idleMonitor.remove_watch(this._idleWatchId);
            if (this._activeWatchId)
                this._idleMonitor.remove_watch(this._activeWatchId);
        }
        this._idleWatchId = 0;
        this._activeWatchId = 0;
        this._idleMonitor = null;
    }

    _dim() {
        if (this._dimmed)
            return;
        this._dimmed = true;

        const brightness = this._settings.get_double(SettingsKey.OLED_DIM_BRIGHTNESS);
        const targetOpacity = Math.round((1 - brightness) * 255);

        this._clearDimOverlays();
        for (const monitor of Main.layoutManager.monitors) {
            const overlay = new Clutter.Actor({
                x: monitor.x,
                y: monitor.y,
                width: monitor.width,
                height: monitor.height,
                background_color: new Clutter.Color({red: 0, green: 0, blue: 0, alpha: 255}),
                opacity: 0,
                reactive: false,
            });
            Main.layoutManager._backgroundGroup.add_child(overlay);
            this._dimOverlays.push(overlay);
            overlay.ease({
                opacity: targetOpacity,
                duration: 4000,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        this._logger.debug('Background dimmed for OLED protection (idle)');
    }

    _undim() {
        if (!this._dimmed)
            return;
        this._dimmed = false;

        for (const overlay of this._dimOverlays) {
            overlay.ease({
                opacity: 0,
                duration: 800,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => overlay.destroy(),
            });
        }
        this._dimOverlays = [];

        this._logger.debug('Background dim removed');
    }

    _clearDimOverlays() {
        for (const overlay of this._dimOverlays)
            overlay.destroy();
        this._dimOverlays = [];
        this._dimmed = false;
    }

    // --- Forced rotation -----------------------------------------------

    _syncForceRotation() {
        this._stopForceRotation();
        if (this.isEnabled && this._settings.get_boolean(SettingsKey.OLED_FORCE_ROTATION_ENABLED))
            this._startForceRotation();
    }

    _startForceRotation() {
        this._forceRotationTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, FORCE_ROTATION_CHECK_SECONDS, () => {
                const maxSeconds = this._settings.get_uint(SettingsKey.OLED_MAX_STATIC_DURATION_SECONDS);
                this._forceNextWallpaper(maxSeconds);
                return GLib.SOURCE_CONTINUE;
            });
    }

    _stopForceRotation() {
        if (this._forceRotationTimeoutId) {
            GLib.source_remove(this._forceRotationTimeoutId);
            this._forceRotationTimeoutId = 0;
        }
    }
}
