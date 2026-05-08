const {
    createCommentAnalysisCore,
    createSyntaxCore,
    createSyntaxConstantCore,
    createCtrlCharSyntaxCore,
    createLookupTokenSyntaxCore,
    createBraceDepthSyntaxCore,
    createLiteralSyntaxCore,
    createLabelSyntaxCore,
    createStateSyntaxCore
} = require('../../core/syntax/index');
const {
    createDocumentContextUtilityCore,
    createFileSnapshotCore
} = require('../../core/document-context/index');
const { createUtilityCore, createPathUtilityCore } = require('../../core/utils/index');

function createCoreSyntaxPrelude({ t }) {
    return {
        ...createSyntaxConstantCore(t),
        ...createPathUtilityCore()
    };
}

function createBaseSyntaxRuntime(deps) {
    const {
        vscode,
        normalizeFsPath,
        INCLUDE_LINE_RE,
        OPERATOR_SYMBOLS,
        commentAnalysisCache,
        ctrlCharStateCache,
        fileSnapshotCache,
        readNormalizedFileContent,
        getSearchPaths,
        resolveInclude
    } = deps;

    let getActiveCtrlChar = null;
    let isEscapedQuote = null;

    const {
        buildCommentAnalysis,
        getCommentAnalysisForLines,
        getCommentDocsForLine,
        getCachedCommentAnalysis,
        setCachedCommentAnalysis
    } = createCommentAnalysisCore({
        getActiveCtrlChar: (...args) => getActiveCtrlChar(...args),
        isEscapedQuote: (...args) => isEscapedQuote(...args),
        commentAnalysisCache
    });

    const ctrlCharRuntime = createCtrlCharSyntaxCore({
        normalizeFsPath,
        getSearchPaths,
        resolveInclude,
        INCLUDE_LINE_RE,
        ctrlCharStateCache,
        getCachedCommentAnalysis,
        setCachedCommentAnalysis,
        buildCommentAnalysis,
        readNormalizedFileContent
    });
    ({
        getActiveCtrlChar,
        isEscapedQuote
    } = ctrlCharRuntime);

    const documentContextUtilityRuntime = createDocumentContextUtilityCore({
        createCtrlCharResolver: ctrlCharRuntime.createCtrlCharResolver,
        getIncludeNameFromLine: ctrlCharRuntime.getIncludeNameFromLine
    });

    const syntaxRuntime = createSyntaxCore({
        getActiveCtrlChar,
        isEscapedQuote,
        getCommentAnalysisForLines,
        getCommentDocsForLine
    });
    const lookupTokenRuntime = createLookupTokenSyntaxCore({
        vscode,
        getActiveCtrlChar,
        isEscapedQuote,
        DEFAULT_CTRL_CHAR: ctrlCharRuntime.DEFAULT_CTRL_CHAR,
        OPERATOR_SYMBOLS
    });
    const braceDepthRuntime = createBraceDepthSyntaxCore({
        getActiveCtrlChar,
        isEscapedQuote
    });
    const fileSnapshotRuntime = createFileSnapshotCore({
        normalizeFsPath,
        fileSnapshotCache,
        getCtrlCharStateForContent: ctrlCharRuntime.getCtrlCharStateForContent,
        computeLineDepths: braceDepthRuntime.computeLineDepths
    });
    const literalRuntime = createLiteralSyntaxCore({
        getActiveCtrlChar,
        isEscapedQuote
    });
    const labelRuntime = createLabelSyntaxCore();
    const stateRuntime = createStateSyntaxCore();
    const utilityRuntime = createUtilityCore();

    return {
        ...ctrlCharRuntime,
        ...documentContextUtilityRuntime,
        ...syntaxRuntime,
        ...lookupTokenRuntime,
        ...braceDepthRuntime,
        ...fileSnapshotRuntime,
        ...literalRuntime,
        ...labelRuntime,
        ...stateRuntime,
        ...utilityRuntime,
        buildCommentAnalysis,
        getCommentAnalysisForLines,
        getCommentDocsForLine,
        getCachedCommentAnalysis,
        setCachedCommentAnalysis
    };
}

module.exports = {
    createCoreSyntaxPrelude,
    createBaseSyntaxRuntime
};
