const { computeFunctionRangeMaps: defaultComputeFunctionRangeMaps } = require('../../core/declarations/scope');
const { isHoverModifierHackMode } = require('../../core/hover-modes');
const { shouldSchedulePersistentHoverForSelectionEvent } = require('../../core/persistent-hover/selection-events');
const { unrefTimer } = require('../../core/utils/timers');

// Persistent hover is a feature-level lifecycle wrapper around the built-in VS Code
// hover widget. It is separate from hover content generation because it manages
// timers, typing suspension, focus restoration, and editor event orchestration.
function createPersistentHoverFeature(deps) {
    const {
        vscode,
        isPawnDocument,
        getPawnDocumentContext,
        resolvePersistentHoverTarget,
        getPersistentHoverMode,
        isPersistentHoverEnabled,
        getHoverMode,
        affectsAnyConfiguration,
        PERSISTENT_HOVER_RELEVANT_CONFIG_KEYS,
        computeFunctionRangeMaps = defaultComputeFunctionRangeMaps
    } = deps;

    const functionRangeByLineByParsedDecls = new WeakMap();
    let persistentHoverShowTimer = null;
    let persistentHoverScrollTimer = null;
    let persistentHoverRetryTimers = [];
    let persistentHoverTypingSuspendUntil = 0;
    let persistentHoverTypingResumeTimer = null;

    function clearPersistentHoverTimers() {
        if (persistentHoverShowTimer) {
            clearTimeout(persistentHoverShowTimer);
            persistentHoverShowTimer = null;
        }
        if (persistentHoverScrollTimer) {
            clearTimeout(persistentHoverScrollTimer);
            persistentHoverScrollTimer = null;
        }
        for (const timer of persistentHoverRetryTimers) {
            clearTimeout(timer);
        }
        persistentHoverRetryTimers = [];
    }

    function clearPersistentHoverTypingResumeTimer() {
        if (persistentHoverTypingResumeTimer) {
            clearTimeout(persistentHoverTypingResumeTimer);
            persistentHoverTypingResumeTimer = null;
        }
    }

    function closePersistentHover() {
        vscode.commands.executeCommand('editor.action.closeHover').then(
            undefined,
            () => {}
        );
    }

    function isPersistentHoverSuppressedByHoverMode() {
        if (typeof getHoverMode !== 'function') return false;
        return isHoverModifierHackMode(getHoverMode());
    }

    function getEffectivePersistentHoverMode() {
        if (typeof getPersistentHoverMode === 'function') {
            return getPersistentHoverMode();
        }
        return isPersistentHoverEnabled() ? 'normal' : 'disabled';
    }

    function getFunctionRangeAtLine(ctx, lineNumber) {
        const parsedDecls = ctx?.parsedDecls || null;
        if (!parsedDecls) return null;

        let rangeByLine = functionRangeByLineByParsedDecls.get(parsedDecls);
        if (!rangeByLine) {
            const depths = parsedDecls.depths || [];
            const lineCount = Math.max(
                Array.isArray(ctx?.rawLines) ? ctx.rawLines.length : 0,
                depths.length,
                lineNumber + 1
            );
            rangeByLine = computeFunctionRangeMaps(
                parsedDecls.functions || [],
                depths,
                lineCount,
                { includeHeader: true }
            ).byLine;
            functionRangeByLineByParsedDecls.set(parsedDecls, rangeByLine);
        }

        return rangeByLine[lineNumber] || null;
    }

    function hasPersistentHoverErrorContext(state) {
        const diagnostics = vscode.languages.getDiagnostics(state.document.uri) || [];
        const errorDiagnostics = diagnostics.filter(item => item?.severity === vscode.DiagnosticSeverity.Error);
        if (!errorDiagnostics.length) return false;

        const lineNumber = state.position.line;
        if (errorDiagnostics.some(item =>
            item.range.start.line <= lineNumber &&
            item.range.end.line >= lineNumber
        )) {
            return true;
        }

        const functionRange = getFunctionRangeAtLine(state.ctx, lineNumber);
        if (!functionRange) return false;

        return errorDiagnostics.some(item =>
            item.range.end.line >= functionRange.startLine &&
            item.range.start.line <= functionRange.endLine
        );
    }

    function isPersistentHoverTypingSuspended() {
        return Date.now() < persistentHoverTypingSuspendUntil;
    }

    function isPersistentHoverStateStillCurrent(state) {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor || activeEditor !== state?.editor) return false;
        if (activeEditor.document !== state.document) return false;
        if (!activeEditor.selection.isEmpty) return false;
        return activeEditor.selection.active.isEqual(state.position);
    }

    function showPersistentHover(state) {
        if (!isPersistentHoverEnabled()) return;
        if (isPersistentHoverSuppressedByHoverMode()) return;
        if (isPersistentHoverTypingSuspended()) return;
        if (!isPersistentHoverStateStillCurrent(state)) return;
        if (state.hoverCommandSucceeded) return;
        vscode.commands.executeCommand('editor.action.showHover').then(() => {
            state.hoverCommandSucceeded = true;
            if (!isPersistentHoverStateStillCurrent(state)) return;
            unrefTimer(setTimeout(() => {
                if (!isPersistentHoverStateStillCurrent(state)) return;
                vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup').then(
                    undefined,
                    () => {}
                );
            }, 0));
        });
    }

    function getPersistentHoverState(editor) {
        if (!isPersistentHoverEnabled()) return null;
        if (isPersistentHoverSuppressedByHoverMode()) return null;
        if (isPersistentHoverTypingSuspended()) return null;
        if (editor !== vscode.window.activeTextEditor) return null;
        if (!editor || !isPawnDocument(editor.document) || !editor.selection.isEmpty) return null;

        const position = editor.selection.active;
        const ctx = getPawnDocumentContext(editor.document, position.line);
        if (!ctx) return null;

        const { parsedDecls, incDecls, lookup } = ctx;
        const { functions, depths } = parsedDecls;
        const cursorDepth = position.line < depths.length ? depths[position.line] : 0;
        const persistentTarget = resolvePersistentHoverTarget(
            editor.document,
            position,
            functions,
            incDecls,
            cursorDepth,
            lookup
        );
        if (!persistentTarget) return null;

        const state = {
            editor,
            document: editor.document,
            position,
            ctx,
            persistentTarget,
            hoverCommandSucceeded: false
        };

        if (getEffectivePersistentHoverMode() === 'error-context' && !hasPersistentHoverErrorContext(state)) {
            return null;
        }

        return state;
    }

    function schedulePersistentHover(editor, delayMs = 0, retryDelays = []) {
        clearPersistentHoverTimers();
        if (!isPersistentHoverEnabled()) return;
        if (isPersistentHoverSuppressedByHoverMode()) return;
        if (isPersistentHoverTypingSuspended()) return;

        persistentHoverShowTimer = unrefTimer(setTimeout(() => {
            persistentHoverShowTimer = null;
            const state = getPersistentHoverState(editor);
            if (!state) return;
            showPersistentHover(state);
            persistentHoverRetryTimers = retryDelays.map(retryDelay =>
                unrefTimer(setTimeout(() => {
                    if (state.hoverCommandSucceeded) return;
                    if (!isPersistentHoverStateStillCurrent(state)) return;
                    showPersistentHover(state);
                }, retryDelay))
            );
        }, delayMs));
    }

    function suspendPersistentHoverForTyping(editor, durationMs = 350) {
        persistentHoverTypingSuspendUntil = Date.now() + durationMs;
        clearPersistentHoverTimers();
        clearPersistentHoverTypingResumeTimer();
        closePersistentHover();
        persistentHoverTypingResumeTimer = unrefTimer(setTimeout(() => {
            persistentHoverTypingResumeTimer = null;
            persistentHoverTypingSuspendUntil = 0;
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor || activeEditor !== editor) return;
            if (!isPawnDocument(activeEditor.document) || !activeEditor.selection.isEmpty) return;
            schedulePersistentHover(activeEditor, 0, [140, 300]);
        }, durationMs + 10));
    }

    function register(context) {
        context.subscriptions.push(
            vscode.window.onDidChangeTextEditorSelection(event => {
                if (event.textEditor !== vscode.window.activeTextEditor) return;
                if (!shouldSchedulePersistentHoverForSelectionEvent(vscode, event)) {
                    clearPersistentHoverTimers();
                    closePersistentHover();
                    return;
                }
                schedulePersistentHover(event.textEditor, 10, [120, 260]);
            }),
            vscode.window.onDidChangeActiveTextEditor(editor => {
                schedulePersistentHover(editor || null, 20, [160, 320]);
            }),
            vscode.workspace.onDidChangeTextDocument(event => {
                const activeEditor = vscode.window.activeTextEditor;
                if (!activeEditor || activeEditor.document !== event.document) return;
                if (event.contentChanges?.length) {
                    suspendPersistentHoverForTyping(activeEditor);
                    return;
                }
                schedulePersistentHover(activeEditor, 30, [180, 360]);
            }),
            vscode.workspace.onDidSaveTextDocument(doc => {
                const activeEditor = vscode.window.activeTextEditor;
                if (!activeEditor || activeEditor.document !== doc) return;
                schedulePersistentHover(activeEditor, 30, [180, 360]);
            }),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (affectsAnyConfiguration(event, PERSISTENT_HOVER_RELEVANT_CONFIG_KEYS)) {
                    if (isPersistentHoverSuppressedByHoverMode()) {
                        clearPersistentHoverTimers();
                        closePersistentHover();
                        return;
                    }
                    schedulePersistentHover(vscode.window.activeTextEditor || null, 30, [180, 360]);
                }
            }),
            vscode.window.onDidChangeTextEditorVisibleRanges(event => {
                if (event.textEditor !== vscode.window.activeTextEditor) return;
                if (persistentHoverScrollTimer) clearTimeout(persistentHoverScrollTimer);
                persistentHoverScrollTimer = unrefTimer(setTimeout(() => {
                    persistentHoverScrollTimer = null;
                    schedulePersistentHover(event.textEditor, 0, [140, 320, 520]);
                }, 90));
            })
        );

        context.subscriptions.push({
            dispose() {
                clearPersistentHoverTimers();
                clearPersistentHoverTypingResumeTimer();
            }
        });

        if (!isPersistentHoverSuppressedByHoverMode()) {
            schedulePersistentHover(vscode.window.activeTextEditor || null, 20, [160, 320]);
        }
    }

    return {
        register,
        schedulePersistentHover,
        suspendPersistentHoverForTyping,
        clearPersistentHoverTimers
    };
}

module.exports = { createPersistentHoverFeature };
