function getExtensionId(context) {
    return String(context?.extension?.id || '').toLowerCase();
}

function getExtensionPath(context) {
    return String(context?.extensionPath || context?.extensionUri?.fsPath || '').toLowerCase();
}

function getPackageJson(extension) {
    return extension?.packageJSON && typeof extension.packageJSON === 'object'
        ? extension.packageJSON
        : {};
}

function hasAmxxPawnLanguageContribution(pkg) {
    return (pkg.contributes?.languages || []).some(language =>
        String(language?.id || '').toLowerCase() === 'amxxpawn'
    );
}

function hasAmxxPawnGrammarContribution(pkg) {
    return (pkg.contributes?.grammars || []).some(grammar =>
        String(grammar?.language || '').toLowerCase() === 'amxxpawn'
    );
}

function hasAmxxPawnCommandContribution(pkg) {
    return (pkg.contributes?.commands || []).some(command =>
        String(command?.command || '').startsWith('amxxPawnAllIn.')
    );
}

function hasAmxxPawnConfigurationContribution(pkg) {
    const properties = pkg.contributes?.configuration?.properties || {};
    return Object.keys(properties).some(key => String(key || '').startsWith('amxxPawnAllIn.'));
}

function isPotentialAmxxPawnToolingExtension(extension) {
    const pkg = getPackageJson(extension);
    return hasAmxxPawnLanguageContribution(pkg) ||
        hasAmxxPawnGrammarContribution(pkg) ||
        hasAmxxPawnCommandContribution(pkg) ||
        hasAmxxPawnConfigurationContribution(pkg);
}

function getExtensionDisplayName(extension) {
    const pkg = getPackageJson(extension);
    return String(pkg.displayName || extension?.id || pkg.name || '').trim();
}

function findConflictingAmxxPawnExtensions(vscode, context) {
    const ownId = getExtensionId(context);
    const ownPath = getExtensionPath(context);
    const conflicts = [];
    for (const extension of vscode?.extensions?.all || []) {
        const id = String(extension?.id || '').toLowerCase();
        const extensionPath = String(extension?.extensionPath || extension?.extensionUri?.fsPath || '').toLowerCase();
        if (ownId && id === ownId) continue;
        if (ownPath && extensionPath && extensionPath === ownPath) continue;
        if (!isPotentialAmxxPawnToolingExtension(extension)) continue;
        conflicts.push({
            id: extension?.id || '',
            displayName: getExtensionDisplayName(extension)
        });
    }
    return conflicts;
}

function warnAboutConflictingAmxxPawnExtensions({ vscode, context, t, outputChannel }) {
    const conflicts = findConflictingAmxxPawnExtensions(vscode, context);
    if (!conflicts.length) return [];

    const names = conflicts
        .map(conflict => conflict.displayName || conflict.id)
        .filter(Boolean)
        .join(', ');
    outputChannel?.appendLine?.(`[lifecycle] extension-conflict count=${conflicts.length} extensions=${names}`);

    const storageKey = `amxxPawnAllIn.extensionConflictWarning.${conflicts.map(item => item.id || item.displayName).sort().join('|')}`;
    if (context?.globalState?.get?.(storageKey)) return conflicts;
    context?.globalState?.update?.(storageKey, Date.now());

    const message = t('extension.conflict.warning', { extensions: names });
    const openExtensions = t('extension.conflict.openExtensions');
    vscode?.window?.showWarningMessage?.(message, openExtensions).then(selection => {
        if (selection !== openExtensions) return;
        vscode?.commands?.executeCommand?.('workbench.extensions.search', '@installed amxx pawn');
    });
    return conflicts;
}

module.exports = {
    findConflictingAmxxPawnExtensions,
    warnAboutConflictingAmxxPawnExtensions
};
