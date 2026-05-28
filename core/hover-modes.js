const HOVER_MODIFIER_HACK_KEY_BY_MODE = Object.freeze({
    'ctrl-hack': Object.freeze({ label: 'Ctrl', vKey: '0x11' }),
    'shift-hack': Object.freeze({ label: 'Shift', vKey: '0x10' }),
    'alt-hack': Object.freeze({ label: 'Alt', vKey: '0x12' })
});

const HOVER_MODE_VALUES = Object.freeze([
    'disabled',
    'normal',
    ...Object.keys(HOVER_MODIFIER_HACK_KEY_BY_MODE)
]);
const DEFAULT_HOVER_MODIFIER_HACK_HOLD_DELAY_MS = 200;

function isHoverModifierHackMode(mode) {
    return Object.prototype.hasOwnProperty.call(HOVER_MODIFIER_HACK_KEY_BY_MODE, mode);
}

function getHoverModifierHackKey(mode) {
    return HOVER_MODIFIER_HACK_KEY_BY_MODE[mode] || null;
}

function normalizeHoverMode(value) {
    const mode = String(value || 'normal').trim().toLowerCase();
    return HOVER_MODE_VALUES.includes(mode) ? mode : 'normal';
}

function createModifierHoldGate(options = {}) {
    const holdDelayMs = Number.isFinite(options.holdDelayMs)
        ? Math.max(0, Number(options.holdDelayMs))
        : DEFAULT_HOVER_MODIFIER_HACK_HOLD_DELAY_MS;
    const setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout;
    const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout;
    const keepTimer = typeof options.keepTimer === 'function' ? options.keepTimer : (timer => timer);
    const onActiveChange = typeof options.onActiveChange === 'function'
        ? options.onActiveChange
        : (() => {});

    let physicalPressed = false;
    let activePressed = false;
    let holdTimer = null;
    let disposed = false;

    const clearHoldTimer = () => {
        if (!holdTimer) return;
        clearTimer(holdTimer);
        holdTimer = null;
    };
    const emitActive = nextActive => {
        const normalized = !!nextActive;
        if (normalized === activePressed) return;
        activePressed = normalized;
        onActiveChange(activePressed);
    };
    const activateAfterHold = () => {
        holdTimer = null;
        if (disposed || !physicalPressed) return;
        emitActive(true);
    };
    const setPhysicalPressed = nextPressed => {
        if (disposed) return;
        const normalized = !!nextPressed;
        if (normalized === physicalPressed) return;
        physicalPressed = normalized;
        clearHoldTimer();
        if (!physicalPressed) {
            emitActive(false);
            return;
        }
        if (holdDelayMs <= 0) {
            emitActive(true);
            return;
        }
        holdTimer = keepTimer(setTimer(activateAfterHold, holdDelayMs));
    };
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        physicalPressed = false;
        clearHoldTimer();
        emitActive(false);
    };

    return {
        setPhysicalPressed,
        dispose,
        isPhysicalPressed: () => physicalPressed,
        isActivePressed: () => activePressed
    };
}

module.exports = {
    DEFAULT_HOVER_MODIFIER_HACK_HOLD_DELAY_MS,
    HOVER_MODE_VALUES,
    HOVER_MODIFIER_HACK_KEY_BY_MODE,
    createModifierHoldGate,
    isHoverModifierHackMode,
    getHoverModifierHackKey,
    normalizeHoverMode
};
