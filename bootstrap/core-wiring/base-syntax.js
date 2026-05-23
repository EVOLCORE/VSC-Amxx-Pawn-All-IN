const { createCommentAnalysisCore } = require('../../core/syntax/comment-analysis');
const { createSyntaxCore } = require('../../core/syntax/runtime');
const { createSyntaxConstantCore } = require('../../core/syntax/constants');
const { createCtrlCharSyntaxCore } = require('../../core/syntax/ctrlchar');
const { createLookupTokenSyntaxCore } = require('../../core/syntax/token-lookup');
const { createBraceDepthSyntaxCore } = require('../../core/syntax/brace-depth');
const { createLiteralSyntaxCore } = require('../../core/syntax/literals');
const { createLabelSyntaxCore } = require('../../core/syntax/labels');
const { createStateSyntaxCore } = require('../../core/syntax/states');
const { createRationalPolicySyntaxCore } = require('../../core/syntax/rational-policy');
const { createDocumentContextUtilityCore } = require('../../core/document-context/document-utils');
const { createFileSnapshotCore } = require('../../core/document-context/file-snapshot');
const { createUtilityCore } = require('../../core/utils/runtime');
const { createPathUtilityCore } = require('../../core/utils/path');

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
        OPERATOR_SYMBOLS,
        commentAnalysisCache,
        ctrlCharStateCache,
        fileSnapshotCache,
        readNormalizedFileContent,
        getSearchPaths,
        getNestedSearchPaths,
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
        getNestedSearchPaths,
        resolveInclude,
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

    const utilityRuntime = createUtilityCore();
    const documentContextUtilityRuntime = createDocumentContextUtilityCore({
        createCtrlCharResolver: ctrlCharRuntime.createCtrlCharResolver,
        getIncludeNameFromLine: ctrlCharRuntime.getIncludeNameFromLine
    });

    const syntaxRuntime = createSyntaxCore({
        getActiveCtrlChar,
        isEscapedQuote,
        isPawnIdentifierStartChar: utilityRuntime.isPawnIdentifierStartChar,
        isPawnIdentifierContinueChar: utilityRuntime.isPawnIdentifierContinueChar,
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
    const rationalPolicyRuntime = createRationalPolicySyntaxCore();

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
        ...rationalPolicyRuntime,
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
