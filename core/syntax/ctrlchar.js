function createCtrlCharSyntaxCore(deps) {
    const {
        normalizeFsPath,
        getSearchPaths,
        resolveInclude,
        INCLUDE_LINE_RE,
        ctrlCharStateCache,
        getCachedCommentAnalysis,
        setCachedCommentAnalysis,
        buildCommentAnalysis,
        readNormalizedFileContent
    } = deps;

    const getIncludeNameFromLine = line => {
        const match = String(line || '').match(INCLUDE_LINE_RE);
        return match ? (match[1] || match[2] || '') : '';
    };

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

    const collectDirectiveLineNumbers = strippedLines => {
        const directiveLines = [];
        for (let lineIndex = 0; lineIndex < strippedLines.length; lineIndex++) {
            const source = String(strippedLines[lineIndex] || '');
            if (source.indexOf('#') < 0) continue;
            let cursor = 0;
            while (cursor < source.length) {
                const code = source.charCodeAt(cursor);
                if (code !== 32 && code !== 9) break;
                cursor++;
            }
            if (cursor < source.length && source.charCodeAt(cursor) === 35) {
                directiveLines.push(lineIndex);
            }
        }
        return directiveLines;
    };

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

    // IMPORTANT:
    // Pawn ctrlchar is dynamic and may be redefined multiple times inside the same file
    // (and inside nested includes) during editing. Reuse of ctrlchar state is only safe
    // for the exact same immutable content snapshot. Do not promote this to a coarse
    // file-level cache that survives text changes, or hover/parse scopes will drift.
    const getCtrlCharStateForContent = (content, fromFilePath = '', visited = new Set(), precomputedRawLines = null) => {
        let ctrlChar = DEFAULT_CTRL_CHAR;
        const currentPath = fromFilePath ? normalizeFsPath(fromFilePath) : '';
        const cachedState = getCachedCtrlCharState(currentPath, content);
        if (cachedState) {
            return cachedState;
        }
        if (currentPath) {
            if (visited.has(currentPath)) {
                const rawLines = content.split(/\r?\n/);
                const analysis = content.includes('/*') || content.includes('//')
                    ? buildCommentAnalysis(rawLines)
                    : null;
                const strippedLines = analysis?.strippedLines || rawLines;
                return {
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
            : content.split(/\r?\n/);
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
        if (content.indexOf('ctrlchar') < 0 && content.indexOf('#include') < 0) {
            const state = {
                strippedLines,
                lineCtrlChars: [],
                directiveCandidateLines: hasDirectiveMarker
                    ? collectDirectiveLineNumbers(strippedLines)
                    : EMPTY_DIRECTIVE_CANDIDATE_LINES,
                finalCtrlChar: ctrlChar
            };
            setCachedCtrlCharState(currentPath, content, state);
            return state;
        }
        const searchPaths = getSearchPaths(fromFilePath);
        const lineCtrlChars = [];
        let nextUnfilledLine = 0;
        const directiveCandidateLines = hasDirectiveMarker
            ? collectDirectiveLineNumbers(strippedLines)
            : EMPTY_DIRECTIVE_CANDIDATE_LINES;
        for (const lineIndex of directiveCandidateLines) {
            fillLineCtrlCharRange(lineCtrlChars, nextUnfilledLine, lineIndex + 1, ctrlChar);
            nextUnfilledLine = lineIndex + 1;
            const line = String(strippedLines[lineIndex] || '').trim();
            const pragmaMatch = line.match(/^\s*#pragma\s+ctrlchar\s+(['"])([^\r\n])\1/);
            if (pragmaMatch) {
                ctrlChar = pragmaMatch[2];
                continue;
            }

            const includeName = getIncludeNameFromLine(line);
            if (!includeName) continue;

            const includePath = resolveInclude(includeName, searchPaths, fromFilePath);
            const normalizedIncludePath = normalizeFsPath(includePath);
            if (!includePath || visited.has(normalizedIncludePath)) continue;

            const includeContent = readNormalizedFileContent(includePath);
            if (includeContent == null) continue;
            ctrlChar = getCtrlCharStateForContent(includeContent, includePath, visited).finalCtrlChar;
        }
        fillLineCtrlCharRange(lineCtrlChars, nextUnfilledLine, rawLines.length, ctrlChar);

        const state = { strippedLines, lineCtrlChars, directiveCandidateLines, finalCtrlChar: ctrlChar };
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
