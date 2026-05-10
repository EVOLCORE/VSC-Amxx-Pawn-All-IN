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

module.exports = {
    HOVER_MODE_VALUES,
    HOVER_MODIFIER_HACK_KEY_BY_MODE,
    isHoverModifierHackMode,
    getHoverModifierHackKey,
    normalizeHoverMode
};
