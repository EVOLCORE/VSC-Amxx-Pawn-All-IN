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
    isPotentialDeclarationStartLine,
    isPotentialEnumDeclarationLine,
    isWhitespaceCharCode
} = require('./line-utils');
const { createDefineDeclarationEventCore } = require('./define-events');
const { createEnumSyntaxDiagnosticsCore } = require('./enum-syntax');
const { createMacroExpansionSyntaxCore } = require('../syntax/macro-expander');

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
        findForScopeEndLine,
        findDepthScopeEndLine
    } = deps;
    const macroExpansionCore = createMacroExpansionSyntaxCore({
        isEscapedQuote,
        isIdentifierStartChar: char => isPawnIdentifierStartCode(String(char || '').charCodeAt(0)),
        isIdentifierContinueChar: char => isPawnIdentifierContinueCode(String(char || '').charCodeAt(0)),
        splitTopLevel
    });
    const {
        collectEnumMemberSyntaxIssues,
        parseEnumMemberPrefix,
        splitTopLevelWithOffsets
    } = createEnumSyntaxDiagnosticsCore({
        FORBIDDEN,
        getActiveCtrlChar,
        isEscapedQuote,
        stripLineComment
    });

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

    function parseFuncArgs(argsStr, filePath, fileName, lineNumber, escapeChar = getActiveCtrlChar()) {
        if (!argsStr?.trim()) return [];

        const cacheKey = getFuncArgsParseCacheKey(argsStr, filePath, lineNumber, escapeChar);
        const cached = funcArgsParseCache.get(cacheKey);
        if (cached) return cached;

        const parsedArgs = splitTopLevel(argsStr, escapeChar).flatMap(piece => {
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
        const text = String(source || '');
        if (text[openIndex] !== '(') return -1;
        let depth = 0;
        let inStr = false;
        let strCh = '';
        for (let index = openIndex; index < text.length; index++) {
            const char = text[index];
            if (inStr) {
                if (char === strCh && !isEscapedQuote(text, index, escapeChar)) {
                    inStr = false;
                }
                continue;
            }
            if (char === '"' || char === '\'') {
                inStr = true;
                strCh = char;
                continue;
            }
            if (char === '(') {
                depth++;
            } else if (char === ')') {
                depth--;
                if (depth === 0) return index;
            }
        }
        return -1;
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

    function nextMeaningfulLineStartsDeclarationBoundary(options = {}) {
        const lineNumber = Number.isInteger(options?.lineNumber) ? options.lineNumber : -1;
        const sourceLines = Array.isArray(options?.strippedLines)
            ? options.strippedLines
            : (Array.isArray(options?.rawLines) ? options.rawLines : null);
        if (!sourceLines || lineNumber < 0) return false;

        for (let probeLine = lineNumber + 1; probeLine < sourceLines.length; probeLine++) {
            const trimmed = String(sourceLines[probeLine] || '').trim();
            if (!trimmed) continue;
            return trimmed.startsWith('#') || isExplicitDeclarationStartLine(trimmed);
        }
        return false;
    }

    function readUnexpectedTrailingDeclarationComma(source, decls = [], options = {}) {
        if (!nextMeaningfulLineStartsDeclarationBoundary(options)) return null;
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
        for (let index = 0; index < variableDecls.length; index++) {
            const decl = variableDecls[index];
            const sameNameOccurrenceIndex = variableDecls
                .slice(0, index)
                .filter(item => item?.name === decl?.name).length;
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
        let strCh = '';
        let endLine = startLine;

        outer:
        for (let lineNo = startLine; lineNo < rawLines.length; lineNo++) {
            const line = rawLines[lineNo] || '';
            const escapeChar = lineCtrlChars[lineNo] || getActiveCtrlChar();
            endLine = lineNo;

            for (let i = 0; i < line.length; i++) {
                const c = line[i];
                const n = line[i + 1] || '';

                if (blockComment) {
                    if (c === '*' && n === '/') { blockComment = false; i++; }
                    continue;
                }
                if (inStr) {
                    if (c === strCh && !isEscapedQuote(line, i, escapeChar)) inStr = false;
                    continue;
                }
                if (c === '/' && n === '/') break;
                if (c === '/' && n === '*') { blockComment = true; i++; continue; }
                if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
                if (c === '{') {
                    braceDepth++;
                    foundOpen = true;
                } else if (c === '}') {
                    braceDepth--;
                    if (foundOpen && braceDepth === 0) break outer;
                }
            }
        }

        if (!foundOpen || braceDepth !== 0) return null;

        const text = rawLines.slice(startLine, endLine + 1).join('\n');
        const openIdx = text.indexOf('{');
        const closeIdx = text.lastIndexOf('}');
        if (openIdx < 0 || closeIdx <= openIdx) return null;
        const enumHeader = text.slice(0, openIdx).replace(/\s+/g, ' ').trim();
        const enumHeaderSpec = parseEnumHeaderSpec(enumHeader);
        const enumName = enumHeaderSpec.displayName;
        const enumSymbolName = enumHeaderSpec.symbolName;

        const enumMayHaveDocs = mayHaveDocsForLine(rawLines, startLine);
        const getEnumDocs = (() => {
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
        })();
        const strippedBlockLines = [];
        for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
            strippedBlockLines.push(String(scanLines[lineNumber] || ''));
        }
        const decls = [];
        const enumMembers = [];
        const hasOuterDecls = Array.isArray(outerDecls) && outerDecls.length;
        let enumEvalDeclsCache = null;
        let enumEvalDeclsCacheDeclCount = -1;
        const getEnumEvalDecls = () => {
            if (!hasOuterDecls) return decls;
            if (enumEvalDeclsCache && enumEvalDeclsCacheDeclCount === decls.length) {
                return enumEvalDeclsCache;
            }
            enumEvalDeclsCacheDeclCount = decls.length;
            enumEvalDeclsCache = outerDecls.concat(decls);
            return enumEvalDeclsCache;
        };
        let nextValue = 0;
        let canAutoValue = true;
        const strippedBlockText = strippedBlockLines.join('\n');
        const strippedOpenIdx = strippedBlockText.indexOf('{');
        const strippedCloseIdx = strippedBlockText.lastIndexOf('}');
        const body = (
            strippedOpenIdx >= 0 && strippedCloseIdx > strippedOpenIdx
                ? strippedBlockText.slice(strippedOpenIdx + 1, strippedCloseIdx)
                : text.slice(openIdx + 1, closeIdx).replace(/\/\*[\s\S]*?\*\//g, '')
        );
        const bodyBlockOffset = strippedOpenIdx >= 0 ? strippedOpenIdx + 1 : openIdx + 1;
        const bodyStartLineOffset = countLineBreaks(strippedBlockText, 0, bodyBlockOffset);

        for (const rawPart of splitTopLevelWithOffsets(body)) {
            const rawPiece = rawPart.text;
            const sourcePiece = stripLineComment(rawPiece);
            let memberPrefix = parseEnumMemberPrefix(sourcePiece);
            if (!memberPrefix && sourcePiece.indexOf('\n') >= 0) {
                let lineStart = 0;
                while (lineStart < sourcePiece.length) {
                    const newlineIndex = sourcePiece.indexOf('\n', lineStart);
                    if (newlineIndex < 0) break;
                    lineStart = newlineIndex + 1;
                    memberPrefix = parseEnumMemberPrefix(sourcePiece.slice(lineStart), lineStart);
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
                    ? formatAutoEnumValueDisplay(nextValue, enumHeaderSpec.stepSpec, getCurrentEnumEvalDecls())
                    : displayValue;
            } else if (value) {
                explicitInt = evaluatePawnNumericExpr(value, getCurrentEnumEvalDecls());
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
                countLineBreaks(sourcePiece, 0, nameOffsetInPiece);
            const memberMayHaveDocs = mayHaveDocsForLine(rawLines, lineNumber);
            const getMemberDocs = (() => {
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
            })();

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
                ? dimsParts.map(part => parseDimSpec(part, getEnumEvalDecls()))
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
                        ? applyEnumStep(explicitInt, enumHeaderSpec.stepSpec, getCurrentEnumEvalDecls())
                        : explicitInt + step;
                    if (stepped == null) {
                        canAutoValue = false;
                    } else {
                        nextValue = stepped;
                    }
                }
            } else if (canAutoValue) {
                const stepped = enumHeaderSpec.stepSpec
                    ? applyEnumStep(nextValue, enumHeaderSpec.stepSpec, getCurrentEnumEvalDecls())
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
        if (!source || source.startsWith('#')) return '';

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
        const defineDecl = defineDecls.find(decl => decl?.name === macroName && isFunctionLikeDefineDecl(decl));
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
        const preprocessorDirective = line.startsWith('#')
            ? parsePreprocessorDirectiveLine(line)
            : null;
        if (line.startsWith('#') && preprocessorDirective?.keyword !== 'define') return [];

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
            if (!macroStyle && name.startsWith('_')) return [];
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
        const name = nm[1];
        if (FORBIDDEN.has(name)) return [];
        rest = nameSource.slice(nm[0].length).trimStart();

        if (rest.startsWith('(')) {
            if (mode === 'local') return [];
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
            const functionDecl = {
                name, args: argsRaw.replace(/\s+/g, ' ').trim(),
                type, typeTag, modifiers, dims: leadingDims,
                file: fileName, filePath, lineNumber, value: '',
                stateSpec
            };
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

            const nextFunctionStartLine = findNextFunctionStartLine(base.functions, func);
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
        const nextFunctionStartLine = findNextFunctionStartLine(base.functions, func);
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
            base.defineDirectiveEvents
        );
        base.localDeclsByFunction.set(func, locals);
        return locals;
    }

    function isPotentialLocalDeclarationStartLine(line) {
        const trimmed = String(line || '').trimStart();
        return /^(?:new|static|const|enum)\b/.test(trimmed);
    }

    function appendLocalsThroughCursor(locals, strippedLines, rawLines, depths, filePath, fileName, bodyFunc, fromLine, cursorLine, lineCtrlChars = [], defineDirectiveEvents = []) {
        if (!bodyFunc || fromLine > cursorLine) return;
        const bodyStartLine = (bodyFunc.headerEndLine ?? bodyFunc.startLine) + 1;
        const parseFromLine = Math.max(bodyStartLine, fromLine);
        if (parseFromLine > cursorLine) return;

        let activeDefineDeclsByLine = null;
        let activeDefineDeclsEventIndex = 0;
        let activeDefineDeclsAdvancedThrough = -1;
        const getActiveDefineDeclsBeforeLine = lineNumber => {
            if (!Array.isArray(defineDirectiveEvents) || !defineDirectiveEvents.length) return [];
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
            }
            return [...activeDefineDeclsByLine.values()];
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
                if (!/^for\s*\(/.test(trimmedStartLine) && !isPotentialLocalDeclarationStartLine(trimmedStartLine)) {
                    continue;
                }
                const { text: joinedText, nextLine } = collectDeclarationText(rawLines, k, lineCtrlChars, strippedLines);
                const lineText = joinedText.trim();
                k = nextLine - 1;
                if (/^for\s*\(/.test(lineText)) {
                    declsOnLine = parseForInit(
                        lineText,
                        rawLines,
                        filePath,
                        fileName,
                        startK,
                        lineCtrlChars[startK] || getActiveCtrlChar(),
                        {
                            defineDecls: getActiveDefineDeclsBeforeLine(startK)
                        }
                    );
                } else {
                    declsOnLine = parseDeclLine(
                        { text: lineText, startLine: startK },
                        rawLines, filePath, fileName, 'local',
                        {
                            defineDecls: getActiveDefineDeclsBeforeLine(startK),
                            escapeChar: lineCtrlChars[startK] || getActiveCtrlChar()
                        }
                    );
                }
            }
            for (const d of declsOnLine) {
                const declDepth = singleStatementDecl
                    ? singleStatementDecl.declDepth
                    : isFunctionSingleStatementBodyLine
                        ? Math.max(1, (depths[bodyFunc.startLine] ?? 0) + 1)
                    : (depths[startK] ?? 0);
                d.declDepth = declDepth;
                d.scopeEndLine = singleStatementDecl
                    ? singleStatementDecl.scopeEndLine
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
            if (trimmed.startsWith('#') || isExplicitDeclarationStartLine(trimmed)) return null;
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
        const topLevelDeclCandidateRe = /^(?:#|enum\b|new\b|static\b|stock\b|public\b|private\b|const\b|forward\b|native\b)/;
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
            if (topLevelDeclCandidateRe.test(previousTrimmed) || topLevelDeclCandidateRe.test(nextTrimmed)) {
                return false;
            }
        }

        return true;
    }

    function parseFileDecls(text, filePath, fileName, cursorLine, preprocessedState = null, options = {}) {
        const cacheKey = normalizeFsPath(filePath);
        const usePreparsedLocals = options.preparseLocals === true;
        const cursorCacheKey = `${cursorLine === undefined ? '__all__' : String(cursorLine)}::locals:${usePreparsedLocals ? 1 : 0}`;
        const useCursorCache = options.cursorCache !== false;
        const filterEnumEvalOuterDecls = decls => (Array.isArray(decls) ? decls : [])
            .filter(decl =>
                decl?.type === 'define' ||
                decl?.type === 'enum' ||
                decl?.type === 'enum-item'
            );
        const parseOuterDecls = filterEnumEvalOuterDecls(options.outerDecls);
        const getParseOuterDeclsForLine = typeof options.getOuterDeclsForLine === 'function'
            ? lineNumber => filterEnumEvalOuterDecls(options.getOuterDeclsForLine(lineNumber))
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
                directiveCandidateLines: sourceCtrlCharState?.directiveCandidateLines || null,
                returnState: true
            });
            const processedText = resolvedPreprocessedState.content;
            const processedSnapshot = getFileSnapshot(filePath, processedText, {
                rawLines: resolvedPreprocessedState.rawLines
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
                            defineDirectiveEvents: previousBase.defineDirectiveEvents,
                            depths,
                            globals: previousBase.globals,
                            functions: previousBase.functions,
                            localDeclsByFunction: null,
                            cursorFunctionIndex: null
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
                        const deprecatedMessage = parseDeprecatedPragmaMessage(strippedLines[i]);
                        if (deprecatedMessage != null) {
                            pendingDeprecatedMessage = deprecatedMessage;
                            i++;
                            continue;
                        }
                        if (!isPotentialDeclarationStartLine(strippedLines[i])) { i++; continue; }
                        if (isPotentialEnumDeclarationLine(strippedLines[i])) {
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
                        defineDirectiveEvents,
                        depths,
                        globals,
                        functions,
                        localDeclsByFunction: null,
                        cursorFunctionIndex: null
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

            if (cursorLine !== undefined && cursorLine < rawLines.length) {
                const previousSequentialState = fileCache.sequentialCursorState;
                const canExtendSequentialState = !!(
                    previousSequentialState &&
                    previousSequentialState.cursorLine < cursorLine &&
                    previousSequentialState.preparsedLocalsMode === usePreparsedLocals &&
                    previousSequentialState.headerFuncStartLine === (headerFunc?.startLine ?? null) &&
                    previousSequentialState.bodyFuncStartLine === (bodyFunc?.startLine ?? null)
                );

                if (canExtendSequentialState) {
                    locals = [...previousSequentialState.localsSoFar];
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
                            defineDirectiveEvents
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
                        defineDirectiveEvents
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
                    const funcModifiers = new Set(func?.modifiers || []);
                    if (
                        funcType === 'native' ||
                        funcType === 'forward' ||
                        funcModifiers.has('native') ||
                        funcModifiers.has('forward')
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

            const scopedLocals = cursorLine === undefined
                ? locals
                : locals.filter(local => {
                const declLine = local.lineNumber;
                const scopeEndLine = local.scopeEndLine ?? declLine;
                return cursorLine >= declLine && cursorLine <= scopeEndLine;
            });

            const scopedGlobals = cursorLine === undefined
                ? globals
                : globals.filter(globalDecl => globalDecl.lineNumber <= cursorLine);
            const activeDefineDecls = [...activeDefinesMap.values()];
            const scopedDefineGlobals = activeDefineDecls.filter(isObjectLikeDefineDecl);
            const scopedDefineFunctions = activeDefineDecls
                .filter(isFunctionLikeDefineDecl)
                .map(d => ({ ...d, startLine: d.lineNumber, headerEndLine: d.lineNumber }));
            const resultGlobals = scopedDefineGlobals.length
                ? [...scopedGlobals, ...scopedDefineGlobals]
                : scopedGlobals;
            const resultFunctions = scopedDefineFunctions.length
                ? [...functions, ...scopedDefineFunctions]
                : functions;

            if (useCursorCache && cursorLine !== undefined) {
                const previousSequentialState = fileCache.sequentialCursorState;
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
                        activeDefineEventIndex,
                        scannedToLine: cursorLine,
                        result: previousResult
                    };
                    return previousResult;
                }
            }

            const parsedDecls = {
                globals: resultGlobals,
                functions: resultFunctions,
                locals: scopedLocals,
                funcArgs,
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
        collectActiveDefineDecls,
        parseFileDecls
    };
}

module.exports = { createDeclarationParsingCore };
