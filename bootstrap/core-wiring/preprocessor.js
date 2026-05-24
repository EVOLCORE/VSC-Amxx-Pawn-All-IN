const { createPreprocessorSyntaxCore } = require('../../core/syntax/preprocessor');
const { maskPreprocessorLine } = require('../../core/syntax/preprocessor-mask');

function createPreprocessorRuntime(deps) {
    const {
        normalizeFsPath,
        getDefineStateKey,
        getSearchPaths,
        getNestedSearchPaths,
        resolveInclude,
        getIncludeNameFromLine,
        collectDeclarationText,
        stripLineComment,
        splitTopLevel,
        readNormalizedFileContent,
        getCachedCommentAnalysis,
        setCachedCommentAnalysis,
        buildCommentAnalysis,
        getCtrlCharStateForContent,
        evaluatePawnNumericExpr,
        readCachedIncludePreprocessedState,
        writeCachedIncludePreprocessedState
    } = deps;

    let preprocessPawnContent = null;
    const runtime = createPreprocessorSyntaxCore({
        evaluatePawnNumericExpr,
        normalizeFsPath,
        getDefineStateKey,
        getSearchPaths,
        getNestedSearchPaths,
        resolveInclude,
        getIncludeNameFromLine,
        collectDeclarationText,
        maskPreprocessorLine,
        stripLineComment,
        splitTopLevel,
        preprocessPawnContentRef: () => preprocessPawnContent,
        readNormalizedFileContent,
        getCachedCommentAnalysis,
        setCachedCommentAnalysis,
        buildCommentAnalysis,
        getCtrlCharStateForContent,
        readCachedIncludePreprocessedState,
        writeCachedIncludePreprocessedState
    });
    preprocessPawnContent = runtime.preprocessPawnContent;
    return runtime;
}

module.exports = { createPreprocessorRuntime };
