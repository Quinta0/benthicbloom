export const SettingsKey = Object.freeze({
    SHOW_INDICATOR: 'show-indicator',
    DEBUG_LOGGING: 'debug-logging',
    WALLPAPER_FOLDERS: 'wallpaper-folders',
    APPLY_TO_LOCK_SCREEN: 'apply-to-lock-screen',

    ROTATION_ENABLED: 'rotation-enabled',
    ROTATION_INTERVAL_SECONDS: 'rotation-interval-seconds',
    ROTATION_MODE: 'rotation-mode',
    CURRENT_INDEX: 'current-index',
    TRANSITION_ENABLED: 'transition-enabled',
    TRANSITION_DURATION_MS: 'transition-duration-ms',

    LIVE_WALLPAPER_ENABLED: 'live-wallpaper-enabled',
    LIVE_WALLPAPER_PATH: 'live-wallpaper-path',
    LIVE_WALLPAPER_MUTED: 'live-wallpaper-muted',
    LIVE_WALLPAPER_PLAYBACK_RATE: 'live-wallpaper-playback-rate',
    LIVE_WALLPAPER_PAUSE_ON_BATTERY: 'live-wallpaper-pause-on-battery',
    LIVE_WALLPAPER_PAUSE_WHEN_FULLSCREEN: 'live-wallpaper-pause-when-fullscreen',

    OLED_PROTECTION_ENABLED: 'oled-protection-enabled',
    OLED_PIXEL_SHIFT_ENABLED: 'oled-pixel-shift-enabled',
    OLED_PIXEL_SHIFT_INTERVAL_SECONDS: 'oled-pixel-shift-interval-seconds',
    OLED_PIXEL_SHIFT_AMOUNT_PX: 'oled-pixel-shift-amount-px',
    OLED_DIM_ON_IDLE_ENABLED: 'oled-dim-on-idle-enabled',
    OLED_DIM_IDLE_DELAY_SECONDS: 'oled-dim-idle-delay-seconds',
    OLED_DIM_BRIGHTNESS: 'oled-dim-brightness',
    OLED_FORCE_ROTATION_ENABLED: 'oled-force-rotation-enabled',
    OLED_MAX_STATIC_DURATION_SECONDS: 'oled-max-static-duration-seconds',
});

export const IMAGE_EXTENSIONS = Object.freeze([
    '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.tif', '.gif',
]);
