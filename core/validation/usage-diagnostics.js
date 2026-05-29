const fs = require('fs');
const { createUtilityCore } = require('../utils/runtime');
const { normalizePathKey } = require('../utils/path');
const { createMacroExpansionSyntaxCore } = require('../syntax/macro-expander');
const { createVirtualExpandedLineContextCore } = require('../syntax/virtual-expanded-line-context');
const { findBalancedGroupEnd } = require('../syntax/balanced');
const { readPawnAssignmentOperatorAt } = require('../syntax/operators');
const { parsePragmaDirectiveLine } = require('../syntax/pragma-directives');
const { splitPawnLines } = require('../syntax/lines');
const { getSemanticScanLines } = require('../syntax/preprocessed-state');
const {
    hasAnyDeclModifier,
    hasDeclModifier
} = require('../declarations/modifiers');
const {
    advanceTopLevelScannerState,
    createTopLevelScannerState,
    isTopLevelScannerState
} = require('../syntax/top-level');
const {
    isPawnIdentifierStartCode: defaultIsIdentifierStartCode,
    isPawnIdentifierContinueCode: defaultIsIdentifierContinueCode,
    readPawnIdentifierAt
} = require('../syntax/identifiers');
const {
    findNextNonWhitespaceIndex,
    findPreviousNonWhitespaceIndex,
    isPawnWhitespaceChar
} = require('../syntax/whitespace');

const SYNTHETIC_LOCAL_DECLARATION_KEYWORD_RE = /\b(?:new|static|const)\b/;
const EMPTY_SYNTHETIC_LOCAL_DECLARATIONS = { ranges: new Set() };

const {
    isPawnIdentifierStartChar: defaultIsIdentifierStartChar,
    isPawnIdentifierContinueChar: defaultIsIdentifierContinueChar
} = createUtilityCore();

