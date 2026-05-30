// Shared declaration parsing/runtime helpers. This keeps declaration parsing
// consistent across include parsing, document context building, hover, and
// live validation instead of letting each feature drift on its own rules.
const {
    mayHaveDocsForLine,
    attachLazyDocs,
    parseDeprecatedPragmaMessage,
    applyDeprecatedPragmaToNextDecl
} = require('./docs');
const {
    countLineBreaks,
    isExplicitDeclarationStartLine,
    isPawnIdentifierContinueCode,
    isPawnIdentifierStartCode,
    isPreprocessorDirectiveLine,
    isPotentialDeclarationStartLine,
    isPotentialEnumDeclarationLine,
    isVariableDeclarationContinuationLine,
    isWhitespaceCharCode
} = require('./line-utils');
const { createDefineDeclarationEventCore } = require('./define-events');
const { hasAnyDeclModifier } = require('./modifiers');
const { createEnumSyntaxDiagnosticsCore } = require('./enum-syntax');
const { findBalancedGroupEnd } = require('../syntax/balanced');
const { startsWithLocalDeclarationKeyword } = require('../syntax/keywords');
const { createMacroExpansionSyntaxCore } = require('../syntax/macro-expander');
const { createVirtualExpandedLineContextCore } = require('../syntax/virtual-expanded-line-context');
const { getPreprocessedCtrlCharState } = require('../syntax/preprocessed-state');
const {
    attachLazyPrecomputedDeclBuckets,
    buildDeclBuckets,
    findDeclInNameBuckets
} = require('../lookup/precomputed-buckets');
const { maskPreprocessorDirectiveLines } = require('../syntax/preprocessor-lines');

