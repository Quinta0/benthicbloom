import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {SettingsKey} from './lib/settingsKeys.js';

export default class BenthicBloomPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.set_default_size(640, 720);
        window.add(this._buildGeneralPage(settings));
        window.add(this._buildRotationPage(settings));
        window.add(this._buildLiveWallpaperPage(settings));
        window.add(this._buildOledPage(settings));
        window.add(this._buildAboutPage());
    }

    _switchRow(settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _spinRow({title, subtitle, lower, upper, step, page, digits = 0}, getValue, setValue) {
        const row = new Adw.SpinRow({
            title,
            subtitle,
            digits,
            adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: page ?? step}),
        });
        row.value = getValue();
        row.connect('notify::value', () => setValue(row.value));
        return row;
    }

    // --- General page ------------------------------------------------

    _buildGeneralPage(settings) {
        const page = new Adw.PreferencesPage({title: _('General'), icon_name: 'preferences-system-symbolic'});

        const behaviorGroup = new Adw.PreferencesGroup({title: _('Behavior')});
        page.add(behaviorGroup);
        behaviorGroup.add(this._switchRow(
            settings, SettingsKey.SHOW_INDICATOR,
            _('Show Panel Indicator'), _('Display a quick-access icon in the top bar')));
        behaviorGroup.add(this._switchRow(
            settings, SettingsKey.APPLY_TO_LOCK_SCREEN,
            _('Apply to Lock Screen'), _('Also use the current wallpaper as the lock screen background')));
        behaviorGroup.add(this._switchRow(
            settings, SettingsKey.DEBUG_LOGGING,
            _('Debug Logging'), _('Print verbose diagnostics to the system log (journalctl -f)')));

        const foldersGroup = new Adw.PreferencesGroup({
            title: _('Wallpaper Folders'),
            description: _('Images found directly inside these folders are used for rotation'),
        });
        page.add(foldersGroup);

        this._folderList = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
        });
        foldersGroup.add(this._folderList);
        this._refreshFolderList(settings);

        const addButton = new Gtk.Button({
            label: _('Add Folder…'),
            halign: Gtk.Align.START,
            margin_top: 6,
            css_classes: ['flat'],
        });
        addButton.connect('clicked', () => this._pickFolder(settings));
        foldersGroup.add(addButton);

        return page;
    }

    _refreshFolderList(settings) {
        let child = this._folderList.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._folderList.remove(child);
            child = next;
        }

        const folders = settings.get_strv(SettingsKey.WALLPAPER_FOLDERS);
        if (folders.length === 0) {
            this._folderList.append(new Adw.ActionRow({title: _('No folders added yet')}));
            return;
        }

        for (const folder of folders) {
            const row = new Adw.ActionRow({title: folder});
            const removeButton = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            removeButton.connect('clicked', () => {
                const current = settings.get_strv(SettingsKey.WALLPAPER_FOLDERS);
                settings.set_strv(SettingsKey.WALLPAPER_FOLDERS, current.filter(f => f !== folder));
                this._refreshFolderList(settings);
            });
            row.add_suffix(removeButton);
            this._folderList.append(row);
        }
    }

    _pickFolder(settings) {
        const dialog = new Gtk.FileDialog({title: _('Select Wallpaper Folder')});
        dialog.select_folder(this._folderList.get_root(), null, (source, result) => {
            try {
                const folder = dialog.select_folder_finish(result);
                const path = folder.get_path();
                if (!path)
                    return;
                const current = settings.get_strv(SettingsKey.WALLPAPER_FOLDERS);
                if (!current.includes(path)) {
                    settings.set_strv(SettingsKey.WALLPAPER_FOLDERS, [...current, path]);
                    this._refreshFolderList(settings);
                }
            } catch (e) {
                // Dialog was dismissed; nothing to do.
            }
        });
    }

    // --- Rotation page -------------------------------------------------

    _buildRotationPage(settings) {
        const page = new Adw.PreferencesPage({title: _('Rotation'), icon_name: 'media-playlist-shuffle-symbolic'});

        const group = new Adw.PreferencesGroup({title: _('Automatic Rotation')});
        page.add(group);
        group.add(this._switchRow(
            settings, SettingsKey.ROTATION_ENABLED,
            _('Enable Rotation'), _('Automatically change the wallpaper on a timer')));

        group.add(this._spinRow(
            {title: _('Interval'), subtitle: _('Minutes between wallpaper changes'), lower: 1, upper: 1440, step: 1, page: 10},
            () => settings.get_uint(SettingsKey.ROTATION_INTERVAL_SECONDS) / 60,
            value => settings.set_uint(SettingsKey.ROTATION_INTERVAL_SECONDS, Math.round(value) * 60)));

        const modeRow = new Adw.ComboRow({
            title: _('Order'),
            model: new Gtk.StringList({strings: [_('Shuffle'), _('Sequential')]}),
        });
        modeRow.selected = settings.get_string(SettingsKey.ROTATION_MODE) === 'sequential' ? 1 : 0;
        modeRow.connect('notify::selected', () => {
            settings.set_string(SettingsKey.ROTATION_MODE, modeRow.selected === 1 ? 'sequential' : 'shuffle');
        });
        group.add(modeRow);

        const transitionGroup = new Adw.PreferencesGroup({title: _('Transitions')});
        page.add(transitionGroup);
        transitionGroup.add(this._switchRow(
            settings, SettingsKey.TRANSITION_ENABLED,
            _('Crossfade'), _('Smoothly fade between wallpapers instead of switching instantly')));
        transitionGroup.add(this._spinRow(
            {title: _('Fade Duration'), subtitle: _('Milliseconds'), lower: 200, upper: 5000, step: 100, page: 500},
            () => settings.get_uint(SettingsKey.TRANSITION_DURATION_MS),
            value => settings.set_uint(SettingsKey.TRANSITION_DURATION_MS, Math.round(value))));

        return page;
    }

    // --- Live wallpaper page --------------------------------------------

    _buildLiveWallpaperPage(settings) {
        const page = new Adw.PreferencesPage({title: _('Live Wallpaper'), icon_name: 'video-x-generic-symbolic'});

        const group = new Adw.PreferencesGroup({
            title: _('Video Wallpaper'),
            description: _(
                'Play a looping video as your desktop background instead of a static image. ' +
                'Requires GStreamer (with its "good" and "base" plugin sets) to be installed on your system.'),
        });
        page.add(group);
        group.add(this._switchRow(
            settings, SettingsKey.LIVE_WALLPAPER_ENABLED,
            _('Enable Live Wallpaper'), _('Overrides the static wallpaper while active')));

        const fileRow = new Adw.ActionRow({
            title: _('Video File'),
            subtitle: settings.get_string(SettingsKey.LIVE_WALLPAPER_PATH) || _('None selected'),
        });
        const chooseButton = new Gtk.Button({label: _('Choose…'), valign: Gtk.Align.CENTER, css_classes: ['flat']});
        chooseButton.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: _('Select Wallpaper Video')});
            const filter = new Gtk.FileFilter();
            filter.add_mime_type('video/*');
            const filterList = new Gio.ListStore({item_type: Gtk.FileFilter});
            filterList.append(filter);
            dialog.filters = filterList;

            dialog.open(fileRow.get_root(), null, (source, result) => {
                try {
                    const file = dialog.open_finish(result);
                    const path = file.get_path();
                    settings.set_string(SettingsKey.LIVE_WALLPAPER_PATH, path);
                    fileRow.subtitle = path;
                } catch (e) {
                    // Dialog was dismissed; nothing to do.
                }
            });
        });
        fileRow.add_suffix(chooseButton);
        group.add(fileRow);

        group.add(this._switchRow(
            settings, SettingsKey.LIVE_WALLPAPER_MUTED,
            _('Mute Audio'), _('Play video wallpapers without sound')));
        group.add(this._spinRow(
            {
                title: _('Playback Speed'),
                subtitle: _('Multiplier, e.g. 0.5 for half speed, 2.0 for double speed'),
                lower: 0.1, upper: 4.0, step: 0.1, page: 0.5, digits: 1,
            },
            () => settings.get_double(SettingsKey.LIVE_WALLPAPER_PLAYBACK_RATE),
            value => settings.set_double(SettingsKey.LIVE_WALLPAPER_PLAYBACK_RATE, value)));

        const powerGroup = new Adw.PreferencesGroup({title: _('Power Saving')});
        page.add(powerGroup);
        powerGroup.add(this._switchRow(
            settings, SettingsKey.LIVE_WALLPAPER_PAUSE_ON_BATTERY,
            _('Pause on Battery'), _('Stop video playback while running on battery power')));
        powerGroup.add(this._switchRow(
            settings, SettingsKey.LIVE_WALLPAPER_PAUSE_WHEN_FULLSCREEN,
            _('Pause When Fullscreen'), _('Stop video playback while a window is fullscreen')));

        return page;
    }

    // --- OLED protection page --------------------------------------------

    _buildOledPage(settings) {
        const page = new Adw.PreferencesPage({title: _('OLED Protection'), icon_name: 'weather-clear-night-symbolic'});

        const group = new Adw.PreferencesGroup({
            title: _('Burn-in Protection'),
            description: _('Reduces the risk of permanent image retention on OLED displays'),
        });
        page.add(group);
        group.add(this._switchRow(
            settings, SettingsKey.OLED_PROTECTION_ENABLED,
            _('Enable OLED Protection'), _('Master switch for all burn-in protection features')));

        const shiftGroup = new Adw.PreferencesGroup({title: _('Pixel Shifting')});
        page.add(shiftGroup);
        shiftGroup.add(this._switchRow(
            settings, SettingsKey.OLED_PIXEL_SHIFT_ENABLED,
            _('Enable Pixel Shifting'), _('Periodically nudge the background by a few pixels')));
        shiftGroup.add(this._spinRow(
            {title: _('Shift Interval'), subtitle: _('Seconds between each shift step'), lower: 10, upper: 600, step: 5, page: 30},
            () => settings.get_uint(SettingsKey.OLED_PIXEL_SHIFT_INTERVAL_SECONDS),
            value => settings.set_uint(SettingsKey.OLED_PIXEL_SHIFT_INTERVAL_SECONDS, Math.round(value))));
        shiftGroup.add(this._spinRow(
            {title: _('Shift Amount'), subtitle: _('Pixels'), lower: 1, upper: 10, step: 1, page: 1},
            () => settings.get_uint(SettingsKey.OLED_PIXEL_SHIFT_AMOUNT_PX),
            value => settings.set_uint(SettingsKey.OLED_PIXEL_SHIFT_AMOUNT_PX, Math.round(value))));

        const dimGroup = new Adw.PreferencesGroup({title: _('Idle Dimming')});
        page.add(dimGroup);
        dimGroup.add(this._switchRow(
            settings, SettingsKey.OLED_DIM_ON_IDLE_ENABLED,
            _('Dim When Idle'), _('Lower brightness after a period of inactivity')));
        dimGroup.add(this._spinRow(
            {title: _('Idle Delay'), subtitle: _('Seconds of inactivity before dimming'), lower: 10, upper: 3600, step: 10, page: 60},
            () => settings.get_uint(SettingsKey.OLED_DIM_IDLE_DELAY_SECONDS),
            value => settings.set_uint(SettingsKey.OLED_DIM_IDLE_DELAY_SECONDS, Math.round(value))));
        dimGroup.add(this._spinRow(
            {
                title: _('Dimmed Brightness'), subtitle: _('0.0 = black, 0.9 = barely dimmed'),
                lower: 0.0, upper: 0.9, step: 0.05, page: 0.1, digits: 2,
            },
            () => settings.get_double(SettingsKey.OLED_DIM_BRIGHTNESS),
            value => settings.set_double(SettingsKey.OLED_DIM_BRIGHTNESS, value)));

        const forceGroup = new Adw.PreferencesGroup({title: _('Forced Rotation')});
        page.add(forceGroup);
        forceGroup.add(this._switchRow(
            settings, SettingsKey.OLED_FORCE_ROTATION_ENABLED,
            _('Force Periodic Change'),
            _('Change the wallpaper even if automatic rotation is off, to avoid prolonged static images')));
        forceGroup.add(this._spinRow(
            {title: _('Maximum Static Duration'), subtitle: _('Hours before a change is forced'), lower: 1, upper: 48, step: 1, page: 4},
            () => settings.get_uint(SettingsKey.OLED_MAX_STATIC_DURATION_SECONDS) / 3600,
            value => settings.set_uint(SettingsKey.OLED_MAX_STATIC_DURATION_SECONDS, Math.round(value) * 3600)));

        return page;
    }

    // --- About page -----------------------------------------------------

    _buildAboutPage() {
        const page = new Adw.PreferencesPage({title: _('About'), icon_name: 'help-about-symbolic'});
        const group = new Adw.PreferencesGroup();
        page.add(group);

        group.add(new Adw.ActionRow({title: this.metadata.name, subtitle: this.metadata.description}));
        group.add(new Adw.ActionRow({
            title: _('Version'),
            subtitle: this.metadata['version-name'] ?? String(this.metadata.version ?? ''),
        }));

        if (this.metadata.url) {
            const linkRow = new Adw.ActionRow({title: _('Source Code'), subtitle: this.metadata.url, activatable: true});
            linkRow.connect('activated', () => Gtk.show_uri(null, this.metadata.url, Gdk.CURRENT_TIME));
            group.add(linkRow);
        }

        return page;
    }
}
