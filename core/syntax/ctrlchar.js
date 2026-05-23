const { splitPawnLines } = require('./lines');
const { parsePragmaDirectiveLine } = require('./pragma-directives');
const { collectPreprocessorDirectiveLineNumbers } = require('./preprocessor-lines');
const {
    getPawnIncludeNameFromLine,
    parsePawnIncludeDirectiveTarget
} = require('./includes');

function createCtrlCharSyntaxCore(deps) {
    const {
        normalizeFsPath,
        getSearchPaths,
        getNestedSearchPaths = null,
        resolveInclude,
        ctrlCharStateCache,
        getCachedCommentAnalysis,
        setCachedCommentAnalysis,
        buildCommentAnalysis,
        readNormalizedFileContent
    } = deps;

    const getIncludeNameFromLine = getPawnIncludeNameFromLine;

    const DEFAULT_CTRL_CHAR = '^';
    const EMPTY_DIRECTIVE_CANDIDATE_LINES = [];
    const ctrlCharStack = [DEFAULT_CTRL_CHAR];
    const normalizeContent = c => c.replace(/\\\r?\n/g, ' ');

    const hasOddTrailingEscape = (text, index, escapeChar) => {
        let count = 0;
        for (let i = index - 1; i >= 0 && text[i] === escapeChar; i--) count++;
        return (count % 2) === 1;
    };

    const getActiveCtrlChar = () => ctrlCharStack[ctrlCharStack.length - 1] || DEFAULT_CTRL_CHAR;
    const normalizeDirectiveProbeText = line => {
        const text = String(line || '');
        return /[A-Z]/.test(text) ? text.toLowerCase() : text;
    };
    const lineMayReferenceInclude = line => normalizeDirectiveProbeText(line).indexOf('include') >= 0;
    const lineMayAffectCtrlChar = line => {
        const text = normalizeDirectiveProbeText(line);
        return text.indexOf('ctrlchar') >= 0 || text.indexOf('include') >= 0;
    };

    const collectDirectiveLineNumbers = collectPreprocessorDirectiveLineNumbers;

    const fillLineCtrlCharRange = (lineCtrlChars, startLine, endLineExclusive, ctrlChar) => {
        if (ctrlChar === DEFAULT_CTRL_CHAR) return;
        for (let lineIndex = Math.max(0, startLine); lineIndex < endLineExclusive; lineIndex++) {
            lineCtrlChars[lineIndex] = ctrlChar;
        }
    };

    const getCachedCtrlCharState = (normalizedPath, content) => {
        if (!normalizedPath) return null;
        const entries = ctrlCharStateCache.get(normalizedPath);
        if (!entries?.length) return null;
        for (const entry of entries) {
            if (entry.content === content) return entry.state;
        }
        return null;
    };

    const setCachedCtrlCharState = (normalizedPath, content, state) => {
        if (!normalizedPath) return;
        const entries = ctrlCharStateCache.get(normalizedPath) || [];
        const filtered = entries.filter(entry => entry.content !== content);
        filtered.unshift({ content, state });
        ctrlCharStateCache.set(normalizedPath, filtered.slice(0, 3));
    };

    const getStrippedLinesForDefaultCtrlCharState = (normalizedPath, content, rawLines, precomputedStrippedLines = null) => {
        if (Array.isArray(precomputedStrippedLines)) {
            return precomputedStrippedLines;
        }
        if (!content.includes('/*') && !content.includes('//')) {
            return rawLines;
        }
        const cachedAnalysis = getCachedCommentAnalysis(normalizedPath, content);
        if (cachedAnalysis) return cachedAnalysis.strippedLines;
        const analysis = buildCommentAnalysis(rawLines);
        setCachedCommentAnalysis(normalizedPath, content, analysis);
        return analysis.strippedLines;
    };

    const buildDefaultCtrlCharState = (
        content,
        normalizedPath = '',
        rawLines = null,
        strippedLines = null,
        hasDirectiveMarker = null
    ) => {
        const sourceText = String(content || '');
        const resolvedRawLines = Array.isArray(rawLines) ? rawLines : splitPawnLines(sourceText);
        const resolvedStrippedLines = getStrippedLinesForDefaultCtrlCharState(
            normalizedPath,
            sourceText,
            resolvedRawLines,
            strippedLines
        );
        const containsDirectiveMarker = hasDirectiveMarker == null
            ? sourceText.indexOf('#') >= 0
            : !!hasDirectiveMarker;
        return {
            rawLines: resolvedRawLines,
            strippedLines: resolvedStrippedLines,
            lineCtrlChars: [],
            directiveCandidateLines: containsDirectiveMarker
                ? collectDirectiveLineNumbers(resolvedStrippedLines)
                : EMPTY_DIRECTIVE_CANDIDATE_LINES,
            finalCtrlChar: DEFAULT_CTRL_CHAR
        };
    };

    const cacheDefaultCtrlCharState = (
        normalizedPath,
        content,
        rawLines = null,
        strippedLines = null,
        hasDirectiveMarker = null
    ) => {
        if (!normalizedPath || getCachedCtrlCharState(normalizedPath, content)) return;
        setCachedCtrlCharState(
            normalizedPath,
            content,
            buildDefaultCtrlCharState(content, normalizedPath, rawLines, strippedLines, hasDirectiveMarker)
        );
    };

    const getCtrlCharGraphCacheKey = normalizedPath =>
        normalizedPath ? `${normalizedPath}::ctrlchar-graph-presence` : '';

    const getCachedCtrlCharGraphPresence = (normalizedPath, content) => {
        const key = getCtrlCharGraphCacheKey(normalizedPath);
        if (!key) return null;
        const entries = ctrlCharStateCache.get(key);
        if (!entries?.length) return null;
        for (const entry of entries) {
            if (entry.content === content) return entry.value;
        }
        return null;
    };

    const setCachedCtrlCharGraphPresence = (normalizedPath, content, value) => {
        const key = getCtrlCharGraphCacheKey(normalizedPath);
        if (!key) return;
        const entries = ctrlCharStateCache.get(key) || [];
        const filtered = entries.filter(entry => entry.content !== content);
        filtered.unshift({ content, value: !!value });
        ctrlCharStateCache.set(key, filtered.slice(0, 3));
    };

    const includeGraphMaySetCtrlChar = (
        content,
        fromFilePath = '',
        strippedLines = null,
        searchPaths = [],
        visited = new Set()
    ) => {
        const text = String(content || '');
        if (text.indexOf('ctrlchar') >= 0) return true;
        const hasDirectiveMarker = text.indexOf('#') >= 0;
        if (!hasDirectiveMarker || text.indexOf('include') < 0) {
            const currentPath = fromFilePath ? normalizeFsPath(fromFilePath) : '';
            cacheDefaultCtrlCharState(currentPath, text, null, strippedLines, hasDirectiveMarker);
            return false;
        }

        const currentPath = fromFilePath ? normalizeFsPath(fromFilePath) : '';
        const cached = getCachedCtrlCharGraphPresence(currentPath, text);
        if (cached != null) return cached;
        if (currentPath) {
            if (visited.has(currentPath)) return false;
            visited.add(currentPath);
        }

        const lines = Array.isArray(strippedLines)
            ? strippedLines
            : splitPawnLines(text);
        const directiveLines = collectDirectiveLineNumbers(lines);
        let maySetCtrlChar = false;
        for (const lineIndex of directiveLines) {
            const line = String(lines[lineIndex] || '').trim();
            if (!lineMayReferenceInclude(line)) continue;
            const includeTarget = parsePawnIncludeDirectiveTarget(line);
            const includeName = includeTarget?.name || '';
            if (!includeName) continue;
            const includePath = resolveInclude(includeName, searchPaths, fromFilePath, {
                delimiter: includeTarget?.delimiter || ''
            });
            const normalizedIncludePath = normalizeFsPath(includePath);
            if (!includePath || visited.has(normalizedIncludePath)) continue;
            const includeContent = readNormalizedFileContent(includePath);
            if (includeContent == null) continue;
            const nestedSearchPaths = typeof getNestedSearchPaths === 'function'
                ? getNestedSearchPaths(includePath, searchPaths)
                : getSearchPaths(includePath);
            if (includeGraphMaySetCtrlChar(
                includeContent,
                includePath,
                null,
                nestedSearchPaths,
                visited
            )) {
                maySetCtrlChar = true;
                break;
            }
        }
        if (currentPath) visited.delete(currentPath);
        setCachedCtrlCharGraphPresence(currentPath, text, maySetCtrlChar);
        if (!maySetCtrlChar) {
            cacheDefaultCtrlCharState(currentPath, text, lines, strippedLines, hasDirectiveMarker);
        }
        return maySetCtrlChar;
    };

    // IMPORTANT:
    // Pawn ctrlchar is dynamic and may be redefined multiple times inside the same file
    // (and inside nested includes) during editing. Reuse of ctrlchar state is only safe
    // for the exact same immutable content snapshot. Do not promote this to a coarse
    // file-level cache that survives text changes, or hover/parse scopes will drift.
    const getCtrlCharStateForContent = (
        content,
        fromFilePath = '',
        visited = new Set(),
        precomputedRawLines = null,
        inheritedSearchPaths = []
    ) => {
        let ctrlChar = DEFAULT_CTRL_CHAR;
        const currentPath = fromFilePath ? normalizeFsPath(fromFilePath) : '';
        const cachedState = getCachedCtrlCharState(currentPath, content);
        if (cachedState) {
            return cachedState;
        }
        if (currentPath) {
            if (visited.has(currentPath)) {
                const rawLines = splitPawnLines(content);
                const analysis = content.includes('/*') || content.includes('//')
                    ? buildCommentAnalysis(rawLines)
                    : null;
                const strippedLines = analysis?.strippedLines || rawLines;
                return {
                    rawLines,
                    strippedLines,
                    lineCtrlChars: rawLines.map(() => ctrlChar),
                    directiveCandidateLines: content.indexOf('#') >= 0
                        ? collectDirectiveLineNumbers(strippedLines)
                        : EMPTY_DIRECTIVE_CANDIDATE_LINES,
                    finalCtrlChar: ctrlChar
                };
            }
            visited.add(currentPath);
        }

        const rawLines = Array.isArray(precomputedRawLines)
            ? precomputedRawLines
            : splitPawnLines(content);
        const strippedLines = (content.includes('/*') || content.includes('//'))
            ? (() => {
                const cachedAnalysis = getCachedCommentAnalysis(currentPath, content);
                if (cachedAnalysis) return cachedAnalysis.strippedLines;
                const analysis = buildCommentAnalysis(rawLines);
                setCachedCommentAnalysis(currentPath, content, analysis);
                return analysis.strippedLines;
            })()
            : rawLines;
        const hasDirectiveMarker = content.indexOf('#') >= 0;
        const hasPotentialIncludeDirective = hasDirectiveMarker && content.indexOf('include') >= 0;
        const searchPaths = typeof getNestedSearchPaths === 'function'
            ? getNestedSearchPaths(fromFilePath, inheritedSearchPaths)
            : getSearchPaths(fromFilePath);
        if (
            content.indexOf('ctrlchar') < 0 &&
            (
                !hasPotentialIncludeDirective ||
                !includeGraphMaySetCtrlChar(
                    content,
                    fromFilePath,
                    strippedLines,
                    searchPaths,
                    new Set(visited)
                )
            )
        ) {
            const state = buildDefaultCtrlCharState(
                content,
                currentPath,
                rawLines,
                strippedLines,
                hasDirectiveMarker
            );
            setCachedCtrlCharState(currentPath, content, state);
            return state;
        }
        const lineCtrlChars = [];
        let nextUnfilledLine = 0;
        const directiveCandidateLines = hasDirectiveMarker
            ? collectDirectiveLineNumbers(strippedLines)
            : EMPTY_DIRECTIVE_CANDIDATE_LINES;
        for (const lineIndex of directiveCandidateLines) {
            fillLineCtrlCharRange(lineCtrlChars, nextUnfilledLine, lineIndex + 1, ctrlChar);
            nextUnfilledLine = lineIndex + 1;
            const line = String(strippedLines[lineIndex] || '').trim();
            if (!lineMayAffectCtrlChar(line)) continue;
            const pragma = parsePragmaDirectiveLine(line);
            const ctrlCharMatch = pragma?.name === 'ctrlchar'
                ? String(pragma.value || '').match(/^(['"])([^\r\n])\1/)
                : null;
            if (ctrlCharMatch) {
                ctrlChar = ctrlCharMatch[2];
                continue;
            }

            const includeTarget = parsePawnIncludeDirectiveTarget(line);
            const includeName = includeTarget?.name || '';
            if (!includeName) continue;

            const includePath = resolveInclude(includeName, searchPaths, fromFilePath, {
                delimiter: includeTarget?.delimiter || ''
            });
            const normalizedIncludePath = normalizeFsPath(includePath);
            if (!includePath || visited.has(normalizedIncludePath)) continue;

            const includeContent = readNormalizedFileContent(includePath);
            if (includeContent == null) continue;
            ctrlChar = getCtrlCharStateForContent(includeContent, includePath, visited, null, searchPaths).finalCtrlChar;
        }
        fillLineCtrlCharRange(lineCtrlChars, nextUnfilledLine, rawLines.length, ctrlChar);

        const state = { rawLines, strippedLines, lineCtrlChars, directiveCandidateLines, finalCtrlChar: ctrlChar };
        setCachedCtrlCharState(currentPath, content, state);
        return state;
    };

    const resolveCtrlCharFromContent = (content, fromFilePath = '', visited = new Set()) =>
        getCtrlCharStateForContent(content, fromFilePath, visited).finalCtrlChar;

    // `precomputedFinalCtrlChar` / `precomputedLineCtrlChars` are only for the same text snapshot.
    // They are an optimization to avoid recomputing ctrlchar state twice in one pipeline stage.
    const withCtrlCharForContent = (content, fn, fromFilePath = null, precomputedFinalCtrlChar = undefined) => {
        ctrlCharStack.push(
            fromFilePath === null
                ? getActiveCtrlChar()
                : (precomputedFinalCtrlChar ?? resolveCtrlCharFromContent(content, fromFilePath))
        );
        try {
            return fn();
        } finally {
            ctrlCharStack.pop();
        }
    };

    const createCtrlCharResolver = (content, fromFilePath = '', precomputedLineCtrlChars = null) => {
        const lineCtrlChars = precomputedLineCtrlChars || getCtrlCharStateForContent(content, fromFilePath).lineCtrlChars;
        let lineStarts = null;
        const getLineStarts = () => {
            if (lineStarts) return lineStarts;
            lineStarts = [0];
            for (let i = 0; i < content.length; i++) {
                if (content[i] === '\n') lineStarts.push(i + 1);
            }
            return lineStarts;
        };
        const lineAtOffset = offset => {
            const starts = getLineStarts();
            let lo = 0;
            let hi = starts.length - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (starts[mid] <= offset) lo = mid + 1;
                else hi = mid - 1;
            }
            return Math.max(0, hi);
        };
        return {
            lineCtrlChars,
            ctrlCharAtLine: line => lineCtrlChars[line] || DEFAULT_CTRL_CHAR,
            ctrlCharAtOffset: offset => lineCtrlChars[lineAtOffset(offset)] || DEFAULT_CTRL_CHAR
        };
    };

    const isEscapedQuote = (text, index, escapeChar = getActiveCtrlChar()) =>
        hasOddTrailingEscape(text, index, escapeChar);

    return {
        DEFAULT_CTRL_CHAR,
        normalizeContent,
        hasOddTrailingEscape,
        getIncludeNameFromLine,
        getActiveCtrlChar,
        getCtrlCharStateForContent,
        withCtrlCharForContent,
        createCtrlCharResolver,
        isEscapedQuote
    };
}

module.exports = { createCtrlCharSyntaxCore };
