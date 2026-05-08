const { createPreprocessorSyntaxCore } = require('../../core/syntax/index');

function createPreprocessorRuntime(deps) {
    const {
        cloneDefineDecls,
        normalizeFsPath,
        getDefineStateKey,
        getSearchPaths,
        resolveInclude,
        getIncludeNameFromLine,
        collectDeclarationText,
        stripLineComment,
        readNormalizedFileContent,
        getCachedCommentAnalysis,
        setCachedCommentAnalysis,
        buildCommentAnalysis,
        evaluatePawnNumericExpr,
        readCachedIncludePreprocessedState,
        writeCachedIncludePreprocessedState
    } = deps;

    let preprocessPawnContent = null;
    const runtime = createPreprocessorSyntaxCore({
        evaluatePawnNumericExpr,
        cloneDefineDecls,
        normalizeFsPath,
        getDefineStateKey,
        getSearchPaths,
        resolveInclude,
        getIncludeNameFromLine,
        collectDeclarationText,
        maskPreprocessorLine: line => String(line || '').replace(/[^\t ]/g, ' '),
        stripLineComment,
        preprocessPawnContentRef: () => preprocessPawnContent,
        readNormalizedFileContent,
        getCachedCommentAnalysis,
        setCachedCommentAnalysis,
        buildCommentAnalysis,
        readCachedIncludePreprocessedState,
        writeCachedIncludePreprocessedState
    });
    preprocessPawnContent = runtime.preprocessPawnContent;
    return runtime;
}

module.exports = { createPreprocessorRuntime };
