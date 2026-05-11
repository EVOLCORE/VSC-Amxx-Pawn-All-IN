const { COMPLETION_TRIGGER_CHARACTERS } = require('../features/completion');
const { isHoverModifierHackMode } = require('../core/hover-modes');
const { shouldSchedulePersistentHoverForSelectionEvent } = require('../core/persistent-hover/selection-events');
const {
    getEffectiveIncludeFileExtensions,
    normalizeIncludeExtensionList
} = require('../core/include-extensions');

function buildLazyActivationRuntime(deps, options = {}) {
    const {
        vscode,
        path,
        context,
        settingsService,
        liveValidationOutputChannel
    } = deps;

    let runtime = null;
    let realRegistered = false;
    let initializeTimer = null;
    const proxyDisposables = [];

    const getBuildActivationRuntime = () => {
        if (typeof options.buildActivationRuntime === 'function') {
            return options.buildActivationRuntime;
        }
        return require('./build-runtime').buildActivationRuntime;
    };

    const getConfiguredExtensions = getter => {
        const values = typeof getter === 'function' ? getter() : [];
        return normalizeIncludeExtensionList(values, []);
    };
    const hasConfiguredExtension = (filePath = '') => {
        const [ext = ''] = normalizeIncludeExtensionList([path.extname(String(filePath || ''))], []);
        if (!ext) return false;
        return [
            ...getConfiguredExtensions(settingsService?.getPawnFileExtensions),
            ...getEffectiveIncludeFileExtensions(getConfiguredExtensions(settingsService?.getIncludeFileExtensions))
        ].includes(ext);
    };
    const shouldDetectPawnByIncludes = () =>
        typeof settingsService?.shouldDetectPawnLanguageByIncludes === 'function' &&
        settingsService.shouldDetectPawnLanguageByIncludes();
    const isLikelyPawnDocument = document =>
        !!document &&
        (document.languageId === 'amxxpawn' || hasConfiguredExtension(document.fileName || ''));
    const shouldEnsureForDocumentLifecycle = document =>
        isLikelyPawnDocument(document) || shouldDetectPawnByIncludes();

    const trackProxyDisposable = disposable => {
        if (!disposable || typeof disposable.dispose !== 'function') return disposable;
        proxyDisposables.push(disposable);
        context?.subscriptions?.push?.(disposable);
        return disposable;
    };
    const logCompletion = message => {
        try {
            liveValidationOutputChannel?.appendLine?.(`[completion] ${message}`);
        } catch {
            // Lazy completion logging should never affect provider results.
        }
    };
    const logHover = message => {
        try {
            liveValidationOutputChannel?.appendLine?.(`[hover] ${message}`);
        } catch {
            // Lazy hover logging should never affect provider results.
        }
    };
    const disposeProxyRegistrations = () => {
        while (proxyDisposables.length) {
            const disposable = proxyDisposables.pop();
            try {
                disposable?.dispose?.();
            } catch {
                // Ignore proxy disposal failures; real providers are about to own the lifecycle.
            }
        }
    };

    function ensureRuntime() {
        if (!runtime) {
            runtime = getBuildActivationRuntime()(deps);
        }
        return runtime;
    }

    function ensureRegisteredRuntime() {
        const activeRuntime = ensureRuntime();
        if (realRegistered) return activeRuntime;
        if (initializeTimer) {
            clearTimeout(initializeTimer);
            initializeTimer = null;
        }
        disposeProxyRegistrations();
        activeRuntime.editorLifecycleFeature.register();
        activeRuntime.editorLifecycleFeature.initialize();
        activeRuntime.persistentHoverFeature.register(context);
        activeRuntime.hoverFeature.register(context);
        activeRuntime.completionFeature.register(context);
        activeRuntime.navigationFeature.register(context);
        realRegistered = true;
        return activeRuntime;
    }

    const proxyEditorLifecycleFeature = {
        register() {
            trackProxyDisposable(vscode.workspace.onDidOpenTextDocument(async doc => {
                if (!shouldEnsureForDocumentLifecycle(doc)) return;
                await ensureRegisteredRuntime().editorLifecycleFeature.handleDidOpenTextDocument?.(doc);
            }));
            trackProxyDisposable(vscode.workspace.onDidChangeTextDocument(event => {
                if (!event?.contentChanges?.length || !shouldEnsureForDocumentLifecycle(event.document)) return;
                ensureRegisteredRuntime().editorLifecycleFeature.handleDidChangeTextDocument?.(event);
            }));
            trackProxyDisposable(vscode.workspace.onDidSaveTextDocument(doc => {
                if (!shouldEnsureForDocumentLifecycle(doc)) return;
                ensureRegisteredRuntime().editorLifecycleFeature.handleDidSaveTextDocument?.(doc);
            }));
            trackProxyDisposable(vscode.workspace.onDidCloseTextDocument(doc => {
                if (!shouldEnsureForDocumentLifecycle(doc)) return;
                ensureRegisteredRuntime().editorLifecycleFeature.handleDidCloseTextDocument?.(doc);
            }));
            trackProxyDisposable(vscode.window.onDidChangeActiveTextEditor(async editor => {
                const doc = editor?.document || null;
                if (!shouldEnsureForDocumentLifecycle(doc)) return;
                await ensureRegisteredRuntime().editorLifecycleFeature.handleDidChangeActiveTextEditor?.(editor);
            }));
            if (typeof vscode.window.onDidChangeVisibleTextEditors === 'function') {
                trackProxyDisposable(vscode.window.onDidChangeVisibleTextEditors(editors => {
                    if (!(editors || []).some(editor => shouldEnsureForDocumentLifecycle(editor?.document || null))) return;
                    ensureRegisteredRuntime().editorLifecycleFeature.handleDidChangeVisibleTextEditors?.(editors);
                }));
            }
            trackProxyDisposable(vscode.workspace.onDidChangeConfiguration(event => {
                if (!event) return;
                ensureRegisteredRuntime().editorLifecycleFeature.handleDidChangeConfiguration?.(event);
            }));
        },
        initialize() {
            const activeDoc = vscode.window.activeTextEditor?.document || null;
            if (!shouldEnsureForDocumentLifecycle(activeDoc)) return;
            initializeTimer = setTimeout(() => {
                initializeTimer = null;
                ensureRegisteredRuntime();
            }, 40);
            if (typeof initializeTimer.unref === 'function') initializeTimer.unref();
        },
        dispose() {
            if (initializeTimer) {
                clearTimeout(initializeTimer);
                initializeTimer = null;
            }
            disposeProxyRegistrations();
            runtime?.editorLifecycleFeature?.dispose?.();
        }
    };

    const proxyHoverFeature = {
        register(proxyContext) {
            const hoverMode = settingsService?.getHoverMode?.();
            if (isHoverModifierHackMode(hoverMode)) {
                ensureRegisteredRuntime();
                return;
            }
            trackProxyDisposable(vscode.languages.registerHoverProvider('amxxpawn', {
                provideHover(document, position) {
                    const startedAt = Date.now();
                    const fileName = String(document?.fileName || '');
                    const line = Number.isInteger(position?.line) ? position.line : -1;
                    const character = Number.isInteger(position?.character) ? position.character : -1;
                    const hoverMode = settingsService?.getHoverMode?.();
                    if (hoverMode === 'disabled') {
                        logHover(`proxy-skip disabled file=${fileName} pos=${line}:${character} ms=${Date.now() - startedAt}`);
                        return null;
                    }
                    if (isHoverModifierHackMode(hoverMode)) {
                        ensureRegisteredRuntime();
                        logHover(`proxy-skip modifier-hack file=${fileName} pos=${line}:${character} ms=${Date.now() - startedAt}`);
                        return null;
                    }
                    logHover(`proxy-request file=${fileName} pos=${line}:${character} lang=${document?.languageId || ''}`);
                    const activeRuntime = ensureRegisteredRuntime();
                    const hover = activeRuntime.buildHoverAtPosition(document, position);
                    logHover(`proxy-result hit=${hover ? 1 : 0} file=${fileName} pos=${line}:${character} ms=${Date.now() - startedAt}`);
                    return hover;
                }
            }));
        }
    };

    const proxyCompletionFeature = {
        register() {
            const provider = {
                provideCompletionItems(document, position) {
                    const startedAt = Date.now();
                    const fileName = String(document?.fileName || '');
                    const line = Number.isInteger(position?.line) ? position.line : -1;
                    const character = Number.isInteger(position?.character) ? position.character : -1;
                    if (settingsService?.isCompletionEnabled?.() === false) {
                        logCompletion(`proxy-skip disabled file=${fileName} ms=${Date.now() - startedAt}`);
                        return [];
                    }
                    logCompletion(`proxy-request file=${fileName} pos=${line}:${character} lang=${document?.languageId || ''}`);
                    const items = ensureRegisteredRuntime().completionFeature.provideCompletionItems?.(document, position) || [];
                    logCompletion(
                        `proxy-result items=${Array.isArray(items) ? items.length : 'unknown'} ` +
                        `file=${fileName} ms=${Date.now() - startedAt}`
                    );
                    return items;
                },
                resolveCompletionItem(item) {
                    const startedAt = Date.now();
                    const label = String(item?.label?.label || item?.label || '');
                    if (settingsService?.isCompletionEnabled?.() === false) {
                        logCompletion(`proxy-resolve-skip disabled label=${label} ms=${Date.now() - startedAt}`);
                        return item;
                    }
                    logCompletion(`proxy-resolve-start label=${label}`);
                    const resolved = ensureRegisteredRuntime().completionFeature.resolveCompletionItem?.(item) || item;
                    logCompletion(`proxy-resolve-done label=${label} ms=${Date.now() - startedAt}`);
                    return resolved;
                }
            };
            trackProxyDisposable(vscode.languages.registerCompletionItemProvider(
                'amxxpawn',
                provider,
                ...COMPLETION_TRIGGER_CHARACTERS
            ));
        }
    };

    const proxyNavigationFeature = {
        register() {
            trackProxyDisposable(vscode.languages.registerDefinitionProvider('amxxpawn', {
                provideDefinition(document, position) {
                    return ensureRegisteredRuntime().navigationFeature.provideDefinition?.(document, position) || null;
                }
            }));
            if (typeof vscode.languages.registerDocumentLinkProvider === 'function') {
                trackProxyDisposable(vscode.languages.registerDocumentLinkProvider('amxxpawn', {
                    provideDocumentLinks(document, token) {
                        return ensureRegisteredRuntime().navigationFeature.provideDocumentLinks?.(document, token) || [];
                    }
                }));
            }
        }
    };

    const proxyPersistentHoverFeature = {
        register() {
            const schedule = (editor, delayMs, retryDelays) =>
                ensureRegisteredRuntime().persistentHoverFeature.schedulePersistentHover?.(editor, delayMs, retryDelays);
            trackProxyDisposable(vscode.window.onDidChangeTextEditorSelection(event => {
                if (!shouldSchedulePersistentHoverForSelectionEvent(vscode, event)) return;
                schedule(event.textEditor, 10, [120, 260]);
            }));
            trackProxyDisposable(vscode.window.onDidChangeActiveTextEditor(editor => {
                schedule(editor || null, 20, [160, 320]);
            }));
            trackProxyDisposable(vscode.workspace.onDidChangeTextDocument(event => {
                const activeEditor = vscode.window.activeTextEditor;
                if (!activeEditor || activeEditor.document !== event.document) return;
                const feature = ensureRegisteredRuntime().persistentHoverFeature;
                if (event.contentChanges?.length) {
                    feature.suspendPersistentHoverForTyping?.(activeEditor);
                } else {
                    feature.schedulePersistentHover?.(activeEditor, 30, [180, 360]);
                }
            }));
            trackProxyDisposable(vscode.workspace.onDidSaveTextDocument(doc => {
                const activeEditor = vscode.window.activeTextEditor;
                if (!activeEditor || activeEditor.document !== doc) return;
                schedule(activeEditor, 30, [180, 360]);
            }));
            trackProxyDisposable(vscode.workspace.onDidChangeConfiguration(() => {
                schedule(vscode.window.activeTextEditor || null, 30, [180, 360]);
            }));
            if (typeof vscode.window.onDidChangeTextEditorVisibleRanges === 'function') {
                trackProxyDisposable(vscode.window.onDidChangeTextEditorVisibleRanges(event => {
                    if (event.textEditor !== vscode.window.activeTextEditor) return;
                    schedule(event.textEditor, 0, [140, 320, 520]);
                }));
            }
        }
    };

    return {
        editorLifecycleFeature: proxyEditorLifecycleFeature,
        persistentHoverFeature: proxyPersistentHoverFeature,
        hoverFeature: proxyHoverFeature,
        completionFeature: proxyCompletionFeature,
        navigationFeature: proxyNavigationFeature,
        buildHoverAtPosition(document, position) {
            return ensureRegisteredRuntime().buildHoverAtPosition(document, position);
        },
        ensureRuntime,
        ensureRegisteredRuntime
    };
}

module.exports = { buildLazyActivationRuntime };
