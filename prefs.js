import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {SettingsKey} from './lib/settingsKeys.js';
import {checkGstreamerBaseAvailable, GSTREAMER_INSTALL_HINT} from './lib/gstreamerAvailability.js';
import {listMediaFilesInFolders} from './lib/wallpaperSource.js';

const BACKGROUND_SCHEMA = 'org.gnome.desktop.background';

// GNOME's own picture-options values, exposed here so wallpaper fill mode
// can be controlled without inventing a parallel setting of our own.
// Built lazily (not at module top level) because gettext can only be
// called once the extension is registered, which hasn't happened yet
// while this module is still being evaluated on import.
function pictureOptions() {
    return [
        {value: 'zoom', label: _('Fill (Crop to Zoom)')},
        {value: 'scaled', label: _('Fit (No Cropping)')},
        {value: 'stretched', label: _('Stretch')},
        {value: 'centered', label: _('Centered')},
        {value: 'wallpaper', label: _('Tiled')},
        {value: 'spanned', label: _('Spanned Across Monitors')},
        {value: 'none', label: _('None (Background Color Only)')},
    ];
}

export default class BenthicBloomPreferences extends ExtensionPreferences {
    async fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const gstreamerError = await checkGstreamerBaseAvailable().then(() => null, e => e.message ?? String(e));

        // Bundled rather than relying on the system icon theme having these
        // exact names — a missing symbolic icon otherwise renders as a
        // blank/broken-image placeholder in the page switcher.
        Gtk.IconTheme.get_for_display(window.get_display()).add_search_path(`${this.path}/icons`);

        const backgroundSettings = new Gio.Settings({schema_id: BACKGROUND_SCHEMA});

        window.set_default_size(640, 720);
        window.add(this._buildGeneralPage(settings, backgroundSettings));
        window.add(this._buildRotationPage(settings));
        window.add(this._buildLiveWallpaperPage(settings, gstreamerError));
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

