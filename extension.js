import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {SettingsKey} from './lib/settingsKeys.js';
import {Logger} from './lib/logger.js';
import {RotationManager} from './lib/rotationManager.js';
import {LiveWallpaperManager} from './lib/liveWallpaper.js';
import {OledProtectionManager} from './lib/oledProtection.js';
import {BenthicBloomIndicator} from './lib/indicator.js';

export default class BenthicBloomExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._logger = new Logger(this._settings, this.metadata.name);

        this._rotationManager = new RotationManager(this._settings, this._logger);
        this._liveWallpaperManager = new LiveWallpaperManager(this._settings, this._logger, {
            // Rotation changes the static picture-uri GSettings key, which
            // makes the shell repaint its own background actor on top of
            // the live wallpaper's. Suspend rotation while a live
            // wallpaper is actually on screen, independent of any
            // user-initiated pause.
            onActiveChanged: active => {
                if (active)
                    this._rotationManager.suspend();
                else
                    this._rotationManager.unsuspend();
            },
        });
        this._oledProtectionManager = new OledProtectionManager(this._settings, this._logger, {
            forceNextWallpaper: maxSeconds => {
                if (this._rotationManager.secondsSinceLastChange >= maxSeconds) {
                    this._rotationManager.next({forced: true})
                        .catch(e => this._logger.error(e, 'Forced OLED rotation failed'));
                }
            },
        });

        this._rotationManager.enable();
        this._liveWallpaperManager.enable()
            .catch(e => this._logger.error(e, 'Live wallpaper failed to initialize'));
        this._oledProtectionManager.enable();

        this._indicator = null;
        this._showIndicatorSignalId = this._settings.connect(
            `changed::${SettingsKey.SHOW_INDICATOR}`, () => this._syncIndicator());
        this._syncIndicator();
    }

    disable() {
        if (this._showIndicatorSignalId) {
            this._settings.disconnect(this._showIndicatorSignalId);
            this._showIndicatorSignalId = 0;
        }

        this._indicator?.destroy();
        this._indicator = null;

        this._oledProtectionManager?.disable();
        this._oledProtectionManager = null;

        this._liveWallpaperManager?.disable();
        this._liveWallpaperManager = null;

        this._rotationManager?.disable();
        this._rotationManager = null;

        this._logger = null;
        this._settings = null;
    }

    _syncIndicator() {
        const shouldShow = this._settings.get_boolean(SettingsKey.SHOW_INDICATOR);

        if (shouldShow && !this._indicator) {
            this._indicator = new BenthicBloomIndicator(this._settings, {
                rotationManager: this._rotationManager,
                liveWallpaperManager: this._liveWallpaperManager,
                oledProtectionManager: this._oledProtectionManager,
                openPreferences: () => this.openPreferences(),
            });
            Main.panel.addToStatusArea(this.uuid, this._indicator);
        } else if (!shouldShow && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
