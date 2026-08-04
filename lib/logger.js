import {SettingsKey} from './settingsKeys.js';

export class Logger {
    constructor(settings, prefix) {
        this._settings = settings;
        this._prefix = prefix ?? 'BenthicBloom';
    }

    debug(message) {
        if (this._settings.get_boolean(SettingsKey.DEBUG_LOGGING))
            console.log(`[${this._prefix}] ${message}`);
    }

    info(message) {
        console.log(`[${this._prefix}] ${message}`);
    }

    warn(message) {
        console.warn(`[${this._prefix}] ${message}`);
    }

    error(error, context) {
        const detail = error?.message ?? String(error);
        console.error(`[${this._prefix}] ${context ? `${context}: ${detail}` : detail}`);
    }
}
