const ACTIVATION_KEY = Symbol.for('amxxPawnAllIn.activationGuard');

function disposeActivationSubscriptions(record) {
    const subscriptions = Array.isArray(record?.subscriptions) ? record.subscriptions : [];
    for (const disposable of subscriptions) {
        try {
            disposable?.dispose?.();
        } catch {
            // Ignore stale activation cleanup failures; VS Code disposes subscriptions defensively too.
        }
    }
}

function registerActivationGuard(context) {
    const globalState = globalThis;
    const previous = globalState[ACTIVATION_KEY];
    if (previous?.subscriptions && previous.subscriptions !== context?.subscriptions) {
        disposeActivationSubscriptions(previous);
    }

    const current = {
        subscriptions: context?.subscriptions || []
    };
    globalState[ACTIVATION_KEY] = current;

    context?.subscriptions?.push?.({
        dispose() {
            if (globalState[ACTIVATION_KEY] === current) {
                delete globalState[ACTIVATION_KEY];
            }
        }
    });
}

module.exports = {
    registerActivationGuard
};
