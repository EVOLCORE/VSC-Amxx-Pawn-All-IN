function shouldSchedulePersistentHoverForSelectionEvent(vscode, event) {
    const selectionKind = vscode?.TextEditorSelectionChangeKind || null;
    if (!selectionKind || selectionKind.Mouse == null) {
        return true;
    }
    return event?.kind === selectionKind.Mouse;
}

module.exports = { shouldSchedulePersistentHoverForSelectionEvent };
