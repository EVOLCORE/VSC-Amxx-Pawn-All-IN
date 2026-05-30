const DEFAULT_NOTIFICATION_TIMEOUT_MS = 10000;

function normalizeTimeoutMs(value = DEFAULT_NOTIFICATION_TIMEOUT_MS) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return DEFAULT_NOTIFICATION_TIMEOUT_MS;
    return Math.max(1000, Math.floor(number));
}

function executeCommandBestEffort(vscode, command) {
    try {
        const result = vscode?.commands?.executeCommand?.(command);
        if (result && typeof result.catch === 'function') {
            result.catch(() => {});
        }
        return result;
    } catch {
        return null;
    }
}

function hideNotificationToasts(vscode) {
    executeCommandBestEffort(vscode, 'notifications.hideToasts');
    executeCommandBestEffort(vscode, 'workbench.action.closeMessages');
}

function showTimedMessage(vscode, kind, message, ...args) {
    const show = vscode?.window?.[kind];
    if (typeof show !== 'function') return Promise.resolve(undefined);

    let settled = false;
    let timer = null;
    const timeoutMs = normalizeTimeoutMs();

    const messagePromise = Promise.resolve()
        .then(() => show.call(vscode.window, message, ...args))
        .then(selection => {
            settled = true;
            if (timer) clearTimeout(timer);
            return selection;
        }, () => {
            settled = true;
            if (timer) clearTimeout(timer);
            return undefined;
        });

    const timeoutPromise = new Promise(resolve => {
        timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            hideNotificationToasts(vscode);
            resolve(undefined);
        }, timeoutMs);
    });

    return Promise.race([messagePromise, timeoutPromise]);
}

function showTimedInformationMessage(vscode, message, ...args) {
    return showTimedMessage(vscode, 'showInformationMessage', message, ...args);
}

function showTimedWarningMessage(vscode, message, ...args) {
    return showTimedMessage(vscode, 'showWarningMessage', message, ...args);
}

function showTimedErrorMessage(vscode, message, ...args) {
    return showTimedMessage(vscode, 'showErrorMessage', message, ...args);
}

module.exports = {
    DEFAULT_NOTIFICATION_TIMEOUT_MS,
    hideNotificationToasts,
    showTimedErrorMessage,
    showTimedInformationMessage,
    showTimedWarningMessage
};
