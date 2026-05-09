const { getDefineStateSignature } = require('../utils/signature');
const { createMacroExpansionSyntaxCore } = require('./macro-expander');
const { createRationalPolicySyntaxCore } = require('./rational-policy');

// Shared Pawn preprocessor helpers. These are language/runtime mechanics used
// by document context, include scanning, and declaration parsing.
function createPreprocessorSyntaxCore(deps) {
    const {
        evaluatePawnNumericExpr,
        cloneDefineDecls,
        normalizeFsPath,
        getDefineStateKey,
        getSearchPaths,
        resolveInclude,
        getIncludeNameFromLine,
        collectDeclarationText,
        maskPreprocessorLine,
        stripLineComment,
        splitTopLevel,
        preprocessPawnContentRef,
        readNormalizedFileContent,
        getCachedCommentAnalysis,
        setCachedCommentAnalysis,
        buildCommentAnalysis,
        readCachedIncludePreprocessedState,
        writeCachedIncludePreprocessedState
    } = deps;
    const PREPROCESSOR_DIRECTIVE_NAMES = Object.freeze([
        'assert',
        'define',
        'else',
        'elseif',
        'emit',
        'endif',
        'endinput',
        'error',
        'file',
        'elif',
        'if',
        'ifdef',
        'ifndef',
        'include',
        'line',
        'pragma',
        'section',
        'tryinclude',
        'undef'
    ]);
    const knownPreprocessorDirectives = new Set(PREPROCESSOR_DIRECTIVE_NAMES);
    const isHorizontalSpace = charCode => charCode === 32 || charCode === 9;
    const isDirectiveIdentifierStartCode = charCode =>
        charCode === 95 || charCode === 64 ||
        (charCode >= 65 && charCode <= 90) ||
        (charCode >= 97 && charCode <= 122);
    const isDirectiveIdentifierContinueCode = charCode =>
        isDirectiveIdentifierStartCode(charCode) ||
        (charCode >= 48 && charCode <= 57);
    const getIncludePreprocessedStateKey = (filePath, defineStateKey = '', defineDecls = []) =>
        `${normalizeFsPath(filePath)}::${getDefineStateSignature(defineDecls, defineStateKey)}`;
    const rationalPolicy = createRationalPolicySyntaxCore({
        evaluatePawnNumericExpr
    });
    const macroExpansion = createMacroExpansionSyntaxCore({
        isEscapedQuote: (source, index, escapeChar) => {
            if (!escapeChar) return false;
            let count = 0;
            for (let cursor = index - 1; cursor >= 0 && source[cursor] === escapeChar; cursor--) count++;
            return (count % 2) === 1;
        },
        isIdentifierStartChar: char => isDirectiveIdentifierStartCode(String(char || '').charCodeAt(0)),
        isIdentifierContinueChar: char => isDirectiveIdentifierContinueCode(String(char || '').charCodeAt(0)),
        splitTopLevel
    });

    function skipDirectiveSpaces(source, cursor) {
        let index = Math.max(0, cursor | 0);
        while (index < source.length && isHorizontalSpace(source.charCodeAt(index))) index++;
        return index;
    }

    function readDirectiveIdentifier(source, cursor = 0) {
        const start = skipDirectiveSpaces(String(source || ''), cursor);
        const text = String(source || '');
        if (start >= text.length || !isDirectiveIdentifierStartCode(text.charCodeAt(start))) {
            return null;
        }
        let end = start + 1;
        while (end < text.length && isDirectiveIdentifierContinueCode(text.charCodeAt(end))) end++;
        return {
            name: text.slice(start, end),
            start,
            end
        };
    }

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
        let hashIndex = 0;
        while (hashIndex < directiveLine.length && isHorizontalSpace(directiveLine.charCodeAt(hashIndex))) hashIndex++;
        if (hashIndex >= directiveLine.length || directiveLine.charCodeAt(hashIndex) !== 35) return null;

        let cursor = skipDirectiveSpaces(directiveLine, hashIndex + 1);
        const keywordInfo = readDirectiveIdentifier(directiveLine, cursor);
        const keywordStart = keywordInfo?.start ?? cursor;
        const keywordEnd = keywordInfo?.end ?? cursor;
        cursor = keywordEnd;

        let payloadStart = skipDirectiveSpaces(directiveLine, cursor);
        let payloadEnd = directiveLine.length;
        while (payloadEnd > payloadStart && isHorizontalSpace(directiveLine.charCodeAt(payloadEnd - 1))) payloadEnd--;

        const keywordRaw = keywordInfo?.name || '';
        const keyword = keywordRaw.toLowerCase();
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

    function hasTrailingPreprocessorContinuation(rawLine) {
        return String(rawLine || '').trimEnd().endsWith('\\');
    }

    function collectPreprocessorDirectiveText(rawLines, startLine, preparedLines = null) {
        const sourceRawLines = Array.isArray(rawLines) ? rawLines : [];
        const sourcePreparedLines = Array.isArray(preparedLines) ? preparedLines : sourceRawLines;
        const firstLine = Math.max(0, startLine | 0);
        let lineNumber = firstLine;
        let text = '';
        let joinedCursor = 0;
        const segments = [];

        while (lineNumber < sourceRawLines.length) {
            const rawLine = String(sourceRawLines[lineNumber] || '');
            const preparedLine = String(sourcePreparedLines[lineNumber] || '');
            const continued = hasTrailingPreprocessorContinuation(rawLine);
            const segmentText = continued
                ? preparedLine.trimEnd().replace(/\\\s*$/, '')
                : preparedLine;
            const prefix = lineNumber === firstLine ? '' : ' ';
            const mappedStart = lineNumber === firstLine
                ? 0
                : (segmentText.length - segmentText.trimStart().length);
            const mappedText = lineNumber === firstLine ? segmentText : segmentText.trim();
            const joinedStart = joinedCursor + prefix.length;

            text += prefix + mappedText;
            segments.push({
                lineNumber,
                sourceStart: mappedStart,
                sourceEnd: mappedStart + mappedText.length,
                joinedStart,
                joinedEnd: joinedStart + mappedText.length
            });
            joinedCursor = text.length;
            lineNumber++;
            if (!continued) break;
        }

        const mapRange = (start, length = 1) => {
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
            segments,
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
            const closeIndex = payload.indexOf(closer, cursor + 1);
            if (closeIndex >= 0) {
                macroStyle = opener === '(' ? 'paren' : 'bracket';
                const body = payload.slice(cursor + 1, closeIndex).trim();
                if (macroStyle === 'paren') args = body;
                else macroIndexer = body;
                cursor = closeIndex + 1;
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
            const analysis = analyzePreprocessorConditionExpression(payload, defineDecls, defineLookup);
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
            const evalDecls = defineLookup ? [...defineLookup.values()] : defineDecls;
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
                    if (!payloadRange) {
                        pushIssue('validation.invalidString', {
                            start: directive.payloadStart,
                            length: 1
                        });
                        return issues;
                    }
                    const payload = line.slice(payloadRange.start, payloadRange.start + payloadRange.length);
                    const bareMatch = payload.match(/^[A-Za-z0-9_./\\-]+/);
                    if (bareMatch) {
                        pushIssue('validation.extraCharactersOnLine', getRestRangeFrom(
                            payloadRange.start + bareMatch[0].length,
                            directive.payloadEnd
                        ));
                        return issues;
                    }
                    pushIssue('validation.invalidString', getPayloadRange() || {
                        start: directive.payloadStart,
                        length: 1
                    });
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

    function normalizePreprocessorRemainingIdentifiers(source) {
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
            if (identifier.name === 'true') normalized += '1';
            else if (identifier.name === 'false') normalized += '0';
            else if (identifier.name === 'char') normalized += 'char';
            else if (identifier.name === 'cellmin') normalized += 'cellmin';
            else if (identifier.name === 'cellmax') normalized += 'cellmax';
            else normalized += '0';
            index = identifier.end;
        }
        return normalized;
    }

    function analyzePreprocessorConditionExpression(expr, defineDecls = [], defineLookup = null) {
        const hasDefine = name => defineLookup ? defineLookup.has(name) : defineDecls.some(d => d.name === name);
        const getDefine = name => defineLookup ? (defineLookup.get(name) || null) : (defineDecls.find(d => d.name === name) || null);
        const evalDecls = defineLookup ? [...defineLookup.values()] : defineDecls;
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
        const normalized = normalizePreprocessorRemainingIdentifiers(expanded.text);
        const evaluated = evaluatePawnNumericExpr(normalized, evalDecls);
        return evaluated == null
            ? { valid: false, value: null, normalized }
            : { valid: true, value: evaluated, normalized };
    }

    function evaluatePreprocessorCondition(expr, defineDecls = [], defineLookup = null) {
        return !!analyzePreprocessorConditionExpression(expr, defineDecls, defineLookup).value;
    }

    function preprocessPawnContent(content, options = {}) {
        const contentText = String(content || '');
        const hasDirectiveMarker = contentText.indexOf('#') >= 0;
        const rawLines = Array.isArray(options.rawLines)
            ? options.rawLines
            : contentText.split(/\r?\n/);
        let defineDecls = Array.isArray(options.defineDecls)
            ? options.defineDecls.slice()
            : [];
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
                let defineDeclMap = null;
                let defineDeclIndexMap = null;
                const state = {
                    content: contentText,
                    rawLines,
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
        const buildDefineDeclMap = () => new Map(defineDecls.map(decl => [decl.name, decl]));
        const buildDefineDeclIndexMap = () => new Map(defineDecls.map((decl, index) => [decl.name, index]));
        const createReturnedState = (contentValue, includeEntriesValue, processedRawLinesValue) => {
            let returnedDefineDeclMap = null;
            let returnedDefineDeclIndexMap = null;
            const state = {
                content: contentValue,
                rawLines: Array.isArray(processedRawLinesValue) ? processedRawLinesValue : rawLines,
                defineDecls,
                rationalState,
                defineStateKey: ensureDefineStateKey(),
                directiveCandidateLines,
                get defineDeclMap() {
                    if (!returnedDefineDeclMap) {
                        returnedDefineDeclMap = defineDeclMap || buildDefineDeclMap();
                    }
                    return returnedDefineDeclMap;
                },
                get defineDeclIndexMap() {
                    if (!returnedDefineDeclIndexMap) {
                        returnedDefineDeclIndexMap = defineDeclIndexMap || buildDefineDeclIndexMap();
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
        const outLines = [];
        let contentChanged = false;
        let defineDeclMap = null;
        let defineDeclIndexMap = null;
        const ensureDefineDeclMap = () => {
            if (!defineDeclMap) {
                defineDeclMap = buildDefineDeclMap();
            }
            return defineDeclMap;
        };
        const ensureDefineDeclIndexMap = () => {
            if (!defineDeclIndexMap) {
                defineDeclIndexMap = buildDefineDeclIndexMap();
            }
            return defineDeclIndexMap;
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
                    const source = String(rawLines[lineNumber] || '');
                    if (source.indexOf('#') < 0) continue;
                    let cursor = 0;
                    while (cursor < source.length) {
                        const code = source.charCodeAt(cursor);
                        if (code !== 32 && code !== 9) break;
                        cursor++;
                    }
                    if (cursor < source.length && source.charCodeAt(cursor) === 35) {
                        candidates.push(lineNumber);
                    }
                }
                return candidates;
            })();
        const readDirectiveName = rest => readDirectiveIdentifier(rest, 0)?.name || '';
        const applyRationalPragmaDirective = directive => {
            const payload = String(directive?.payload || '');
            const pragmaName = payload.trim().match(/^([A-Za-z_@]\w*)/)?.[1] || '';
            if (pragmaName.toLowerCase() !== 'rational') return false;
            const pragmaOffset = pragmaName ? payload.indexOf(pragmaName) : 0;
            const parsed = rationalPolicy.parseRationalPragmaPayload(
                payload.slice(pragmaOffset + pragmaName.length),
                defineDecls
            );
            const nextState = rationalPolicy.createRationalStateFromPragma(parsed);
            if (!rationalPolicy.getRationalFormatAlreadyDefinedIssue(rationalState, nextState) && nextState) {
                rationalState = nextState;
            }
            return true;
        };
        const collectDirectiveDeclarationText = lineNumber => {
            const collected = collectDeclarationText(rawLines, lineNumber, [], strippedLines);
            if (collected.text.indexOf('//') < 0) return collected;

            let hasLineComment = false;
            for (let currentLine = lineNumber; currentLine < collected.nextLine; currentLine++) {
                if (String(strippedLines[currentLine] || '').indexOf('//') >= 0) {
                    hasLineComment = true;
                    break;
                }
            }
            if (!hasLineComment) return collected;

            const directiveLines = [];
            for (let currentLine = lineNumber; currentLine < collected.nextLine; currentLine++) {
                const source = String(strippedLines[currentLine] || '');
                directiveLines[currentLine] = source.indexOf('//') >= 0
                    ? stripLineComment(source)
                    : source;
            }
            return collectDeclarationText(rawLines, lineNumber, [], directiveLines);
        };
        const appendContentLine = lineNumber => {
            const rawLine = rawLines[lineNumber];
            if (isActive()) {
                outLines.push(rawLine);
            } else {
                const maskedLine = maskPreprocessorLine(rawLine);
                if (maskedLine !== rawLine) contentChanged = true;
                outLines.push(maskedLine);
            }
        };
        const appendMaskedLine = rawLine => {
            const maskedLine = maskPreprocessorLine(rawLine);
            if (maskedLine !== rawLine) contentChanged = true;
            outLines.push(maskedLine);
        };
        const appendContentRange = (startLine, endLineExclusive) => {
            for (let lineNumber = Math.max(0, startLine); lineNumber < endLineExclusive; lineNumber++) {
                appendContentLine(lineNumber);
            }
        };

        const processDirectiveLine = lineNumber => {
            const rawLine = rawLines[lineNumber];
            const directiveSource = collectPreprocessorDirectiveText(rawLines, lineNumber, strippedLines);
            const directive = parsePreprocessorDirectiveLine(directiveSource.text);
            const trimmed = directive?.trimmed || '';
            const keyword = directive?.keyword || '';
            const rest = directive?.rest || '';
            const nextDirectiveLine = directiveSource.nextLine;
            const appendMaskedDirectiveLines = () => {
                appendMaskedLine(rawLine);
                for (let continuationLine = lineNumber + 1; continuationLine < nextDirectiveLine; continuationLine++) {
                    appendMaskedLine(rawLines[continuationLine]);
                }
            };
            const appendRawDirectiveLines = () => {
                outLines.push(rawLine);
                for (let continuationLine = lineNumber + 1; continuationLine < nextDirectiveLine; continuationLine++) {
                    appendMaskedLine(rawLines[continuationLine]);
                }
            };

            if (!directive) {
                appendContentLine(lineNumber);
                return lineNumber + 1;
            }

            if (keyword === 'ifdef') {
                const parentActive = isActive();
                const cond = ensureDefineDeclMap().has(readDirectiveName(rest));
                stack.push({ parentActive, branchTaken: parentActive && cond, active: parentActive && cond });
                appendMaskedDirectiveLines();
                return nextDirectiveLine;
            }

            if (keyword === 'ifndef') {
                const parentActive = isActive();
                const cond = !ensureDefineDeclMap().has(readDirectiveName(rest));
                stack.push({ parentActive, branchTaken: parentActive && cond, active: parentActive && cond });
                appendMaskedDirectiveLines();
                return nextDirectiveLine;
            }

            if (keyword === 'if' && rest) {
                const parentActive = isActive();
                const cond = evaluatePreprocessorCondition(rest, defineDecls, ensureDefineDeclMap());
                stack.push({ parentActive, branchTaken: parentActive && cond, active: parentActive && cond });
                appendMaskedDirectiveLines();
                return nextDirectiveLine;
            }

            if ((keyword === 'elseif' || keyword === 'elif') && rest) {
                const frame = stack[stack.length - 1];
                if (frame) {
                    const cond = frame.parentActive && !frame.branchTaken &&
                        evaluatePreprocessorCondition(rest, defineDecls, ensureDefineDeclMap());
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
                    appendContentRange(nextDirectiveLine, rawLines.length);
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
                const { text: joinedDefine, nextLine } = collectDirectiveDeclarationText(lineNumber);
                const parsedDefine = parsePreprocessorDefineDirective(joinedDefine);
                const parsed = parsedDefine?.valid ? parsedDefine : lineDefine;
                const { name, args, macroStyle, macroIndexer, value } = parsed;
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
                defineStateKeyDirty = true;
                outLines.push(rawLine);
                for (let continuationLine = lineNumber + 1; continuationLine < nextLine; continuationLine++) {
                    appendMaskedLine(rawLines[continuationLine]);
                }
                return nextLine;
            }

            if (keyword === 'undef') {
                const undefName = readDirectiveName(rest);
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
                defineStateKeyDirty = true;
                appendRawDirectiveLines();
                return nextDirectiveLine;
            }

            if (keyword === 'pragma') {
                applyRationalPragmaDirective(directive);
                appendRawDirectiveLines();
                return nextDirectiveLine;
            }

            if (keyword === 'include') {
                const includeName = getIncludeNameFromLine(trimmed);
                if (!includeName) {
                    appendRawDirectiveLines();
                    return nextDirectiveLine;
                }
                const fromFilePath = options.fromFilePath || '';
                const includePath = resolveInclude(includeName, searchPaths, fromFilePath);
                if (includePath) {
                    const activeDefineStateKey = ensureDefineStateKey();
                    const includeEntry = {
                        name: includeName,
                        filePath: includePath,
                        defineDecls: defineDecls.slice(),
                        defineStateKey: activeDefineStateKey,
                        depth: includeDepth,
                        lineNumber
                    };
                    includeEntries.push(includeEntry);

                    const includeKey = normalizeFsPath(includePath);
                    if (includeKey && !activeFiles.has(includeKey)) {
                        const nestedIncludeDepth = includeDepth + 1;
                        const nestedSearchPaths = getSearchPaths(includePath);
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
                            try {
                                nestedState = preprocessPawnContentRef()(includeContent, {
                                    defineDecls,
                                    precomputedDefineStateKey: activeDefineStateKey,
                                    fromFilePath: includePath,
                                    searchPaths: nestedSearchPaths,
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
                                        rationalState: nestedState.rationalState || null,
                                        directiveCandidateLines: nestedState.directiveCandidateLines,
                                        includeEntries: nestedState.includeEntries || [],
                                        unresolvedIncludeEntries: nestedState.unresolvedIncludeEntries || []
                                    }
                                );
                            }
                            defineDecls = nestedState.defineDecls || [];
                            defineStateKey = String(nestedState.defineStateKey || '');
                            defineStateKeyDirty = !defineStateKey;
                            defineDeclMap = nestedState.defineDeclMap || buildDefineDeclMap();
                            defineDeclIndexMap = nestedState.defineDeclIndexMap || buildDefineDeclIndexMap();
                            includeEntries.push(...nestedState.includeEntries);
                        }
                    }
                } else {
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

        const processedContent = !contentChanged && contentText.indexOf('\r') < 0
            ? contentText
            : outLines.join('\n');
        if (options.returnState) {
            return createReturnedState(processedContent, includeEntries, outLines);
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
