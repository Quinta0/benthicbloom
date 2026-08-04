import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {SettingsKey} from './settingsKeys.js';
import {listImagesInFolders} from './wallpaperSource.js';
import {ShuffleBag} from './shuffleBag.js';

const BACKGROUND_SCHEMA = 'org.gnome.desktop.background';
const SCREENSAVER_SCHEMA = 'org.gnome.desktop.screensaver';
const MIN_INTERVAL_SECONDS = 5;

/**
 * Owns the wallpaper image list, the rotation timer, and applying the
 * chosen image to both the desktop and (optionally) the lock screen via
 * their standard GSettings schemas, with an optional crossfade overlay
 * played on top while the change happens underneath.
 */
export class RotationManager {
    constructor(settings, logger) {
        this._settings = settings;
        this._logger = logger;
        this._backgroundSettings = new Gio.Settings({schema_id: BACKGROUND_SCHEMA});
        this._screensaverSettings = new Gio.Settings({schema_id: SCREENSAVER_SCHEMA});

        this._images = [];
        this._sequentialIndex = -1;
        this._shuffleBag = new ShuffleBag();
        this._timeoutId = 0;
        this._settingsSignals = [];
        this._paused = false;
        this._suspended = false;
        this._lastChangeTime = GLib.get_monotonic_time();
        this._currentPath = null;
        this._transitionOverlays = [];
    }

    enable() {
        this._settingsSignals.push(
            this._settings.connect(`changed::${SettingsKey.WALLPAPER_FOLDERS}`, () => this._reloadImages()),
            this._settings.connect(`changed::${SettingsKey.ROTATION_ENABLED}`, () => this._restartTimer()),
            this._settings.connect(`changed::${SettingsKey.ROTATION_INTERVAL_SECONDS}`, () => this._restartTimer()),
            this._settings.connect(`changed::${SettingsKey.ROTATION_MODE}`, () => this._onModeChanged())
        );

        this._reloadImages().catch(e => this._logger.error(e, 'Failed to load wallpaper folders'));
        this._restartTimer();
    }

    disable() {
        for (const id of this._settingsSignals)
            this._settings.disconnect(id);
        this._settingsSignals = [];

        this._clearTimer();
        this._clearTransitionOverlays();
    }

    get currentPath() {
        return this._currentPath;
    }

    get hasImages() {
        return this._images.length > 0;
    }

    get isPaused() {
        return this._paused;
    }

    get secondsSinceLastChange() {
        return (GLib.get_monotonic_time() - this._lastChangeTime) / GLib.USEC_PER_SEC;
    }

    async _reloadImages() {
        const folders = this._settings.get_strv(SettingsKey.WALLPAPER_FOLDERS);
        this._images = folders.length > 0 ? await listImagesInFolders(folders) : [];
        this._shuffleBag.setItems(this._images);
        this._sequentialIndex = -1;
        this._logger.debug(`Loaded ${this._images.length} wallpaper(s) from ${folders.length} folder(s)`);
    }

    _onModeChanged() {
        this._sequentialIndex = -1;
        this._shuffleBag.setItems(this._images);
    }

    _restartTimer() {
        this._clearTimer();

        if (this._paused || this._suspended || !this._settings.get_boolean(SettingsKey.ROTATION_ENABLED))
            return;

        const interval = Math.max(
            MIN_INTERVAL_SECONDS, this._settings.get_uint(SettingsKey.ROTATION_INTERVAL_SECONDS));

        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this.next().catch(e => this._logger.error(e, 'Automatic rotation failed'));
            return GLib.SOURCE_CONTINUE;
        });
    }

    _clearTimer() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    pause() {
        this._paused = true;
        this._clearTimer();
    }

    resume() {
        this._paused = false;
        this._restartTimer();
    }

    /**
     * Distinct from user-initiated pause(): called while a live wallpaper
     * is actually covering the desktop, so rotation doesn't keep changing
     * a static image nobody can see (which also churns the shell's own
     * background actor on top of the live wallpaper's). Resuming restores
     * whatever the user's own pause() state was, rather than forcing
     * rotation back on.
     */
    suspend() {
        this._suspended = true;
        this._clearTimer();
    }

    unsuspend() {
        this._suspended = false;
        this._restartTimer();
    }

    async next({forced = false} = {}) {
        if (this._suspended) {
            this._logger.debug('Rotation suspended while live wallpaper is active');
            return;
        }

        if (this._images.length === 0)
            await this._reloadImages();

        if (this._images.length === 0) {
            this._logger.debug('No wallpapers available to rotate to');
            return;
        }

        const mode = this._settings.get_string(SettingsKey.ROTATION_MODE);
        let path;
        if (mode === 'sequential') {
            this._sequentialIndex = (this._sequentialIndex + 1) % this._images.length;
            path = this._images[this._sequentialIndex];
        } else {
            path = this._shuffleBag.next();
        }

        if (path)
            await this._applyWallpaper(path);

        if (forced)
            this._logger.debug('Wallpaper change forced (OLED protection)');
    }

    async previous() {
        if (this._suspended || this._images.length === 0)
            return;

        const mode = this._settings.get_string(SettingsKey.ROTATION_MODE);
        if (mode === 'sequential') {
            this._sequentialIndex = (this._sequentialIndex - 1 + this._images.length) % this._images.length;
            await this._applyWallpaper(this._images[this._sequentialIndex]);
        } else {
            await this.next();
        }
    }

    async _applyWallpaper(path) {
        const previousPath = this._currentPath;
        const uri = GLib.filename_to_uri(path, null);

        if (this._settings.get_boolean(SettingsKey.TRANSITION_ENABLED) && previousPath)
            this._playCrossfade(previousPath);

        this._backgroundSettings.set_string('picture-uri', uri);
        if (this._backgroundSettings.settings_schema.has_key('picture-uri-dark'))
            this._backgroundSettings.set_string('picture-uri-dark', uri);

        if (this._settings.get_boolean(SettingsKey.APPLY_TO_LOCK_SCREEN))
            this._screensaverSettings.set_string('picture-uri', uri);

        this._currentPath = path;
        this._lastChangeTime = GLib.get_monotonic_time();
        this._logger.debug(`Wallpaper changed to ${path}`);
    }

    /**
     * The real background actor doesn't crossfade on its own, so we paint the
     * *old* image full-screen on a throwaway overlay right as the new image
     * is set underneath, then fade the overlay out to reveal it.
     */
    _playCrossfade(previousPath) {
        this._clearTransitionOverlays();

        const durationMs = this._settings.get_uint(SettingsKey.TRANSITION_DURATION_MS);
        const uri = GLib.filename_to_uri(previousPath, null).replace(/"/g, '%22');

        for (const monitor of Main.layoutManager.monitors) {
            const overlay = new St.Widget({
                reactive: false,
                x: monitor.x,
                y: monitor.y,
                width: monitor.width,
                height: monitor.height,
                style: `background-image: url("${uri}"); background-size: cover; background-position: center;`,
                opacity: 255,
            });
            Main.layoutManager._backgroundGroup.add_child(overlay);
            this._transitionOverlays.push(overlay);

            overlay.ease({
                opacity: 0,
                duration: durationMs,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    overlay.destroy();
                    const idx = this._transitionOverlays.indexOf(overlay);
                    if (idx >= 0)
                        this._transitionOverlays.splice(idx, 1);
                },
            });
        }
    }

    _clearTransitionOverlays() {
        for (const overlay of this._transitionOverlays)
            overlay.destroy();
        this._transitionOverlays = [];
    }
}
