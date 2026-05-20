const { isIncludeDirectiveKeyword } = require('../core/syntax/includes');

function createDocumentLanguageService(deps) {
    const {
        vscode,
        isPawnDocument,
        matchesConfiguredPawnFileExtension,
        shouldDetectPawnLanguageByIncludes = () => false,
        getSearchPaths = () => [],
        resolveInclude = () => null,
        getIncludeNameFromLine = () => '',
        parsePreprocessorDirectiveLine
    } = deps;
    // Assign AMXX Pawn dynamically for configured source/include suffixes and for
    // non-Pawn files that contain a resolved Pawn include directive.
    const hasResolvedPawnIncludeDirective = document => {
        if (!document?.fileName || typeof document.lineAt !== 'function') return false;
        if (shouldDetectPawnLanguageByIncludes() !== true) return false;
        const lineCount = Number.isInteger(document.lineCount) ? document.lineCount : 0;
        if (lineCount <= 0) return false;
        let searchPaths = null;
        const getResolvedSearchPaths = () => {
            if (searchPaths) return searchPaths;
            searchPaths = getSearchPaths(document.fileName) || [];
            return searchPaths;
        };
        for (let lineNumber = 0; lineNumber < lineCount; lineNumber++) {
            const lineText = String(document.lineAt(lineNumber)?.text || '');
            const directive = parsePreprocessorDirectiveLine(lineText);
            if (!isIncludeDirectiveKeyword(directive?.keyword)) continue;
            const includeName = getIncludeNameFromLine(directive.trimmed);
            if (!includeName) continue;
            if (resolveInclude(includeName, getResolvedSearchPaths(), document.fileName)) {
                return true;
            }
        }
        return false;
    };

    const ensureConfiguredPawnLanguage = async document => {
        if (!document?.fileName) return null;
        if (isPawnDocument(document)) return document;
        if (
            !matchesConfiguredPawnFileExtension(document.fileName) &&
            !hasResolvedPawnIncludeDirective(document)
        ) {
            return null;
        }
        try {
            return await vscode.languages.setTextDocumentLanguage(document, 'amxxpawn');
        } catch {
            return null;
        }
    };

    return {
        ensureConfiguredPawnLanguage
    };
}

module.exports = { createDocumentLanguageService };
