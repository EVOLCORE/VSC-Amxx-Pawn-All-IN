function isDebugOutputChannelEnabled(outputChannel) {
    if (typeof outputChannel?.isEnabled === 'function') {
        return outputChannel.isEnabled() === true;
    }
    return typeof outputChannel?.appendLine === 'function';
}

function createPrefixedDebugLogger(outputChannel, prefix = '') {
    const label = String(prefix || '').trim();
    const messagePrefix = label ? `[${label}] ` : '';
    return message => {
        if (!isDebugOutputChannelEnabled(outputChannel)) return;
        try {
            const text = typeof message === 'function' ? message() : message;
            outputChannel?.appendLine?.(`${messagePrefix}${text}`);
        } catch {
            // Debug logging must never affect feature behavior.
        }
    };
}

module.exports = {
    createPrefixedDebugLogger,
    isDebugOutputChannelEnabled
};
