function createCommentAnalysisCore(deps) {
    const {
        getActiveCtrlChar,
        isEscapedQuote,
        commentAnalysisCache
    } = deps;

    const analysisByLines = new WeakMap();
    const DEFAULT_LINE_CTRL_CHARS = {};
    const DOC_CACHE_UNSET = Symbol('doc-cache-unset');
    const spaceMaskCache = [''];

    const normalizeDocLine = trimmedLine => {
        if (!trimmedLine) return '';
        if (!(trimmedLine.startsWith('//') || trimmedLine.startsWith('/*') || trimmedLine.startsWith('*'))) {
            return '';
        }
        return trimmedLine
            .replace(/^\/\*\*?/, '')
            .replace(/\*\/$/, '')
            .replace(/^\*\s?/, '')
            .replace(/^\/\/\s?/, '')
            .trim();
    };

    const getLineCacheKey = lineCtrlChars =>
        Array.isArray(lineCtrlChars) && lineCtrlChars.length
            ? lineCtrlChars
            : DEFAULT_LINE_CTRL_CHARS;

    const getSpaceMask = length => {
        const safeLength = Math.max(0, length | 0);
        if (!spaceMaskCache[safeLength]) {
            spaceMaskCache[safeLength] = ' '.repeat(safeLength);
        }
        return spaceMaskCache[safeLength];
    };

    const setMaskResult = (result, strippedLine, inBlockComment, changed) => {
        result.strippedLine = strippedLine;
        result.inBlockComment = inBlockComment;
        result.changed = changed;
        return result;
    };

    const maskCommentRanges = (rawLine, escapeChar, initialInBlockComment, result = {}) => {
        const source = String(rawLine || '');
        if (!source) {
            return setMaskResult(result, source, initialInBlockComment, false);
        }

        let inBlockComment = initialInBlockComment;
        let inStr = false;
        let strCh = '';
        let writeStart = 0;
        let changed = false;
        let segments = null;
        let firstLineCommentIndex = -1;
        let firstBlockCommentIndex = -1;

        if (!inBlockComment) {
            firstLineCommentIndex = source.indexOf('//');
            firstBlockCommentIndex = source.indexOf('/*');
            if (firstLineCommentIndex < 0 && firstBlockCommentIndex < 0) {
                return setMaskResult(result, source, false, false);
            }
            if (firstLineCommentIndex >= 0) {
                const doubleQuoteIndex = source.indexOf('"');
                const singleQuoteIndex = source.indexOf("'");
                const hasEarlierBlockComment = firstBlockCommentIndex >= 0 && firstBlockCommentIndex < firstLineCommentIndex;
                const hasEarlierString = (
                    (doubleQuoteIndex >= 0 && doubleQuoteIndex < firstLineCommentIndex) ||
                    (singleQuoteIndex >= 0 && singleQuoteIndex < firstLineCommentIndex)
                );
                if (!hasEarlierBlockComment && !hasEarlierString) {
                    return setMaskResult(
                        result,
                        source.slice(0, firstLineCommentIndex) + getSpaceMask(source.length - firstLineCommentIndex),
                        false,
                        true
                    );
                }
            }
        }

        const appendMaskedRange = (start, end) => {
            if (!segments) segments = [];
            if (start > writeStart) {
                segments.push(source.slice(writeStart, start));
            }
            segments.push(getSpaceMask(end - start));
            writeStart = end;
            changed = true;
        };

        if (source.indexOf('"') < 0 && source.indexOf("'") < 0) {
            let scanIndex = 0;
            while (scanIndex < source.length) {
                if (inBlockComment) {
                    const blockEndIndex = source.indexOf('*/', scanIndex);
                    const maskEnd = blockEndIndex >= 0 ? blockEndIndex + 2 : source.length;
                    appendMaskedRange(scanIndex, maskEnd);
                    inBlockComment = blockEndIndex < 0;
                    scanIndex = maskEnd;
                    if (inBlockComment) break;
                    continue;
                }

                const lineCommentIndex = source.indexOf('//', scanIndex);
                const blockCommentIndex = source.indexOf('/*', scanIndex);
                if (lineCommentIndex < 0 && blockCommentIndex < 0) break;
                if (lineCommentIndex >= 0 && (blockCommentIndex < 0 || lineCommentIndex < blockCommentIndex)) {
                    appendMaskedRange(lineCommentIndex, source.length);
                    scanIndex = source.length;
                    break;
                }

                const blockEndIndex = source.indexOf('*/', blockCommentIndex + 2);
                const maskEnd = blockEndIndex >= 0 ? blockEndIndex + 2 : source.length;
                appendMaskedRange(blockCommentIndex, maskEnd);
                inBlockComment = blockEndIndex < 0;
                scanIndex = maskEnd;
                if (inBlockComment) break;
            }

            if (!changed) {
                return setMaskResult(result, source, inBlockComment, false);
            }
            if (writeStart < source.length) {
                segments.push(source.slice(writeStart));
            }
            return setMaskResult(result, segments ? segments.join('') : source, inBlockComment, true);
        }

        for (let i = 0; i < source.length; i++) {
            const c = source[i];
            const n = source[i + 1] || '';

            if (inBlockComment) {
                const blockStart = i;
                let blockEnd = source.length;
                for (; i < source.length; i++) {
                    if (source[i] === '*' && (source[i + 1] || '') === '/') {
                        blockEnd = i + 2;
                        inBlockComment = false;
                        break;
                    }
                }
                appendMaskedRange(blockStart, blockEnd);
                i = blockEnd - 1;
                continue;
            }

            if (inStr) {
                if (c === strCh && isEscapedQuote(source, i, escapeChar) === false) {
                    inStr = false;
                }
                continue;
            }

            if (c === '"' || c === "'") {
                inStr = true;
                strCh = c;
                continue;
            }

            if (c === '/' && n === '*') {
                inBlockComment = true;
                appendMaskedRange(i, i + 2);
                i++;
                continue;
            }

            if (c === '/' && n === '/') {
                appendMaskedRange(i, source.length);
                break;
            }
        }

        if (!changed) {
            return setMaskResult(result, source, inBlockComment, false);
        }
        if (writeStart < source.length) {
            segments.push(source.slice(writeStart));
        }
        return setMaskResult(result, segments ? segments.join('') : source, inBlockComment, true);
    };

    function buildCommentAnalysis(lines, lineCtrlChars = [], lineIndex = null) {
        const sourceLines = Array.isArray(lines) ? lines : [];
        let strippedLines = sourceLines;
        let hasStrippedCopy = false;
        const setStrippedLine = (lineNo, value) => {
            if (!hasStrippedCopy) {
                strippedLines = sourceLines.slice();
                hasStrippedCopy = true;
            }
            strippedLines[lineNo] = value;
        };
        let inBlockComment = false;
        let hasCommentSyntax = false;
        const defaultEscapeChar = getActiveCtrlChar();
        const maskResult = { strippedLine: '', inBlockComment: false, changed: false };
        const relevantLines = Array.isArray(lineIndex?.commentRelevantLines)
            ? lineIndex.commentRelevantLines
            : null;
        if (lineIndex && Array.isArray(relevantLines) && relevantLines.length === 0) {
            return {
                strippedLines,
                trailingLineComments: null,
                leadingDocsByLine: null,
                hasCommentSyntax: false,
                lineIndex
            };
        }
        if (!(relevantLines?.length) && !sourceLines.length) {
            return {
                strippedLines,
                trailingLineComments: null,
                leadingDocsByLine: null,
                hasCommentSyntax: false,
                lineIndex: lineIndex || null
            };
        }

        const visitLine = lineNo => {
            const rawLine = String(sourceLines[lineNo] || '');
            const escapeChar = lineCtrlChars[lineNo] || defaultEscapeChar;
            if (!inBlockComment && rawLine.indexOf('/') < 0) {
                return;
            }

            hasCommentSyntax = true;
            const maskedLine = maskCommentRanges(rawLine, escapeChar, inBlockComment, maskResult);
            inBlockComment = maskedLine.inBlockComment;
            if (maskedLine.changed) {
                setStrippedLine(lineNo, maskedLine.strippedLine);
            }
        };

        if (relevantLines?.length) {
            for (const lineNo of relevantLines) {
                visitLine(lineNo);
            }
        } else {
            for (let lineNo = 0; lineNo < sourceLines.length; lineNo++) {
                visitLine(lineNo);
            }
        }

        return {
            strippedLines,
            trailingLineComments: null,
            leadingDocsByLine: null,
            hasCommentSyntax,
            lineIndex: lineIndex || null
        };
    }

    function extractTrailingLineComment(line, escapeChar = getActiveCtrlChar()) {
        const source = String(line || '');
        if (source.indexOf('//') < 0) return '';
        let inStr = false;
        let strCh = '';
        let inBlockComment = false;

        for (let i = 0; i < source.length; i++) {
            const c = source[i];
            const n = source[i + 1] || '';
            if (inBlockComment) {
                if (c === '*' && n === '/') {
                    inBlockComment = false;
                    i++;
                }
                continue;
            }
            if (inStr) {
                if (c === strCh && !isEscapedQuote(source, i, escapeChar)) inStr = false;
                continue;
            }
            if (c === '"' || c === "'") {
                inStr = true;
                strCh = c;
                continue;
            }
            if (c === '/' && n === '*') {
                inBlockComment = true;
                i++;
                continue;
            }
            if (c === '/' && n === '/') {
                return source.slice(i + 2).trim();
            }
        }

        return '';
    }

    function collectLeadingDocs(lines, startLine) {
        const docs = [];
        let blankGap = 0;
        const isDocCommentLine = trimmedLine =>
            !!trimmedLine &&
            (
                trimmedLine.startsWith('//') ||
                trimmedLine.startsWith('/*') ||
                trimmedLine.startsWith('*')
            );

        for (let lineNo = startLine - 1; lineNo >= 0; lineNo--) {
            const trimmedLine = String(lines[lineNo] || '').trim();
            if (!trimmedLine) {
                blankGap++;
                if (blankGap > 1) break;
                continue;
            }

            if (isDocCommentLine(trimmedLine)) {
                const docLine = normalizeDocLine(trimmedLine);
                if (docLine) {
                    docs.unshift(docLine);
                }
                blankGap = 0;
                continue;
            }

            break;
        }

        return docs.length ? docs.join('  \n') : '';
    }

    function getCommentAnalysisForLines(lines, lineCtrlChars = [], lineIndex = null) {
        if (!Array.isArray(lines)) {
            return {
                strippedLines: [],
                trailingLineComments: [],
                leadingDocsByLine: [],
                hasCommentSyntax: false
            };
        }

        let lineCache = analysisByLines.get(lines);
        if (!lineCache) {
            lineCache = new WeakMap();
            analysisByLines.set(lines, lineCache);
        }

        const cacheKey = getLineCacheKey(lineCtrlChars);
        const cachedAnalysis = lineCache.get(cacheKey);
        if (cachedAnalysis) return cachedAnalysis;

        const analysis = buildCommentAnalysis(lines, lineCtrlChars, lineIndex);
        lineCache.set(cacheKey, analysis);
        return analysis;
    }

    function getCommentDocsForLine(lines, lineNo, options = {}) {
        if (!Array.isArray(lines) || lineNo < 0 || lineNo >= lines.length) return '';
        const lineCtrlChars = options.lineCtrlChars || [];
        const analysis = getCommentAnalysisForLines(lines, lineCtrlChars, options.lineIndex || null);
        if (!analysis.trailingLineComments) {
            analysis.trailingLineComments = new Array(lines.length).fill(DOC_CACHE_UNSET);
        }
        if (!analysis.leadingDocsByLine) {
            analysis.leadingDocsByLine = new Array(lines.length).fill(DOC_CACHE_UNSET);
        }

        let leadingDocs = analysis.leadingDocsByLine[lineNo];
        if (leadingDocs === DOC_CACHE_UNSET) {
            leadingDocs = collectLeadingDocs(lines, lineNo);
            analysis.leadingDocsByLine[lineNo] = leadingDocs;
        }

        if (!options.includeInline) {
            return leadingDocs;
        }

        let inlineDoc = analysis.trailingLineComments[lineNo];
        if (inlineDoc === DOC_CACHE_UNSET) {
            const escapeChar = lineCtrlChars[lineNo] || getActiveCtrlChar();
            inlineDoc = extractTrailingLineComment(lines[lineNo], escapeChar);
            analysis.trailingLineComments[lineNo] = inlineDoc;
        }

        if (!inlineDoc) return leadingDocs;
        return leadingDocs ? `${leadingDocs}  \n${inlineDoc}` : inlineDoc;
    }

    const getCachedCommentAnalysis = (normalizedPath, content) => {
        if (!normalizedPath) return null;
        const entries = commentAnalysisCache.get(normalizedPath);
        if (!entries?.length) return null;
        for (const entry of entries) {
            if (entry.content === content) return entry.analysis;
        }
        return null;
    };

    const setCachedCommentAnalysis = (normalizedPath, content, analysis) => {
        if (!normalizedPath) return;
        const entries = commentAnalysisCache.get(normalizedPath) || [];
        const filtered = entries.filter(entry => entry.content !== content);
        filtered.unshift({ content, analysis });
        commentAnalysisCache.set(normalizedPath, filtered.slice(0, 3));
    };

    return {
        buildCommentAnalysis,
        getCommentAnalysisForLines,
        getCommentDocsForLine,
        getCachedCommentAnalysis,
        setCachedCommentAnalysis
    };
}

module.exports = { createCommentAnalysisCore };