function createDeclarationParsingCore(deps) {
    const {
        normalizeFsPath,
        getFuncArgsParseCacheKey,
        funcArgsParseCache,
        getActiveCtrlChar,
        splitTopLevel,
        isEscapedQuote,
        extractParenContent,
        stripLineComment,
        parseEnumHeaderSpec,
        parseDimsParts,
        parseDimSpec,
        evaluatePawnNumericExpr,
        findDeclByNameCached,
        getDeclNameBuckets,
        BUILTIN_DECLS = [],
        formatAutoEnumValueDisplay,
        formatResolvedEnumValueDisplay,
        applyEnumStep,
        escapeRegExp,
        extractDocs,
        FORBIDDEN,
        TAG_RE,
        NAME_RE,
        MOD_RE,
        VAR_MODS,
        parseDims,
        parseValueAndRemainder,
        parsePreprocessorDirectiveLine,
        parsePreprocessorSingleIdentifierPayload,
        parsePreprocessorDefineDirective,
        parseFunctionStateSpecTail,
        computeLineDepths,
        collectDeclarationText,
        collectForHeaderText,
        withCtrlCharForContent,
        getCtrlCharStateForContent,
        preprocessPawnContent,
        buildDependencyStampMap,
        areDependencyStampsFresh,
        fileDeclParseCache,
        getFileSnapshot,
        isObjectLikeDefineDecl,
        isFunctionLikeDefineDecl,
        parseSingleStatementBodyDecls,
        findStatementScopeEndLine,
        findForScopeEndLine,
        findDepthScopeEndLine
    } = deps;
    const macroExpansionCore = createMacroExpansionSyntaxCore({
        isEscapedQuote,
        isIdentifierStartChar: char => isPawnIdentifierStartCode(String(char || '').charCodeAt(0)),
        isIdentifierContinueChar: char => isPawnIdentifierContinueCode(String(char || '').charCodeAt(0)),
        splitTopLevel
    });
    const virtualExpandedLineContextCore = createVirtualExpandedLineContextCore({
        macroExpansionCore,
        isFunctionLikeDefineDecl
    });
    const {
        collectEnumMemberSyntaxIssues,
        parseEnumMemberPrefix,
        parseEnumMemberPrefixFrom,
        splitTopLevelWithOffsets
    } = createEnumSyntaxDiagnosticsCore({
        FORBIDDEN,
        getActiveCtrlChar,
        isEscapedQuote,
        stripLineComment
    });
    const enumEvalOuterDeclsCache = new WeakMap();
    const filterEnumEvalOuterDecls = decls => {
        if (!Array.isArray(decls)) return [];
        const cached = enumEvalOuterDeclsCache.get(decls);
        if (cached) return cached;
        const filtered = [];
        for (const decl of decls) {
            if (
                decl?.type === 'define' ||
                decl?.type === 'enum' ||
                decl?.type === 'enum-item'
            ) {
                filtered.push(decl);
            }
        }
        enumEvalOuterDeclsCache.set(decls, filtered);
        return filtered;
    };

    function createEnumEvalLookup(outerDecls = [], enumDecls = []) {
        const outerSource = Array.isArray(outerDecls) ? outerDecls : [];
        const enumSource = Array.isArray(enumDecls) ? enumDecls : [];
        let outerNameBuckets = null;
        let builtinNameBuckets = null;
        let enumIndexedCount = 0;
        const enumNameBuckets = new Map();

        const getOuterNameBuckets = () => {
            if (!outerNameBuckets) {
                outerNameBuckets = typeof getDeclNameBuckets === 'function'
                    ? getDeclNameBuckets(outerSource)
                    : buildDeclBuckets(outerSource).nameBuckets;
            }
            return outerNameBuckets;
        };
        const getBuiltinNameBuckets = () => {
            if (!builtinNameBuckets) {
                builtinNameBuckets = buildDeclBuckets(BUILTIN_DECLS).nameBuckets;
            }
            return builtinNameBuckets;
        };
        const getEnumNameBuckets = () => {
            while (enumIndexedCount < enumSource.length) {
                const decl = enumSource[enumIndexedCount++];
                if (!decl?.name) continue;
                const bucket = enumNameBuckets.get(decl.name);
                if (bucket) bucket.push(decl);
                else enumNameBuckets.set(decl.name, [decl]);
            }
            return enumNameBuckets;
        };
        const findLocal = (name, predicate = null) =>
            findDeclInNameBuckets(getOuterNameBuckets(), name, predicate) ||
            findDeclInNameBuckets(getEnumNameBuckets(), name, predicate);
        const findBuiltin = (name, predicate = null) => {
            if (!Array.isArray(BUILTIN_DECLS) || !BUILTIN_DECLS.length) return null;
            return typeof findDeclByNameCached === 'function'
                ? findDeclByNameCached(BUILTIN_DECLS, name, predicate)
                : findDeclInNameBuckets(getBuiltinNameBuckets(), name, predicate);
        };
        const findDefineByName = name =>
            findLocal(name, item => item.type === 'define') ||
            findBuiltin(name, item => item.type === 'define');

        return {
            findDeclByName: findLocal,
            findAnyDeclByName: (name, predicate = null) =>
                findLocal(name, predicate) || findBuiltin(name, predicate),
            findDefineByName
        };
    }

    function parseVarPiece(piece, modifiers, filePath, fileName, lineNumber, docs, mayHaveDocs = true) {
        let s = piece.trim().replace(/;$/, '').trim();
        if (!s) return null;
        let typeTag = '';
        const tm = s.match(TAG_RE);
        if (tm) { typeTag = tm[1]; s = s.slice(tm[0].length); }
        const nm = s.match(NAME_RE);
        if (!nm) return null;
        const name = nm[1];
        if (FORBIDDEN.has(name)) return null;
        s = s.slice(nm[0].length).trimStart();
        const { dims, rest } = parseDims(s);
        const value = rest.startsWith('=') ? rest.slice(1).trim().replace(/;$/, '').trim() : '';
        const decl = {
            name, args: '', type: 'variable',
            typeTag, modifiers: [...modifiers], dims,
            file: fileName, filePath, lineNumber, value
        };
        return attachLazyDocs(
            decl,
            'docs',
            typeof docs === 'function' ? docs : () => docs ?? '',
            mayHaveDocs
        );
    }

    function expandDeclarationArgMacros(argsStr, defineDecls = [], escapeChar = getActiveCtrlChar()) {
        const source = String(argsStr || '').trim();
        if (!source || !Array.isArray(defineDecls) || !defineDecls.length) return source;
        return splitTopLevel(source, escapeChar)
            .map(piece => {
                const part = String(piece || '').trim();
                if (!part || part === '...') return part;
                return expandDeclarationHeadMacro(part, defineDecls, escapeChar) || part;
            })
            .join(', ');
    }

    function parseFuncArgs(argsStr, filePath, fileName, lineNumber, escapeChar = getActiveCtrlChar(), options = {}) {
        if (!argsStr?.trim()) return [];
        const effectiveArgsStr = expandDeclarationArgMacros(argsStr, options.defineDecls, escapeChar);

        const cacheKey = getFuncArgsParseCacheKey(effectiveArgsStr, filePath, lineNumber, escapeChar);
        const cached = funcArgsParseCache.get(cacheKey);
        if (cached) return cached;

        const parsedArgs = splitTopLevel(effectiveArgsStr, escapeChar).flatMap(piece => {
            piece = piece.trim();
            if (!piece || piece === '...') return [];
            const modifiers = [];
            if (/^const\b/.test(piece)) { modifiers.push('const'); piece = piece.slice(5).trimStart(); }
            if (piece.startsWith('&'))  { modifiers.push('&');     piece = piece.slice(1).trimStart(); }
            let typeTag = '';
            const tm = piece.match(TAG_RE);
            if (tm) { typeTag = tm[1]; piece = piece.slice(tm[0].length); }
            const nm = piece.match(NAME_RE);
            if (!nm) return [];
            const name = nm[1];
            if (FORBIDDEN.has(name)) return [];
            piece = piece.slice(nm[0].length).trimStart();
            const { dims, rest } = parseDims(piece);
            const value = rest.startsWith('=') ? rest.slice(1).trim().replace(/;$/, '').trim() : '';
            return [{
                name, args: '', type: 'variable',
                typeTag, modifiers, dims,
                file: fileName, filePath, lineNumber, value, docs: '',
                isArg: true
            }];
        });
        funcArgsParseCache.set(cacheKey, parsedArgs);
        return parsedArgs;
    }

    function findMatchingParenInText(source, openIndex, escapeChar = getActiveCtrlChar()) {
        return findBalancedGroupEnd(source, openIndex, '(', ')', {
            escapeChar,
            isEscapedQuote
        });
    }

    function parseForInit(lineText, rawLines, filePath, fileName, lineNumber, escapeChar = getActiveCtrlChar(), options = {}) {
        const content = extractParenContent(lineText, escapeChar);
        if (!content) return [];
        let d = 0, inStr = false, strCh = '', semiIdx = -1;
        for (let i = 0; i < content.length; i++) {
            const c = content[i];
            if (inStr) { if (c === strCh && !isEscapedQuote(content, i, escapeChar)) inStr = false; continue; }
            if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
            if ('[({'.includes(c)) d++;
            else if ('])}'.includes(c)) d--;
            else if (c === ';' && d === 0) { semiIdx = i; break; }
        }
        const initPart = (semiIdx >= 0 ? content.slice(0, semiIdx) : content).trim();
        if (!initPart) return [];
        return parseDeclLine(
            { text: initPart, startLine: lineNumber },
            rawLines, filePath, fileName, 'local',
            {
                ...options,
                escapeChar
            }
        ).map(v => ({ ...v, isForVar: true }));
    }

    function findIdentifierSpanForOccurrenceInLine(source, name, occurrenceIndex = 0) {
        const lineText = String(source || '');
        const target = String(name || '');
        if (!target) return null;
        let seenCount = 0;
        for (let index = 0; index < lineText.length;) {
            const foundIndex = lineText.indexOf(target, index);
            if (foundIndex < 0) break;
            const beforeCode = lineText.charCodeAt(foundIndex - 1);
            const afterCode = lineText.charCodeAt(foundIndex + target.length);
            if (!isPawnIdentifierContinueCode(beforeCode) && !isPawnIdentifierContinueCode(afterCode)) {
                if (seenCount === occurrenceIndex) {
                    return {
                        start: foundIndex,
                        end: foundIndex + target.length
                    };
                }
                seenCount++;
            }
            index = foundIndex + target.length;
        }
        return null;
    }

    function findSameLineMatchingBracket(source, openIndex) {
        const lineText = String(source || '');
        let depth = 0;
        for (let index = openIndex; index < lineText.length; index++) {
            const char = lineText[index];
            if (char === '[') {
                depth++;
                continue;
            }
            if (char === ']') {
                depth--;
                if (depth === 0) return index;
            }
        }
        return -1;
    }

    function readUnexpectedVariableDeclarationTail(source, decl, occurrenceIndex = 0) {
        const lineText = String(source || '');
        if (!decl?.name) return null;
        const nameSpan = findIdentifierSpanForOccurrenceInLine(lineText, decl.name, occurrenceIndex);
        if (!nameSpan) return null;
        let cursor = nameSpan.end;
        while (cursor < lineText.length && isWhitespaceCharCode(lineText.charCodeAt(cursor))) cursor++;
        while (lineText[cursor] === '[') {
            const closeIndex = findSameLineMatchingBracket(lineText, cursor);
            if (closeIndex < 0) return null;
            cursor = closeIndex + 1;
            while (cursor < lineText.length && isWhitespaceCharCode(lineText.charCodeAt(cursor))) cursor++;
        }

        const char = lineText[cursor] || '';
        if (!char || char === '=' || char === ',' || char === ';') return null;
        if (char === '/' && (lineText[cursor + 1] === '/' || lineText[cursor + 1] === '*')) return null;

        let end = cursor + 1;
        while (
            end < lineText.length &&
            !isWhitespaceCharCode(lineText.charCodeAt(end)) &&
            !/[\s=,;[\](){}]/.test(lineText[end] || '') &&
            !(lineText[end] === '/' && (lineText[end + 1] === '/' || lineText[end + 1] === '*'))
        ) {
            end++;
        }
        return {
            start: cursor,
            end: Math.max(cursor + 1, end),
            token: lineText.slice(cursor, Math.max(cursor + 1, end))
        };
    }

    function nextMeaningfulLineCannotContinueVariableDeclaration(options = {}) {
        const lineNumber = Number.isInteger(options?.lineNumber) ? options.lineNumber : -1;
        const sourceLines = Array.isArray(options?.strippedLines)
            ? options.strippedLines
            : (Array.isArray(options?.rawLines) ? options.rawLines : null);
        if (!sourceLines || lineNumber < 0) return false;

        for (let probeLine = lineNumber + 1; probeLine < sourceLines.length; probeLine++) {
            const trimmed = String(sourceLines[probeLine] || '').trim();
            if (!trimmed) continue;
            return isPreprocessorDirectiveLine(trimmed) ||
                isExplicitDeclarationStartLine(trimmed) ||
                !isVariableDeclarationContinuationLine(trimmed);
        }
        return true;
    }

    function readUnexpectedTrailingDeclarationComma(source, decls = [], options = {}) {
        if (!nextMeaningfulLineCannotContinueVariableDeclaration(options)) return null;
        const lineNumber = Number.isInteger(options?.lineNumber) ? options.lineNumber : -1;
        const lineDecls = (decls || []).filter(decl =>
            decl?.type === 'variable' &&
            !decl.macroExpandedDeclaration &&
            (!Number.isInteger(lineNumber) || decl.lineNumber === lineNumber)
        );
        if (!lineDecls.length) return null;

        const lineText = String(source || '');
        const sourceWithoutComment = stripLineComment(lineText, options?.escapeChar || getActiveCtrlChar());
        const trimmedEnd = String(sourceWithoutComment || '').trimEnd();
        if (!trimmedEnd.endsWith(',')) return null;
        return {
            decl: lineDecls[lineDecls.length - 1],
            start: Math.max(0, trimmedEnd.length - 1)
        };
    }

    function collectVariableDeclarationSyntaxIssuesForLine(source, decls = [], options = {}) {
        const variableDecls = (decls || [])
            .filter(decl => decl?.type === 'variable' && !decl.macroExpandedDeclaration);
        const issues = [];
        const trailingComma = readUnexpectedTrailingDeclarationComma(source, variableDecls, options);
        if (trailingComma) {
            issues.push({
                decl: trailingComma.decl,
                startIndex: trailingComma.start,
                length: 1,
                messageKey: 'validation.unexpectedToken',
                params: { token: ',' }
            });
        }
        const occurrenceByName = new Map();
        for (let index = 0; index < variableDecls.length; index++) {
            const decl = variableDecls[index];
            const declName = decl?.name || '';
            const sameNameOccurrenceIndex = declName ? (occurrenceByName.get(declName) || 0) : 0;
            if (declName) occurrenceByName.set(declName, sameNameOccurrenceIndex + 1);
            const invalidTail = readUnexpectedVariableDeclarationTail(source, decl, sameNameOccurrenceIndex);
            if (!invalidTail) continue;
            issues.push({
                decl,
                startIndex: invalidTail.start,
                length: Math.max(1, invalidTail.end - invalidTail.start),
                messageKey: 'validation.unexpectedToken',
                params: { token: invalidTail.token }
            });
        }
        return issues;
    }

    function parseEnumBlock(rawLines, startLine, filePath, fileName, lineCtrlChars = [], strippedLines = null, outerDecls = []) {
        const scanLines = strippedLines || rawLines;
        const firstEscapeChar = lineCtrlChars[startLine] || getActiveCtrlChar();
        if (!isPotentialEnumDeclarationLine(scanLines[startLine])) return null;

        let braceDepth = 0;
        let foundOpen = false;
        let blockComment = false;
        let inStr = false;
        let strCh = 0;
        let endLine = startLine;

        if (Array.isArray(strippedLines)) {
            outer:
            for (let lineNo = startLine; lineNo < strippedLines.length; lineNo++) {
                const line = strippedLines[lineNo] || '';
                const escapeChar = lineCtrlChars[lineNo] || getActiveCtrlChar();
                endLine = lineNo;

                for (let i = 0; i < line.length; i++) {
                    const code = line.charCodeAt(i);
                    if (inStr) {
                        if (code === strCh && !isEscapedQuote(line, i, escapeChar)) inStr = false;
                        continue;
                    }
                    if (code === 34 || code === 39) { inStr = true; strCh = code; continue; }
                    if (code === 123) {
                        braceDepth++;
                        foundOpen = true;
                    } else if (code === 125) {
                        braceDepth--;
                        if (foundOpen && braceDepth === 0) break outer;
                    }
                }
            }
        } else {
            outer:
            for (let lineNo = startLine; lineNo < rawLines.length; lineNo++) {
                const line = rawLines[lineNo] || '';
                const escapeChar = lineCtrlChars[lineNo] || getActiveCtrlChar();
                endLine = lineNo;

                for (let i = 0; i < line.length; i++) {
                    const code = line.charCodeAt(i);
                    const nextCode = line.charCodeAt(i + 1);

                    if (blockComment) {
                        if (code === 42 && nextCode === 47) { blockComment = false; i++; }
                        continue;
                    }
                    if (inStr) {
                        if (code === strCh && !isEscapedQuote(line, i, escapeChar)) inStr = false;
                        continue;
                    }
                    if (code === 47 && nextCode === 47) break;
                    if (code === 47 && nextCode === 42) { blockComment = true; i++; continue; }
                    if (code === 34 || code === 39) { inStr = true; strCh = code; continue; }
                    if (code === 123) {
                        braceDepth++;
                        foundOpen = true;
                    } else if (code === 125) {
                        braceDepth--;
                        if (foundOpen && braceDepth === 0) break outer;
                    }
                }
            }
        }

        if (!foundOpen || braceDepth !== 0) return null;

        const headerSourceLines = Array.isArray(strippedLines) ? strippedLines : rawLines;
        const hasStrippedHeaderSource = headerSourceLines !== rawLines;
        let text = '';
        let headerSourceText = '';
        let openIdx = -1;
        let closeIdx = -1;
        if (hasStrippedHeaderSource) {
            const scanBlockLines = new Array(endLine - startLine + 1);
            for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
                scanBlockLines[lineNumber - startLine] = String(headerSourceLines[lineNumber] || '');
            }
            headerSourceText = scanBlockLines.join('\n');
            openIdx = headerSourceText.indexOf('{');
            closeIdx = headerSourceText.lastIndexOf('}');
        } else {
            const rawBlockLines = rawLines.slice(startLine, endLine + 1);
            text = rawBlockLines.join('\n');
            headerSourceText = text;
            openIdx = text.indexOf('{');
            closeIdx = text.lastIndexOf('}');
        }
        if (openIdx < 0 || closeIdx <= openIdx) return null;
        const enumHeaderSource = openIdx >= 0
            ? headerSourceText.slice(0, openIdx)
            : text.slice(0, openIdx);
        const enumHeader = enumHeaderSource.replace(/\s+/g, ' ').trim();
        const enumHeaderSpec = parseEnumHeaderSpec(enumHeader);
        const enumName = enumHeaderSpec.displayName;
        const enumSymbolName = enumHeaderSpec.symbolName;

        const enumMayHaveDocs = mayHaveDocsForLine(rawLines, startLine);
        const getEnumDocs = enumMayHaveDocs
            ? (() => {
                let resolved = false;
                let value = '';
                return () => {
                    if (!resolved) {
                        value = rawLines.length
                            ? extractDocs(rawLines, startLine, {
                                includeInline: true,
                                escapeChar: firstEscapeChar,
                                lineCtrlChars
                            })
                            : '';
                        resolved = true;
                    }
                    return value;
                };
            })()
            : null;
        const decls = [];
        const enumMembers = [];
        const hasOuterDecls = Array.isArray(outerDecls) && outerDecls.length;
        let enumEvalDeclsCache = null;
        let enumEvalDeclsCacheDeclCount = -1;
        const enumEvalLookup = createEnumEvalLookup(outerDecls, decls);
        let enumEvalAnalysisCache = null;
        let enumEvalAnalysisCacheDeclCount = -1;
        const getEnumEvalDecls = () => {
            if (!hasOuterDecls) return decls;
            if (enumEvalDeclsCache && enumEvalDeclsCacheDeclCount === decls.length) {
                return enumEvalDeclsCache;
            }
            enumEvalDeclsCacheDeclCount = decls.length;
            enumEvalDeclsCache = outerDecls.concat(decls);
            return enumEvalDeclsCache;
        };
        const getEnumEvalAnalysisCache = () => {
            if (enumEvalAnalysisCache && enumEvalAnalysisCacheDeclCount === decls.length) {
                return enumEvalAnalysisCache;
            }
            enumEvalAnalysisCacheDeclCount = decls.length;
            enumEvalAnalysisCache = {
                ...enumEvalLookup,
                numericExprByText: new Map()
            };
            return enumEvalAnalysisCache;
        };
        let nextValue = 0;
        let canAutoValue = true;
        const strippedBlockText = headerSourceText;
        const bodySource = (
            openIdx >= 0 && closeIdx > openIdx
                ? strippedBlockText.slice(openIdx + 1, closeIdx)
                : (text || headerSourceText).slice(openIdx + 1, closeIdx).replace(/\/\*[\s\S]*?\*\//g, '')
        );
        const body = maskPreprocessorDirectiveLines(bodySource);
        const bodyBlockOffset = openIdx + 1;
        const bodyStartLineOffset = countLineBreaks(strippedBlockText, 0, bodyBlockOffset);

        for (const rawPart of splitTopLevelWithOffsets(body)) {
            const rawPiece = rawPart.text;
            const sourcePiece = stripLineComment(rawPiece);
            let memberPrefix = parseEnumMemberPrefix(sourcePiece);
            if (!memberPrefix && sourcePiece.indexOf('\n') >= 0) {
                let lineStart = 0;
                let lineOffset = 0;
                while (lineStart < sourcePiece.length) {
                    const newlineIndex = sourcePiece.indexOf('\n', lineStart);
                    if (newlineIndex < 0) break;
                    lineStart = newlineIndex + 1;
                    lineOffset++;
                    memberPrefix = parseEnumMemberPrefixFrom(sourcePiece, lineStart, 0, lineOffset);
                    if (memberPrefix) break;
                }
            }
            if (!memberPrefix) continue;
            const { typeTag, name, nameOffsetInPiece } = memberPrefix;
            const piece = memberPrefix.rest;
            const { dims, rest } = parseDims(piece);
            const value = rest.startsWith('=') ? rest.slice(1).trim().replace(/;$/, '').trim() : '';

            let displayValue = '';
            let valueDisplay = '';
            let explicitInt = null;
            let enumEvalDecls = null;
            const getCurrentEnumEvalDecls = () => {
                if (!enumEvalDecls) enumEvalDecls = getEnumEvalDecls();
                return enumEvalDecls;
            };
            if (!value && canAutoValue) {
                displayValue = String(nextValue);
                valueDisplay = enumHeaderSpec.stepSpec
                    ? formatAutoEnumValueDisplay(
                        nextValue,
                        enumHeaderSpec.stepSpec,
                        getCurrentEnumEvalDecls(),
                        getEnumEvalAnalysisCache()
                    )
                    : displayValue;
            } else if (value) {
                explicitInt = evaluatePawnNumericExpr(
                    value,
                    getCurrentEnumEvalDecls(),
                    null,
                    getEnumEvalAnalysisCache()
                );
                if (explicitInt != null) {
                    displayValue = String(explicitInt);
                    valueDisplay = formatResolvedEnumValueDisplay(value, displayValue);
                } else {
                    displayValue = value;
                    valueDisplay = value;
                }
            }

            const lineNumber = startLine +
                bodyStartLineOffset +
                rawPart.startLineOffset +
                (memberPrefix.nameLineOffsetInPiece || 0);
            const memberMayHaveDocs = mayHaveDocsForLine(rawLines, lineNumber);
            const getMemberDocs = memberMayHaveDocs
                ? (() => {
                    let resolved = false;
                    let value = '';
                    return () => {
                        if (!resolved) {
                            value = rawLines.length
                                ? extractDocs(rawLines, lineNumber, {
                                    includeInline: true,
                                    escapeChar: lineCtrlChars[lineNumber] || firstEscapeChar,
                                    lineCtrlChars
                                })
                                : '';
                            resolved = true;
                        }
                        return value;
                    };
                })()
                : null;

            const enumDecl = {
                name,
                args: '',
                type: 'enum-item',
                typeTag,
                modifiers: [],
                dims,
                file: fileName,
                filePath,
                lineNumber,
                enumName,
                value: displayValue,
                valueDisplay
            };
            attachLazyDocs(enumDecl, 'docs', getMemberDocs, memberMayHaveDocs);
            attachLazyDocs(enumDecl, 'enumDocs', getEnumDocs, enumMayHaveDocs);
            decls.push(enumDecl);
            enumMembers.push(enumDecl);

            let step = 1;
            const dimsParts = parseDimsParts(dims);
            const dimsSpecs = dimsParts.length
                ? dimsParts.map(part => parseDimSpec(part, getEnumEvalDecls(), null, getEnumEvalAnalysisCache()))
                : [];
            if (dimsSpecs.length && dimsSpecs.every(spec => spec.capacity != null)) {
                const product = dimsSpecs.reduce((acc, spec) => acc * Math.max(1, spec.capacity), 1);
                step = Number.isFinite(product) && product > 0 ? product : 1;
            }

            if (value) {
                if (explicitInt == null) {
                    canAutoValue = false;
                } else {
                    const stepped = enumHeaderSpec.stepSpec
                        ? applyEnumStep(
                            explicitInt,
                            enumHeaderSpec.stepSpec,
                            getCurrentEnumEvalDecls(),
                            getEnumEvalAnalysisCache()
                        )
                        : explicitInt + step;
                    if (stepped == null) {
                        canAutoValue = false;
                    } else {
                        nextValue = stepped;
                    }
                }
            } else if (canAutoValue) {
                const stepped = enumHeaderSpec.stepSpec
                    ? applyEnumStep(
                        nextValue,
                        enumHeaderSpec.stepSpec,
                        getCurrentEnumEvalDecls(),
                        getEnumEvalAnalysisCache()
                    )
                    : nextValue + step;
                if (stepped == null) {
                    canAutoValue = false;
                } else {
                    nextValue = stepped;
                }
            }
        }

        const enumSymbolDecl = {
            name: enumSymbolName || '',
            args: '',
            type: 'enum',
            typeTag: '',
            modifiers: [],
            dims: '',
            file: fileName,
            filePath,
            lineNumber: startLine,
            enumName: enumName,
            enumDisplayName: enumName || enumHeaderSpec.raw || '',
            enumMembers,
            value: canAutoValue ? String(nextValue) : ''
        };
        attachLazyDocs(enumSymbolDecl, 'docs', getEnumDocs, enumMayHaveDocs);
        decls.unshift(enumSymbolDecl);

        return { decls, nextLine: endLine + 1 };
    }

    function expandDeclarationHeadMacro(line, defineDecls = [], escapeChar = getActiveCtrlChar()) {
        if (!Array.isArray(defineDecls) || !defineDecls.length) return '';
        const source = String(line || '').trim();
        if (!source || isPreprocessorDirectiveLine(source)) return '';

        let rest = source;
        let prefixLength = 0;
        let match;
        while ((match = rest.match(MOD_RE))) {
            prefixLength += match[0].length;
            rest = rest.slice(match[0].length);
        }
        const tagMatch = rest.match(TAG_RE);
        if (tagMatch) {
            prefixLength += tagMatch[0].length;
            rest = rest.slice(tagMatch[0].length);
        }

        const nameMatch = rest.match(NAME_RE);
        if (!nameMatch) return '';
        const macroName = nameMatch[1];
        const defineDecl = virtualExpandedLineContextCore.findFunctionLikeDefineDecl(defineDecls, macroName);
        if (!defineDecl) return '';

        const nameStart = prefixLength;
        const nameEnd = nameStart + nameMatch[0].length;
        let openIndex = nameEnd;
        while (openIndex < source.length && /\s/.test(source[openIndex] || '')) openIndex++;
        if (source[openIndex] !== '(') return '';
        const closeIndex = macroExpansionCore.findMatchingParenIndex(source, openIndex, escapeChar);
        if (closeIndex < 0) return '';

        const replacement = macroExpansionCore.expandFunctionLikeDefineCall(
            defineDecl,
            source.slice(openIndex + 1, closeIndex),
            {
                escapeChar,
                defineDecls,
                expandActualArgs: false
            }
        );
        if (!replacement || replacement === source.slice(nameStart, closeIndex + 1)) return '';
        return `${source.slice(0, nameStart)}${replacement}${source.slice(closeIndex + 1)}`.trim();
    }

    function parseDeclLine(logLine, rawLines, filePath, fileName, mode, options = {}) {
        let line = logLine.text.trim().replace(/;$/, '').trim();
        if (!line) return [];
        const isPreprocessorDirective = isPreprocessorDirectiveLine(line);
        const preprocessorDirective = isPreprocessorDirective
            ? parsePreprocessorDirectiveLine(line)
            : null;
        if (isPreprocessorDirective && preprocessorDirective?.keyword !== 'define') return [];

        const lineNumber = logLine.startLine;
        if (!preprocessorDirective && !options.skipDeclarationMacroExpansion) {
            const expandedLine = expandDeclarationHeadMacro(
                line,
                options.defineDecls,
                options.escapeChar || getActiveCtrlChar()
            );
            if (expandedLine && expandedLine !== line) {
                const expandedDecls = parseDeclLine(
                    { text: expandedLine, startLine: lineNumber },
                    rawLines,
                    filePath,
                    fileName,
                    mode,
                    {
                        ...options,
                        skipDeclarationMacroExpansion: true
                    }
                );
                for (const decl of expandedDecls) {
                    if (decl) decl.macroExpandedDeclaration = true;
                }
                return expandedDecls;
            }
        }
        const mayHaveDocs = mayHaveDocsForLine(rawLines, lineNumber);
        let docsValue = null;
        let docsResolved = false;
        const getDocs = () => {
            if (!docsResolved) {
                docsValue = rawLines.length
                    ? extractDocs(rawLines, lineNumber, { includeInline: true })
                    : '';
                docsResolved = true;
            }
            return docsValue || '';
        };

        if (preprocessorDirective?.keyword === 'define') {
            if (mode === 'local') return [];
            const parsedDefine = parsePreprocessorDefineDirective(preprocessorDirective);
            if (!parsedDefine?.valid) return [];
            const { name, args, macroStyle, macroIndexer, value } = parsedDefine;
            if (!macroStyle && name.startsWith('_') && !String(value || '').trim()) return [];
            const defineDecl = {
                name,
                args,
                macroStyle,
                macroIndexer,
                type: 'define', typeTag: '', modifiers: [], dims: '',
                file: fileName, filePath, lineNumber,
                value: value?.trim() ?? ''
            };
            return [attachLazyDocs(defineDecl, 'docs', getDocs, mayHaveDocs)];
        }

        let rest = line;
        const modifiers = [];
        let m;
        while ((m = rest.match(MOD_RE))) { modifiers.push(m[1]); rest = rest.slice(m[0].length); }

        let typeTag = '';
        const tm = rest.match(TAG_RE);
        if (tm) { typeTag = tm[1]; rest = rest.slice(tm[0].length); }

        let leadingDims = '';
        let nameSource = rest;
        if (rest.startsWith('[') && (modifiers.includes('native') || modifiers.includes('forward'))) {
            const parsedLeading = parseDims(rest);
            if (parsedLeading.dims && NAME_RE.test(parsedLeading.rest || '')) {
                leadingDims = parsedLeading.dims;
                nameSource = parsedLeading.rest;
            }
        }

        const nm = nameSource.match(NAME_RE);
        if (!nm) return [];
        let name = nm[1];
        if (FORBIDDEN.has(name)) return [];
        rest = nameSource.slice(nm[0].length).trimStart();

        if (rest.startsWith('(')) {
            if (mode === 'local') return [];
            if (name.startsWith('@') && name.length > 1) {
                if (!modifiers.includes('native') &&
                    !modifiers.includes('forward') &&
                    !modifiers.includes('public')) {
                    modifiers.push('public');
                }
            }
            const argsRaw = extractParenContent(rest) ?? '';
            const closeParenIndex = findMatchingParenInText(rest, 0);
            const stateSpec = closeParenIndex >= 0
                ? parseFunctionStateSpecTail(rest.slice(closeParenIndex + 1), line.length - rest.length + closeParenIndex + 1)
                : null;
            let type = 'function';
            if      (modifiers.includes('native'))  type = 'native';
            else if (modifiers.includes('forward')) type = 'forward';
            else if (modifiers.includes('public'))  type = 'public';
            else if (modifiers.includes('stock'))   type = 'stock';
            else if (modifiers.includes('static'))  type = 'static';
            const normalizedArgs = argsRaw.replace(/\s+/g, ' ').trim();
            const expandedArgs = expandDeclarationArgMacros(
                argsRaw,
                options.defineDecls,
                options.escapeChar || getActiveCtrlChar()
            ).replace(/\s+/g, ' ').trim();
            const functionDecl = {
                name, args: expandedArgs || normalizedArgs,
                type, typeTag, modifiers, dims: leadingDims,
                file: fileName, filePath, lineNumber, value: '',
                stateSpec
            };
            if (expandedArgs && expandedArgs !== normalizedArgs) {
                functionDecl.rawArgs = normalizedArgs;
                functionDecl.macroExpandedArgs = true;
            }
            return [attachLazyDocs(functionDecl, 'docs', getDocs, mayHaveDocs)];
        }

        if (!modifiers.some(mm => VAR_MODS.has(mm))) return [];

        const { dims: d0, rest: r1 } = parseDims(rest);
        let firstValue = '', remainder = '';
        if (r1.startsWith('=')) {
            const { value, remainder: rem } = parseValueAndRemainder(r1);
            firstValue = value; remainder = rem;
        } else if (r1.startsWith(',')) {
            remainder = r1.slice(1).trim();
        }

        const firstVariableDecl = {
            name, args: '', type: 'variable',
            typeTag, modifiers, dims: d0,
            file: fileName, filePath, lineNumber, value: firstValue
        };
        const results = [attachLazyDocs(firstVariableDecl, 'docs', getDocs, mayHaveDocs)];
        for (const piece of splitTopLevel(remainder)) {
            const v = parseVarPiece(piece, modifiers, filePath, fileName, lineNumber, getDocs, mayHaveDocs);
            if (v) results.push(v);
        }
        return results;
    }

    const {
        advanceActiveDefineDecls,
        collectActiveDefineDecls,
        collectDefineDeclarationText,
        collectDefineDirectiveEvents
    } = createDefineDeclarationEventCore({
        collectDeclarationText,
        getActiveCtrlChar,
        parseDeclLine,
        parsePreprocessorDirectiveLine,
        parsePreprocessorSingleIdentifierPayload,
        stripLineComment
    });

    function areDeclListsEqualByRef(left, right) {
        if (left === right) return true;
        if (!Array.isArray(left) || !Array.isArray(right)) return false;
        if (left.length !== right.length) return false;
        for (let index = 0; index < left.length; index++) {
            if (left[index] !== right[index]) return false;
        }
        return true;
    }

    function areScopedLocalsVisibleThroughLine(locals, cursorLine) {
        if (!Array.isArray(locals) || !locals.length) return true;
        for (const local of locals) {
            const declLine = local?.lineNumber ?? -1;
            const scopeEndLine = local?.scopeEndLine ?? declLine;
            if (cursorLine > scopeEndLine) return false;
        }
        return true;
    }

    const EMPTY_ACTIVE_DEFINE_DECLS = { globals: [], functions: [] };

    function getActiveDefineDerivedDecls(activeDefinesMap, previousSequentialState = null) {
        if (!activeDefinesMap?.size) return EMPTY_ACTIVE_DEFINE_DECLS;
        if (
            previousSequentialState?.activeDefinesMap === activeDefinesMap &&
            previousSequentialState.activeDefineDerivedDecls
        ) {
            return previousSequentialState.activeDefineDerivedDecls;
        }

        const globals = [];
        const functions = [];
        for (const decl of activeDefinesMap.values()) {
            if (isObjectLikeDefineDecl(decl)) globals.push(decl);
            if (isFunctionLikeDefineDecl(decl)) {
                functions.push({
                    ...decl,
                    startLine: decl.lineNumber,
                    headerEndLine: decl.lineNumber
                });
            }
        }
        return globals.length || functions.length
            ? { globals, functions }
            : EMPTY_ACTIVE_DEFINE_DECLS;
    }

    function findCursorFunctions(functions, depths, cursorLine, cursorFunctionIndex = null) {
        if (!Number.isInteger(cursorLine)) {
            return {
                cursorDepth: 0,
                headerFunc: null,
                bodyFunc: null,
                enclosing: null
            };
        }
        const cursorDepth = (cursorLine !== undefined && cursorLine < depths.length)
            ? depths[cursorLine]
            : 0;
        if (cursorFunctionIndex && Number.isInteger(cursorLine)) {
            const headerFunc = cursorFunctionIndex.headerFuncByLine?.[cursorLine] || null;
            const bodyFunc = cursorFunctionIndex.bodyFuncByLine?.[cursorLine] || null;
            return {
                cursorDepth,
                headerFunc,
                bodyFunc,
                enclosing: headerFunc || bodyFunc
            };
        }
        const headerFunc = functions.reduce(
            (best, f) => {
                const endLine = f.headerEndLine ?? f.startLine;
                if (cursorLine < f.startLine || cursorLine > endLine) return best;
                return !best || f.startLine > best.startLine ? f : best;
            },
            null
        );
        const bodyFunc = cursorDepth > 0
            ? functions.reduce(
                (best, f) => f.startLine <= cursorLine && (!best || f.startLine > best.startLine) ? f : best,
                null
            )
            : (
                functions.reduce(
                    (best, f) => {
                        if (f?.singleStatementBodyLine !== cursorLine) return best;
                        return !best || f.startLine > best.startLine ? f : best;
                    },
                    null
                )
            );

        return {
            cursorDepth,
            headerFunc,
            bodyFunc,
            enclosing: headerFunc || bodyFunc
        };
    }

    function findNextFunctionStartLine(functions, func) {
        const currentStartLine = func?.startLine ?? func?.lineNumber ?? -1;
        let nextStartLine = -1;
        for (const candidate of functions || []) {
            if (!candidate || candidate === func) continue;
            const candidateStartLine = candidate.startLine ?? candidate.lineNumber ?? -1;
            if (candidateStartLine <= currentStartLine) continue;
            if (nextStartLine < 0 || candidateStartLine < nextStartLine) {
                nextStartLine = candidateStartLine;
            }
        }
        return nextStartLine;
    }

    function getNextFunctionStartLineIndex(base) {
        if (base?.nextFunctionStartLineByFunction) return base.nextFunctionStartLineByFunction;
        const index = new Map();
        const functions = Array.isArray(base?.functions) ? base.functions : [];
        let previous = null;
        for (const func of functions) {
            if (!func) continue;
            if (previous) {
                index.set(previous, func.startLine ?? func.lineNumber ?? -1);
            }
            previous = func;
        }
        if (previous) {
            index.set(previous, -1);
        }
        if (base) base.nextFunctionStartLineByFunction = index;
        return index;
    }

    function getNextFunctionStartLine(base, func) {
        if (!func) return -1;
        const index = getNextFunctionStartLineIndex(base);
        return index.has(func)
            ? index.get(func)
            : findNextFunctionStartLine(base?.functions || [], func);
    }

    function findFunctionBodyRange(func, depths, scanMaxLine = null) {
        if (!func) return null;
        if (Number.isInteger(func.singleStatementBodyLine)) {
            return {
                startLine: func.singleStatementBodyLine,
                endLine: func.singleStatementBodyLine
            };
        }
        const headerEndLine = func.headerEndLine ?? func.startLine ?? 0;
        const headerDepth = depths[headerEndLine] ?? 0;
        const maxLine = Math.min(
            depths.length - 1,
            Number.isInteger(scanMaxLine) ? scanMaxLine : depths.length - 1
        );
        let bodyStartLine = -1;
        let bodyDepth = 0;
        for (let line = headerEndLine + 1; line <= maxLine; line++) {
            const lineDepth = depths[line] ?? 0;
            if (lineDepth > headerDepth) {
                bodyStartLine = line;
                bodyDepth = lineDepth;
                break;
            }
        }
        if (bodyStartLine < 0) return null;
        return {
            startLine: bodyStartLine,
            endLine: findDepthScopeEndLine(depths, bodyStartLine, bodyDepth)
        };
    }

    function findFunctionBodyEndLine(func, depths, scanMaxLine = null) {
        const bodyRange = findFunctionBodyRange(func, depths, scanMaxLine);
        return bodyRange?.endLine ?? (func?.headerEndLine ?? func?.startLine ?? -1);
    }

    function getCursorFunctionIndex(base) {
        if (base.cursorFunctionIndex) return base.cursorFunctionIndex;
        const lineCount = base.rawLines?.length || base.depths?.length || 0;
        const headerFuncByLine = new Array(lineCount).fill(null);
        const bodyFuncByLine = new Array(lineCount).fill(null);

        for (const func of base.functions || []) {
            const headerStartLine = func.startLine ?? func.lineNumber ?? -1;
            const headerEndLine = func.headerEndLine ?? headerStartLine;
            for (let line = Math.max(0, headerStartLine); line <= headerEndLine && line < lineCount; line++) {
                const current = headerFuncByLine[line];
                if (!current || headerStartLine > (current.startLine ?? current.lineNumber ?? -1)) {
                    headerFuncByLine[line] = func;
                }
            }

            const nextFunctionStartLine = getNextFunctionStartLine(base, func);
            const bodyRange = findFunctionBodyRange(
                func,
                base.depths || [],
                nextFunctionStartLine >= 0 ? nextFunctionStartLine - 1 : null
            );
            if (!bodyRange) continue;
            for (let line = Math.max(0, bodyRange.startLine); line <= bodyRange.endLine && line < lineCount; line++) {
                const current = bodyFuncByLine[line];
                if (!current || headerStartLine > (current.startLine ?? current.lineNumber ?? -1)) {
                    bodyFuncByLine[line] = func;
                }
            }
        }

        base.cursorFunctionIndex = {
            headerFuncByLine,
            bodyFuncByLine
        };
        return base.cursorFunctionIndex;
    }

    function getPreparsedLocalsForFunction(base, func, filePath, fileName) {
        if (!func) return [];
        if (!base.localDeclsByFunction) {
            base.localDeclsByFunction = new Map();
        }
        if (base.localDeclsByFunction.has(func)) {
            return base.localDeclsByFunction.get(func);
        }
        const nextFunctionStartLine = getNextFunctionStartLine(base, func);
        const bodyEndLine = findFunctionBodyEndLine(
            func,
            base.depths || [],
            nextFunctionStartLine >= 0 ? nextFunctionStartLine - 1 : null
        );
        if (bodyEndLine < 0) {
            base.localDeclsByFunction.set(func, []);
            return [];
        }
        const bodyStartLine = (func.headerEndLine ?? func.startLine) + 1;
        const locals = [];
        appendLocalsThroughCursor(
            locals,
            base.strippedLines,
            base.rawLines,
            base.depths,
            filePath,
            fileName,
            func,
            bodyStartLine,
            bodyEndLine,
            base.lineCtrlChars,
            base.defineDirectiveEvents,
            base.defineDecls
        );
        base.localDeclsByFunction.set(func, locals);
        return locals;
    }

    function isPotentialLocalDeclarationStartLine(line) {
        const trimmed = String(line || '').trimStart();
        return startsWithLocalDeclarationKeyword(trimmed);
    }

    function splitTopLevelStatements(source, escapeChar = getActiveCtrlChar()) {
        const text = String(source || '');
        const statements = [];
        let start = 0;
        let depth = 0;
        let inString = false;
        let stringChar = '';
        let inBlockComment = false;
        let inLineComment = false;

        const pushStatement = end => {
            const statementText = text.slice(start, end).trim();
            if (statementText) statements.push(statementText);
            start = end + 1;
        };

        for (let index = 0; index < text.length; index++) {
            const char = text[index];
            const next = text[index + 1] || '';

            if (inLineComment) {
                if (char === '\n' || char === '\r') inLineComment = false;
                continue;
            }
            if (inBlockComment) {
                if (char === '*' && next === '/') {
                    inBlockComment = false;
                    index++;
                }
                continue;
            }
            if (inString) {
                if (char === stringChar && !isEscapedQuote(text, index, escapeChar)) inString = false;
                continue;
            }
            if (char === '/' && next === '/') {
                inLineComment = true;
                index++;
                continue;
            }
            if (char === '/' && next === '*') {
                inBlockComment = true;
                index++;
                continue;
            }
            if (char === '"' || char === "'") {
                inString = true;
                stringChar = char;
                continue;
            }

            if (char === '(' || char === '[' || char === '{') {
                depth++;
            } else if (char === ')' || char === ']' || char === '}') {
                depth = Math.max(0, depth - 1);
            } else if (char === ';' && depth === 0) {
                pushStatement(index);
            }
        }

        pushStatement(text.length);
        return statements;
    }

    function collectVirtualExpandedLocalDecls(expandedLine, rawLines, filePath, fileName, lineNumber, escapeChar, defineDecls = []) {
        const decls = [];
        for (const statement of splitTopLevelStatements(expandedLine, escapeChar)) {
            const trimmed = String(statement || '').trim();
            if (!trimmed) continue;
            if (!isPotentialLocalDeclarationStartLine(trimmed)) continue;
            decls.push(...parseDeclLine(
                { text: trimmed, startLine: lineNumber },
                rawLines,
                filePath,
                fileName,
                'local',
                {
                    defineDecls,
                    escapeChar
                }
            ).map(decl => ({ ...decl, macroExpandedDeclaration: true })));
        }
        decls.push(...collectVirtualExpandedForInitDecls(
            expandedLine,
            rawLines,
            filePath,
            fileName,
            lineNumber,
            escapeChar,
            defineDecls
        ));
        return decls;
    }

    function collectVirtualExpandedForInitDecls(source, rawLines, filePath, fileName, lineNumber, escapeChar, defineDecls = []) {
        const text = String(source || '');
        const decls = [];
        let inString = false;
        let stringChar = '';
        let inBlockComment = false;
        let inLineComment = false;

        for (let index = 0; index < text.length;) {
            const char = text[index];
            const next = text[index + 1] || '';

            if (inLineComment) {
                if (char === '\n' || char === '\r') inLineComment = false;
                index++;
                continue;
            }
            if (inBlockComment) {
                if (char === '*' && next === '/') {
                    inBlockComment = false;
                    index += 2;
                } else {
                    index++;
                }
                continue;
            }
            if (inString) {
                if (char === stringChar && !isEscapedQuote(text, index, escapeChar)) inString = false;
                index++;
                continue;
            }
            if (char === '/' && next === '/') {
                inLineComment = true;
                index += 2;
                continue;
            }
            if (char === '/' && next === '*') {
                inBlockComment = true;
                index += 2;
                continue;
            }
            if (char === '"' || char === "'") {
                inString = true;
                stringChar = char;
                index++;
                continue;
            }

            const code = text.charCodeAt(index);
            if (!isPawnIdentifierStartCode(code)) {
                index++;
                continue;
            }
            const wordStart = index;
            index++;
            while (index < text.length && isPawnIdentifierContinueCode(text.charCodeAt(index))) index++;
            if (text.slice(wordStart, index) !== 'for') continue;

            let openIndex = index;
            while (openIndex < text.length && isWhitespaceCharCode(text.charCodeAt(openIndex))) openIndex++;
            if (text[openIndex] !== '(') continue;

            const closeIndex = findBalancedGroupEnd(text, openIndex, '(', ')', {
                escapeChar,
                isEscapedQuote
            });
            if (closeIndex < 0) continue;

            decls.push(...parseForInit(
                text.slice(wordStart, closeIndex + 1),
                rawLines,
                filePath,
                fileName,
                lineNumber,
                escapeChar,
                { defineDecls }
            ).map(decl => ({ ...decl, macroForVar: true, macroExpandedDeclaration: true })));
            index = closeIndex + 1;
        }

        return decls;
    }

    function hydrateFunctionLikeDefineDeclFromSource(defineDecl, rawLines, lineCtrlChars = []) {
        if (!defineDecl || defineDecl.type !== 'define' || !isFunctionLikeDefineDecl(defineDecl)) return defineDecl;
        if (String(defineDecl.value || '').trim()) return defineDecl;
        const lineNumber = Number.isInteger(defineDecl.lineNumber) ? defineDecl.lineNumber : -1;
        if (lineNumber < 0 || lineNumber >= rawLines.length) return defineDecl;

        const collected = collectDeclarationText(rawLines, lineNumber, lineCtrlChars, rawLines);
        const directive = parsePreprocessorDirectiveLine(String(collected.text || '').trim());
        if (directive?.keyword !== 'define') return defineDecl;
        const parsed = parsePreprocessorDefineDirective(directive);
        if (!parsed?.valid || parsed.name !== defineDecl.name) return defineDecl;
        if (!String(parsed.value || '').trim()) return defineDecl;
        return {
            ...defineDecl,
            args: parsed.args,
            macroStyle: parsed.macroStyle,
            macroIndexer: parsed.macroIndexer,
            value: String(parsed.value || '').trim()
        };
    }

    function replaceDefineDeclInList(defineDecls = [], oldDecl, newDecl) {
        if (!oldDecl || oldDecl === newDecl || !Array.isArray(defineDecls)) return defineDecls;
        let changed = false;
        const replaced = defineDecls.map(decl => {
            if (decl !== oldDecl) return decl;
            changed = true;
            return newDecl;
        });
        return changed ? replaced : defineDecls;
    }

    function appendLocalsThroughCursor(locals, strippedLines, rawLines, depths, filePath, fileName, bodyFunc, fromLine, cursorLine, lineCtrlChars = [], defineDirectiveEvents = [], baseDefineDecls = []) {
        if (!bodyFunc || fromLine > cursorLine) return;
        const bodyStartLine = (bodyFunc.headerEndLine ?? bodyFunc.startLine) + 1;
        const parseFromLine = Math.max(bodyStartLine, fromLine);
        if (parseFromLine > cursorLine) return;

        let activeDefineDeclsByLine = null;
        let activeDefineDeclsEventIndex = 0;
        let activeDefineDeclsAdvancedThrough = -1;
        let activeDefineDeclsCache = null;
        const getActiveDefineDeclsBeforeLine = lineNumber => {
            const baseDefines = Array.isArray(baseDefineDecls) ? baseDefineDecls : [];
            if (!Array.isArray(defineDirectiveEvents) || !defineDirectiveEvents.length) return baseDefines;
            if (!activeDefineDeclsByLine) activeDefineDeclsByLine = new Map();
            const targetLine = Math.max(-1, (Number.isInteger(lineNumber) ? lineNumber : -1) - 1);
            if (targetLine > activeDefineDeclsAdvancedThrough) {
                const advanced = advanceActiveDefineDecls(
                    activeDefineDeclsByLine,
                    defineDirectiveEvents,
                    activeDefineDeclsAdvancedThrough + 1,
                    targetLine,
                    activeDefineDeclsEventIndex
                );
                activeDefineDeclsEventIndex = advanced.nextEventIndex;
                activeDefineDeclsAdvancedThrough = targetLine;
                if (advanced.changed) {
                    activeDefineDeclsCache = null;
                }
            }
            if (!activeDefineDeclsCache) {
                activeDefineDeclsCache = [...baseDefines, ...activeDefineDeclsByLine.values()];
            }
            return activeDefineDeclsCache;
        };

        const singleStatementDecls = parseSingleStatementBodyDecls(
            strippedLines,
            rawLines,
            depths,
            filePath,
            fileName,
            parseFromLine,
            cursorLine,
            lineCtrlChars
        );

        for (let k = parseFromLine; k <= cursorLine; k++) {
            const isFunctionSingleStatementBodyLine = bodyFunc.singleStatementBodyLine === k;
            if ((depths[k] === 0) && !isFunctionSingleStatementBodyLine) continue;
            if (isPotentialEnumDeclarationLine(strippedLines[k])) {
                const enumBlock = parseEnumBlock(rawLines, k, filePath, fileName, lineCtrlChars, strippedLines, locals);
                if (enumBlock) {
                    const declDepth = depths[k] ?? 0;
                    for (const d of enumBlock.decls) {
                        d.declDepth = declDepth;
                        d.scopeEndLine = findDepthScopeEndLine(depths, k, declDepth);
                        locals.push(d);
                    }
                    k = enumBlock.nextLine - 1;
                    continue;
                }
            }
            const startK = k;
            const singleStatementDecl = singleStatementDecls.get(startK) || null;
            let declsOnLine;
            if (singleStatementDecl) {
                declsOnLine = singleStatementDecl.decls.map(d => ({ ...d }));
            } else {
                const trimmedStartLine = String(strippedLines[startK] || '').trim();
                const escapeChar = lineCtrlChars[startK] || getActiveCtrlChar();
                let activeDefineDeclsForLine = null;
                const getActiveDefineDeclsForLine = () => {
                    if (!activeDefineDeclsForLine) {
                        activeDefineDeclsForLine = getActiveDefineDeclsBeforeLine(startK);
                    }
                    return activeDefineDeclsForLine;
                };
                let virtualExpandedLocalDecls = null;
                if (!/^for\s*\(/.test(trimmedStartLine) && !isPotentialLocalDeclarationStartLine(trimmedStartLine)) {
                    const leadingMacroCall = virtualExpandedLineContextCore.readLeadingFunctionLikeDefineCall(trimmedStartLine);
                    if (!leadingMacroCall) {
                        continue;
                    }
                    const activeDefineDecls = getActiveDefineDeclsForLine();
                    const foundDefineDecl = virtualExpandedLineContextCore.findFunctionLikeDefineDecl(
                        activeDefineDecls,
                        leadingMacroCall.name
                    );
                    if (!foundDefineDecl) {
                        continue;
                    }
                    const defineDecl = hydrateFunctionLikeDefineDeclFromSource(
                        foundDefineDecl,
                        rawLines,
                        lineCtrlChars
                    );
                    const effectiveActiveDefineDecls = replaceDefineDeclInList(
                        activeDefineDecls,
                        foundDefineDecl,
                        defineDecl
                    );
                    const virtualLine = virtualExpandedLineContextCore.getVirtualExpandedLineContext(
                        trimmedStartLine,
                        effectiveActiveDefineDecls,
                        {
                            escapeChar,
                            defineDecl,
                            expandActualArgs: false,
                            maxOutputLength: 8192
                        }
                    );
                    const expandedLine = virtualLine.hasExpansion && virtualLine.changed
                        ? virtualLine.expandedText
                        : '';
                    virtualExpandedLocalDecls = collectVirtualExpandedLocalDecls(
                        expandedLine,
                        rawLines,
                        filePath,
                        fileName,
                        startK,
                        escapeChar,
                        effectiveActiveDefineDecls
                    );
                    if (!virtualExpandedLocalDecls.length) {
                        continue;
                    }
                }
                const declarationText = virtualExpandedLocalDecls
                    ? null
                    : /^for\s*\(/.test(trimmedStartLine)
                        ? collectForHeaderText(rawLines, k, lineCtrlChars, strippedLines)
                        : collectDeclarationText(rawLines, k, lineCtrlChars, strippedLines);
                const lineText = declarationText ? declarationText.text.trim() : '';
                if (declarationText) k = declarationText.nextLine - 1;
                if (virtualExpandedLocalDecls) {
                    declsOnLine = virtualExpandedLocalDecls;
                } else if (/^for\s*\(/.test(lineText)) {
                    declsOnLine = parseForInit(
                        lineText,
                        rawLines,
                        filePath,
                        fileName,
                        startK,
                        escapeChar,
                        {
                            defineDecls: getActiveDefineDeclsForLine()
                        }
                    );
                } else {
                    declsOnLine = parseDeclLine(
                        { text: lineText, startLine: startK },
                        rawLines, filePath, fileName, 'local',
                        {
                            defineDecls: getActiveDefineDeclsForLine(),
                            escapeChar
                        }
                    );
                }
            }
            for (const d of declsOnLine) {
                const declDepth = singleStatementDecl
                    ? singleStatementDecl.declDepth
                    : d.macroForVar
                        ? Math.max(
                            (depths[startK] ?? 0) + 1,
                            depths[startK + 1] ?? ((depths[startK] ?? 0) + 1)
                        )
                        : isFunctionSingleStatementBodyLine
                            ? Math.max(1, (depths[bodyFunc.startLine] ?? 0) + 1)
                            : (depths[startK] ?? 0);
                d.declDepth = declDepth;
                d.scopeEndLine = singleStatementDecl
                    ? singleStatementDecl.scopeEndLine
                    : d.macroForVar
                        ? typeof findStatementScopeEndLine === 'function'
                            ? findStatementScopeEndLine(
                                strippedLines,
                                depths,
                                startK,
                                0,
                                depths[startK] ?? 0,
                                lineCtrlChars
                            )
                            : findDepthScopeEndLine(depths, startK, declDepth)
                        : isFunctionSingleStatementBodyLine
                            ? startK
                            : d.isForVar
                                ? findForScopeEndLine(strippedLines, depths, startK, lineCtrlChars)
                                : findDepthScopeEndLine(depths, startK, declDepth);
                locals.push(d);
            }
        }
    }

    function findFunctionHeaderEndPosition(rawLines, startLine, lineCtrlChars = []) {
        let parenDepth = 0;
        let sawOpenParen = false;
        let inStr = false;
        let strCh = '';
        let inBlockComment = false;

        for (let lineNumber = Math.max(0, startLine); lineNumber < rawLines.length; lineNumber++) {
            const line = String(rawLines[lineNumber] || '');
            const escapeChar = lineCtrlChars[lineNumber] || getActiveCtrlChar();
            for (let index = 0; index < line.length; index++) {
                const char = line[index];
                const nextChar = line[index + 1] || '';

                if (inBlockComment) {
                    if (char === '*' && nextChar === '/') {
                        inBlockComment = false;
                        index++;
                    }
                    continue;
                }
                if (inStr) {
                    if (char === strCh && !isEscapedQuote(line, index, escapeChar)) {
                        inStr = false;
                    }
                    continue;
                }
                if (char === '/' && nextChar === '/') break;
                if (char === '/' && nextChar === '*') {
                    inBlockComment = true;
                    index++;
                    continue;
                }
                if (char === '"' || char === "'") {
                    inStr = true;
                    strCh = char;
                    continue;
                }
                if (char === '(') {
                    sawOpenParen = true;
                    parenDepth++;
                    continue;
                }
                if (char === ')') {
                    if (parenDepth > 0) {
                        parenDepth--;
                        if (sawOpenParen && parenDepth === 0) {
                            return { lineNumber, charIndex: index };
                        }
                    }
                }
            }
        }

        return { lineNumber: startLine, charIndex: -1 };
    }

    function readLastPawnIdentifier(source) {
        const text = String(source || '');
        let end = text.length;
        while (end > 0 && isWhitespaceCharCode(text.charCodeAt(end - 1))) end--;
        let start = end;
        while (start > 0 && isPawnIdentifierContinueCode(text.charCodeAt(start - 1))) start--;
        if (start >= end || !isPawnIdentifierStartCode(text.charCodeAt(start))) return '';
        return text.slice(start, end);
    }

    function readFirstPawnIdentifier(source) {
        const text = String(source || '').trimStart();
        if (!text || !isPawnIdentifierStartCode(text.charCodeAt(0))) return '';
        let end = 1;
        while (end < text.length && isPawnIdentifierContinueCode(text.charCodeAt(end))) end++;
        return text.slice(0, end);
    }

    function isFunctionDefinitionBoundaryLine(lineNumber, rawLines, strippedLines = rawLines, lineCtrlChars = []) {
        const firstLineText = String(strippedLines?.[lineNumber] ?? rawLines[lineNumber] ?? '');
        const firstLineTrimmed = firstLineText.trim();
        if (!firstLineTrimmed || firstLineTrimmed.includes(';')) return false;
        if (isPreprocessorDirectiveLine(firstLineTrimmed)) return false;

        const headerEndPosition = findFunctionHeaderEndPosition(rawLines, lineNumber, lineCtrlChars);
        if ((headerEndPosition.charIndex ?? -1) < 0) return false;

        const headerEndLine = headerEndPosition.lineNumber ?? lineNumber;
        const headerLines = [];
        for (let line = lineNumber; line <= headerEndLine && line < rawLines.length; line++) {
            headerLines.push(String(strippedLines?.[line] ?? rawLines[line] ?? ''));
        }
        const headerText = headerLines.join(' ').trim();
        const openParenIndex = headerText.indexOf('(');
        if (openParenIndex <= 0) return false;

        const head = headerText.slice(0, openParenIndex).trim();
        const name = readLastPawnIdentifier(head);
        if (!name || FORBIDDEN.has(name)) return false;

        const leadingWord = readFirstPawnIdentifier(head);
        if (leadingWord && FORBIDDEN.has(leadingWord)) return false;

        const endLineText = String(strippedLines?.[headerEndLine] ?? rawLines[headerEndLine] ?? '');
        const trailingText = endLineText.slice((headerEndPosition.charIndex ?? -1) + 1).trim();
        if (trailingText.startsWith('{')) return true;
        if (trailingText.startsWith(';')) return false;

        for (let line = headerEndLine + 1; line < rawLines.length; line++) {
            const trimmed = String(strippedLines?.[line] ?? rawLines[line] ?? '').trim();
            if (!trimmed) continue;
            return trimmed.startsWith('{');
        }

        return false;
    }

    function findSingleStatementFunctionBodyLine(functionDecl, rawLines, strippedLines = rawLines, lineCtrlChars = []) {
        if (!functionDecl || !rawLines?.length) return null;
        if (functionDecl.type === 'forward' || functionDecl.type === 'native' || functionDecl.type === 'define') {
            return null;
        }

        const headerStartLine = functionDecl.startLine ?? functionDecl.lineNumber ?? 0;
        const headerEndPosition = findFunctionHeaderEndPosition(rawLines, headerStartLine, lineCtrlChars);
        const headerEndLine = headerEndPosition.lineNumber ?? headerStartLine;
        const headerLines = [];
        for (let line = headerStartLine; line <= headerEndLine && line < rawLines.length; line++) {
            headerLines.push(String(strippedLines?.[line] ?? rawLines[line] ?? ''));
        }
        const headerText = headerLines.join(' ').trim();
        if (!headerText || headerText.endsWith(';') || headerText.includes('{')) {
            return null;
        }

        const trailingHeaderLineText = String(strippedLines?.[headerEndLine] ?? rawLines[headerEndLine] ?? '');
        const trailingHeaderText = trailingHeaderLineText.slice((headerEndPosition.charIndex ?? -1) + 1).trim();
        if (trailingHeaderText && !trailingHeaderText.startsWith('{') && !trailingHeaderText.startsWith(';')) {
            return headerEndLine;
        }

        for (let line = headerEndLine + 1; line < rawLines.length; line++) {
            const text = String(strippedLines?.[line] ?? rawLines[line] ?? '');
            const trimmed = text.trim();
            if (!trimmed) continue;
            if (trimmed.startsWith('{')) return null;
            if (isPreprocessorDirectiveLine(trimmed) || isExplicitDeclarationStartLine(trimmed)) return null;
            if (isFunctionDefinitionBoundaryLine(line, rawLines, strippedLines, lineCtrlChars)) return null;
            return line;
        }

        return null;
    }

    function findFunctionHeaderEndLine(rawLines, startLine, lineCtrlChars = []) {
        return findFunctionHeaderEndPosition(rawLines, startLine, lineCtrlChars).lineNumber;
    }

    function findChangedLineWindow(previousLines, nextLines) {
        if (!Array.isArray(previousLines) || !Array.isArray(nextLines)) return null;
        if (previousLines.length !== nextLines.length) return null;

        let startLine = 0;
        while (startLine < previousLines.length && previousLines[startLine] === nextLines[startLine]) {
            startLine++;
        }
        if (startLine >= previousLines.length) {
            return { startLine: -1, endLine: -1 };
        }

        let endLine = previousLines.length - 1;
        while (endLine >= startLine && previousLines[endLine] === nextLines[endLine]) {
            endLine--;
        }

        return { startLine, endLine };
    }

    function canReuseTopLevelParseBase(previousBase, nextRawLines, nextStrippedLines, nextDepths) {
        if (!previousBase || !Array.isArray(nextRawLines) || !Array.isArray(nextStrippedLines) || !Array.isArray(nextDepths)) {
            return false;
        }

        const changeWindow = findChangedLineWindow(previousBase.rawLines, nextRawLines);
        if (!changeWindow) return false;
        if (changeWindow.startLine < 0) return true;

        const structuralMarkerRe = /#|\{|\}|\/\*|\*\//;
        const isTopLevelDeclarationCandidate = line =>
            isPreprocessorDirectiveLine(line) || isExplicitDeclarationStartLine(line);
        for (let lineNumber = changeWindow.startLine; lineNumber <= changeWindow.endLine; lineNumber++) {
            const previousRawLine = String(previousBase.rawLines[lineNumber] || '');
            const nextRawLine = String(nextRawLines[lineNumber] || '');
            if (structuralMarkerRe.test(previousRawLine) || structuralMarkerRe.test(nextRawLine)) {
                return false;
            }
            if ((previousBase.depths[lineNumber] ?? 0) === 0 || (nextDepths[lineNumber] ?? 0) === 0) {
                return false;
            }
            const previousTrimmed = String(previousBase.strippedLines[lineNumber] || '').trim();
            const nextTrimmed = String(nextStrippedLines[lineNumber] || '').trim();
            if (isTopLevelDeclarationCandidate(previousTrimmed) || isTopLevelDeclarationCandidate(nextTrimmed)) {
                return false;
            }
        }

        return true;
    }

    function countVisiblePrefixDeclsByLine(decls, cursorLine) {
        if (!Array.isArray(decls) || cursorLine === undefined) return Array.isArray(decls) ? decls.length : 0;
        let low = 0;
        let high = decls.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            const lineNumber = decls[mid]?.lineNumber ?? -1;
            if (lineNumber <= cursorLine) low = mid + 1;
            else high = mid;
        }
        return low;
    }

    function getScopedGlobalsForCursor(base, cursorLine) {
        const globals = Array.isArray(base?.globals) ? base.globals : [];
        if (cursorLine === undefined) return globals;
        const count = countVisiblePrefixDeclsByLine(globals, cursorLine);
        if (count >= globals.length) return globals;
        if (!base.scopedGlobalsByPrefixCount) {
            base.scopedGlobalsByPrefixCount = new Map();
        }
        const cached = base.scopedGlobalsByPrefixCount.get(count);
        if (cached) return cached;
        const scopedGlobals = count > 0 ? globals.slice(0, count) : [];
        base.scopedGlobalsByPrefixCount.set(count, scopedGlobals);
        return scopedGlobals;
    }

    function getMergedDeclListByRef(owner, primaryDecls, extraDecls, cacheKey) {
        if (!Array.isArray(extraDecls) || extraDecls.length === 0) return primaryDecls;
        if (!Array.isArray(primaryDecls) || primaryDecls.length === 0) return extraDecls;
        if (!owner || typeof owner !== 'object') return [...primaryDecls, ...extraDecls];
        let byPrimary = owner[cacheKey];
        if (!(byPrimary instanceof WeakMap)) {
            byPrimary = new WeakMap();
            Object.defineProperty(owner, cacheKey, {
                configurable: true,
                value: byPrimary
            });
        }
        let byExtra = byPrimary.get(primaryDecls);
        if (!(byExtra instanceof WeakMap)) {
            byExtra = new WeakMap();
            byPrimary.set(primaryDecls, byExtra);
        }
        let merged = byExtra.get(extraDecls);
        if (!merged) {
            merged = [...primaryDecls, ...extraDecls];
            byExtra.set(extraDecls, merged);
        }
        return merged;
    }

    function parseFileDecls(text, filePath, fileName, cursorLine, preprocessedState = null, options = {}) {
        const cacheKey = normalizeFsPath(filePath);
        const usePreparsedLocals = options.preparseLocals === true;
        const cursorCacheKey = `${cursorLine === undefined ? '__all__' : String(cursorLine)}::locals:${usePreparsedLocals ? 1 : 0}`;
        const useCursorCache = options.cursorCache !== false;
        const parseOuterDecls = Array.isArray(options.enumEvalOuterDecls)
            ? options.enumEvalOuterDecls
            : filterEnumEvalOuterDecls(options.outerDecls);
        const getParseOuterDeclsForLine = typeof options.getEnumEvalOuterDeclsForLine === 'function'
            ? lineNumber => {
                const lineOuterDecls = options.getEnumEvalOuterDeclsForLine(lineNumber);
                return Array.isArray(lineOuterDecls) ? lineOuterDecls : parseOuterDecls;
            }
            : typeof options.getOuterDeclsForLine === 'function'
            ? lineNumber => {
                const lineOuterDecls = options.getOuterDeclsForLine(lineNumber);
                return lineOuterDecls === options.outerDecls
                    ? parseOuterDecls
                    : filterEnumEvalOuterDecls(lineOuterDecls);
            }
            : () => parseOuterDecls;
        const outerDeclsCacheKey = String(options.outerDeclsCacheKey ?? (
            parseOuterDecls.length ? `outer:${parseOuterDecls.length}` : ''
        ));
        let fileCache = cacheKey ? fileDeclParseCache.get(cacheKey) : null;
        const canReuseEquivalentBase = !!(
            fileCache &&
            fileCache.fileName === fileName &&
            fileCache.outerDeclsCacheKey === outerDeclsCacheKey &&
            areDependencyStampsFresh(fileCache.dependencyStamps) &&
            preprocessedState?.semanticEquivalentBodyEdit
        );

        if (
            !fileCache ||
            fileCache.text !== text ||
            fileCache.fileName !== fileName ||
            fileCache.outerDeclsCacheKey !== outerDeclsCacheKey ||
            !areDependencyStampsFresh(fileCache.dependencyStamps)
        ) {
            if (canReuseEquivalentBase) {
                fileCache = {
                    text,
                    fileName,
                    outerDeclsCacheKey,
                    byCursorLine: fileCache.byCursorLine,
                    sequentialCursorState: fileCache.sequentialCursorState,
                    dependencyStamps: fileCache.dependencyStamps,
                    base: fileCache.base
                };
                if (cacheKey) fileDeclParseCache.set(cacheKey, fileCache);
            } else {
            const sourceSnapshot = preprocessedState ? null : getFileSnapshot(filePath, text);
            const sourceCtrlCharState = sourceSnapshot?.ctrlCharState || null;
            const resolvedPreprocessedState = preprocessedState || preprocessPawnContent(text, {
                fromFilePath: filePath,
                rawLines: sourceSnapshot?.rawLines,
                strippedLines: sourceCtrlCharState?.strippedLines,
                lineCtrlChars: sourceCtrlCharState?.lineCtrlChars || [],
                finalCtrlChar: sourceCtrlCharState?.finalCtrlChar,
                directiveCandidateLines: sourceCtrlCharState?.directiveCandidateLines || null,
                returnState: true
            });
            const processedText = resolvedPreprocessedState.content;
            const processedSnapshot = getFileSnapshot(filePath, processedText, {
                rawLines: resolvedPreprocessedState.rawLines,
                ctrlCharState: getPreprocessedCtrlCharState(resolvedPreprocessedState)
            });
            const previousBase = fileCache?.base || null;
            const processedRawLines = processedSnapshot.rawLines;
            const processedLineCtrlChars = processedSnapshot.lineCtrlChars;
            const processedStrippedLines = processedSnapshot.strippedLines;
            const processedDepths = processedSnapshot.lineDepths;
            const canReuseBase = canReuseTopLevelParseBase(
                previousBase,
                processedRawLines,
                processedStrippedLines,
                processedDepths
            );
            fileCache = {
                text,
                fileName,
                outerDeclsCacheKey,
                byCursorLine: new Map(),
                sequentialCursorState: null,
                dependencyStamps: buildDependencyStampMap(
                    (resolvedPreprocessedState.includeEntries || []).map(entry => entry.filePath)
                ),
                base: withCtrlCharForContent(processedText, () => {
                    const rawLines = processedRawLines;
                    const lineCtrlChars = processedLineCtrlChars;
                    const strippedLines = processedStrippedLines;
                    const depths = processedDepths;
                    if (canReuseBase && previousBase) {
                        return {
                            processedText,
                            rawLines,
                            strippedLines,
                            lineCtrlChars,
                            finalCtrlChar: processedSnapshot.finalCtrlChar,
                            defineDecls: previousBase.defineDecls,
                            defineDirectiveEvents: previousBase.defineDirectiveEvents,
                            depths,
                            globals: previousBase.globals,
                            functions: previousBase.functions,
                            localDeclsByFunction: null,
                            cursorFunctionIndex: null,
                            scopedGlobalsByPrefixCount: previousBase.scopedGlobalsByPrefixCount || new Map()
                        };
                    }
                    const defineDirectiveEvents = collectDefineDirectiveEvents(
                        rawLines,
                        filePath,
                        fileName,
                        lineCtrlChars,
                        strippedLines,
                        resolvedPreprocessedState.directiveCandidateLines || null
                    );
                    const globals = [];
                    const functions = [];
                    let pendingDeprecatedMessage = null;
                    const topLevelActiveDefines = new Map();
                    let topLevelActiveDefineEventIndex = 0;

                    const advanceTopLevelActiveDefinesBefore = lineNumber => {
                        if (!Number.isInteger(lineNumber) || !defineDirectiveEvents.length) return;
                        const advanced = advanceActiveDefineDecls(
                            topLevelActiveDefines,
                            defineDirectiveEvents,
                            0,
                            Math.max(-1, lineNumber - 1),
                            topLevelActiveDefineEventIndex
                        );
                        topLevelActiveDefineEventIndex = advanced.nextEventIndex;
                    };

                    let i = 0;
                    while (i < strippedLines.length) {
                        if (depths[i] !== 0) { i++; continue; }
                        advanceTopLevelActiveDefinesBefore(i);
                        const strippedLine = strippedLines[i];
                        if (String(strippedLine || '').indexOf('#') >= 0) {
                            const deprecatedMessage = parseDeprecatedPragmaMessage(strippedLine);
                            if (deprecatedMessage != null) {
                                pendingDeprecatedMessage = deprecatedMessage;
                                i++;
                                continue;
                            }
                        }
                        if (!isPotentialDeclarationStartLine(strippedLine)) { i++; continue; }
                        if (isPotentialEnumDeclarationLine(strippedLine)) {
                            const enumEvalOuterDecls = globals.concat(
                                topLevelActiveDefines.size ? [...topLevelActiveDefines.values()] : [],
                                getParseOuterDeclsForLine(i)
                            );
                            const enumBlock = parseEnumBlock(rawLines, i, filePath, fileName, lineCtrlChars, strippedLines, enumEvalOuterDecls);
                            if (enumBlock) {
                                if (pendingDeprecatedMessage != null && applyDeprecatedPragmaToNextDecl(enumBlock.decls, pendingDeprecatedMessage)) {
                                    pendingDeprecatedMessage = null;
                                }
                                globals.push(...enumBlock.decls);
                                i = enumBlock.nextLine;
                                continue;
                            }
                        }
                        const startI = i;
                        const { text: joined, nextLine } = collectDeclarationText(rawLines, i, lineCtrlChars, strippedLines);
                        i = nextLine;
                        const parsedGlobalDecls = parseDeclLine(
                            { text: joined, startLine: startI },
                            rawLines,
                            filePath,
                            fileName,
                            'global',
                            {
                                defineDecls: [...topLevelActiveDefines.values()],
                                escapeChar: lineCtrlChars[startI] || getActiveCtrlChar()
                            }
                        );
                        if (pendingDeprecatedMessage != null && applyDeprecatedPragmaToNextDecl(parsedGlobalDecls, pendingDeprecatedMessage)) {
                            pendingDeprecatedMessage = null;
                        }
                        for (const d of parsedGlobalDecls) {
                            if (d.type === 'variable') globals.push(d);
                            else if (d.type !== 'define') {
                                const functionDecl = {
                                    ...d,
                                    startLine: startI,
                                    headerEndLine: findFunctionHeaderEndLine(rawLines, startI, lineCtrlChars)
                                };
                                functionDecl.singleStatementBodyLine = findSingleStatementFunctionBodyLine(
                                    functionDecl,
                                    rawLines,
                                    strippedLines,
                                    lineCtrlChars
                                );
                                functions.push(functionDecl);
                                if (Number.isInteger(functionDecl.singleStatementBodyLine)) {
                                    i = Math.max(i, functionDecl.singleStatementBodyLine + 1);
                                }
                            }
                        }
                    }

                    return {
                        processedText,
                        rawLines,
                        strippedLines,
                        lineCtrlChars,
                        finalCtrlChar: processedSnapshot.finalCtrlChar,
                        defineDecls: resolvedPreprocessedState.defineDecls || [],
                        defineDirectiveEvents,
                        depths,
                        globals,
                        functions,
                        localDeclsByFunction: null,
                        cursorFunctionIndex: null,
                        scopedGlobalsByPrefixCount: new Map()
                    };
                }, filePath, processedSnapshot.finalCtrlChar)
            };
            if (cacheKey) fileDeclParseCache.set(cacheKey, fileCache);
            }
        }

        if (useCursorCache) {
            const cachedForCursor = fileCache.byCursorLine.get(cursorCacheKey);
            if (cachedForCursor) return cachedForCursor;
        }

        const result = withCtrlCharForContent(fileCache.base.processedText, () => {
            const {
                rawLines,
                strippedLines,
                lineCtrlChars,
                defineDecls,
                defineDirectiveEvents,
                depths,
                globals,
                functions
            } = fileCache.base;

            let locals = [];
            let funcArgs = [];
            let activeDefinesMap = null;
            let activeDefineEventIndex = 0;
            const {
                cursorDepth,
                headerFunc,
                bodyFunc,
                enclosing
            } = findCursorFunctions(
                functions,
                depths,
                cursorLine,
                (cursorLine !== undefined && usePreparsedLocals) ? getCursorFunctionIndex(fileCache.base) : null
            );
            const previousSequentialState = fileCache.sequentialCursorState;
            const canExtendSequentialState = !!(
                cursorLine !== undefined &&
                previousSequentialState &&
                previousSequentialState.cursorLine < cursorLine &&
                previousSequentialState.preparsedLocalsMode === usePreparsedLocals &&
                previousSequentialState.headerFuncStartLine === (headerFunc?.startLine ?? null) &&
                previousSequentialState.bodyFuncStartLine === (bodyFunc?.startLine ?? null)
            );
            let localsStartedFromPreviousSequentialState = false;

            if (cursorLine !== undefined && cursorLine < rawLines.length) {
                if (canExtendSequentialState) {
                    locals = [...previousSequentialState.localsSoFar];
                    localsStartedFromPreviousSequentialState = true;
                    funcArgs = previousSequentialState.funcArgs;
                    activeDefineEventIndex = previousSequentialState.activeDefineEventIndex ?? 0;
                    const nextDefineEvent = defineDirectiveEvents[activeDefineEventIndex] || null;
                    if (!nextDefineEvent || nextDefineEvent.lineNumber > cursorLine) {
                        activeDefinesMap = previousSequentialState.activeDefinesMap;
                    } else {
                        activeDefinesMap = new Map(previousSequentialState.activeDefinesMap);
                    }
                    if (bodyFunc && !usePreparsedLocals) {
                        appendLocalsThroughCursor(
                            locals,
                            strippedLines,
                            rawLines,
                            depths,
                            filePath,
                            fileName,
                            bodyFunc,
                            previousSequentialState.scannedToLine + 1,
                            cursorLine,
                            lineCtrlChars,
                            defineDirectiveEvents,
                            defineDecls
                        );
                    }
                    if (nextDefineEvent && nextDefineEvent.lineNumber <= cursorLine) {
                        const defineAdvance = advanceActiveDefineDecls(
                            activeDefinesMap,
                            defineDirectiveEvents,
                            previousSequentialState.cursorLine + 1,
                            cursorLine,
                            activeDefineEventIndex
                        );
                        activeDefineEventIndex = defineAdvance.nextEventIndex;
                    }
                }

                if (enclosing) {
                    if (!funcArgs.length) {
                        funcArgs.push(...parseFuncArgs(
                            enclosing.args,
                            filePath,
                            fileName,
                            enclosing.lineNumber,
                            lineCtrlChars[enclosing.lineNumber] || getActiveCtrlChar()
                        ));
                    }
                }

                if (usePreparsedLocals && bodyFunc) {
                    const allFunctionLocals = getPreparsedLocalsForFunction(fileCache.base, bodyFunc, filePath, fileName);
                    let nextLocalIndex = canExtendSequentialState
                        ? (previousSequentialState.preparsedLocalIndex ?? locals.length)
                        : 0;
                    if (nextLocalIndex < 0 || nextLocalIndex > allFunctionLocals.length) {
                        nextLocalIndex = 0;
                        locals = [];
                    }
                    for (; nextLocalIndex < allFunctionLocals.length; nextLocalIndex++) {
                        const local = allFunctionLocals[nextLocalIndex];
                        if ((local.lineNumber ?? -1) > cursorLine) break;
                        locals.push(local);
                    }
                } else if (!canExtendSequentialState && bodyFunc) {
                    const bodyStartLine = (bodyFunc.headerEndLine ?? bodyFunc.startLine) + 1;
                    appendLocalsThroughCursor(
                        locals,
                        strippedLines,
                        rawLines,
                        depths,
                        filePath,
                        fileName,
                        bodyFunc,
                        bodyStartLine,
                        cursorLine,
                        lineCtrlChars,
                        defineDirectiveEvents,
                        defineDecls
                    );
                }

                if (!activeDefinesMap) {
                    activeDefinesMap = new Map();
                    activeDefineEventIndex = advanceActiveDefineDecls(
                        activeDefinesMap,
                        defineDirectiveEvents,
                        0,
                        cursorLine,
                        0
                    ).nextEventIndex;
                }
            } else {
                activeDefinesMap = new Map();
                activeDefineEventIndex = advanceActiveDefineDecls(
                    activeDefinesMap,
                    defineDirectiveEvents,
                    0,
                    rawLines.length - 1,
                    0
                ).nextEventIndex;
            }

            if (cursorLine === undefined && usePreparsedLocals) {
                for (const func of functions) {
                    const funcType = String(func?.type || '');
                    if (
                        funcType === 'native' ||
                        funcType === 'forward' ||
                        hasAnyDeclModifier(func, ['native', 'forward'])
                    ) {
                        continue;
                    }
                    if (func?.args) {
                        funcArgs.push(...parseFuncArgs(
                            func.args,
                            filePath,
                            fileName,
                            func.lineNumber,
                            lineCtrlChars[func.lineNumber] || getActiveCtrlChar()
                        ));
                    }
                    locals.push(...getPreparsedLocalsForFunction(fileCache.base, func, filePath, fileName));
                }
            }

            let scopedLocals = locals;
            if (cursorLine !== undefined) {
                const previousVisibleLocals = localsStartedFromPreviousSequentialState
                    ? previousSequentialState?.result?.locals
                    : null;
                const previousLocalsSoFarLength = previousSequentialState?.localsSoFar?.length ?? -1;
                if (
                    previousVisibleLocals &&
                    locals.length === previousLocalsSoFarLength &&
                    areScopedLocalsVisibleThroughLine(previousVisibleLocals, cursorLine)
                ) {
                    scopedLocals = previousVisibleLocals;
                } else {
                    scopedLocals = locals.filter(local => {
                        const declLine = local.lineNumber;
                        const scopeEndLine = local.scopeEndLine ?? declLine;
                        return cursorLine >= declLine && cursorLine <= scopeEndLine;
                    });
                }
            }

            const scopedGlobals = getScopedGlobalsForCursor(fileCache.base, cursorLine);
            const activeDefineDerivedDecls = getActiveDefineDerivedDecls(
                activeDefinesMap,
                useCursorCache ? fileCache.sequentialCursorState : null
            );
            const scopedDefineGlobals = activeDefineDerivedDecls.globals;
            const scopedDefineFunctions = activeDefineDerivedDecls.functions;
            const resultGlobals = getMergedDeclListByRef(
                fileCache.base,
                scopedGlobals,
                scopedDefineGlobals,
                'mergedScopedGlobalsByRef'
            );
            const resultFunctions = getMergedDeclListByRef(
                fileCache.base,
                functions,
                scopedDefineFunctions,
                'mergedScopedFunctionsByRef'
            );

            if (useCursorCache && cursorLine !== undefined) {
                const previousResult = previousSequentialState?.result || null;
                const canReusePreviousResult = !!(
                    previousResult &&
                    previousSequentialState.cursorLine < cursorLine &&
                    previousSequentialState.headerFuncStartLine === (headerFunc?.startLine ?? null) &&
                    previousSequentialState.bodyFuncStartLine === (bodyFunc?.startLine ?? null) &&
                    areDeclListsEqualByRef(previousResult.globals, resultGlobals) &&
                    areDeclListsEqualByRef(previousResult.functions, resultFunctions) &&
                    areDeclListsEqualByRef(previousResult.locals, scopedLocals) &&
                    areDeclListsEqualByRef(previousResult.funcArgs, funcArgs)
                );

                if (canReusePreviousResult) {
                    fileCache.sequentialCursorState = {
                        cursorLine,
                        headerFuncStartLine: headerFunc?.startLine ?? null,
                        bodyFuncStartLine: bodyFunc?.startLine ?? null,
                        funcArgs,
                        localsSoFar: locals,
                        preparsedLocalsMode: usePreparsedLocals,
                        preparsedLocalIndex: usePreparsedLocals
                            ? locals.length
                            : (previousSequentialState.preparsedLocalIndex ?? 0),
                        activeDefinesMap,
                        activeDefineDerivedDecls,
                        activeDefineEventIndex,
                        scannedToLine: cursorLine,
                        result: previousResult
                    };
                    return previousResult;
                }
            }

            const parsedDecls = {
                globals: attachLazyPrecomputedDeclBuckets(resultGlobals),
                functions: attachLazyPrecomputedDeclBuckets(resultFunctions),
                locals: attachLazyPrecomputedDeclBuckets(scopedLocals),
                funcArgs: attachLazyPrecomputedDeclBuckets(funcArgs),
                depths
            };
            if (useCursorCache && cursorLine !== undefined) {
                fileCache.sequentialCursorState = {
                    cursorLine,
                    headerFuncStartLine: headerFunc?.startLine ?? null,
                    bodyFuncStartLine: bodyFunc?.startLine ?? null,
                    funcArgs,
                    localsSoFar: locals,
                    preparsedLocalsMode: usePreparsedLocals,
                    preparsedLocalIndex: usePreparsedLocals ? locals.length : 0,
                    activeDefinesMap,
                    activeDefineDerivedDecls,
                    activeDefineEventIndex,
                    scannedToLine: cursorLine,
                    result: parsedDecls
                };
            }
            return parsedDecls;
        }, filePath, fileCache.base.finalCtrlChar);

        if (useCursorCache) {
            fileCache.byCursorLine.set(cursorCacheKey, result);
        }
        return result;
    }

    return {
        parseVarPiece,
        parseFuncArgs,
        parseForInit,
        parseEnumBlock,
        collectEnumMemberSyntaxIssues,
        collectVariableDeclarationSyntaxIssuesForLine,
        isPotentialEnumDeclarationLine,
        isPotentialDeclarationStartLine,
        isExplicitDeclarationStartLine,
        parseDeclLine,
        collectDefineDeclarationText,
        collectActiveDefineDecls,
        filterEnumEvalOuterDecls,
        parseFileDecls
    };
}

module.exports = { createDeclarationParsingCore };
