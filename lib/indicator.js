import GObject from 'gi://GObject';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {SettingsKey} from './settingsKeys.js';

export const BenthicBloomIndicator = GObject.registerClass(
class BenthicBloomIndicator extends PanelMenu.Button {
    _init(settings, {rotationManager, liveWallpaperManager, openPreferences}) {
        super._init(0.0, 'BenthicBloom');

        this._rotationManager = rotationManager;

        this.add_child(new St.Icon({
            icon_name: 'preferences-desktop-wallpaper-symbolic',
            style_class: 'system-status-icon benthicbloom-indicator-icon',
        }));

        const rotationToggle = new PopupMenu.PopupSwitchMenuItem(
            'Auto Rotation', settings.get_boolean(SettingsKey.ROTATION_ENABLED));
        rotationToggle.connect('toggled', (_item, state) => {
            settings.set_boolean(SettingsKey.ROTATION_ENABLED, state);
        });
        this.menu.addMenuItem(rotationToggle);

        const nextItem = new PopupMenu.PopupMenuItem('Next Wallpaper');
        nextItem.connect('activate', () => {
            rotationManager.next().catch(e => console.error(`[BenthicBloom] ${e.message ?? e}`));
        });
        nextItem.setSensitive(!settings.get_boolean(SettingsKey.LIVE_WALLPAPER_ENABLED));
        this.menu.addMenuItem(nextItem);

        const liveToggle = new PopupMenu.PopupSwitchMenuItem(
            'Live Wallpaper', settings.get_boolean(SettingsKey.LIVE_WALLPAPER_ENABLED));
        liveToggle.connect('toggled', (_item, state) => {
            settings.set_boolean(SettingsKey.LIVE_WALLPAPER_ENABLED, state);
        });
        liveToggle.reactive = liveWallpaperManager.isAvailable;
        if (!liveWallpaperManager.isAvailable)
            liveToggle.label.text = 'Live Wallpaper (GStreamer not found)';
        this.menu.addMenuItem(liveToggle);

        const oledToggle = new PopupMenu.PopupSwitchMenuItem(
            'OLED Protection', settings.get_boolean(SettingsKey.OLED_PROTECTION_ENABLED));
        oledToggle.connect('toggled', (_item, state) => {
            settings.set_boolean(SettingsKey.OLED_PROTECTION_ENABLED, state);
        });
        this.menu.addMenuItem(oledToggle);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const settingsItem = new PopupMenu.PopupMenuItem('Wallpaper Settings…');
        settingsItem.connect('activate', () => openPreferences());
        this.menu.addMenuItem(settingsItem);

        const signalIds = [
            settings.connect(`changed::${SettingsKey.ROTATION_ENABLED}`, () => {
                rotationToggle.setToggleState(settings.get_boolean(SettingsKey.ROTATION_ENABLED));
            }),
            settings.connect(`changed::${SettingsKey.LIVE_WALLPAPER_ENABLED}`, () => {
                const enabled = settings.get_boolean(SettingsKey.LIVE_WALLPAPER_ENABLED);
                liveToggle.setToggleState(enabled);
                nextItem.setSensitive(!enabled);
            }),
            settings.connect(`changed::${SettingsKey.OLED_PROTECTION_ENABLED}`, () => {
                oledToggle.setToggleState(settings.get_boolean(SettingsKey.OLED_PROTECTION_ENABLED));
            }),
        ];

        this.connect('destroy', () => {
            for (const id of signalIds)
                settings.disconnect(id);
        });
    }
});
