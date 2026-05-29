const {
    couldCompleteManualFunctionBodyAfterEnter,
    getManualFunctionBodyInsertionPlan
} = require('../../core/completion/manual-function-body');

function createManualFunctionBodyFeature(deps) {
    const {
        vscode,
        getPawnDocumentContext,
        getManualFunctionBodyStyle
    } = deps;

    let applying = false;
    let pendingTimer = null;

    function readPlainEnterPosition(change) {
        const text = String(change?.text || '');
        const match = text.match(/^(?:\r\n|\n|\r)([ \t]*)$/);
        if (!match) return null;
        const range = change?.range;
        if (!range?.start || !range?.end) return null;
        if (range.start.line !== range.end.line || range.start.character !== range.end.character) return null;
        return new vscode.Position(range.start.line + 1, match[1].length);
    }

    function readEnterPositionFromEvent(event) {
        const changes = Array.isArray(event?.contentChanges) ? event.contentChanges : [];
        if (changes.length !== 1) return null;
        return readPlainEnterPosition(changes[0]);
    }

    function buildRange(edit) {
        return new vscode.Range(
            new vscode.Position(edit.line, edit.startCharacter),
            new vscode.Position(edit.line, edit.endCharacter)
        );
    }

    async function applyInsertionPlan(editor, plan) {
        applying = true;
        try {
            if (plan.headerEdit) {
                await editor.edit(builder => {
                    builder.replace(buildRange(plan.headerEdit), plan.headerEdit.text);
                }, { undoStopBefore: false, undoStopAfter: false });
            }
            await editor.insertSnippet(
                new vscode.SnippetString(plan.bodyEdit.snippetText),
                buildRange(plan.bodyEdit),
                { undoStopBefore: false, undoStopAfter: true }
            );
        } finally {
            applying = false;
        }
    }

    async function tryApply(document, position, expectedVersion = null) {
        if (applying || !document || !position) return false;
        if (expectedVersion != null && document.version !== expectedVersion) return false;
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document !== document || typeof editor.insertSnippet !== 'function') return false;

        const style = typeof getManualFunctionBodyStyle === 'function'
            ? getManualFunctionBodyStyle()
            : 'same-line';
        if (String(style || '').trim().toLowerCase() === 'disabled') return false;
        if (!couldCompleteManualFunctionBodyAfterEnter(document, position)) return false;

        const ctx = getPawnDocumentContext(document, position.line, {
            includeDecls: false,
            cursorCache: false,
            ephemeral: true
        });
        const plan = getManualFunctionBodyInsertionPlan(document, position, ctx, { braceStyle: style });
        if (!plan) return false;
        await applyInsertionPlan(editor, plan);
        return true;
    }

    function handleDidChangeTextDocument(event) {
        if (applying) return;
        const position = readEnterPositionFromEvent(event);
        if (!position) return;
        const document = event.document;
        const expectedVersion = document?.version ?? null;
        if (pendingTimer) {
            clearTimeout(pendingTimer);
            pendingTimer = null;
        }
        pendingTimer = setTimeout(() => {
            pendingTimer = null;
            tryApply(document, position, expectedVersion).catch(() => {});
        }, 0);
        if (typeof pendingTimer.unref === 'function') pendingTimer.unref();
    }

    function register(context) {
        if (typeof vscode.workspace.onDidChangeTextDocument !== 'function') return null;
        const disposable = vscode.workspace.onDidChangeTextDocument(handleDidChangeTextDocument);
        context?.subscriptions?.push?.(disposable);
        return disposable;
    }

    function dispose() {
        if (pendingTimer) {
            clearTimeout(pendingTimer);
            pendingTimer = null;
        }
    }

    return {
        register,
        dispose,
        handleDidChangeTextDocument,
        tryApply
    };
}

module.exports = { createManualFunctionBodyFeature };
