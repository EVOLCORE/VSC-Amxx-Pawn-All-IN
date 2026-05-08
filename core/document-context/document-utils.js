function createDocumentContextUtilityCore(deps) {
    const {
        createCtrlCharResolver,
        getIncludeNameFromLine
    } = deps;

    const isPawnDocument = document =>
        !!document &&
        document.languageId === 'amxxpawn' &&
        !!document.fileName;

    const getDocumentTextAndResolver = document => {
        const text = document.getText();
        return {
            text,
            resolver: createCtrlCharResolver(text, document.uri.fsPath)
        };
    };

    return {
        isPawnDocument,
        getDocumentTextAndResolver,
        getIncludeNameFromLine
    };
}

module.exports = { createDocumentContextUtilityCore };