    _buildGeneralPage(settings, backgroundSettings) {
        const page = new Adw.PreferencesPage({title: _('General'), icon_name: 'bb-general-symbolic'});

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

        const displayGroup = new Adw.PreferencesGroup({
            title: _('Display'),
            description: _('How the wallpaper image is fitted to your screen, e.g. cropped to fill it'),
        });
        page.add(displayGroup);
        const pictureOptionsList = pictureOptions();
        const fillModeRow = new Adw.ComboRow({
            title: _('Fill Mode'),
            model: new Gtk.StringList({strings: pictureOptionsList.map(o => o.label)}),
        });
        const currentOption = backgroundSettings.get_string('picture-options');
        fillModeRow.selected = Math.max(0, pictureOptionsList.findIndex(o => o.value === currentOption));
        fillModeRow.connect('notify::selected', () => {
            backgroundSettings.set_string('picture-options', pictureOptionsList[fillModeRow.selected].value);
        });
        displayGroup.add(fillModeRow);

        const foldersGroup = new Adw.PreferencesGroup({
            title: _('Wallpaper Folders'),
            description: _('Images found directly inside these folders are used for rotation'),
        });
        page.add(foldersGroup);

        const folderList = this._buildFolderListBox(settings, SettingsKey.WALLPAPER_FOLDERS, _('No folders added yet'));
        foldersGroup.add(folderList);

        const buttonRow = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, margin_top: 6});
        foldersGroup.add(buttonRow);

        const addButton = new Gtk.Button({label: _('Add Folder…'), css_classes: ['flat']});
        addButton.connect('clicked', () => this._pickFolderForList(
            settings, SettingsKey.WALLPAPER_FOLDERS, folderList, _('No folders added yet')));
        buttonRow.append(addButton);

        const refreshButton = new Gtk.Button({label: _('Refresh'), css_classes: ['flat']});
        refreshButton.connect('clicked', () => settings.set_uint(
            SettingsKey.WALLPAPER_RESCAN_REQUEST, settings.get_uint(SettingsKey.WALLPAPER_RESCAN_REQUEST) + 1));
        buttonRow.append(refreshButton);

        return page;
    }

    // --- Shared folder-list widgets (used by the General and Live Wallpaper pages) --

    _buildFolderListBox(settings, key, emptyText, onChange) {
        const listBox = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
        this._refreshFolderListBox(listBox, settings, key, emptyText, onChange);
        return listBox;
    }

    _refreshFolderListBox(listBox, settings, key, emptyText, onChange) {
        let child = listBox.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            listBox.remove(child);
            child = next;
        }

        const folders = settings.get_strv(key);
        if (folders.length === 0) {
            listBox.append(new Adw.ActionRow({title: emptyText}));
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
                const current = settings.get_strv(key);
                settings.set_strv(key, current.filter(f => f !== folder));
                this._refreshFolderListBox(listBox, settings, key, emptyText, onChange);
                onChange?.();
            });
            row.add_suffix(removeButton);
            listBox.append(row);
        }
    }

    _pickFolderForList(settings, key, listBox, emptyText, onChange) {
        const dialog = new Gtk.FileDialog({title: _('Select Folder')});
        dialog.select_folder(listBox.get_root(), null, (source, result) => {
            try {
                const folder = dialog.select_folder_finish(result);
                const path = folder.get_path();
                if (!path)
                    return;
                const current = settings.get_strv(key);
                if (!current.includes(path)) {
                    settings.set_strv(key, [...current, path]);
                    this._refreshFolderListBox(listBox, settings, key, emptyText, onChange);
                    onChange?.();
                }
            } catch (e) {
                // Dialog was dismissed; nothing to do.
            }
        });
    }

    // --- Rotation page -------------------------------------------------

    _buildRotationPage(settings) {
        const page = new Adw.PreferencesPage({title: _('Rotation'), icon_name: 'bb-rotation-symbolic'});

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
            _('Enable Transition'), _('Play an animation between wallpapers instead of switching instantly')));

        const styles = ['fade', 'slide', 'zoom', 'random'];
        const styleLabels = [_('Fade'), _('Slide'), _('Zoom'), _('Random')];
        const styleRow = new Adw.ComboRow({title: _('Style'), model: new Gtk.StringList({strings: styleLabels})});
        styleRow.selected = Math.max(0, styles.indexOf(settings.get_string(SettingsKey.TRANSITION_STYLE)));
        styleRow.connect('notify::selected', () => {
            settings.set_string(SettingsKey.TRANSITION_STYLE, styles[styleRow.selected]);
        });
        transitionGroup.add(styleRow);

        transitionGroup.add(this._spinRow(
            {title: _('Fade Duration'), subtitle: _('Milliseconds'), lower: 200, upper: 5000, step: 100, page: 500},
            () => settings.get_uint(SettingsKey.TRANSITION_DURATION_MS),
            value => settings.set_uint(SettingsKey.TRANSITION_DURATION_MS, Math.round(value))));

        return page;
    }

    // --- Live wallpaper page --------------------------------------------

    _buildLiveWallpaperPage(settings, gstreamerError) {
        const page = new Adw.PreferencesPage({title: _('Live Wallpaper'), icon_name: 'bb-live-wallpaper-symbolic'});

        if (gstreamerError) {
            const warningGroup = new Adw.PreferencesGroup();
            const warningRow = new Adw.ActionRow({
                title: _('GStreamer Not Found'),
                subtitle: `${_('Live wallpapers will stay disabled until this is fixed:')} ${gstreamerError}\n\n${GSTREAMER_INSTALL_HINT}`,
                css_classes: ['warning'],
            });
            warningRow.subtitle_lines = 0;
            warningGroup.add(warningRow);
            page.add(warningGroup);
        }

        const group = new Adw.PreferencesGroup({
            title: _('Video Wallpaper'),
            description: _(
                'Play a looping video or animated GIF as your desktop background instead of a static image. ' +
                'Requires GStreamer (with its "good" and "base" plugin sets, which provide GIF decoding) ' +
                'to be installed on your system. Note: this page can only detect GStreamer being ' +
                'completely missing — the rendering path it also needs is private to gnome-shell and can’t ' +
                'be checked from here, so the absence of a warning below isn’t a full guarantee.'),
        });
        page.add(group);
        group.add(this._switchRow(
            settings, SettingsKey.LIVE_WALLPAPER_ENABLED,
            _('Enable Live Wallpaper'), _('Overrides the static wallpaper while active')));

        const fileRow = new Adw.ActionRow({
            title: _('Video / GIF File'),
            subtitle: settings.get_string(SettingsKey.LIVE_WALLPAPER_PATH) || _('None selected'),
        });
        const chooseButton = new Gtk.Button({label: _('Choose…'), valign: Gtk.Align.CENTER, css_classes: ['flat']});
        chooseButton.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: _('Select Wallpaper Video or GIF')});

            const mediaFilter = new Gtk.FileFilter({name: _('Videos and animated GIFs')});
            mediaFilter.add_mime_type('video/*');
            mediaFilter.add_mime_type('image/gif');
            mediaFilter.add_pattern('*.gif');

            const allFilter = new Gtk.FileFilter({name: _('All files')});
            allFilter.add_pattern('*');

            const filterList = new Gio.ListStore({item_type: Gtk.FileFilter});
            filterList.append(mediaFilter);
            filterList.append(allFilter);
            dialog.filters = filterList;
            dialog.default_filter = mediaFilter;

            dialog.open(fileRow.get_root(), null, (source, result) => {
                try {
                    const file = dialog.open_finish(result);
                    const path = file.get_path();
                    settings.set_string(SettingsKey.LIVE_WALLPAPER_PATH, path);
                    fileRow.subtitle = path;
                    this._refreshLiveMediaList(settings, fileRow);
                } catch (e) {
                    // Dialog was dismissed; nothing to do.
                }
            });
        });
        fileRow.add_suffix(chooseButton);
        group.add(fileRow);

        const liveDisplayModes = ['fit', 'fill', 'stretch', 'center'];
        const liveDisplayLabels = [_('Fit (Letterboxed)'), _('Fill (Crop to Cover)'), _('Stretch'), _('Center')];
        const displayModeRow = new Adw.ComboRow({
            title: _('Display Mode'),
            model: new Gtk.StringList({strings: liveDisplayLabels}),
        });
        displayModeRow.selected = Math.max(
            0, liveDisplayModes.indexOf(settings.get_string(SettingsKey.LIVE_WALLPAPER_DISPLAY_MODE)));
        displayModeRow.connect('notify::selected', () => {
            settings.set_string(SettingsKey.LIVE_WALLPAPER_DISPLAY_MODE, liveDisplayModes[displayModeRow.selected]);
        });
        group.add(displayModeRow);

        const muteRow = this._switchRow(
            settings, SettingsKey.LIVE_WALLPAPER_MUTED,
            _('Mute Audio'), _('Play video wallpapers without sound'));
        group.add(muteRow);
        const rateRow = this._spinRow(
            {
                title: _('Playback Speed'),
                subtitle: _('Multiplier, e.g. 0.5 for half speed, 2.0 for double speed'),
                lower: 0.1, upper: 4.0, step: 0.1, page: 0.5, digits: 1,
            },
            () => settings.get_double(SettingsKey.LIVE_WALLPAPER_PLAYBACK_RATE),
            value => settings.set_double(SettingsKey.LIVE_WALLPAPER_PLAYBACK_RATE, value));
        group.add(rateRow);

        const foldersGroup = new Adw.PreferencesGroup({
            title: _('Wallpaper Folders'),
            description: _('Videos and animated GIFs found directly inside these folders can be picked below'),
        });
        page.add(foldersGroup);

        const mediaGroup = new Adw.PreferencesGroup({title: _('Available Media')});
        page.add(mediaGroup);
        this._liveMediaList = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
        mediaGroup.add(this._liveMediaList);
        this._liveMediaGeneration = 0;

        const refreshMedia = () => this._refreshLiveMediaList(settings, fileRow);

        const liveFolderList = this._buildFolderListBox(
            settings, SettingsKey.LIVE_WALLPAPER_FOLDERS, _('No folders added yet'), refreshMedia);
        foldersGroup.add(liveFolderList);

        const liveButtonRow = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, margin_top: 6});
        foldersGroup.add(liveButtonRow);

        const addFolderButton = new Gtk.Button({label: _('Add Folder…'), css_classes: ['flat']});
        addFolderButton.connect('clicked', () => this._pickFolderForList(
            settings, SettingsKey.LIVE_WALLPAPER_FOLDERS, liveFolderList, _('No folders added yet'), refreshMedia));
        liveButtonRow.append(addFolderButton);

        const refreshMediaButton = new Gtk.Button({label: _('Refresh'), css_classes: ['flat']});
        refreshMediaButton.connect('clicked', refreshMedia);
        liveButtonRow.append(refreshMediaButton);

        refreshMedia();

        const powerGroup = new Adw.PreferencesGroup({title: _('Power Saving')});
        page.add(powerGroup);
        powerGroup.add(this._switchRow(
            settings, SettingsKey.LIVE_WALLPAPER_PAUSE_ON_BATTERY,
            _('Pause on Battery'), _('Stop video playback while running on battery power')));
        powerGroup.add(this._switchRow(
            settings, SettingsKey.LIVE_WALLPAPER_PAUSE_WHEN_FULLSCREEN,
            _('Pause When Fullscreen'), _('Stop video playback while a window is fullscreen')));

        // The enable switch itself stays usable so the setting can be
        // prepared ahead of time, but everything that only matters once
        // GStreamer is actually driving playback is greyed out.
        if (gstreamerError) {
            fileRow.sensitive = false;
            displayModeRow.sensitive = false;
            muteRow.sensitive = false;
            rateRow.sensitive = false;
            foldersGroup.sensitive = false;
            mediaGroup.sensitive = false;
            powerGroup.sensitive = false;
        }

        return page;
    }

    /** Re-scans the configured live wallpaper folders and repopulates the "Available Media" list. */
    _refreshLiveMediaList(settings, fileRow) {
        const listBox = this._liveMediaList;
        const generation = ++this._liveMediaGeneration;

        let child = listBox.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            listBox.remove(child);
            child = next;
        }

        const folders = settings.get_strv(SettingsKey.LIVE_WALLPAPER_FOLDERS);
        if (folders.length === 0) {
            listBox.append(new Adw.ActionRow({title: _('Add a folder above to browse its videos and GIFs')}));
            return;
        }

        listBox.append(new Adw.ActionRow({title: _('Scanning…')}));

        listMediaFilesInFolders(folders).then(paths => {
            if (generation !== this._liveMediaGeneration)
                return; // A folder changed again before this scan finished; a newer one is in flight.

            let c = listBox.get_first_child();
            while (c) {
                const next = c.get_next_sibling();
                listBox.remove(c);
                c = next;
            }

            if (paths.length === 0) {
                listBox.append(new Adw.ActionRow({title: _('No videos or GIFs found in those folders')}));
                return;
            }

            const currentPath = settings.get_string(SettingsKey.LIVE_WALLPAPER_PATH);
            for (const path of paths) {
                const row = new Adw.ActionRow({
                    title: Gio.File.new_for_path(path).get_basename(),
                    subtitle: path,
                    activatable: true,
                });
                if (path === currentPath)
                    row.add_suffix(new Gtk.Image({icon_name: 'object-select-symbolic'}));
                row.connect('activated', () => {
                    settings.set_string(SettingsKey.LIVE_WALLPAPER_PATH, path);
                    fileRow.subtitle = path;
                    this._refreshLiveMediaList(settings, fileRow);
                });
                listBox.append(row);
            }
        }).catch(() => {});
    }

    // --- OLED protection page --------------------------------------------

    _buildOledPage(settings) {
        const page = new Adw.PreferencesPage({title: _('OLED Protection'), icon_name: 'bb-oled-symbolic'});

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
            {
                title: _('Shift Interval'), subtitle: _('Minutes between each shift step'),
                lower: 0.5, upper: 10, step: 0.5, page: 1, digits: 1,
            },
            () => settings.get_uint(SettingsKey.OLED_PIXEL_SHIFT_INTERVAL_SECONDS) / 60,
            value => settings.set_uint(SettingsKey.OLED_PIXEL_SHIFT_INTERVAL_SECONDS, Math.round(value * 60))));
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
            {title: _('Idle Delay'), subtitle: _('Minutes of inactivity before dimming'), lower: 1, upper: 60, step: 1, page: 5},
            () => settings.get_uint(SettingsKey.OLED_DIM_IDLE_DELAY_SECONDS) / 60,
            value => settings.set_uint(SettingsKey.OLED_DIM_IDLE_DELAY_SECONDS, Math.round(value * 60))));
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
        const page = new Adw.PreferencesPage({title: _('About'), icon_name: 'bb-about-symbolic'});
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
