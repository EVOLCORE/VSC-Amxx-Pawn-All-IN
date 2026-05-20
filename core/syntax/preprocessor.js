const { getDefineStateSignature } = require('../utils/signature');
const { createMacroExpansionSyntaxCore } = require('./macro-expander');
const { isCompilerPredefinedConstantName } = require('./compiler-builtins');
const {
    PREPROCESSOR_DIRECTIVE_NAMES,
    readPreprocessorDirectiveNameContext,
    readPreprocessorIdentifierToken
} = require('./preprocessor-directives');
const { createRationalPolicySyntaxCore } = require('./rational-policy');
const { parsePawnIncludeDirectiveTarget } = require('./includes');
const {
    isPawnIdentifierContinueCode,
    isPawnIdentifierStartCode
} = require('./identifiers');

// Shared Pawn preprocessor helpers. These are language/runtime mechanics used
// by document context, include scanning, and declaration parsing.
const { splitPawnLines } = require('./lines');
const {
    isPawnHorizontalWhitespaceCode,
    skipPawnHorizontalWhitespace
} = require('./whitespace');
const {
    hasTrailingBackslashContinuation,
    removeTrailingBackslashContinuation
} = require('./continuation');

function createPreprocessorSyntaxCore(deps) {
    const {
        evaluatePawnNumericExpr,
        normalizeFsPath,
        getDefineStateKey,
        getSearchPaths,
        getNestedSearchPaths = null,
        resolveInclude,
        getIncludeNameFromLine,
        maskPreprocessorLine,
        stripLineComment,
        splitTopLevel,
        preprocessPawnContentRef,
        readNormalizedFileContent,
        getCachedCommentAnalysis,
        setCachedCommentAnalysis,
        buildCommentAnalysis,
        getCtrlCharStateForContent = null,
        readCachedIncludePreprocessedState,
        writeCachedIncludePreprocessedState
    } = deps;
    const knownPreprocessorDirectives = new Set(PREPROCESSOR_DIRECTIVE_NAMES);
    const getIncludePreprocessedStateKey = (filePath, defineStateKey = '', defineDecls = []) =>
        `${normalizeFsPath(filePath)}::${getDefineStateSignature(defineDecls, defineStateKey)}`;
    const rationalPolicy = createRationalPolicySyntaxCore({
        evaluatePawnNumericExpr
    });
    const defineDeclLookupCache = new WeakMap();
    const macroExpansion = createMacroExpansionSyntaxCore({
        isEscapedQuote: (source, index, escapeChar) => {
            if (!escapeChar) return false;
            let count = 0;
            for (let cursor = index - 1; cursor >= 0 && source[cursor] === escapeChar; cursor--) count++;
            return (count % 2) === 1;
        },
        isIdentifierStartChar: char => isPawnIdentifierStartCode(String(char || '').charCodeAt(0)),
        isIdentifierContinueChar: char => isPawnIdentifierContinueCode(String(char || '').charCodeAt(0)),
        splitTopLevel
    });

    const skipDirectiveSpaces = skipPawnHorizontalWhitespace;
    const readDirectiveIdentifier = readPreprocessorIdentifierToken;
    const defineLookupValuesCache = new WeakMap();

    const getDefineLookupValues = (defineLookup = null, fallbackDecls = []) => {
        if (!(defineLookup instanceof Map)) return fallbackDecls;
        const cached = defineLookupValuesCache.get(defineLookup);
        if (cached) return cached;
        const values = [...defineLookup.values()];
        defineLookupValuesCache.set(defineLookup, values);
        return values;
    };

    const invalidateDefineLookupValues = defineLookup => {
        if (defineLookup instanceof Map) defineLookupValuesCache.delete(defineLookup);
    };

    function getDirectiveLineWithoutComment(line, escapeChar = undefined, shouldStripLineComment = true) {
        const sourceLine = String(line || '');
        return shouldStripLineComment
            ? String(stripLineComment(sourceLine, escapeChar))
            : sourceLine;
    }

    function parsePreprocessorDirectiveLine(line, options = {}) {
        const sourceLine = String(line || '');
        const directiveLine = getDirectiveLineWithoutComment(
            sourceLine,
            options.escapeChar,
            options.stripLineComment !== false
        );
        const directiveNameContext = readPreprocessorDirectiveNameContext(directiveLine);
        if (!directiveNameContext) return null;

        const hashIndex = directiveNameContext.hashStart;
        const keywordStart = directiveNameContext.tokenStart;
        const keywordEnd = directiveNameContext.tokenEnd;
        let cursor = keywordEnd;

        let payloadStart = skipDirectiveSpaces(directiveLine, cursor);
        let payloadEnd = directiveLine.length;
        while (payloadEnd > payloadStart && isPawnHorizontalWhitespaceCode(directiveLine.charCodeAt(payloadEnd - 1))) payloadEnd--;

        const keywordRaw = directiveNameContext.directiveNameRaw || '';
        const keyword = directiveNameContext.directiveName || '';
        return {
            sourceLine,
            directiveLine,
            hashIndex,
            keyword,
            keywordRaw,
            keywordStart,
            keywordEnd,
            payloadStart,
            payloadEnd,
            payload: directiveLine.slice(payloadStart, payloadEnd),
            trimmed: directiveLine.slice(hashIndex, payloadEnd),
            rest: directiveLine.slice(payloadStart, payloadEnd)
        };
    }

    function collectPreprocessorDirectiveText(rawLines, startLine, preparedLines = null, includeRangeMap = true) {
        const sourceRawLines = Array.isArray(rawLines) ? rawLines : [];
        const sourcePreparedLines = Array.isArray(preparedLines) ? preparedLines : sourceRawLines;
        const firstLine = Math.max(0, startLine | 0);
        let lineNumber = firstLine;
        let text = '';
        let joinedCursor = 0;
        const segments = includeRangeMap ? [] : null;

        while (lineNumber < sourceRawLines.length) {
            const rawLine = String(sourceRawLines[lineNumber] || '');
            const preparedLine = String(sourcePreparedLines[lineNumber] || '');
            const continued = hasTrailingBackslashContinuation(rawLine);
            const segmentText = continued
                ? removeTrailingBackslashContinuation(preparedLine).trimEnd()
                : preparedLine;
            const prefix = lineNumber === firstLine ? '' : ' ';
            const mappedText = lineNumber === firstLine ? segmentText : segmentText.trim();
            if (includeRangeMap) {
                const mappedStart = lineNumber === firstLine
                    ? 0
                    : (segmentText.length - segmentText.trimStart().length);
                const joinedStart = joinedCursor + prefix.length;
                segments.push({
                    lineNumber,
                    sourceStart: mappedStart,
                    sourceEnd: mappedStart + mappedText.length,
                    joinedStart,
                    joinedEnd: joinedStart + mappedText.length
                });
            }
            text += prefix + mappedText;
            joinedCursor = text.length;
            lineNumber++;
            if (!continued) break;
        }

        const mapRange = (start, length = 1) => {
            if (!segments) {
                return { lineNumber: firstLine, start: Math.max(0, start | 0), length: Math.max(1, length | 0) };
            }
            const rangeStart = Math.max(0, start | 0);
            const rangeEnd = Math.max(rangeStart + 1, rangeStart + Math.max(1, length | 0));
            const segment = segments.find(item =>
                rangeStart >= item.joinedStart &&
                rangeStart <= Math.max(item.joinedStart, item.joinedEnd)
            ) || segments[0] || null;
            if (!segment) {
                return { lineNumber: firstLine, start: rangeStart, length: Math.max(1, length | 0) };
            }
            const startInSegment = Math.max(0, rangeStart - segment.joinedStart);
            const endInSegment = Math.max(
                startInSegment + 1,
                Math.min(segment.joinedEnd - segment.joinedStart, rangeEnd - segment.joinedStart)
            );
            return {
                lineNumber: segment.lineNumber,
                start: segment.sourceStart + startInSegment,
                length: Math.max(1, endInSegment - startInSegment)
            };
        };

        return {
            text,
            nextLine: Math.max(firstLine + 1, lineNumber),
            continued: lineNumber > firstLine + 1,
            segments: segments || [],
            mapRange
        };
    }

    function getPreprocessorDirectivePayloadRange(directive) {
        if (!directive || directive.payloadStart >= directive.payloadEnd) return null;
        return {
            start: directive.payloadStart,
            length: Math.max(1, directive.payloadEnd - directive.payloadStart)
        };
    }

    function parsePreprocessorSingleIdentifierPayload(directive) {
        if (!directive) return null;
        const payload = String(directive.payload || '');
        const identifier = readDirectiveIdentifier(payload, 0);
        if (!identifier) return null;
        let extraStart = skipDirectiveSpaces(payload, identifier.end);
        return {
            name: identifier.name,
            nameStart: directive.payloadStart + identifier.start,
            nameEnd: directive.payloadStart + identifier.end,
            extraRange: extraStart < payload.length
                ? {
                    start: directive.payloadStart + extraStart,
                    length: payload.length - extraStart
                }
                : null
        };
    }

    function parsePreprocessorDefineDirective(lineOrDirective, options = {}) {
        const directive = typeof lineOrDirective === 'object' && lineOrDirective !== null
            ? lineOrDirective
            : parsePreprocessorDirectiveLine(lineOrDirective, options);
        if (!directive || directive.keyword !== 'define') return null;

        const payload = String(directive.payload || '');
        const nameInfo = readDirectiveIdentifier(payload, 0);
        if (!nameInfo) {
            return {
                valid: false,
                directive,
                patternStart: directive.payloadStart,
                name: '',
                nameStart: directive.payloadStart,
                nameEnd: directive.payloadStart,
                args: '',
                macroStyle: '',
                macroIndexer: '',
                value: ''
            };
        }

        let cursor = nameInfo.end;
        let args = '';
        let macroIndexer = '';
        let macroStyle = '';
        if (payload[cursor] === '(' || payload[cursor] === '[') {
            const opener = payload[cursor];
            const closer = opener === '(' ? ')' : ']';
            if (opener === '[') {
                const indexerParts = [];
                while (payload[cursor] === '[') {
                    const closeIndex = payload.indexOf(closer, cursor + 1);
                    if (closeIndex < 0) break;
                    indexerParts.push(payload.slice(cursor + 1, closeIndex).trim());
                    cursor = closeIndex + 1;
                }
                if (indexerParts.length) {
                    macroStyle = 'bracket';
                    macroIndexer = indexerParts.join('][');
                }
            } else {
                const closeIndex = payload.indexOf(closer, cursor + 1);
                if (closeIndex >= 0) {
                    macroStyle = 'paren';
                    args = payload.slice(cursor + 1, closeIndex).trim();
                    cursor = closeIndex + 1;
                }
            }
        }

        cursor = skipDirectiveSpaces(payload, cursor);
        return {
            valid: true,
            directive,
            patternStart: directive.payloadStart + nameInfo.start,
            name: nameInfo.name,
            nameStart: directive.payloadStart + nameInfo.start,
            nameEnd: directive.payloadStart + nameInfo.end,
            args,
            macroStyle,
            macroIndexer,
            value: payload.slice(cursor).trim()
        };
    }

    function isPreprocessorQuoteEscaped(source, index) {
        const text = String(source || '');
        const previous = text[index - 1] || '';
        if (previous !== '\\' && previous !== '^' && previous !== '!') return false;
        let count = 0;
        for (let cursor = index - 1; cursor >= 0 && text[cursor] === previous; cursor--) count++;
        return (count % 2) === 1;
    }

    function getPreprocessorDirectiveIssues(directive, defineDecls = [], options = {}) {
        if (!directive) return [];
        const issues = [];
        const directiveName = directive.keyword || '';
        const defineLookup = options.defineLookup || null;
        const activeBranch = options.activeBranch !== false;
        const pushIssue = (messageKey, range, params = {}, severity = '') => {
            if (!messageKey || !range) return;
            issues.push({ messageKey, range, params, severity });
        };
        const getPayloadRange = () => getPreprocessorDirectivePayloadRange(directive);
        const getRestRangeFrom = (payloadStart, payloadEnd = directive.payloadEnd) =>
            getPreprocessorDirectivePayloadRange({
                payloadStart,
                payloadEnd
            });

        if (!knownPreprocessorDirectives.has(directiveName)) {
            pushIssue('validation.unknownDirective', {
                start: directive.keywordStart,
                length: Math.max(1, directive.keywordEnd - directive.keywordStart)
            });
            return issues;
        }

        if (directiveName === 'error') {
            if (!activeBranch) return issues;
            const payloadRange = getPayloadRange() || {
                start: directive.keywordStart,
                length: Math.max(1, directive.keywordEnd - directive.keywordStart)
            };
            const message = String(directive.payload || '').trim();
            pushIssue('validation.userError', payloadRange, { message });
            return issues;
        }

        if (directiveName === 'else' || directiveName === 'endif') {
            pushIssue('validation.extraCharactersOnLine', getPayloadRange());
            return issues;
        }

        if (
            directiveName === 'if' ||
            directiveName === 'elseif' ||
            directiveName === 'elif' ||
            directiveName === 'assert'
        ) {
            if (directiveName === 'assert' && !activeBranch) return issues;
            const payloadRange = getPayloadRange();
            if (!payloadRange) {
                pushIssue('validation.mustBeConstantExpression', {
                    start: directive.payloadStart,
                    length: 1
                });
                return issues;
            }
            const payload = directive.directiveLine.slice(
                payloadRange.start,
                payloadRange.start + payloadRange.length
            );
            const analysis = analyzePreprocessorConditionExpression(payload, defineDecls, defineLookup, {
                lineNumber: directive.lineNumber
            });
            if (analysis?.valid === false) {
                pushIssue('validation.mustBeConstantExpression', payloadRange);
            } else if (directiveName === 'assert' && activeBranch && !analysis?.value) {
                pushIssue('validation.assertionFailed', payloadRange, { expression: payload.trim() });
            }
            return issues;
        }

        if (directiveName === 'line') {
            const payloadRange = getPayloadRange();
            if (!payloadRange) {
                pushIssue('validation.mustBeConstantExpression', {
                    start: directive.payloadStart,
                    length: 1
                });
                return issues;
            }
            const payload = directive.directiveLine.slice(
                payloadRange.start,
                payloadRange.start + payloadRange.length
            );
            const evalDecls = getDefineLookupValues(defineLookup, defineDecls);
            const evaluatedLineNumber = evaluatePawnNumericExpr(payload, evalDecls);
            if (evaluatedLineNumber == null) {
                pushIssue('validation.mustBeConstantExpression', payloadRange);
            }
            return issues;
        }

        if (directiveName === 'include' || directiveName === 'tryinclude' || directiveName === 'file') {
            let valueStart = directive.payloadStart;
            const line = directive.directiveLine;
            const opener = line[valueStart] || '';
            if (opener !== '<' && opener !== '"') {
                if (directiveName === 'include' || directiveName === 'tryinclude') {
                    const payloadRange = getPayloadRange();
                    const includeTarget = parsePawnIncludeDirectiveTarget(directive.directiveLine);
                    if (!payloadRange || !includeTarget || includeTarget.isDelimited) {
                        pushIssue('validation.invalidString', {
                            start: directive.payloadStart,
                            length: 1
                        });
                        return issues;
                    }
                    const restStart = includeTarget.nameEnd;
                    if (line.slice(restStart, directive.payloadEnd).trim()) {
                        pushIssue('validation.extraCharactersOnLine', getRestRangeFrom(
                            restStart,
                            directive.payloadEnd
                        ));
                    }
                    return issues;
                }
                if (directiveName === 'file') {
                    pushIssue('validation.invalidString', getPayloadRange() || {
                        start: directive.payloadStart,
                        length: 1
                    });
                }
                return issues;
            }
            if (directiveName === 'file' && opener !== '"') {
                pushIssue('validation.invalidString', getPayloadRange() || {
                    start: directive.payloadStart,
                    length: 1
                });
                return issues;
            }
            const closer = opener === '<' ? '>' : '"';
            valueStart++;
            while (valueStart < line.length && /\s/.test(line[valueStart])) valueStart++;
            const closeIndex = line.indexOf(closer, valueStart);
            if (closeIndex < 0) {
                pushIssue('validation.invalidString', getRestRangeFrom(
                    Math.max(0, valueStart - 1),
                    directive.payloadEnd
                ) || { start: Math.max(0, valueStart - 1), length: 1 });
                return issues;
            }
            pushIssue('validation.extraCharactersOnLine', getRestRangeFrom(closeIndex + 1, directive.payloadEnd));
            return issues;
        }

        if (
            directiveName === 'ifdef' ||
            directiveName === 'ifndef' ||
            directiveName === 'undef'
        ) {
            const parsed = parsePreprocessorSingleIdentifierPayload(directive);
            if (!parsed) {
                pushIssue('validation.mustBeConstantExpression', getPayloadRange() || {
                    start: directive.payloadStart,
                    length: 1
                });
                return issues;
            }
            pushIssue('validation.extraCharactersOnLine', parsed.extraRange);
            return issues;
        }

        if (directiveName === 'define') {
            const defineDirective = parsePreprocessorDefineDirective(directive);
            if (defineDirective && !defineDirective.valid) {
                pushIssue('validation.definePatternMustStartWithAlphabeticCharacter', {
                    start: defineDirective.patternStart,
                    length: 1
                });
            }
            return issues;
        }

        return issues;
    }

    function replaceDefinedOperatorsInPreprocessorExpression(source, hasDefine) {
        const text = String(source || '');
        let normalized = '';
        let inString = false;
        let stringChar = '';
        for (let index = 0; index < text.length;) {
            const char = text[index] || '';
            if (inString) {
                normalized += char;
                if (char === stringChar && !isPreprocessorQuoteEscaped(text, index)) {
                    inString = false;
                }
                index++;
                continue;
            }
            if (char === '"' || char === "'") {
                inString = true;
                stringChar = char;
                normalized += char;
                index++;
                continue;
            }

            const identifier = readDirectiveIdentifier(text, index);
            if (!identifier || identifier.start !== index) {
                normalized += char;
                index++;
                continue;
            }

            if (identifier.name !== 'defined') {
                normalized += identifier.name;
                index = identifier.end;
                continue;
            }

            let cursor = skipDirectiveSpaces(text, identifier.end);
            let wrapped = false;
            if (text[cursor] === '(') {
                wrapped = true;
                cursor = skipDirectiveSpaces(text, cursor + 1);
            }
            const defineName = readDirectiveIdentifier(text, cursor);
            if (!defineName || defineName.start !== cursor) {
                return { valid: false, normalized };
            }
            cursor = skipDirectiveSpaces(text, defineName.end);
            if (wrapped) {
                if (text[cursor] !== ')') return { valid: false, normalized };
                cursor++;
            }
            normalized += hasDefine(defineName.name) ? '1' : '0';
            index = cursor;
        }
        return { valid: true, normalized };
    }

    function normalizePreprocessorRemainingIdentifiers(source, options = {}) {
        const text = String(source || '');
        const lineValue = Number.isInteger(options.lineNumber)
            ? String(Math.max(1, options.lineNumber + 1))
            : '1';
        let normalized = '';
        let inString = false;
        let stringChar = '';
        for (let index = 0; index < text.length;) {
            const char = text[index] || '';
            if (inString) {
                normalized += char;
                if (char === stringChar && !isPreprocessorQuoteEscaped(text, index)) {
                    inString = false;
                }
                index++;
                continue;
            }
            if (char === '"' || char === "'") {
                inString = true;
                stringChar = char;
                normalized += char;
                index++;
                continue;
            }

            const identifier = readDirectiveIdentifier(text, index);
            if (!identifier || identifier.start !== index) {
                normalized += char;
                index++;
                continue;
            }
            if (identifier.name === 'true') normalized += '1';
            else if (identifier.name === 'false') normalized += '0';
            else if (identifier.name === '__LINE__') normalized += lineValue;
            else if (identifier.name === 'char') normalized += 'char';
            else if (identifier.name === 'cellmin') normalized += 'cellmin';
            else if (identifier.name === 'cellmax') normalized += 'cellmax';
            else normalized += '0';
            index = identifier.end;
        }
        return normalized;
    }

    function analyzePreprocessorConditionExpression(expr, defineDecls = [], defineLookup = null, options = {}) {
        const hasDefine = name => isCompilerPredefinedConstantName(name) ||
            (defineLookup ? defineLookup.has(name) : defineDecls.some(d => d.name === name));
        const getDefine = name => defineLookup ? (defineLookup.get(name) || null) : (defineDecls.find(d => d.name === name) || null);
        const evalDecls = getDefineLookupValues(defineLookup, defineDecls);
        const source = String(expr || '').trim();
        if (!source) return { valid: false, value: null, normalized: '' };

        const definedResolved = replaceDefinedOperatorsInPreprocessorExpression(source, hasDefine);
        if (!definedResolved.valid) {
            return { valid: false, value: null, normalized: definedResolved.normalized };
        }
        const expanded = macroExpansion.expandMacros(definedResolved.normalized, evalDecls, {
            getDefine,
            defineLookup,
            maxOutputLength: 8192
        });
        if (!expanded.complete) {
            return { valid: false, value: null, normalized: expanded.text };
        }
        const normalized = normalizePreprocessorRemainingIdentifiers(expanded.text, options);
        const evaluated = evaluatePawnNumericExpr(normalized, evalDecls);
        return evaluated == null
            ? { valid: false, value: null, normalized }
            : { valid: true, value: evaluated, normalized };
    }

    function evaluatePreprocessorCondition(expr, defineDecls = [], defineLookup = null, options = {}) {
        return !!analyzePreprocessorConditionExpression(expr, defineDecls, defineLookup, options).value;
    }

    function preprocessPawnContent(content, options = {}) {
        const contentText = String(content || '');
        const hasDirectiveMarker = contentText.indexOf('#') >= 0;
        const rawLines = Array.isArray(options.rawLines)
            ? options.rawLines
            : splitPawnLines(contentText);
        const initialDefineDecls = Array.isArray(options.defineDecls)
            ? options.defineDecls
            : null;
        let defineDecls = initialDefineDecls || [];
        let ownsDefineDecls = !initialDefineDecls;
        let defineStateKey = String(options.precomputedDefineStateKey || '');
        let defineStateKeyDirty = !defineStateKey;
        const includePreprocessedStates = options.includePreprocessedStates instanceof Map
            ? options.includePreprocessedStates
            : (options.captureIncludePreprocessedStates ? new Map() : null);
        const ensureDefineStateKey = () => {
            if (defineStateKeyDirty) {
                defineStateKey = getDefineStateKey(defineDecls);
                defineStateKeyDirty = false;
            }
            return defineStateKey;
        };
        if (!hasDirectiveMarker) {
            if (options.returnState) {
                const rationalState = options.rationalState || null;
                const state = {
                    content: contentText,
                    rawLines,
                    strippedLines: Array.isArray(options.strippedLines) ? options.strippedLines : rawLines,
                    lineCtrlChars: Array.isArray(options.lineCtrlChars) ? options.lineCtrlChars : [],
                    finalCtrlChar: options.finalCtrlChar || '^',
                    defineDecls,
                    rationalState,
                    defineStateKey: ensureDefineStateKey(),
                    directiveCandidateLines: [],
                    includeEntries: [],
                    unresolvedIncludeEntries: []
                };
                if (includePreprocessedStates) {
                    state.includePreprocessedStates = includePreprocessedStates;
                }
                return state;
            }
            return contentText;
        }
        const buildDefineDeclLookup = (includeIndexMap = false) => {
            const cached = !ownsDefineDecls ? defineDeclLookupCache.get(defineDecls) : null;
            if (cached && (!includeIndexMap || cached.indexMap)) {
                return {
                    map: cached.map,
                    indexMap: cached.indexMap || null,
                    sharedCache: true
                };
            }
            if (cached && includeIndexMap && !cached.indexMap) {
                cached.indexMap = buildDefineDeclIndexMap();
                return {
                    map: cached.map,
                    indexMap: cached.indexMap,
                    sharedCache: true
                };
            }
            const map = new Map();
            const indexMap = includeIndexMap ? new Map() : null;
            for (let index = 0; index < defineDecls.length; index++) {
                const decl = defineDecls[index];
                map.set(decl.name, decl);
                if (indexMap) indexMap.set(decl.name, index);
            }
            if (!ownsDefineDecls) {
                const entry = cached || { map, indexMap };
                if (!cached) {
                    defineDeclLookupCache.set(defineDecls, entry);
                }
                return {
                    map: entry.map,
                    indexMap: entry.indexMap || null,
                    sharedCache: true
                };
            }
            return { map, indexMap };
        };
        const buildDefineDeclIndexMap = () => {
            const indexMap = new Map();
            for (let index = 0; index < defineDecls.length; index++) {
                const decl = defineDecls[index];
                indexMap.set(decl.name, index);
            }
            return indexMap;
        };
        const createReturnedState = (contentValue, includeEntriesValue, processedRawLinesValue) => {
            let returnedDefineDeclMap = null;
            let returnedDefineDeclIndexMap = null;
            const returnedRawLines = Array.isArray(processedRawLinesValue) ? processedRawLinesValue : rawLines;
            const state = {
                content: contentValue,
                rawLines: returnedRawLines,
                strippedLines: Array.isArray(outStrippedLines) ? outStrippedLines : strippedLines,
                lineCtrlChars: Array.isArray(options.lineCtrlChars) ? options.lineCtrlChars : [],
                finalCtrlChar: options.finalCtrlChar || '^',
                defineDecls,
                rationalState,
                defineStateKey: ensureDefineStateKey(),
                directiveCandidateLines,
                get defineDeclMap() {
                    if (!returnedDefineDeclMap) {
                        returnedDefineDeclMap = ensureDefineDeclLookup().map;
                    }
                    return returnedDefineDeclMap;
                },
                get defineDeclIndexMap() {
                    if (!returnedDefineDeclIndexMap) {
                        returnedDefineDeclIndexMap = ensureDefineDeclIndexMap();
                    }
                    return returnedDefineDeclIndexMap;
                },
                includeEntries: includeEntriesValue,
                unresolvedIncludeEntries
            };
            if (includePreprocessedStates) {
                state.includePreprocessedStates = includePreprocessedStates;
            }
            return state;
        };
        const cachePath = options.fromFilePath ? normalizeFsPath(options.fromFilePath) : '';
        const searchPaths = options.searchPaths || getSearchPaths(options.fromFilePath || '');
        const strippedLines = Array.isArray(options.strippedLines)
            ? options.strippedLines
            : contentText.includes('/*')
            ? (() => {
                const cachedAnalysis = getCachedCommentAnalysis(cachePath, contentText);
                if (cachedAnalysis) return cachedAnalysis.strippedLines;
                const analysis = buildCommentAnalysis(rawLines, [], null);
                setCachedCommentAnalysis(cachePath, contentText, analysis);
                return analysis.strippedLines;
            })()
            : rawLines;
        let outLines = null;
        let outStrippedLines = null;
        let emittedLineCount = 0;
        let contentChanged = false;
        let defineDeclLookup = null;
        const ensureMutableDefineDecls = () => {
            if (ownsDefineDecls) return defineDecls;
            defineDecls = defineDecls.slice();
            ownsDefineDecls = true;
            if (defineDeclLookup?.sharedCache) {
                defineDeclLookup = {
                    map: new Map(defineDeclLookup.map || []),
                    indexMap: defineDeclLookup.indexMap
                        ? new Map(defineDeclLookup.indexMap)
                        : null
                };
            }
            return defineDecls;
        };
        const ensureDefineDeclLookup = () => {
            if (!defineDeclLookup) {
                defineDeclLookup = buildDefineDeclLookup(false);
            }
            return defineDeclLookup;
        };
        const ensureDefineDeclMap = () => {
            return ensureDefineDeclLookup().map;
        };
        const ensureDefineDeclIndexMap = () => {
            if (!defineDeclLookup) {
                defineDeclLookup = buildDefineDeclLookup(true);
            } else if (!defineDeclLookup.indexMap) {
                defineDeclLookup.indexMap = buildDefineDeclIndexMap();
            }
            return defineDeclLookup.indexMap;
        };
        const stack = [];
        const includeEntries = [];
        const unresolvedIncludeEntries = [];
        let rationalState = options.rationalState || null;
        const includeDepth = Number.isInteger(options.includeDepth) ? options.includeDepth : 0;
        const activeFiles = options.activeFiles || new Set();
        const currentPath = options.fromFilePath ? normalizeFsPath(options.fromFilePath) : '';
        const ownsActiveFile = currentPath && !activeFiles.has(currentPath);
        if (ownsActiveFile) activeFiles.add(currentPath);
        const isActive = () => stack.length ? !!stack[stack.length - 1].active : true;
        const directiveCandidateLines = Array.isArray(options.directiveCandidateLines)
            ? options.directiveCandidateLines
            : (() => {
                const candidates = [];
                for (let lineNumber = 0; lineNumber < rawLines.length; lineNumber++) {
                    const source = String(strippedLines[lineNumber] || '');
                    if (source.indexOf('#') < 0) continue;
                    const cursor = skipPawnHorizontalWhitespace(source, 0);
                    if (cursor < source.length && source.charCodeAt(cursor) === 35) {
                        candidates.push(lineNumber);
                    }
                }
                return candidates;
            })();
        const readDirectiveName = rest => readDirectiveIdentifier(rest, 0)?.name || '';
        const applyRationalPragmaDirective = directive => {
            const payload = String(directive?.payload || '');
            const pragmaToken = readDirectiveIdentifier(payload, 0);
            const pragmaName = pragmaToken?.name || '';
            if (pragmaName.toLowerCase() !== 'rational') return false;
            const parsed = rationalPolicy.parseRationalPragmaPayload(
                payload.slice(pragmaToken?.end ?? 0),
                defineDecls
            );
            const nextState = rationalPolicy.createRationalStateFromPragma(parsed);
            if (!rationalPolicy.getRationalFormatAlreadyDefinedIssue(rationalState, nextState) && nextState) {
                rationalState = nextState;
            }
            return true;
        };
        const ensureOutLines = () => {
            if (!outLines) {
                outLines = rawLines.slice(0, emittedLineCount);
                outStrippedLines = strippedLines.slice(0, emittedLineCount);
            }
            return outLines;
        };
        const emitRawLine = (rawLine, strippedLine = rawLine) => {
            if (outLines) {
                outLines.push(rawLine);
                outStrippedLines.push(strippedLine);
            }
            emittedLineCount++;
        };
        const emitChangedLine = (line, strippedLine = line) => {
            ensureOutLines().push(line);
            outStrippedLines.push(strippedLine);
            emittedLineCount++;
            contentChanged = true;
        };
        const appendContentLine = lineNumber => {
            const rawLine = rawLines[lineNumber];
            if (isActive()) {
                emitRawLine(rawLine, strippedLines[lineNumber] || rawLine);
            } else {
                const maskedLine = maskPreprocessorLine(rawLine);
                if (maskedLine !== rawLine) emitChangedLine(maskedLine, maskedLine);
                else emitRawLine(maskedLine, strippedLines[lineNumber] || maskedLine);
            }
        };
        const appendMaskedLine = (rawLine, strippedLine = rawLine) => {
            const maskedLine = maskPreprocessorLine(rawLine);
            if (maskedLine !== rawLine) emitChangedLine(maskedLine, maskedLine);
            else emitRawLine(maskedLine, strippedLine);
        };
        const appendContentRange = (startLine, endLineExclusive) => {
            const start = Math.max(0, startLine);
            if (isActive() && !outLines) {
                emittedLineCount += Math.max(0, endLineExclusive - start);
                return;
            }
            for (let lineNumber = start; lineNumber < endLineExclusive; lineNumber++) {
                appendContentLine(lineNumber);
            }
        };
        const appendMaskedRange = (startLine, endLineExclusive) => {
            for (let lineNumber = Math.max(0, startLine); lineNumber < endLineExclusive; lineNumber++) {
                appendMaskedLine(rawLines[lineNumber], strippedLines[lineNumber] || rawLines[lineNumber]);
            }
        };

        const processDirectiveLine = lineNumber => {
            const rawLine = rawLines[lineNumber];
            const preparedLine = String(strippedLines[lineNumber] ?? '');
            const hasContinuation = hasTrailingBackslashContinuation(rawLine);
            const directiveSource = hasContinuation
                ? collectPreprocessorDirectiveText(rawLines, lineNumber, strippedLines, false)
                : null;
            const directiveText = directiveSource
                ? directiveSource.text
                : preparedLine;
            const directive = parsePreprocessorDirectiveLine(directiveText, { stripLineComment: false });
            const trimmed = directive?.trimmed || '';
            const keyword = directive?.keyword || '';
            const rest = directive?.rest || '';
            const nextDirectiveLine = directiveSource?.nextLine ?? (lineNumber + 1);
            const appendMaskedDirectiveLines = () => {
                appendMaskedLine(rawLine, strippedLines[lineNumber] || rawLine);
                for (let continuationLine = lineNumber + 1; continuationLine < nextDirectiveLine; continuationLine++) {
                    appendMaskedLine(
                        rawLines[continuationLine],
                        strippedLines[continuationLine] || rawLines[continuationLine]
                    );
                }
            };
            const appendRawDirectiveLines = () => {
                emitRawLine(rawLine, strippedLines[lineNumber] || rawLine);
                for (let continuationLine = lineNumber + 1; continuationLine < nextDirectiveLine; continuationLine++) {
                    appendMaskedLine(
                        rawLines[continuationLine],
                        strippedLines[continuationLine] || rawLines[continuationLine]
                    );
                }
            };

            if (!directive) {
                appendContentLine(lineNumber);
                return lineNumber + 1;
            }

            if (keyword === 'ifdef') {
                const parentActive = isActive();
                const directiveName = readDirectiveName(rest);
                const cond = isCompilerPredefinedConstantName(directiveName) ||
                    ensureDefineDeclMap().has(directiveName);
                stack.push({ parentActive, branchTaken: parentActive && cond, active: parentActive && cond });
                appendMaskedDirectiveLines();
                return nextDirectiveLine;
            }

            if (keyword === 'ifndef') {
                const parentActive = isActive();
                const directiveName = readDirectiveName(rest);
                const cond = !(
                    isCompilerPredefinedConstantName(directiveName) ||
                    ensureDefineDeclMap().has(directiveName)
                );
                stack.push({ parentActive, branchTaken: parentActive && cond, active: parentActive && cond });
                appendMaskedDirectiveLines();
                return nextDirectiveLine;
            }

            if (keyword === 'if' && rest) {
                const parentActive = isActive();
                const cond = evaluatePreprocessorCondition(rest, defineDecls, ensureDefineDeclMap(), { lineNumber });
                stack.push({ parentActive, branchTaken: parentActive && cond, active: parentActive && cond });
                appendMaskedDirectiveLines();
                return nextDirectiveLine;
            }

            if ((keyword === 'elseif' || keyword === 'elif') && rest) {
                const frame = stack[stack.length - 1];
                if (frame) {
                    const cond = frame.parentActive && !frame.branchTaken &&
                        evaluatePreprocessorCondition(rest, defineDecls, ensureDefineDeclMap(), { lineNumber });
                    frame.active = cond;
                    if (cond) frame.branchTaken = true;
                }
                appendMaskedDirectiveLines();
                return nextDirectiveLine;
            }

            if (keyword === 'else') {
                const frame = stack[stack.length - 1];
                if (frame) {
                    frame.active = frame.parentActive && !frame.branchTaken;
                    frame.branchTaken = true;
                }
                appendMaskedDirectiveLines();
                return nextDirectiveLine;
            }

            if (keyword === 'endif') {
                if (stack.length) stack.pop();
                appendMaskedDirectiveLines();
                return nextDirectiveLine;
            }

            if (keyword === 'endinput') {
                appendMaskedDirectiveLines();
                if (isActive()) {
                    appendMaskedRange(nextDirectiveLine, rawLines.length);
                    return rawLines.length;
                }
                return nextDirectiveLine;
            }

            if (!isActive()) {
                appendMaskedDirectiveLines();
                return nextDirectiveLine;
            }

            if (keyword === 'define') {
                const lineDefine = parsePreprocessorDefineDirective(directive);
                if (!lineDefine?.valid) {
                    appendRawDirectiveLines();
                    return nextDirectiveLine;
                }
                const { name, args, macroStyle, macroIndexer, value } = lineDefine;
                ensureMutableDefineDecls();
                const defineIndexMap = ensureDefineDeclIndexMap();
                const defineMap = ensureDefineDeclMap();
                const existingIndex = defineIndexMap.has(name)
                    ? defineIndexMap.get(name)
                    : -1;
                const defineDecl = {
                    name,
                    args,
                    macroStyle,
                    macroIndexer,
                    type: 'define',
                    value: value?.trim() ?? ''
                };
                if (existingIndex >= 0) {
                    defineDecls[existingIndex] = defineDecl;
                } else {
                    defineIndexMap.set(name, defineDecls.length);
                    defineDecls.push(defineDecl);
                }
                defineMap.set(name, defineDecl);
                invalidateDefineLookupValues(defineMap);
                defineStateKeyDirty = true;
                emitRawLine(rawLine, strippedLines[lineNumber] || rawLine);
                for (let continuationLine = lineNumber + 1; continuationLine < nextDirectiveLine; continuationLine++) {
                    appendMaskedLine(
                        rawLines[continuationLine],
                        strippedLines[continuationLine] || rawLines[continuationLine]
                    );
                }
                return nextDirectiveLine;
            }

            if (keyword === 'undef') {
                const undefName = readDirectiveName(rest);
                ensureMutableDefineDecls();
                const defineIndexMap = ensureDefineDeclIndexMap();
                const defineMap = ensureDefineDeclMap();
                const idx = defineIndexMap.has(undefName)
                    ? defineIndexMap.get(undefName)
                    : -1;
                if (idx >= 0) {
                    const lastIndex = defineDecls.length - 1;
                    if (idx !== lastIndex) {
                        const movedDecl = defineDecls[lastIndex];
                        defineDecls[idx] = movedDecl;
                        defineIndexMap.set(movedDecl.name, idx);
                    }
                    defineDecls.pop();
                    defineIndexMap.delete(undefName);
                }
                defineMap.delete(undefName);
                invalidateDefineLookupValues(defineMap);
                defineStateKeyDirty = true;
                appendRawDirectiveLines();
                return nextDirectiveLine;
            }

            if (keyword === 'pragma') {
                applyRationalPragmaDirective(directive);
                appendRawDirectiveLines();
                return nextDirectiveLine;
            }

            if (keyword === 'include' || keyword === 'tryinclude') {
                const includeTarget = parsePawnIncludeDirectiveTarget(trimmed);
                const includeName = includeTarget?.name || getIncludeNameFromLine(trimmed);
                if (!includeName) {
                    appendRawDirectiveLines();
                    return nextDirectiveLine;
                }
                const includeRequired = keyword === 'include';
                const fromFilePath = options.fromFilePath || '';
                const includeResolution = resolveInclude(includeName, searchPaths, fromFilePath, {
                    delimiter: includeTarget?.delimiter || '',
                    returnMeta: true
                });
                const includePath = typeof includeResolution === 'string'
                    ? includeResolution
                    : includeResolution?.filePath || '';
                if (includePath) {
                    const activeDefineStateKey = ensureDefineStateKey();
                    const includeDefineDecls = ownsDefineDecls
                        ? defineDecls.slice()
                        : defineDecls;
                    const includeEntry = {
                        name: includeName,
                        filePath: includePath,
                        defineDecls: includeDefineDecls,
                        defineStateKey: activeDefineStateKey,
                        depth: includeDepth,
                        lineNumber,
                        required: includeRequired,
                        sourcePath: includeResolution?.sourcePath || '',
                        sourcePriority: Number.isFinite(includeResolution?.sourcePriority)
                            ? includeResolution.sourcePriority
                            : Number.MAX_SAFE_INTEGER,
                        resolutionKind: includeResolution?.resolutionKind || ''
                    };
                    includeEntries.push(includeEntry);

                    const includeKey = normalizeFsPath(includePath);
                    if (includeKey && !activeFiles.has(includeKey)) {
                        const nestedIncludeDepth = includeDepth + 1;
                        const nestedSearchPaths = typeof getNestedSearchPaths === 'function'
                            ? getNestedSearchPaths(includePath, searchPaths)
                            : getSearchPaths(includePath);
                        let nestedState = !rationalState
                            ? readCachedIncludePreprocessedState(includePath, activeDefineStateKey, {
                                activeFiles,
                                includeDepth: nestedIncludeDepth,
                                baseDefineDecls: defineDecls
                            })
                            : null;
                        if (!nestedState) {
                            const includeContent = readNormalizedFileContent(includePath);
                            if (includeContent == null) {
                                appendRawDirectiveLines();
                                return nextDirectiveLine;
                            }
                            const includeCtrlCharState = typeof getCtrlCharStateForContent === 'function'
                                ? getCtrlCharStateForContent(includeContent, includePath)
                                : null;
                            try {
                                nestedState = preprocessPawnContentRef()(includeContent, {
                                    defineDecls,
                                    precomputedDefineStateKey: activeDefineStateKey,
                                    fromFilePath: includePath,
                                    searchPaths: nestedSearchPaths,
                                    rawLines: includeCtrlCharState?.rawLines,
                                    strippedLines: includeCtrlCharState?.strippedLines,
                                    lineCtrlChars: includeCtrlCharState?.lineCtrlChars || [],
                                    finalCtrlChar: includeCtrlCharState?.finalCtrlChar,
                                    directiveCandidateLines: includeCtrlCharState?.directiveCandidateLines,
                                    includeDepth: nestedIncludeDepth,
                                    activeFiles,
                                    rationalState,
                                    includePreprocessedStates,
                                    captureIncludePreprocessedStates: !!includePreprocessedStates,
                                    readCachedIncludePreprocessedState,
                                    writeCachedIncludePreprocessedState,
                                    returnState: true
                                });
                                if (!rationalState) {
                                    writeCachedIncludePreprocessedState(includePath, activeDefineStateKey, nestedState, {
                                        activeFiles,
                                        includeDepth: nestedIncludeDepth,
                                        baseDefineDecls: defineDecls
                                    });
                                }
                            } catch {
                                // Ignore unreadable includes and keep current define state.
                                nestedState = null;
                            }
                        }
                        if (nestedState) {
                            rationalState = nestedState.rationalState || rationalState;
                            includeEntry.rationalState = rationalState;
                            if (Array.isArray(nestedState.unresolvedIncludeEntries)) {
                                for (const nestedEntry of nestedState.unresolvedIncludeEntries) {
                                    if (!nestedEntry?.name) continue;
                                    unresolvedIncludeEntries.push({
                                        ...nestedEntry,
                                        parentName: nestedEntry.parentName || includeName,
                                        parentLineNumber: Number.isInteger(nestedEntry.parentLineNumber)
                                            ? nestedEntry.parentLineNumber
                                            : lineNumber
                                    });
                                }
                            }
                            if (includePreprocessedStates) {
                                includePreprocessedStates.set(
                                    getIncludePreprocessedStateKey(includePath, activeDefineStateKey, defineDecls),
                                    {
                                        content: nestedState.content,
                                        rawLines: nestedState.rawLines,
                                        strippedLines: nestedState.strippedLines,
                                        lineCtrlChars: nestedState.lineCtrlChars,
                                        finalCtrlChar: nestedState.finalCtrlChar,
                                        rationalState: nestedState.rationalState || null,
                                        directiveCandidateLines: nestedState.directiveCandidateLines,
                                        includeEntries: nestedState.includeEntries || [],
                                        unresolvedIncludeEntries: nestedState.unresolvedIncludeEntries || []
                                    }
                                );
                            }
                            defineDecls = nestedState.defineDecls || [];
                            ownsDefineDecls = false;
                            defineStateKey = String(nestedState.defineStateKey || '');
                            defineStateKeyDirty = !defineStateKey;
                            defineDeclLookup = null;
                            includeEntries.push(...nestedState.includeEntries);
                        }
                    }
                } else if (includeRequired) {
                    unresolvedIncludeEntries.push({
                        name: includeName,
                        lineNumber,
                        depth: includeDepth,
                        required: true
                    });
                }
                appendRawDirectiveLines();
                return nextDirectiveLine;
            }

            appendRawDirectiveLines();
            return nextDirectiveLine;
        };

        try {
            if (directiveCandidateLines?.length) {
                let cursor = 0;
                for (const candidateLine of directiveCandidateLines) {
                    if (!Number.isInteger(candidateLine) || candidateLine < cursor || candidateLine >= rawLines.length) {
                        continue;
                    }
                    appendContentRange(cursor, candidateLine);
                    cursor = processDirectiveLine(candidateLine);
                    if (cursor >= rawLines.length) break;
                }
                if (cursor < rawLines.length) {
                    appendContentRange(cursor, rawLines.length);
                }
            } else {
                for (let lineNumber = 0; lineNumber < rawLines.length;) {
                    lineNumber = processDirectiveLine(lineNumber);
                }
            }
        } finally {
            if (ownsActiveFile) activeFiles.delete(currentPath);
        }

        const processedRawLines = outLines || rawLines;
        const processedContent = !contentChanged && contentText.indexOf('\r') < 0
            ? contentText
            : processedRawLines.join('\n');
        if (options.returnState) {
            return createReturnedState(processedContent, includeEntries, processedRawLines);
        }
        return processedContent;
    }

    function parseEnumHeaderSpec(enumHeader) {
        const headerTail = String(enumHeader || '').replace(/^enum\b\s*/, '').trim();
        let displayName = headerTail;
        let stepSpecRaw = '';

        if (headerTail.endsWith(')')) {
            let depth = 0;
            for (let i = headerTail.length - 1; i >= 0; i--) {
                const c = headerTail[i];
                if (c === ')') {
                    depth++;
                    continue;
                }
                if (c !== '(') continue;
                depth--;
                if (depth !== 0) continue;

                const prefix = headerTail.slice(0, i).trim();
                const optionBody = headerTail.slice(i + 1, -1).trim();
                if (!prefix || /^(?:(?:[A-Za-z_@]\w*|_)\s*:\s*)?[A-Za-z_@]\w*$/.test(prefix)) {
                    displayName = prefix;
                    stepSpecRaw = optionBody;
                }
                break;
            }
        }

        const symbolMatch = displayName.match(/^(?:(?:[A-Za-z_@]\w*|_)\s*:\s*)?([A-Za-z_@]\w*)$/);
        const stepMatch = stepSpecRaw.match(/^(<<|>>|[+\-*/%|&^])?=\s*(.+)$/);
        return {
            raw: headerTail,
            displayName,
            symbolName: symbolMatch ? symbolMatch[1] : '',
            stepSpec: stepMatch ? { op: stepMatch[1] || '+', expr: stepMatch[2].trim() } : null
        };
    }

    function applyEnumStep(currentValue, stepSpec, decls = []) {
        if (!stepSpec) return currentValue + 1;
        const stepValue = evaluatePawnNumericExpr(stepSpec.expr, decls);
        if (stepValue == null) return null;
        switch (stepSpec.op) {
            case '+': return currentValue + stepValue;
            case '-': return currentValue - stepValue;
            case '*': return currentValue * stepValue;
            case '/': return stepValue === 0 ? null : Math.trunc(currentValue / stepValue);
            case '%': return stepValue === 0 ? null : currentValue % stepValue;
            case '|': return currentValue | stepValue;
            case '&': return currentValue & stepValue;
            case '^': return currentValue ^ stepValue;
            case '<<': return currentValue << stepValue;
            case '>>': return currentValue >> stepValue;
            default: return currentValue + stepValue;
        }
    }

    return {
        getIncludePreprocessedStateKey,
        knownPreprocessorDirectives,
        parsePreprocessorDirectiveLine,
        getPreprocessorDirectivePayloadRange,
        collectPreprocessorDirectiveText,
        parsePreprocessorSingleIdentifierPayload,
        parsePreprocessorDefineDirective,
        getPreprocessorDirectiveIssues,
        analyzePreprocessorConditionExpression,
        evaluatePreprocessorCondition,
        preprocessPawnContent,
        parseEnumHeaderSpec,
        applyEnumStep
    };
}

module.exports = { createPreprocessorSyntaxCore };
