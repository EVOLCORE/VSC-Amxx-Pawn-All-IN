const { isIncludeDirectiveKeyword } = require('../core/syntax/includes');
const {
    createPawnLanguageProbeScanState,
    isPawnLanguageDetectionEligibleDocument,
    readPawnLanguageProbeLine
} = require('../core/language-detection/pawn-probe');

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
    // non-Pawn files that look like real Pawn sources. A resolved include alone is
    // too broad because Markdown/C/C++ snippets commonly contain #include lines.
    const hasConfidentPawnIncludeDetection = document => {
        if (!document?.fileName || typeof document.lineAt !== 'function') return false;
        if (shouldDetectPawnLanguageByIncludes() !== true) return false;
        if (!isPawnLanguageDetectionEligibleDocument(document)) return false;
        const lineCount = Number.isInteger(document.lineCount) ? document.lineCount : 0;
        if (lineCount <= 0) return false;
        let searchPaths = null;
        let resolvedPawnInclude = false;
        let syntaxSignal = false;
        const scanState = createPawnLanguageProbeScanState();
        const getResolvedSearchPaths = () => {
            if (searchPaths) return searchPaths;
            searchPaths = getSearchPaths(document.fileName) || [];
            return searchPaths;
        };
        for (let lineNumber = 0; lineNumber < lineCount; lineNumber++) {
            const lineText = String(document.lineAt(lineNumber)?.text || '');
            const probe = readPawnLanguageProbeLine(lineText, scanState);
            syntaxSignal = syntaxSignal || probe.syntaxSignal;
            if (!probe.includeCandidate) {
                if (resolvedPawnInclude && syntaxSignal) return true;
                continue;
            }
            const directive = parsePreprocessorDirectiveLine(lineText);
            if (!isIncludeDirectiveKeyword(directive?.keyword)) continue;
            const includeName = getIncludeNameFromLine(directive.trimmed);
            if (!includeName) continue;
            if (resolveInclude(includeName, getResolvedSearchPaths(), document.fileName)) {
                resolvedPawnInclude = true;
                if (syntaxSignal) return true;
            }
        }
        return false;
    };

    const ensureConfiguredPawnLanguage = async document => {
        if (!document?.fileName) return null;
        if (isPawnDocument(document)) return document;
        if (
            !matchesConfiguredPawnFileExtension(document.fileName) &&
            !hasConfidentPawnIncludeDetection(document)
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
