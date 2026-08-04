import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {IMAGE_EXTENSIONS} from './settingsKeys.js';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async', 'next_files_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async', 'close_finish');

function hasImageExtension(name) {
    const lower = name.toLowerCase();
    return IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

/** Non-recursively lists image files directly inside a single folder. */
export async function listImagesInFolder(folderPath) {
    const results = [];
    const dir = folderPath.startsWith('file://')
        ? Gio.File.new_for_uri(folderPath)
        : Gio.File.new_for_path(folderPath);

    let enumerator;
    try {
        enumerator = await dir.enumerate_children_async(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            null);
    } catch (e) {
        return results;
    }

    for (;;) {
        const infos = await enumerator.next_files_async(50, GLib.PRIORITY_DEFAULT, null);
        if (infos.length === 0)
            break;

        for (const info of infos) {
            if (info.get_file_type() !== Gio.FileType.REGULAR)
                continue;
            if (!hasImageExtension(info.get_name()))
                continue;
            results.push(enumerator.get_child(info).get_path());
        }
    }

    try {
        await enumerator.close_async(GLib.PRIORITY_DEFAULT, null);
    } catch (e) {
        // Enumerator already exhausted; nothing to clean up.
    }

    return results;
}

/** Merges and de-duplicates images found across several folders. */
export async function listImagesInFolders(folderPaths) {
    const lists = await Promise.all(
        folderPaths.map(folder => listImagesInFolder(folder).catch(() => [])));

    const seen = new Set();
    const merged = [];
    for (const list of lists) {
        for (const path of list) {
            if (!seen.has(path)) {
                seen.add(path);
                merged.push(path);
            }
        }
    }

    merged.sort();
    return merged;
}
