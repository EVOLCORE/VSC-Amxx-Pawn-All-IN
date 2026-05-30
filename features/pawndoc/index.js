const fs = require('fs');
const path = require('path');
const { createIncludeDocumentMatcher } = require('../../core/include-documents');
const {
    showTimedErrorMessage,
    showTimedInformationMessage
} = require('../../services/notifications');
const {
    buildPawnDocInsertionPlan,
    buildPawnDocSingleInsertionPlan
} = require('../../core/pawndoc/generator');
const {
    PAWNDOC_ACTIVE_INCLUDE_CONTEXT,
    PAWNDOC_COMMAND_ID,
    PAWNDOC_SELECTION_COMMAND_ID
} = require('./constants');

function createPawnDocFeature(deps) {
    const {
        vscode,
        t,
        getIncludeFileExtensions,
        getPawnDocumentContext,
        splitTopLevel,
        parseFuncArgs,
        getActiveCtrlChar
    } = deps;

    const includeDocumentMatcher = createIncludeDocumentMatcher(getIncludeFileExtensions);
    let activeIncludeContextValue = null;

    function isPawnDocIncludeDocument(document) {
        return !!document &&
            document.languageId === 'amxxpawn' &&
            includeDocumentMatcher.isIncludeDocument(document);
    }

    function isPawnDocDocument(document) {
        return !!document && document.languageId === 'amxxpawn';
    }

    function updateActiveIncludeContext(editor = vscode.window.activeTextEditor) {
        const nextValue = isPawnDocIncludeDocument(editor?.document || null);
        if (nextValue === activeIncludeContextValue) return;
        activeIncludeContextValue = nextValue;
        vscode.commands.executeCommand('setContext', PAWNDOC_ACTIVE_INCLUDE_CONTEXT, nextValue).then(
            undefined,
            () => {}
        );
    }

    function createBackupFilePath(filePath) {
        const dir = path.dirname(filePath);
        const base = path.basename(filePath);
        const stamp = new Date()
            .toISOString()
            .replace(/[-:]/g, '')
            .replace(/\..+$/, '')
            .replace('T', '-');
        let candidate = path.join(dir, `${base}.pawndoc-${stamp}.bak`);
        let index = 1;
        while (fs.existsSync(candidate)) {
            candidate = path.join(dir, `${base}.pawndoc-${stamp}.${index}.bak`);
            index++;
        }
        return candidate;
    }

    async function askShouldCreateBackup() {
        const yes = t('pawndoc.backupPrompt.yes');
        const no = t('pawndoc.backupPrompt.no');
        const cancel = t('pawndoc.backupPrompt.cancel');
        const choice = await showTimedInformationMessage(vscode,
            t('pawndoc.backupPrompt.message'),
            { modal: true },
            yes,
            no,
            cancel
        );
        if (choice === yes) return true;
        if (choice === no) return false;
        return null;
    }

    async function applyPawnDocPlan(document, plan, options = {}) {
        if (!plan?.insertions?.length) {
            showTimedInformationMessage(vscode, t(options.emptyMessageKey || 'pawndoc.noDeclarations'));
            return { changed: false, count: 0, backupPath: '' };
        }

        const shouldCreateBackup = await askShouldCreateBackup();
        if (shouldCreateBackup === null) {
            return { changed: false, count: 0, backupPath: '' };
        }

        let backupPath = '';
        if (shouldCreateBackup && document.uri?.scheme !== 'file') {
            showTimedErrorMessage(vscode, t('pawndoc.fileDocumentRequired'));
            return null;
        }
        if (shouldCreateBackup) {
            backupPath = createBackupFilePath(document.uri.fsPath);
            try {
                fs.writeFileSync(backupPath, document.getText(), 'utf8');
            } catch (error) {
                showTimedErrorMessage(vscode, t('pawndoc.backupFailed', { message: error?.message || String(error) }));
                return null;
            }
        }

        const edit = new vscode.WorkspaceEdit();
        for (const insertion of plan.insertions) {
            edit.insert(document.uri, new vscode.Position(insertion.line, 0), insertion.text);
        }

        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
            showTimedErrorMessage(vscode, t('pawndoc.editFailed'));
            return null;
        }

        const messageKey = backupPath ? 'pawndoc.generated' : 'pawndoc.generatedNoBackup';
        showTimedInformationMessage(vscode, t(messageKey, {
            count: plan.insertions.length,
            backupFile: backupPath ? path.basename(backupPath) : ''
        }));
        return {
            changed: true,
            count: plan.insertions.length,
            backupPath
        };
    }

    function buildPawnDocContext(document) {
        const ctx = getPawnDocumentContext(document, undefined, {
            includeDecls: false,
            cursorCache: false,
            ephemeral: true
        });
        return ctx?.parsedDecls?.functions || [];
    }

    async function generatePawnDocForEditor(editor = vscode.window.activeTextEditor) {
        const document = editor?.document || null;
        if (!isPawnDocIncludeDocument(document)) {
            showTimedInformationMessage(vscode, t('pawndoc.invalidDocument'));
            return null;
        }
        if (document.uri?.scheme !== 'file') {
            showTimedErrorMessage(vscode, t('pawndoc.fileDocumentRequired'));
            return null;
        }

        const declarations = buildPawnDocContext(document);
        const text = document.getText();
        const plan = buildPawnDocInsertionPlan(text, declarations, {
            splitTopLevel,
            parseFuncArgs,
            escapeChar: typeof getActiveCtrlChar === 'function' ? getActiveCtrlChar() : undefined
        });
        return applyPawnDocPlan(document, plan, {
            emptyMessageKey: 'pawndoc.noDeclarations'
        });
    }

    function serializeRange(range) {
        return {
            start: {
                line: Number.isInteger(range?.start?.line) ? range.start.line : 0,
                character: Number.isInteger(range?.start?.character) ? range.start.character : 0
            },
            end: {
                line: Number.isInteger(range?.end?.line) ? range.end.line : Number.isInteger(range?.start?.line) ? range.start.line : 0,
                character: Number.isInteger(range?.end?.character) ? range.end.character : Number.isInteger(range?.start?.character) ? range.start.character : 0
            }
        };
    }

    function getEditorForPawnDocTarget(target = null) {
        const targetUri = target?.uri ? String(target.uri) : '';
        const activeEditor = vscode.window.activeTextEditor || null;
        if (!targetUri) return activeEditor;
        const sameUri = editor => String(editor?.document?.uri?.toString?.() || '') === targetUri;
        if (sameUri(activeEditor)) return activeEditor;
        return (vscode.window.visibleTextEditors || []).find(sameUri) || null;
    }

    function getSelectionLines(editor, target = null) {
        const rawRange = target?.range || editor?.selection || null;
        const range = serializeRange(rawRange);
        return {
            startLine: Math.min(range.start.line, range.end.line),
            endLine: Math.max(range.start.line, range.end.line)
        };
    }

    async function generatePawnDocAtSelection(target = null) {
        const editor = getEditorForPawnDocTarget(target);
        const document = editor?.document || null;
        if (!isPawnDocDocument(document)) {
            showTimedInformationMessage(vscode, t('pawndoc.invalidPawnDocument'));
            return null;
        }

        const declarations = buildPawnDocContext(document);
        const text = document.getText();
        const plan = buildPawnDocSingleInsertionPlan(text, declarations, getSelectionLines(editor, target), {
            splitTopLevel,
            parseFuncArgs,
            escapeChar: typeof getActiveCtrlChar === 'function' ? getActiveCtrlChar() : undefined
        });
        return applyPawnDocPlan(document, plan, {
            emptyMessageKey: 'pawndoc.noTarget'
        });
    }

    function canOfferPawnDocCodeAction(document, range) {
        if (!isPawnDocDocument(document)) return false;
        const startLine = Math.max(0, Number(range?.start?.line) || 0);
        const endLine = Math.max(startLine, Math.min(document.lineCount - 1, Number(range?.end?.line) || startLine));
        for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
            if (String(document.lineAt(lineNumber)?.text || '').trim()) return true;
        }
        return false;
    }

    function createPawnDocCodeAction(document, range) {
        const title = t('pawndoc.codeAction.generateHere');
        const kind = vscode.CodeActionKind?.RefactorRewrite ||
            vscode.CodeActionKind?.Refactor ||
            vscode.CodeActionKind?.QuickFix;
        const action = typeof vscode.CodeAction === 'function'
            ? new vscode.CodeAction(title, kind)
            : { title, kind };
        action.command = {
            command: PAWNDOC_SELECTION_COMMAND_ID,
            title,
            arguments: [{
                uri: String(document.uri?.toString?.() || ''),
                range: serializeRange(range)
            }]
        };
        return action;
    }

    function provideCodeActions(document, range) {
        if (!canOfferPawnDocCodeAction(document, range)) return [];
        return [createPawnDocCodeAction(document, range)];
    }

    function registerCodeActions(context) {
        if (typeof vscode.languages?.registerCodeActionsProvider !== 'function') return null;
        const kind = vscode.CodeActionKind?.RefactorRewrite ||
            vscode.CodeActionKind?.Refactor ||
            vscode.CodeActionKind?.QuickFix;
        const provider = vscode.languages.registerCodeActionsProvider(
            'amxxpawn',
            { provideCodeActions },
            kind ? { providedCodeActionKinds: [kind] } : undefined
        );
        context.subscriptions.push(provider);
        return provider;
    }

    function registerCommands(context) {
        context.subscriptions.push(
            vscode.commands.registerCommand(PAWNDOC_COMMAND_ID, () => generatePawnDocForEditor())
        );
        context.subscriptions.push(
            vscode.commands.registerCommand(PAWNDOC_SELECTION_COMMAND_ID, target => generatePawnDocAtSelection(target))
        );
    }

    function register(context) {
        updateActiveIncludeContext();

        registerCommands(context);
        registerCodeActions(context);
        context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(editor => updateActiveIncludeContext(editor))
        );
        context.subscriptions.push(
            vscode.workspace.onDidOpenTextDocument(() => updateActiveIncludeContext())
        );
        context.subscriptions.push(
            vscode.workspace.onDidCloseTextDocument(() => updateActiveIncludeContext())
        );
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(() => updateActiveIncludeContext())
        );
    }

    return {
        register,
        generatePawnDocForEditor,
        generatePawnDocAtSelection,
        isPawnDocDocument,
        isPawnDocIncludeDocument,
        provideCodeActions,
        updateActiveIncludeContext
    };
}

module.exports = {
    PAWNDOC_ACTIVE_INCLUDE_CONTEXT,
    PAWNDOC_COMMAND_ID,
    PAWNDOC_SELECTION_COMMAND_ID,
    createPawnDocFeature
};
