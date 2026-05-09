function createDebugOutputChannel(outputChannel, settingsService) {
    const isEnabled = () => settingsService?.isDebugOutputEnabled?.() === true;
    const callWhenEnabled = (method, args) => {
        if (!isEnabled()) return;
        try {
            outputChannel?.[method]?.(...args);
        } catch {
            // Debug output must never affect feature behavior.
        }
    };

    return {
        append(value) {
            callWhenEnabled('append', [value]);
        },
        appendLine(value) {
            callWhenEnabled('appendLine', [value]);
        },
        clear() {
            callWhenEnabled('clear', []);
        },
        show(...args) {
            callWhenEnabled('show', args);
        }
    };
}

module.exports = { createDebugOutputChannel };