function createSymbolUsageDiagnostics(deps = {}) {
    const {
        getSymbolNeverUsedIssue,
        getSymbolAssignedValueNeverUsedIssue,
        isEscapedQuote,
        splitTopLevel,
        getPreferredFunctionHoverMatch,
        hasIncludeFunctionTwin,
        readFileContent = null,
        isIdentifierStartChar = defaultIsIdentifierStartChar,
        isIdentifierContinueChar = defaultIsIdentifierContinueChar,
        isIdentifierStartCode = defaultIsIdentifierStartCode,
        isIdentifierContinueCode = defaultIsIdentifierContinueCode
    } = deps;
    const macroExpansionCore = createMacroExpansionSyntaxCore({
        isEscapedQuote,
        isIdentifierStartChar,
        isIdentifierContinueChar,
        splitTopLevel
    });
    const virtualExpandedLineContextCore = createVirtualExpandedLineContextCore({
        macroExpansionCore
    });

    const normalizePath = normalizePathKey;

    function skipIndexedAccesses(source, index) {
        let cursor = findNextNonWhitespaceIndex(source, index);
        while (cursor >= 0 && source[cursor] === '[') {
            const closeIndex = findBalancedGroupEnd(source, cursor, '[', ']');
            if (closeIndex < 0) return cursor;
            cursor = findNextNonWhitespaceIndex(source, closeIndex + 1);
        }
        return cursor;
    }

    function getAssignmentOperatorAt(source, index) {
        return readPawnAssignmentOperatorAt(source, index);
    }

    function hasUnmatchedTernaryQuestionBefore(source, colonIndex, occurrenceStart) {
        let parenDepth = 0;
        let bracketDepth = 0;
        let braceDepth = 0;
        let inString = false;
        let stringChar = '';
        const ternaryStack = [];

        for (let index = 0; index < colonIndex; index++) {
            const char = source[index] || '';
            if (inString) {
                if (char === stringChar) inString = false;
                continue;
            }
            if (char === '"' || char === "'") {
                inString = true;
                stringChar = char;
                continue;
            }
            if (char === '(') parenDepth++;
            else if (char === ')' && parenDepth > 0) parenDepth--;
            else if (char === '[') bracketDepth++;
            else if (char === ']' && bracketDepth > 0) bracketDepth--;
            else if (char === '{') braceDepth++;
            else if (char === '}' && braceDepth > 0) braceDepth--;
            else if (char === '?') {
                ternaryStack.push({ parenDepth, bracketDepth, braceDepth, index });
            } else if (char === ':') {
                for (let stackIndex = ternaryStack.length - 1; stackIndex >= 0; stackIndex--) {
                    const question = ternaryStack[stackIndex];
                    if (
                        question.parenDepth === parenDepth &&
                        question.bracketDepth === bracketDepth &&
                        question.braceDepth === braceDepth
                    ) {
                        ternaryStack.splice(stackIndex, 1);
                        break;
                    }
                }
            }
        }

        return ternaryStack.some(question =>
            question.index < occurrenceStart &&
            question.parenDepth === parenDepth &&
            question.bracketDepth === bracketDepth &&
            question.braceDepth === braceDepth
        );
    }

    function classifyVariableOccurrence(source, start, end) {
        const next = findNextNonWhitespaceIndex(source, end);
        const nextChar = next >= 0 ? source[next] : '';
        if (nextChar === ':' && !hasUnmatchedTernaryQuestionBefore(source, next, start)) {
            return { read: false, written: false, skip: true };
        }
        if (
            (source.slice(Math.max(0, start - 2), start) === '++') ||
            (source.slice(Math.max(0, start - 2), start) === '--') ||
            source.slice(end, end + 2) === '++' ||
            source.slice(end, end + 2) === '--'
        ) {
            return { read: true, written: true, skip: false };
        }

        const afterAccess = skipIndexedAccesses(source, end);
        const op = afterAccess >= 0 ? getAssignmentOperatorAt(source, afterAccess) : '';
        if (op) {
            return {
                read: op !== '=',
                written: true,
                skip: false
            };
        }
        return { read: true, written: false, skip: false };
    }

    function collectDeclarationNameRanges(entries, rawLines) {
        const byLine = new Map();
        const entriesByLine = new Map();
        for (const entry of entries) {
            const lineNumber = entry.decl.lineNumber ?? -1;
            if (lineNumber < 0 || lineNumber >= rawLines.length || !entry.name) continue;
            let lineEntries = entriesByLine.get(lineNumber);
            if (!lineEntries) {
                lineEntries = [];
                entriesByLine.set(lineNumber, lineEntries);
            }
            lineEntries.push(entry);
        }

        for (const [lineNumber, lineEntries] of entriesByLine) {
            const source = String(rawLines[lineNumber] || '');
            const pendingByName = new Map();
            for (const entry of lineEntries) {
                let pending = pendingByName.get(entry.name);
                if (!pending) {
                    pending = [];
                    pendingByName.set(entry.name, pending);
                }
                pending.push(entry);
            }

            for (let index = 0; index < source.length;) {
                if (!isIdentifierStartChar(source[index])) {
                    index++;
                    continue;
                }
                const start = index;
                index++;
                while (index < source.length && isIdentifierContinueChar(source[index])) index++;
                const end = index;
                const pending = pendingByName.get(source.slice(start, end));
                if (!pending?.length) continue;
                const entry = pending.shift();
                let lineRanges = byLine.get(lineNumber);
                if (!lineRanges) {
                    lineRanges = [];
                    byLine.set(lineNumber, lineRanges);
                }
                lineRanges.push({ start, end, entry });
                entry.nameStart = start;
                entry.nameEnd = end;
            }
        }
        return byLine;
    }

    function isDeclarationNameOccurrence(declarationNameRangesByLine, lineNumber, start, end) {
        const ranges = declarationNameRangesByLine.get(lineNumber) || [];
        return ranges.some(range => range.start === start && range.end === end);
    }

    function createEntry(decl, kind, options = {}) {
        const name = String(decl?.name || '').trim();
        if (!name) return null;
        return {
            decl,
            kind,
            name,
            read: !!options.read,
            written: !!options.written,
            stock: !!options.stock,
            public: !!options.public,
            native: !!options.native,
            global: !!options.global,
            referenceArg: !!options.referenceArg,
            scopeStartLine: Number.isInteger(options.scopeStartLine)
                ? options.scopeStartLine
                : (decl.lineNumber ?? 0),
            scopeEndLine: Number.isInteger(options.scopeEndLine)
                ? options.scopeEndLine
                : Number.MAX_SAFE_INTEGER,
            declDepth: decl.declDepth ?? 0,
            functionDecl: options.functionDecl || null
        };
    }

    function isCurrentDocumentDecl(decl, documentPath) {
        const declPath = normalizePath(decl?.filePath || decl?.file || '');
        return !declPath || !documentPath || declPath === documentPath;
    }

    function isFunctionImplementationDecl(functionDecl) {
        if (!functionDecl?.name) return false;
        const functionType = String(functionDecl.type || '');
        if (functionType === 'native' || functionType === 'forward' || functionType === 'define') {
            return false;
        }
        return !hasAnyDeclModifier(functionDecl, ['native', 'forward']);
    }

    function findForwardParentDecl(functionDecl, rootCtx) {
        if (!isFunctionImplementationDecl(functionDecl)) return null;
        const name = functionDecl.name;
        const functions = rootCtx?.parsedDecls?.functions || [];
        const localForward = functions.find(candidate =>
            candidate !== functionDecl &&
            candidate?.name === name &&
            candidate.type === 'forward'
        );
        if (localForward) return localForward;

        const incDecls = rootCtx?.incDecls || [];
        const findIncludeForward = candidateName => {
            if (!candidateName || !hasIncludeFunctionTwin?.(candidateName, incDecls, rootCtx?.lookup)) {
                return null;
            }
            const includeDecl = getPreferredFunctionHoverMatch?.(
                candidateName,
                functions,
                incDecls,
                { preferInclude: true },
                rootCtx?.lookup
            )?.data || null;
            if (includeDecl?.type === 'forward') return includeDecl;
            return incDecls.find(candidate =>
                candidate?.name === candidateName &&
                candidate.type === 'forward'
            ) || null;
        };

        const exactIncludeForward = findIncludeForward(name);
        if (exactIncludeForward) return exactIncludeForward;
        if (!String(name || '').startsWith('@') || String(name || '').length <= 1) {
            return null;
        }
        return findIncludeForward(String(name).slice(1));
    }

    function collectPragmaUnusedNames(lines) {
        const names = new Set();
        for (const line of lines || []) {
            const text = String(line || '');
            if (text.indexOf('#') < 0 || text.indexOf('unused') < 0) continue;
            const pragma = parsePragmaDirectiveLine(text);
            if (pragma?.name !== 'unused') continue;
            for (const piece of String(pragma.value || '').split(',')) {
                const name = readPawnIdentifierAt(piece.trim(), 0)?.name || '';
                if (name) names.add(name);
            }
        }
        return names;
    }

    function collectSyntheticLocalDeclarationInfo(source) {
        const names = new Set();
        const ranges = new Set();
        const text = String(source || '');
        let inString = false;
        let stringCharCode = 0;
        let inBlockComment = false;
        let lineComment = false;
        const addName = ident => {
            if (!ident?.text) return;
            names.add(ident.text);
            ranges.add(`${ident.start}:${ident.end}`);
        };
        const readIdentifier = start => {
            if (!isIdentifierStartCode(text.charCodeAt(start))) return null;
            let end = start + 1;
            while (end < text.length && isIdentifierContinueCode(text.charCodeAt(end))) end++;
            return { text: text.slice(start, end), start, end };
        };
        const nextNonWhitespace = start => {
            for (let index = start; index < text.length; index++) {
                if (!isPawnWhitespaceChar(text[index])) return index;
            }
            return -1;
        };
        const skipBalanced = (start, openChar, closeChar) => {
            const close = findBalancedGroupEnd(text, start, openChar, closeChar, { isEscapedQuote });
            return close >= 0 ? close + 1 : text.length;
        };
        const skipInitializer = start => {
            const scannerState = createTopLevelScannerState();
            for (let index = start; index < text.length; index++) {
                const char = text[index];
                if (advanceTopLevelScannerState(text, index, scannerState, { isEscapedQuote })) continue;
                if (!isTopLevelScannerState(scannerState)) continue;
                if (char === ',' || char === ';') return index;
            }
            return text.length;
        };
        const scanDeclarationList = start => {
            let cursor = start;
            while (cursor >= 0 && cursor < text.length) {
                cursor = nextNonWhitespace(cursor);
                if (cursor < 0) return text.length;

                while (true) {
                    const ident = readIdentifier(cursor);
                    if (!ident) break;
                    const identLower = ident.text.toLowerCase();
                    const afterIdent = nextNonWhitespace(ident.end);
                    if (afterIdent >= 0 && text[afterIdent] === ':') {
                        cursor = afterIdent + 1;
                        continue;
                    }
                    if (
                        identLower === 'new' ||
                        identLower === 'static' ||
                        identLower === 'const' ||
                        identLower === 'stock'
                    ) {
                        cursor = ident.end;
                        continue;
                    }
                    break;
                }

                const nameIdent = readIdentifier(cursor);
                if (!nameIdent) return cursor;
                addName(nameIdent);
                cursor = nextNonWhitespace(nameIdent.end);
                while (cursor >= 0 && text[cursor] === '[') {
                    cursor = nextNonWhitespace(skipBalanced(cursor, '[', ']'));
                }
                if (cursor >= 0 && text[cursor] === '=') {
                    cursor = skipInitializer(cursor + 1);
                }
                cursor = nextNonWhitespace(cursor);
                if (cursor >= 0 && text[cursor] === ',') {
                    cursor++;
                    continue;
                }
                return cursor >= 0 ? cursor : text.length;
            }
            return text.length;
        };

        for (let index = 0; index < text.length; index++) {
            const code = text.charCodeAt(index);
            const nextCode = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
            if (inBlockComment) {
                if (code === 42 && nextCode === 47) {
                    inBlockComment = false;
                    index++;
                }
                continue;
            }
            if (lineComment) break;
            if (inString) {
                if (code === stringCharCode) inString = false;
                continue;
            }
            if (code === 47 && nextCode === 47) {
                lineComment = true;
                continue;
            }
            if (code === 47 && nextCode === 42) {
                inBlockComment = true;
                index++;
                continue;
            }
            if (code === 34 || code === 39) {
                inString = true;
                stringCharCode = code;
                continue;
            }
            if (!isIdentifierStartCode(code)) continue;
            if (index > 0 && isIdentifierContinueCode(text.charCodeAt(index - 1))) continue;
            const ident = readIdentifier(index);
            if (!ident) continue;
            const keyword = ident.text.toLowerCase();
            if (keyword === 'new' || keyword === 'static' || keyword === 'const') {
                index = scanDeclarationList(ident.end) - 1;
            } else {
                index = ident.end - 1;
            }
        }
        return { names, ranges };
    }

    function getUsageDefineDeclMaps(rootCtx) {
        const parameterizedDefinesByName = new Map();
        const objectLikeDefinesByName = new Map();
        const defineDecls = rootCtx?.preprocessedState?.defineDecls || [];
        if (!Array.isArray(defineDecls) || !defineDecls.length) {
            return { defineDecls: [], parameterizedDefinesByName, objectLikeDefinesByName };
        }
        for (const decl of defineDecls) {
            if (decl?.type !== 'define' || !decl.name) continue;
            if (decl.macroStyle === 'paren' || decl.macroStyle === 'bracket') {
                parameterizedDefinesByName.set(decl.name, decl);
                continue;
            }
            if (
                !String(decl.value || '').trim()
            ) {
                continue;
            }
            objectLikeDefinesByName.set(decl.name, decl);
        }
        return { defineDecls, parameterizedDefinesByName, objectLikeDefinesByName };
    }

    function collectSymbolUsageIssues(rootCtx, options = {}) {
        const parsedDecls = rootCtx?.parsedDecls || {};
        const rawLines = rootCtx?.rawLines || splitPawnLines(rootCtx?.text || '');
        const scanLines = getSemanticScanLines(rootCtx, { rawLines });
        const documentPath = normalizePath(rootCtx?.fp || '');
        const functionRanges = options.functionRangeMaps || {};
        const functionBodyRangeByLine = functionRanges.byLine || [];
        const functionBodyRangeByFunction = functionRanges.byFunction || new Map();
        const {
            defineDecls,
            parameterizedDefinesByName,
            objectLikeDefinesByName
        } = getUsageDefineDeclMaps(rootCtx);
        const callbackSignatureMode = String(options.callbackSignatureMode || 'strict');
        const compilerLikeForwardCallbackCache = new WeakMap();
        const isCompilerLikeForwardCallbackFunction = functionDecl => {
            if (callbackSignatureMode !== 'compiler-like' || !functionDecl) {
                return false;
            }
            if (compilerLikeForwardCallbackCache.has(functionDecl)) {
                return compilerLikeForwardCallbackCache.get(functionDecl);
            }
            const value = !!findForwardParentDecl(functionDecl, rootCtx);
            compilerLikeForwardCallbackCache.set(functionDecl, value);
            return value;
        };
        const variableEntriesByName = new Map();
        const entries = [];
        const addEntry = entry => {
            if (!entry) return;
            entries.push(entry);
            let bucket = variableEntriesByName.get(entry.name);
            if (!bucket) {
                bucket = [];
                variableEntriesByName.set(entry.name, bucket);
            }
            bucket.push(entry);
        };

        const functionByHeaderLine = [];
        for (const func of parsedDecls.functions || []) {
            const startLine = func.startLine ?? func.lineNumber ?? -1;
            const endLine = func.headerEndLine ?? startLine;
            for (let line = startLine; line <= endLine; line++) {
                if (line >= 0) functionByHeaderLine[line] = func;
            }
        }

        const addGlobalVariableDecls = decls => {
            for (const decl of decls || []) {
                if (decl?.type !== 'variable') continue;
                if (!isCurrentDocumentDecl(decl, documentPath)) continue;
                const isPublicVariable = hasDeclModifier(decl, 'public');
                addEntry(createEntry(decl, 'variable', {
                    read: isPublicVariable,
                    written: isPublicVariable,
                    public: isPublicVariable,
                    stock: hasDeclModifier(decl, 'stock'),
                    global: true,
                    scopeStartLine: decl.lineNumber ?? 0,
                    scopeEndLine: Number.MAX_SAFE_INTEGER
                }));
            }
        };

        const addFunctionVariableDecls = decls => {
            for (const decl of decls || []) {
                if (decl?.type !== 'variable') continue;
                if (!isCurrentDocumentDecl(decl, documentPath)) continue;
                const functionDecl = decl.isArg
                    ? functionByHeaderLine[decl.lineNumber ?? -1] || null
                    : (functionBodyRangeByLine[decl.lineNumber ?? -1]?.func || null);
                if (!functionDecl) {
                    continue;
                }
                const functionType = String(functionDecl?.type || '');
                if (decl.isArg && (
                    functionType === 'native' ||
                    functionType === 'forward' ||
                    hasAnyDeclModifier(functionDecl, ['native', 'forward'])
                )) {
                    continue;
                }
                const functionRange = functionDecl ? functionBodyRangeByFunction.get(functionDecl) : null;
                const isStockFunction = !!(
                    functionType === 'stock' ||
                    hasDeclModifier(functionDecl, 'stock')
                );
                const isPublicArg = !!(decl.isArg && functionDecl && (
                    functionDecl.type === 'public' ||
                    hasDeclModifier(functionDecl, 'public') ||
                    functionDecl.name === 'main' ||
                    functionDecl.name === 'entry'
                ));
                const isCompilerLikeCallbackArg = !!(
                    decl.isArg &&
                    isCompilerLikeForwardCallbackFunction(functionDecl)
                );
                const isReferenceArg = !!(decl.isArg && (hasDeclModifier(decl, '&') || String(decl.dims || '').trim()));
                const isPublicVariable = hasDeclModifier(decl, 'public');
                addEntry(createEntry(decl, 'variable', {
                    read: isPublicArg || isCompilerLikeCallbackArg || isPublicVariable,
                    written: !!String(decl.value || '').trim() || isPublicVariable,
                    referenceArg: isReferenceArg,
                    public: isPublicVariable,
                    stock: hasDeclModifier(decl, 'stock') || isStockFunction,
                    functionDecl,
                    scopeStartLine: decl.isArg
                        ? (functionRange?.bodyStartLine ?? ((functionDecl?.headerEndLine ?? decl.lineNumber ?? 0) + 1))
                        : (decl.lineNumber ?? 0),
                    scopeEndLine: decl.scopeEndLine ?? functionRange?.endLine ?? Number.MAX_SAFE_INTEGER
                }));
            }
        };
        addGlobalVariableDecls(parsedDecls.globals);
        addFunctionVariableDecls(parsedDecls.funcArgs);
        addFunctionVariableDecls(parsedDecls.locals);

        const declarationNameRangesByLine = collectDeclarationNameRanges(entries, rawLines);
        const pragmaUnusedNames = collectPragmaUnusedNames(scanLines);
        for (const name of pragmaUnusedNames) {
            for (const entry of variableEntriesByName.get(name) || []) {
                entry.read = true;
                entry.written = true;
            }
        }
        const variableNameFirstCharCodes = new Uint8Array(128);
        for (const name of variableEntriesByName.keys()) {
            const firstCode = name.charCodeAt(0);
            if (firstCode >= 0 && firstCode < variableNameFirstCharCodes.length) {
                variableNameFirstCharCodes[firstCode] = 1;
            }
        }
        const usageNameFirstCharCodes = new Uint8Array(128);
        const markUsageNameFirstCode = name => {
            const firstCode = String(name || '').charCodeAt(0);
            if (firstCode >= 0 && firstCode < usageNameFirstCharCodes.length) {
                usageNameFirstCharCodes[firstCode] = 1;
            }
        };
        for (const name of variableEntriesByName.keys()) markUsageNameFirstCode(name);
        for (const name of parameterizedDefinesByName.keys()) markUsageNameFirstCode(name);
        for (const name of objectLikeDefinesByName.keys()) markUsageNameFirstCode(name);
        const lineMayContainTrackedIdentifierStart = (source, firstCharCodes) => {
            const text = String(source || '');
            for (let index = 0; index < text.length; index++) {
                const code = text.charCodeAt(index);
                if (code >= firstCharCodes.length || !firstCharCodes[code]) continue;
                if (index > 0 && isIdentifierContinueCode(text.charCodeAt(index - 1))) continue;
                return true;
            }
            return false;
        };
        const objectLikeDefineUsageRelevanceCache = new WeakMap();
        const objectLikeDefineNameUsageRelevanceCache = new Map();
        const scanDefineValueIdentifiers = (value, onIdentifier) => {
            const text = String(value || '');
            let inBlockComment = false;
            let inString = false;
            let stringCharCode = 0;
            let lineComment = false;
            for (let index = 0; index < text.length; index++) {
                const code = text.charCodeAt(index);
                const nextCode = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
                if (inBlockComment) {
                    if (code === 42 && nextCode === 47) {
                        inBlockComment = false;
                        index++;
                    }
                    continue;
                }
                if (lineComment) break;
                if (inString) {
                    if (code === stringCharCode) inString = false;
                    continue;
                }
                if (code === 47 && nextCode === 47) {
                    lineComment = true;
                    continue;
                }
                if (code === 47 && nextCode === 42) {
                    inBlockComment = true;
                    index++;
                    continue;
                }
                if (code === 34 || code === 39) {
                    inString = true;
                    stringCharCode = code;
                    continue;
                }
                if (!isIdentifierStartCode(code)) continue;
                if (index > 0 && isIdentifierContinueCode(text.charCodeAt(index - 1))) continue;

                const start = index;
                let end = index + 1;
                while (end < text.length && isIdentifierContinueCode(text.charCodeAt(end))) end++;
                if (onIdentifier(text.slice(start, end)) === true) return true;
                index = end - 1;
            }
            return false;
        };
        const objectLikeDefineMayReferenceTrackedVariable = (decl, visited = new Set()) => {
            if (!decl || decl.type !== 'define' || decl.args || decl.macroStyle) return false;
            if (objectLikeDefineUsageRelevanceCache.has(decl)) {
                return objectLikeDefineUsageRelevanceCache.get(decl);
            }
            const name = String(decl.name || '');
            if (name) {
                if (objectLikeDefineNameUsageRelevanceCache.has(name)) {
                    return objectLikeDefineNameUsageRelevanceCache.get(name);
                }
                if (visited.has(name)) return false;
                visited.add(name);
            }
            const value = String(decl.value || '');
            const relevant = scanDefineValueIdentifiers(value, identifier => {
                if (variableEntriesByName.has(identifier)) return true;
                const nestedDefine = objectLikeDefinesByName.get(identifier);
                return !!nestedDefine && objectLikeDefineMayReferenceTrackedVariable(nestedDefine, visited);
            });
            objectLikeDefineUsageRelevanceCache.set(decl, relevant);
            if (name) objectLikeDefineNameUsageRelevanceCache.set(name, relevant);
            if (name) visited.delete(name);
            return relevant;
        };
        const usageScopeLineDiff = entries.length ? new Int32Array(scanLines.length + 1) : null;
        if (usageScopeLineDiff) {
            for (const entry of entries) {
                const startLine = Math.max(0, Math.min(scanLines.length, entry.scopeStartLine ?? 0));
                const endLine = Math.max(-1, Math.min(scanLines.length - 1, entry.scopeEndLine ?? (scanLines.length - 1)));
                if (endLine < startLine || startLine >= scanLines.length) continue;
                usageScopeLineDiff[startLine]++;
                usageScopeLineDiff[endLine + 1]--;
            }
        }
        const identifierCandidateLineFlags = rootCtx?.lineIndex?.unknownSymbolCandidateLineFlags || null;

        const isVariableEntryVisibleAtLine = (entry, lineNumber) => {
            if (lineNumber < entry.scopeStartLine || lineNumber > entry.scopeEndLine) return false;
            return !(
                entry.functionDecl &&
                functionBodyRangeByLine[lineNumber]?.func !== entry.functionDecl &&
                !entry.decl.isArg
            );
        };

        const variableEntryResolveCacheByLine = new Map();
        const resolveVariableEntryUncached = (name, lineNumber, candidates = null) => {
            candidates = candidates || variableEntriesByName.get(name);
            if (!candidates?.length) return null;
            if (candidates.length === 1) {
                const entry = candidates[0];
                return isVariableEntryVisibleAtLine(entry, lineNumber) ? entry : null;
            }
            let best = null;
            for (const entry of candidates) {
                if (!isVariableEntryVisibleAtLine(entry, lineNumber)) continue;
                if (!best) {
                    best = entry;
                    continue;
                }
                if ((entry.declDepth ?? 0) > (best.declDepth ?? 0)) {
                    best = entry;
                    continue;
                }
                if ((entry.declDepth ?? 0) === (best.declDepth ?? 0) && (entry.decl.lineNumber ?? -1) > (best.decl.lineNumber ?? -1)) {
                    best = entry;
                }
            }
            return best;
        };
        const resolveVariableEntry = (name, lineNumber) => {
            const candidates = variableEntriesByName.get(name);
            if (!candidates?.length) return null;
            if (candidates.length === 1) {
                const entry = candidates[0];
                return isVariableEntryVisibleAtLine(entry, lineNumber) ? entry : null;
            }
            let lineCache = variableEntryResolveCacheByLine.get(lineNumber);
            if (!lineCache) {
                lineCache = new Map();
                variableEntryResolveCacheByLine.set(lineNumber, lineCache);
            }
            if (lineCache.has(name)) return lineCache.get(name);
            const entry = resolveVariableEntryUncached(name, lineNumber, candidates);
            lineCache.set(name, entry);
            return entry;
        };

        const markVariableOccurrence = (name, lineNumber, source, start, end, options = {}) => {
            if (options.syntheticDeclarationRanges?.has?.(`${start}:${end}`)) {
                return false;
            }
            if (
                !options.synthetic &&
                isDeclarationNameOccurrence(declarationNameRangesByLine, lineNumber, start, end)
            ) {
                return false;
            }
            const variableEntry = resolveVariableEntry(name, lineNumber);
            if (!variableEntry) return false;
            if (options.globalOnly && !variableEntry.global) return false;
            const occurrence = classifyVariableOccurrence(source, start, end);
            if (occurrence.skip) return false;
            const wasRead = variableEntry.read;
            if (occurrence.read || (occurrence.written && variableEntry.referenceArg)) variableEntry.read = true;
            if (occurrence.written) variableEntry.written = true;
            if (!wasRead && variableEntry.read && typeof options.onReadEntry === 'function') {
                options.onReadEntry(variableEntry);
            }
            return true;
        };

        const scanVariableUsageSource = (source, lineNumber, options = {}) => {
            const text = String(source || '');
            if (!text) return;
            if (!lineMayContainTrackedIdentifierStart(text, variableNameFirstCharCodes)) return;
            let inSyntheticBlockComment = false;
            let inString = false;
            let stringCharCode = 0;
            let lineComment = false;
            for (let index = 0; index < text.length; index++) {
                const code = text.charCodeAt(index);
                const nextCode = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
                if (inSyntheticBlockComment) {
                    if (code === 42 && nextCode === 47) {
                        inSyntheticBlockComment = false;
                        index++;
                    }
                    continue;
                }
                if (lineComment) break;
                if (inString) {
                    if (code === stringCharCode) inString = false;
                    continue;
                }
                if (code === 47 && nextCode === 47) {
                    lineComment = true;
                    continue;
                }
                if (code === 47 && nextCode === 42) {
                    inSyntheticBlockComment = true;
                    index++;
                    continue;
                }
                if (code === 34 || code === 39) {
                    inString = true;
                    stringCharCode = code;
                    continue;
                }
                if (!isIdentifierStartCode(code)) continue;
                if (index > 0 && isIdentifierContinueCode(text.charCodeAt(index - 1))) continue;
                if (code >= variableNameFirstCharCodes.length || !variableNameFirstCharCodes[code]) continue;

                const start = index;
                let end = index + 1;
                while (end < text.length && isIdentifierContinueCode(text.charCodeAt(end))) end++;
                const name = text.slice(start, end);
                index = end - 1;
                const nextNonWhitespace = findNextNonWhitespaceIndex(text, end);
                if (nextNonWhitespace >= 0 && text[nextNonWhitespace] === '(') {
                    continue;
                }
                markVariableOccurrence(name, lineNumber, text, start, end, options);
            }
        };

        const applyParameterizedDefineUsage = (decl, line, lineNumber, start, openIndex) => {
            if (!decl || !line || openIndex < 0) return false;
            const escapeChar = rootCtx?.lineCtrlChars?.[lineNumber] || '';
            const callArgs = macroExpansionCore.readParameterizedDefineCallArgs?.(line, openIndex, decl, escapeChar);
            if (!callArgs) return false;
            const invocation = line.slice(start, callArgs.end);
            let expansionSource = '';
            if (decl.macroStyle === 'paren') {
                const virtualLine = virtualExpandedLineContextCore.getVirtualExpandedLineContext(invocation, defineDecls, {
                    escapeChar,
                    defineDecl: decl,
                    expandActualArgs: false,
                    fallbackToFunctionLikeCall: true,
                    maxOutputLength: 8192
                });
                expansionSource = virtualLine.hasExpansion
                    ? virtualLine.expandedText
                    : '';
            }
            if (!expansionSource) {
                const expanded = macroExpansionCore.expandMacros(invocation, defineDecls, {
                    escapeChar,
                    expandActualArgs: false,
                    maxOutputLength: 8192
                });
                expansionSource = expanded.complete && expanded.changed
                    ? expanded.text
                    : '';
            }
            if (!expansionSource) return false;
            const syntheticDeclarations = SYNTHETIC_LOCAL_DECLARATION_KEYWORD_RE.test(expansionSource)
                ? collectSyntheticLocalDeclarationInfo(expansionSource)
                : EMPTY_SYNTHETIC_LOCAL_DECLARATIONS;
            scanVariableUsageSource(expansionSource, lineNumber, {
                synthetic: true,
                syntheticDeclarationRanges: syntheticDeclarations.ranges
            });
            return true;
        };
        const expandedObjectLikeUsageLines = new Map();
        const applyObjectLikeDefineUsage = (decl, line, lineNumber) => {
            if (!decl || !line) return false;
            const cacheKey = `${lineNumber}:${line}`;
            if (expandedObjectLikeUsageLines.has(cacheKey)) {
                return expandedObjectLikeUsageLines.get(cacheKey);
            }
            const escapeChar = rootCtx?.lineCtrlChars?.[lineNumber] || '';
            const expanded = macroExpansionCore.expandMacros(line, defineDecls, {
                escapeChar,
                expandActualArgs: false,
                maxOutputLength: 8192
            });
            const expansionSource = expanded.complete && expanded.changed
                ? String(expanded.text || '')
                : '';
            if (!expansionSource || expansionSource === line) {
                expandedObjectLikeUsageLines.set(cacheKey, false);
                return false;
            }
            const syntheticDeclarations = SYNTHETIC_LOCAL_DECLARATION_KEYWORD_RE.test(expansionSource)
                ? collectSyntheticLocalDeclarationInfo(expansionSource)
                : EMPTY_SYNTHETIC_LOCAL_DECLARATIONS;
            scanVariableUsageSource(expansionSource, lineNumber, {
                synthetic: true,
                syntheticDeclarationRanges: syntheticDeclarations.ranges
            });
            expandedObjectLikeUsageLines.set(cacheKey, true);
            return true;
        };

        let inBlockComment = false;
        let activeUsageScopeLineCount = 0;
        for (let lineNumber = 0; lineNumber < scanLines.length; lineNumber++) {
            if (usageScopeLineDiff) activeUsageScopeLineCount += usageScopeLineDiff[lineNumber];
            if (activeUsageScopeLineCount <= 0) continue;
            if (identifierCandidateLineFlags && !identifierCandidateLineFlags[lineNumber]) continue;
            const line = String(scanLines[lineNumber] || '');
            if (!lineMayContainTrackedIdentifierStart(line, usageNameFirstCharCodes)) continue;
            const rawLine = String(rawLines[lineNumber] || '');
            const syntheticLocalDeclarations = line !== rawLine && SYNTHETIC_LOCAL_DECLARATION_KEYWORD_RE.test(line)
                ? collectSyntheticLocalDeclarationInfo(line)
                : null;
            let inString = false;
            let stringCharCode = 0;
            let lineComment = false;
            for (let index = 0; index < line.length; index++) {
                const code = line.charCodeAt(index);
                const nextCode = index + 1 < line.length ? line.charCodeAt(index + 1) : 0;
                if (inBlockComment) {
                    if (code === 42 && nextCode === 47) {
                        inBlockComment = false;
                        index++;
                    }
                    continue;
                }
                if (lineComment) break;
                if (inString) {
                    if (code === stringCharCode) inString = false;
                    continue;
                }
                if (code === 47 && nextCode === 47) {
                    lineComment = true;
                    continue;
                }
                if (code === 47 && nextCode === 42) {
                    inBlockComment = true;
                    index++;
                    continue;
                }
                if (code === 34 || code === 39) {
                    inString = true;
                    stringCharCode = code;
                    continue;
                }
                if (!isIdentifierStartCode(code)) continue;
                if (index > 0 && isIdentifierContinueCode(line.charCodeAt(index - 1))) continue;
                if (code >= usageNameFirstCharCodes.length || !usageNameFirstCharCodes[code]) continue;

                const start = index;
                let end = index + 1;
                while (end < line.length && isIdentifierContinueCode(line.charCodeAt(end))) end++;
                const name = line.slice(start, end);
                index = end - 1;
                const nextNonWhitespace = findNextNonWhitespaceIndex(line, end);
                if (
                    nextNonWhitespace >= 0 &&
                    (line[nextNonWhitespace] === '(' || line[nextNonWhitespace] === '[')
                ) {
                    const defineDecl = parameterizedDefinesByName.get(name);
                    if (defineDecl && applyParameterizedDefineUsage(
                        defineDecl,
                        line,
                        lineNumber,
                        start,
                        nextNonWhitespace
                    )) {
                        continue;
                    }
                    if (line[nextNonWhitespace] === '(') continue;
                }
                const objectLikeDefineDecl = objectLikeDefinesByName.get(name);
                if (
                    objectLikeDefineDecl &&
                    objectLikeDefineMayReferenceTrackedVariable(objectLikeDefineDecl) &&
                    applyObjectLikeDefineUsage(objectLikeDefineDecl, line, lineNumber)
                ) {
                    continue;
                }
                if (code >= variableNameFirstCharCodes.length || !variableNameFirstCharCodes[code]) continue;
                markVariableOccurrence(name, lineNumber, line, start, end, {
                    syntheticDeclarationRanges: syntheticLocalDeclarations?.ranges
                });
            }
        }

        const getIncludeLineNumber = entry => {
            const line = entry?.lineNumber ?? entry?.line;
            return Number.isInteger(line) ? line : -1;
        };
        const includeUsageLinesByPath = new Map();
        const readIncludeUsageLines = filePath => {
            const normalized = normalizePath(filePath || '');
            if (!normalized) return [];
            if (includeUsageLinesByPath.has(normalized)) return includeUsageLinesByPath.get(normalized);
            let lines = [];
            try {
                const content = typeof readFileContent === 'function'
                    ? readFileContent(filePath)
                    : fs.readFileSync(filePath, 'utf8');
                lines = content == null ? [] : splitPawnLines(content);
            } catch {
                lines = [];
            }
            includeUsageLinesByPath.set(normalized, lines);
            return lines;
        };
        const scanDirectIncludeGlobalUsages = () => {
            const includeEntries = Array.isArray(rootCtx?.includeEntries) ? rootCtx.includeEntries : [];
            if (!includeEntries.length) return;
            const unreadGlobalEntries = new Set(entries.filter(entry =>
                entry.global &&
                !entry.read &&
                !entry.stock &&
                !entry.public
            ));
            if (!unreadGlobalEntries.size) return;
            const scannedIncludePaths = new Set();
            for (const includeEntry of includeEntries) {
                if (!unreadGlobalEntries.size) break;
                if ((includeEntry?.depth ?? 0) !== 0) continue;
                const includePath = includeEntry?.filePath || '';
                const normalizedIncludePath = normalizePath(includePath);
                if (!normalizedIncludePath || normalizedIncludePath === documentPath) continue;
                if (scannedIncludePaths.has(normalizedIncludePath)) continue;
                const includeLineNumber = getIncludeLineNumber(includeEntry);
                if (includeLineNumber < 0) continue;
                scannedIncludePaths.add(normalizedIncludePath);
                for (const includeLine of readIncludeUsageLines(includePath)) {
                    const syntheticDeclarations = SYNTHETIC_LOCAL_DECLARATION_KEYWORD_RE.test(includeLine)
                        ? collectSyntheticLocalDeclarationInfo(includeLine)
                        : EMPTY_SYNTHETIC_LOCAL_DECLARATIONS;
                    scanVariableUsageSource(includeLine, includeLineNumber, {
                        synthetic: true,
                        globalOnly: true,
                        onReadEntry: entry => unreadGlobalEntries.delete(entry),
                        syntheticDeclarationRanges: syntheticDeclarations.ranges
                    });
                    if (!unreadGlobalEntries.size) break;
                }
            }
        };
        scanDirectIncludeGlobalUsages();

        const issues = [];
        for (const entry of entries) {
            if (entry.stock || entry.native || entry.public) continue;
            if (!entry.read && !entry.written) {
                issues.push({
                    entry,
                    issue: getSymbolNeverUsedIssue(entry.name)
                });
            } else if (!entry.read && entry.written) {
                issues.push({
                    entry,
                    issue: getSymbolAssignedValueNeverUsedIssue(entry.name)
                });
            }
        }

        return issues;
    }

    return {
        collectSymbolUsageIssues
    };
}

module.exports = { createSymbolUsageDiagnostics };
