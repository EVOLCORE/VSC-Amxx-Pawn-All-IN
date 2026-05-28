const fs = require('fs');
const path = require('path');
const { createIncludeDocumentMatcher } = require('../../core/include-documents');
const { buildPawnDocInsertionPlan } = require('../../core/pawndoc/generator');

const PAWNDOC_COMMAND_ID = 'amxxPawnAllIn.generatePawnDoc';
const PAWNDOC_ACTIVE_INCLUDE_CONTEXT = 'amxxPawnAllIn.activeIncludeFile';

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

    async function generatePawnDocForEditor(editor = vscode.window.activeTextEditor) {
        const document = editor?.document || null;
        if (!isPawnDocIncludeDocument(document)) {
            vscode.window.showInformationMessage(t('pawndoc.invalidDocument'));
            return null;
        }
        if (document.uri?.scheme !== 'file') {
            vscode.window.showErrorMessage(t('pawndoc.fileDocumentRequired'));
            return null;
        }

        const ctx = getPawnDocumentContext(document, undefined, {
            includeDecls: false,
            cursorCache: false,
            ephemeral: true
        });
        const declarations = ctx?.parsedDecls?.functions || [];
        const text = document.getText();
        const plan = buildPawnDocInsertionPlan(text, declarations, {
            splitTopLevel,
            parseFuncArgs,
            escapeChar: typeof getActiveCtrlChar === 'function' ? getActiveCtrlChar() : undefined
        });

        if (!plan.insertions.length) {
            vscode.window.showInformationMessage(t('pawndoc.noDeclarations'));
            return { changed: false, count: 0, backupPath: '' };
        }

        const backupPath = createBackupFilePath(document.uri.fsPath);
        try {
            fs.writeFileSync(backupPath, text, 'utf8');
        } catch (error) {
            vscode.window.showErrorMessage(t('pawndoc.backupFailed', { message: error?.message || String(error) }));
            return null;
        }

        const edit = new vscode.WorkspaceEdit();
        for (const insertion of plan.insertions) {
            edit.insert(document.uri, new vscode.Position(insertion.line, 0), insertion.text);
        }

        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
            vscode.window.showErrorMessage(t('pawndoc.editFailed'));
            return null;
        }

        vscode.window.showInformationMessage(t('pawndoc.generated', {
            count: plan.insertions.length,
            backupFile: path.basename(backupPath)
        }));
        return {
            changed: true,
            count: plan.insertions.length,
            backupPath
        };
    }

    function register(context) {
        updateActiveIncludeContext();

        context.subscriptions.push(
            vscode.commands.registerCommand(PAWNDOC_COMMAND_ID, () => generatePawnDocForEditor())
        );
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
        isPawnDocIncludeDocument,
        updateActiveIncludeContext
    };
}

module.exports = {
    PAWNDOC_ACTIVE_INCLUDE_CONTEXT,
    PAWNDOC_COMMAND_ID,
    createPawnDocFeature
};
