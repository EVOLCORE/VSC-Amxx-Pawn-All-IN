const { createUtilityCore } = require('../utils');
const { createSemanticSyntaxCore } = require('../syntax/semantic-classifier');
const { createMacroExpansionSyntaxCore } = require('../syntax/macro-expander');
const { createArrayShapeCore } = require('../array-shape');

const {
    isPawnIdentifierStartChar: defaultIsPawnIdentifierStartChar,
    isPawnIdentifierContinueChar: defaultIsPawnIdentifierContinueChar
} = createUtilityCore();

// Shared validation/type-inference layer used by hover and live validation.
// The module is dependency-injected on purpose so we can keep behavior stable
// while gradually moving hot paths out of the main extension file.
function createValidationCore(deps) {
    const {
        vscode,
        fs,
        t,
        getActiveCtrlChar,
        isEscapedQuote,
        measurePawnStringLiteral,
        splitTopLevel,
        escapeRegExp,
        unwrapOuterParens,
        extractEnumSymbolName,
        findDeclByNameCached,
        isFunctionLikeDecl,
        BUILTIN_DECLS,
        FORBIDDEN,
        TAG_RE,
        isPawnIdentifierStartChar = defaultIsPawnIdentifierStartChar,
        isPawnIdentifierContinueChar = defaultIsPawnIdentifierContinueChar
    } = deps;
    const declLookupCache = new WeakMap();
    const effectiveDeclDimPartsCache = new WeakMap();
    const functionReturnTypeCache = new WeakMap();
    const functionReturnTypeStableCache = new Map();
    const parsedNumericExprCache = new Map();
    const PARSED_NUMERIC_EXPR_CACHE_LIMIT = 4096;
    const PARSED_NUMERIC_EXPR_CACHE_MAX_CHARS = 512;
    const PAWN_CHARS_PER_CELL = 4;
    const normalizeCachePath = value => String(value || '').replace(/\\/g, '/').toLowerCase();
    const semanticSyntaxCore = createSemanticSyntaxCore({
        isEscapedQuote,
        isIdentifierStartChar: isPawnIdentifierStartChar,
        isIdentifierContinueChar: isPawnIdentifierContinueChar
    });
    const macroExpansionCore = createMacroExpansionSyntaxCore({
        isEscapedQuote,
        isIdentifierStartChar: isPawnIdentifierStartChar,
        isIdentifierContinueChar: isPawnIdentifierContinueChar,
        splitTopLevel
    });
    const parseBraceArrayLiteralExpression = (expr, escapeChar = getActiveCtrlChar()) =>
        semanticSyntaxCore.parseBraceArrayLiteralExpression(expr, { escapeChar });
    const arrayShapeCore = createArrayShapeCore({
        measurePawnStringLiteral,
        parseBraceArrayLiteralExpression,
        parseDimsParts,
        parseDimSpec
    });
    const parseIndexedAccessExpression = (expr, escapeChar = getActiveCtrlChar(), options = {}) => {
        const expressionOptions = typeof escapeChar === 'object' && escapeChar !== null
            ? { ...escapeChar }
            : { ...(options || {}), escapeChar };
        if (expressionOptions.escapeChar == null) {
            expressionOptions.escapeChar = getActiveCtrlChar();
        }
        return semanticSyntaxCore.parseIndexedAccessExpression(expr, expressionOptions);
    };
    const getOpenDocumentForFile = filePath => {
        const targetPath = normalizeCachePath(filePath);
        if (!targetPath) return null;
        for (const doc of vscode?.workspace?.textDocuments || []) {
            if (normalizeCachePath(doc?.fileName) === targetPath) {
                return doc;
            }
        }
        return null;
    };
    const getTextLineStartOffset = (source, targetLine) => {
        const text = String(source || '');
        const line = Math.max(0, Number.isInteger(targetLine) ? targetLine : 0);
        let offset = 0;
        for (let currentLine = 0; currentLine < line; currentLine++) {
            const newlineIndex = text.indexOf('\n', offset);
            if (newlineIndex < 0) return text.length;
            offset = newlineIndex + 1;
        }
        return offset;
    };
    const isImplicitBoolToScalarCompat = (expectedTag, actualTag, actualDims) =>
        !String(expectedTag || '').trim() &&
        !String(actualDims || '').trim() &&
        String(actualTag || '').toLowerCase() === 'bool';
    const normalizeEnumName = value => String(value || '').replace(/^_?\s*:\s*/, '').trim();
    const normalizeTagName = value => String(value || '').replace(/^_?\s*:\s*/, '').trim();
    const isAnyTagName = value => normalizeTagName(value).toLowerCase() === 'any';
    const isFixedPawnTagName = value => /^[A-Z]/.test(normalizeTagName(value));

    function isIdentifierStartChar(char = '') {
        return isPawnIdentifierStartChar(char);
    }

    function isIdentifierContinueChar(char = '') {
        return isPawnIdentifierContinueChar(char);
    }

    function readPawnLiteralCharValue(source, index, escapeChar = '') {
        const text = String(source || '');
        if (index >= text.length) return null;

        const char = text[index];
        if (!escapeChar || char !== escapeChar) {
            const value = text.codePointAt(index);
            if (value == null) return null;
            return {
                value,
                end: index + String.fromCodePoint(value).length
            };
        }

        index++;
        if (index >= text.length) return null;
        const escaped = text[index];
        if (escaped === escapeChar) return { value: escaped.codePointAt(0), end: index + 1 };
        if (escaped === 'a') return { value: 7, end: index + 1 };
        if (escaped === 'b') return { value: 8, end: index + 1 };
        if (escaped === 'e') return { value: 27, end: index + 1 };
        if (escaped === 'f') return { value: 12, end: index + 1 };
        if (escaped === 'n') return { value: 10, end: index + 1 };
        if (escaped === 'r') return { value: 13, end: index + 1 };
        if (escaped === 't') return { value: 9, end: index + 1 };
        if (escaped === 'v') return { value: 11, end: index + 1 };
        if (escaped === '\'' || escaped === '"' || escaped === '%') {
            return { value: escaped.codePointAt(0), end: index + 1 };
        }
        if (escaped === 'x') {
            index++;
            const digitStart = index;
            let value = 0;
            while (index < text.length && /[0-9a-fA-F]/.test(text[index])) {
                value = (value << 4) + Number.parseInt(text[index], 16);
                index++;
            }
            if (index === digitStart) return null;
            if (text[index] === ';') index++;
            return { value, end: index };
        }
        if (/[0-9]/.test(escaped)) {
            let value = 0;
            while (index < text.length && /[0-9]/.test(text[index])) {
                value = value * 10 + Number.parseInt(text[index], 10);
                index++;
            }
            if (text[index] === ';') index++;
            return { value, end: index };
        }
        return null;
    }

    function evaluatePawnCharacterLiteralValue(literal, escapeChar = getActiveCtrlChar()) {
        const text = String(literal || '');
        if (text.length < 3 || text[0] !== '\'' || text[text.length - 1] !== '\'') return null;
        const parsed = readPawnLiteralCharValue(text, 1, escapeChar);
        if (!parsed || parsed.end !== text.length - 1) return null;
        if (parsed.value < 0 || parsed.value > 0xff) return null;
        return parsed.value;
    }

    function replaceNumericCharacterLiteralsForValidation(source, escapeChar = getActiveCtrlChar()) {
        const text = String(source || '');
        if (text.indexOf('\'') < 0) return text;
        let output = '';
        let cursor = 0;
        for (let index = 0; index < text.length; index++) {
            if (text[index] !== '\'') continue;
            const parsed = readPawnLiteralCharValue(text, index + 1, escapeChar);
            if (!parsed || text[parsed.end] !== '\'') continue;
            if (parsed.value < 0 || parsed.value > 0xff) continue;
            output += text.slice(cursor, index) + '0';
            cursor = parsed.end + 1;
            index = parsed.end;
        }
        return cursor > 0 ? output + text.slice(cursor) : text;
    }


    function isHexLiteralIdentifierTail(source, startIndex) {
        const text = String(source || '');
        if (startIndex <= 0) return false;
        if (text[startIndex] === 'x' || text[startIndex] === 'X') {
            if (text[startIndex - 1] !== '0') return false;
            return /[0-9a-fA-F]/.test(text[startIndex + 1] || '');
        }
        if (!/[a-fA-F]/.test(text[startIndex] || '')) return false;

        let probe = startIndex - 1;
        while (probe >= 0 && /[0-9a-fA-F]/.test(text[probe])) probe--;
        return probe >= 1 &&
            (text[probe] === 'x' || text[probe] === 'X') &&
            text[probe - 1] === '0';
    }

    function getDeclLookup(decls = []) {
        if (!Array.isArray(decls) || !decls.length) return null;
        if (decls.length < 24) return null;
        let lookup = declLookupCache.get(decls);
        if (lookup) return lookup;

        lookup = new Map();
        for (const decl of decls) {
            if (!decl?.name || lookup.has(decl.name)) continue;
            lookup.set(decl.name, decl);
        }
        declLookupCache.set(decls, lookup);
        return lookup;
    }

    function findDeclByNameFromList(decls = [], name = '', predicate = null) {
        if (!name) return null;
        const lookup = predicate ? null : getDeclLookup(decls);
        if (lookup) {
            return lookup.get(name) || null;
        }
        return decls.find(item => item.name === name && (!predicate || predicate(item))) || null;
    }

    function findAnyDeclByNameFromSources(decls = [], name = '', predicate = null, analysisCache = null) {
        if (!name) return null;
        if (analysisCache?.findAnyDeclByName) {
            return analysisCache.findAnyDeclByName(name, predicate);
        }
        return findDeclByNameFromList(decls, name, predicate) ||
            findDeclByNameCached(BUILTIN_DECLS, name, predicate);
    }

    function findLocalDeclByNameFromSources(decls = [], name = '', predicate = null, analysisCache = null) {
        if (!name) return null;
        if (analysisCache?.findDeclByName) {
            return analysisCache.findDeclByName(name, predicate);
        }
        return findDeclByNameFromList(decls, name, predicate);
    }

    const arrayScalarIgnoredNames = new Set([
        '_',
        'new', 'static', 'stock', 'public', 'private', 'const', 'native', 'forward',
        'return', 'if', 'for', 'while', 'switch', 'case', 'default', 'do', 'else',
        'sizeof', 'tagof', 'defined', 'state', 'goto', 'assert', 'sleep', 'exit', 'enum',
        'true', 'false', 'cellmin', 'cellmax', 'char'
    ]);

    function stripTrailingSemicolon(source) {
        return String(source || '').trim().replace(/;\s*$/, '').trim();
    }

    function unwrapExpressionForValidation(expr, escapeChar = getActiveCtrlChar()) {
        let source = stripTrailingSemicolon(expr);
        while (source.startsWith('(')) {
            const unwrapped = unwrapOuterParens(source, escapeChar);
            if (unwrapped === source) break;
            source = unwrapped.trim();
        }
        return source;
    }

    function stripNamedArgumentPrefix(expr, escapeChar = getActiveCtrlChar()) {
        const source = unwrapExpressionForValidation(expr, escapeChar);
        const namedArg = semanticSyntaxCore.getRootNamedArgumentExpression(source, { escapeChar });
        return namedArg ? unwrapExpressionForValidation(namedArg.expression, escapeChar) : source;
    }

    function stripTagCastsForValidation(expr, escapeChar = getActiveCtrlChar()) {
        const source = stripNamedArgumentPrefix(expr, escapeChar);
        return unwrapExpressionForValidation(
            semanticSyntaxCore.stripRootTagCasts(source, { escapeChar }),
            escapeChar
        );
    }

    function isConstVariableDecl(decl) {
        return Array.isArray(decl?.modifiers) && decl.modifiers.includes('const');
    }

    function findVariableDeclByNameFromSources(decls = [], name = '', analysisCache = null) {
        const symbolName = String(name || '').trim();
        if (!symbolName) return null;
        return findAnyDeclByNameFromSources(
            decls,
            symbolName,
            item => item?.type === 'variable',
            analysisCache
        );
    }

    function parseAssignableAccessExpression(expr, escapeChar = getActiveCtrlChar()) {
        const source = unwrapExpressionForValidation(expr, escapeChar);
        const indexedExpr = parseIndexedAccessExpression(source, escapeChar);
        if (!indexedExpr?.baseName || !indexedExpr.accesses?.length) return null;
        const accesses = indexedExpr.accesses.map(accessText => ({
            text: accessText,
            innerText: accessText.slice(1, -1).trim(),
            kind: accessText[0] === '{' ? '{' : '['
        }));
        if (accesses.some(access => !access.innerText)) return null;
        return { baseName: indexedExpr.baseName, accesses };
    }

    function getExpressionAssignableInfo(expr, decls = [], analysisCache = null, options = {}) {
        const escapeChar = options?.escapeChar ?? getActiveCtrlChar();
        const source = stripTagCastsForValidation(expr, escapeChar);
        if (!source) {
            return { isLValue: false, isConst: false, dims: '', baseDecl: null, name: '', isIndexedAccess: false };
        }

        const bareName = source.match(/^([A-Za-z_@]\w*)$/)?.[1] || '';
        if (bareName) {
            const decl = findVariableDeclByNameFromSources(decls, bareName, analysisCache);
            if (!decl) {
                return { isLValue: false, isConst: false, dims: '', baseDecl: null, name: bareName, isIndexedAccess: false };
            }
            const inferred = inferArgType(source, decls, analysisCache);
            return {
                isLValue: true,
                isConst: isConstVariableDecl(decl),
                dims: inferred?.dims || '',
                baseDecl: decl,
                name: bareName,
                isIndexedAccess: false
            };
        }

        const indexedExpr = parseAssignableAccessExpression(source, escapeChar);
        if (indexedExpr?.baseName) {
            const baseDecl = findVariableDeclByNameFromSources(decls, indexedExpr.baseName, analysisCache);
            if (!baseDecl) {
                return {
                    isLValue: false,
                    isConst: false,
                    dims: '',
                    baseDecl: null,
                    name: indexedExpr.baseName,
                    isIndexedAccess: true
                };
            }
            const inferred = inferArgType(source, decls, analysisCache);
            let allowsScalarAssignmentToArrayField = false;
            if (inferred?.dims && indexedExpr.accesses?.length) {
                const accessChain = resolveIndexedAccessValidationChain(
                    baseDecl,
                    indexedExpr.accesses.map(access => access.innerText),
                    decls,
                    analysisCache
                );
                const lastStep = accessChain[accessChain.length - 1] || null;
                allowsScalarAssignmentToArrayField =
                    !!lastStep?.dimSpec?.enumName &&
                    Array.isArray(lastStep.nextDimParts) &&
                    lastStep.nextDimParts.length > 0;
            }
            return {
                isLValue: true,
                isConst: isConstVariableDecl(baseDecl),
                dims: inferred?.dims || '',
                baseDecl,
                name: indexedExpr.baseName,
                isIndexedAccess: true,
                allowsScalarAssignmentToArrayField
            };
        }

        return { isLValue: false, isConst: false, dims: '', baseDecl: null, name: '', isIndexedAccess: false };
    }

    function isSyntacticAssignableExpression(expr, options = {}) {
        const escapeChar = options?.escapeChar ?? getActiveCtrlChar();
        const source = stripTagCastsForValidation(stripTrailingSemicolon(expr), escapeChar);
        if (!source) return false;
        if (semanticSyntaxCore.isNamedArgumentTarget(source, { escapeChar })) return true;
        return semanticSyntaxCore.isSyntacticAssignableExpression(source, { escapeChar }) ||
            !!parseIndexedAccessExpression(source, escapeChar);
    }

    function findFirstNonWhitespaceIndex(source, startIndex = 0) {
        const text = String(source || '');
        let index = Math.max(0, startIndex);
        while (index < text.length && /\s/.test(text[index])) index++;
        return index;
    }

    function findPreviousNonWhitespaceIndex(source, startIndex = 0) {
        const text = String(source || '');
        let index = Math.min(text.length - 1, startIndex);
        while (index >= 0 && /\s/.test(text[index])) index--;
        return index;
    }

    function findBalancedGroupEnd(source, openIndex, openChar = '(', closeChar = ')', escapeChar = getActiveCtrlChar()) {
        const text = String(source || '');
        if (text[openIndex] !== openChar) return -1;
        let depth = 0;
        let inStr = false;
        let strCh = '';
        for (let index = openIndex; index < text.length; index++) {
            const char = text[index];
            if (inStr) {
                if (char === strCh && !isEscapedQuote(text, index, escapeChar)) inStr = false;
                continue;
            }
            if (char === '"' || char === "'") {
                inStr = true;
                strCh = char;
                continue;
            }
            if (char === openChar) {
                depth++;
                continue;
            }
            if (char === closeChar) {
                depth--;
                if (depth === 0) return index;
                if (depth < 0) return -1;
            }
        }
        return -1;
    }

    function hasUnclosedFunctionCallGroup(source, escapeChar = getActiveCtrlChar()) {
        const text = String(source || '');
        let inStr = false;
        let strCh = '';
        for (let index = 0; index < text.length; index++) {
            const char = text[index];
            if (inStr) {
                if (char === strCh && !isEscapedQuote(text, index, escapeChar)) inStr = false;
                continue;
            }
            if (char === '"' || char === "'") {
                inStr = true;
                strCh = char;
                continue;
            }
            if (!isIdentifierStartChar(char)) continue;
            const start = index;
            index++;
            while (index < text.length && isIdentifierContinueChar(text[index])) index++;
            const nextIndex = findFirstNonWhitespaceIndex(text, index);
            if (text[nextIndex] === '(') {
                const closeIndex = findBalancedGroupEnd(text, nextIndex, '(', ')', escapeChar);
                if (closeIndex < 0) return true;
                index = closeIndex;
                continue;
            }
            index = Math.max(start, index - 1);
        }
        return false;
    }

    function skipSizeofTagofOperand(source, index, escapeChar = getActiveCtrlChar()) {
        const text = String(source || '');
        let next = findFirstNonWhitespaceIndex(text, index);
        if (text[next] === '(') {
            const closeIndex = findBalancedGroupEnd(text, next, '(', ')', escapeChar);
            return closeIndex >= 0 ? closeIndex + 1 : next + 1;
        }
        if (!isIdentifierStartChar(text[next] || '')) return next;
        while (next < text.length && isIdentifierContinueChar(text[next])) next++;
        while (true) {
            next = findFirstNonWhitespaceIndex(text, next);
            if (text[next] !== '[') break;
            const closeIndex = findBalancedGroupEnd(text, next, '[', ']', escapeChar);
            if (closeIndex < 0) break;
            next = closeIndex + 1;
        }
        return next;
    }

    function readIndexedAccessEnd(source, index, escapeChar = getActiveCtrlChar()) {
        const text = String(source || '');
        let end = index;
        while (true) {
            const bracketStart = findFirstNonWhitespaceIndex(text, end);
            if (text[bracketStart] !== '[') break;
            const closeIndex = findBalancedGroupEnd(text, bracketStart, '[', ']', escapeChar);
            if (closeIndex < 0) break;
            end = closeIndex + 1;
        }
        return end;
    }

    function mayContainArrayScalarExpressionUse(source, escapeChar = getActiveCtrlChar()) {
        const text = String(source || '');
        if (!/[A-Za-z_@]/.test(text)) return false;
        let inStr = false;
        let strCh = '';
        for (let index = 0; index < text.length; index++) {
            const char = text[index];
            if (inStr) {
                if (char === strCh && !isEscapedQuote(text, index, escapeChar)) inStr = false;
                continue;
            }
            if (char === '"' || char === "'") {
                inStr = true;
                strCh = char;
                continue;
            }
            if ('+-*/%&|^<>?:!~'.includes(char)) return true;
        }
        return false;
    }

    function findArrayMustBeIndexedIssueInScalarExpression(expr, decls = [], analysisCache = null, options = {}) {
        const escapeChar = options?.escapeChar ?? getActiveCtrlChar();
        const text = String(expr || '');
        if (!text || !mayContainArrayScalarExpressionUse(text, escapeChar)) return null;

        let inStr = false;
        let strCh = '';
        for (let index = 0; index < text.length; index++) {
            const char = text[index];
            if (inStr) {
                if (char === strCh && !isEscapedQuote(text, index, escapeChar)) inStr = false;
                continue;
            }
            if (char === '"' || char === "'") {
                inStr = true;
                strCh = char;
                continue;
            }
            if (!isIdentifierStartChar(char)) continue;

            const identStart = index;
            index++;
            while (index < text.length && isIdentifierContinueChar(text[index])) index++;
            const name = text.slice(identStart, index);
            index--;

            if (arrayScalarIgnoredNames.has(name)) {
                if (name === 'tagof' || name === 'sizeof') {
                    index = Math.max(index, skipSizeofTagofOperand(text, index + 1, escapeChar) - 1);
                }
                continue;
            }

            const previousIndex = findPreviousNonWhitespaceIndex(text, identStart - 1);
            const nextIndex = findFirstNonWhitespaceIndex(text, index + 1);
            const previousChar = previousIndex >= 0 ? text[previousIndex] : '';
            const nextChar = nextIndex < text.length ? text[nextIndex] : '';
            if (nextChar === ':') continue;
            if (previousChar === '.') continue;
            if (nextChar === '(') {
                const closeIndex = findBalancedGroupEnd(text, nextIndex, '(', ')', escapeChar);
                if (closeIndex >= 0) index = closeIndex;
                continue;
            }

            const decl = findVariableDeclByNameFromSources(decls, name, analysisCache);
            if (!decl?.dims) continue;

            const accessEnd = readIndexedAccessEnd(text, index + 1, escapeChar);
            const accessSource = text.slice(identStart, accessEnd).trim();
            const accessType = inferArgType(accessSource, decls, analysisCache);
            if (accessType?.dims) return { name };
            index = Math.max(index, accessEnd - 1);
        }

        return null;
    }

    function findArrayMustBeIndexedIssue(expr, decls = [], analysisCache = null, options = {}) {
        const escapeChar = options?.escapeChar ?? getActiveCtrlChar();
        const source = stripTagCastsForValidation(expr, escapeChar);
        if (!source) return null;
        if (hasUnclosedFunctionCallGroup(source, escapeChar)) return null;

        const inferred = inferArgType(source, decls, analysisCache);
        if (inferred?.dims) {
            const bareName = source.match(/^([A-Za-z_@]\w*)$/)?.[1] || '';
            if (bareName && findVariableDeclByNameFromSources(decls, bareName, analysisCache)?.dims) {
                return { name: bareName };
            }

            const indexedExpr = parseIndexedAccessExpression(source, escapeChar);
            if (indexedExpr?.baseName) {
                const baseDecl = findVariableDeclByNameFromSources(decls, indexedExpr.baseName, analysisCache);
                if (baseDecl?.dims) return { name: indexedExpr.baseName };
            }
        }

        return findArrayMustBeIndexedIssueInScalarExpression(source, decls, analysisCache, { escapeChar });
    }

    function inferArrayShapeActualType(expr, decls = [], analysisCache = null) {
        const inferred = inferArgType(expr, decls, analysisCache) || { tag: '', dims: '' };
        if (inferred.dims) {
            return { type: inferred, callReturn: null };
        }
        const callReturn = inferCallReturnType(expr, decls, analysisCache);
        return callReturn?.known
            ? { type: { tag: callReturn.tag || inferred.tag || '', dims: callReturn.dims || '' }, callReturn }
            : { type: inferred, callReturn: null };
    }

    function expandFunctionLikeDefineCall(decl, argsText = '', escapeChar = getActiveCtrlChar()) {
        return macroExpansionCore.expandFunctionLikeDefineCall(decl, argsText, {
            escapeChar,
            expandActualArgs: false
        });
    }

    function getRootTagCastExpressionForValidation(expr, escapeChar = getActiveCtrlChar()) {
        let source = unwrapOuterParens(expr);
        if (!source) return null;
        const namedArg = semanticSyntaxCore.getRootNamedArgumentExpression(source, { escapeChar });
        if (namedArg) source = unwrapOuterParens(namedArg.expression);
        return semanticSyntaxCore.getRootTagCastExpression(source, { escapeChar });
    }

    function expandExpressionMacrosForTypeInference(expr, decls = [], analysisCache = null, disabledNames = new Set()) {
        const source = String(expr || '').trim();
        if (!source || source.length > 512 || !/[A-Za-z_@]/.test(source)) return '';
        const expanded = macroExpansionCore.expandMacros(source, decls, {
            escapeChar: getActiveCtrlChar(),
            disabledNames,
            getDefine: name => findAnyDeclByNameFromSources(
                decls,
                name,
                item => item.type === 'define',
                analysisCache
            ),
            maxInputLength: 512,
            maxOutputLength: 2048
        });
        if (!expanded.complete || !expanded.changed) return '';
        const expandedText = String(expanded.text || '').trim();
        return expandedText && expandedText !== source ? expandedText : '';
    }

    function inferFunctionDeclReturnType(decl, allDecls, analysisCache = null) {
        if (!decl?.filePath || !Number.isInteger(decl.lineNumber) || !fs?.readFileSync) {
            return { tag: '', dims: '' };
        }
        if (functionReturnTypeCache.has(decl)) {
            return functionReturnTypeCache.get(decl);
        }

        const fallback = { tag: '', dims: '', known: false };
        const knownScalar = { tag: '', dims: '', known: true };
        const cacheFunctionReturnTypeResult = result => {
            functionReturnTypeCache.set(decl, result);
            return result;
        };

        try {
            const openDocument = getOpenDocumentForFile(decl.filePath);
            const stat = openDocument ? null : fs.statSync?.(decl.filePath);
            const stableCacheKey = stat
                ? [
                    decl.filePath,
                    decl.lineNumber,
                    decl.name,
                    Number(stat.mtimeMs || 0),
                    Number(stat.size || 0)
                ].join('|')
                : '';
            if (stableCacheKey && functionReturnTypeStableCache.has(stableCacheKey)) {
                return cacheFunctionReturnTypeResult(functionReturnTypeStableCache.get(stableCacheKey));
            }
            const text = openDocument
                ? String(openDocument.getText?.() || '')
                : String(fs.readFileSync(decl.filePath, 'utf8') || '');
            if (!text) return cacheFunctionReturnTypeResult(fallback);
            const lines = text.split(/\r?\n/);
            const startLine = Math.max(0, Math.min(lines.length - 1, decl.lineNumber));
            let headerLine = startLine;
            const headerRe = new RegExp(`\\b${escapeRegExp(decl.name)}\\s*\\(`);
            for (let probe = startLine; probe < Math.min(lines.length, startLine + 6); probe++) {
                if (headerRe.test(String(lines[probe] || ''))) {
                    headerLine = probe;
                    break;
                }
            }

            const headerStartOffset = getTextLineStartOffset(text, headerLine);
            const sourceFromHeader = text.slice(headerStartOffset);
            const bodyOpenRelative = sourceFromHeader.indexOf('{');
            if (bodyOpenRelative < 0) return cacheFunctionReturnTypeResult(fallback);

            let depth = 0;
            let bodyCloseRelative = -1;
            let inStr = false;
            let strCh = '';
            for (let index = bodyOpenRelative; index < sourceFromHeader.length; index++) {
                const char = sourceFromHeader[index];
                if (inStr) {
                    if (char === strCh && !isEscapedQuote(sourceFromHeader, index, getActiveCtrlChar())) inStr = false;
                    continue;
                }
                if (char === '"' || char === "'") {
                    inStr = true;
                    strCh = char;
                    continue;
                }
                if (char === '{') depth++;
                else if (char === '}') {
                    depth--;
                    if (depth === 0) {
                        bodyCloseRelative = index;
                        break;
                    }
                }
            }
            if (bodyCloseRelative < 0) return cacheFunctionReturnTypeResult(fallback);

            const bodyText = sourceFromHeader.slice(bodyOpenRelative + 1, bodyCloseRelative);
            const localArrayDimsByName = new Map();
            for (const paramText of splitTopLevel(decl.args || '')) {
                const paramMeta = parseParamMeta(paramText);
                if (paramMeta.name && paramMeta.expectedDims) {
                    localArrayDimsByName.set(paramMeta.name, paramMeta.expectedDims);
                }
            }
            const localArrayDeclRe = /\b(?:new|static)\s+([A-Za-z_@]\w*)\s*((?:\[[^\]]+\])+)/g;
            let localMatch = null;
            while ((localMatch = localArrayDeclRe.exec(bodyText))) {
                localArrayDimsByName.set(localMatch[1], localMatch[2]);
            }

            const returnTypes = [];
            const returnRe = /^\s*return\b([^\r\n;]*)(?:;)?\s*$/gm;
            let returnMatch = null;
            while ((returnMatch = returnRe.exec(bodyText))) {
                const returnExpr = String(returnMatch[1] || '').trim();
                if (!returnExpr) continue;
                const localDims = localArrayDimsByName.get(returnExpr);
                if (localDims) {
                    returnTypes.push({ tag: '', dims: localDims });
                    continue;
                }
                returnTypes.push(inferArgType(returnExpr, allDecls, analysisCache));
            }

            const resolved = returnTypes.find(item => item?.tag || item?.dims) || knownScalar;
            const consistent = returnTypes.every(item =>
                (item?.tag || '') === (resolved.tag || '') &&
                (item?.dims || '') === (resolved.dims || '')
            );
            const result = consistent ? { ...resolved, known: true } : fallback;
            if (stableCacheKey) {
                functionReturnTypeStableCache.set(stableCacheKey, result);
            }
            return cacheFunctionReturnTypeResult(result);
        } catch {
            return cacheFunctionReturnTypeResult(fallback);
        }
    }

    function inferCallReturnType(expr, decls = [], analysisCache = null, seenExprs = new Set()) {
        const source = String(expr || '').trim();
        if (!source || seenExprs.has(source)) return null;
        if (analysisCache?.callReturnTypeByExpr?.has(source)) {
            return analysisCache.callReturnTypeByExpr.get(source);
        }
        seenExprs.add(source);
        const cacheCallReturnTypeResult = result => {
            if (analysisCache?.callReturnTypeByExpr) {
                analysisCache.callReturnTypeByExpr.set(source, result);
            }
            return result;
        };

        const callExpr = parseWholeCallExpression(source);
        if (!callExpr) return cacheCallReturnTypeResult(null);

        let decl = findAnyDeclByNameFromSources(
            decls,
            callExpr.name,
            item => isFunctionLikeDecl(item),
            analysisCache
        );
        if (!decl) {
            const aliasDefine = findAnyDeclByNameFromSources(
                decls,
                callExpr.name,
                item => item.type === 'define' && !item.args,
                analysisCache
            );
            const aliasTargetName = String(aliasDefine?.value || '').trim().match(/^([A-Za-z_@]\w*)$/)?.[1] || '';
            if (aliasTargetName) {
                decl = findAnyDeclByNameFromSources(
                    decls,
                    aliasTargetName,
                    item => isFunctionLikeDecl(item),
                    analysisCache
                );
            }
        }
        if (!decl) return cacheCallReturnTypeResult(null);

        if (decl.type === 'define' && decl.macroStyle === 'paren') {
            const expandedDefineValue = expandFunctionLikeDefineCall(
                decl,
                callExpr.argsText,
                getActiveCtrlChar()
            );
            if (!expandedDefineValue || expandedDefineValue === source) return cacheCallReturnTypeResult(null);
            return cacheCallReturnTypeResult(inferCallReturnType(expandedDefineValue, decls, analysisCache, seenExprs));
        }

        if (decl.dims) {
            return cacheCallReturnTypeResult({
                known: true,
                tag: decl.typeTag || '',
                dims: decl.dims || '',
                decl
            });
        }

        const hasSourceBody = !!decl.filePath && Number.isInteger(decl.lineNumber);
        const inferredReturnType = hasSourceBody
            ? inferFunctionDeclReturnType(decl, decls, analysisCache)
            : { tag: decl.typeTag || '', dims: '', known: true };
        return cacheCallReturnTypeResult({
            known: inferredReturnType?.known !== false,
            tag: inferredReturnType?.tag || decl.typeTag || '',
            dims: inferredReturnType?.dims || '',
            decl
        });
    }

    function inferArrayLikeCallReturnType(expr, decls = [], analysisCache = null, seenExprs = new Set()) {
        const inferred = inferCallReturnType(expr, decls, analysisCache, seenExprs);
        return inferred?.dims
            ? inferred
            : null;
    }

    function getEnumItemExpressionTag(decl) {
        if (!decl || decl.type !== 'enum-item') return '';
        if (decl.typeTag) return decl.typeTag;
        const enumName = String(decl.enumName || '').trim();
        const taggedEnum = enumName.match(/^([A-Za-z_@]\w*|_)\s*:\s*([A-Za-z_@]\w*)$/);
        if (taggedEnum) {
            return taggedEnum[1] === '_' ? '' : taggedEnum[1];
        }
        return normalizeEnumName(enumName);
    }

    function inferEnumItemType(decl) {
        if (!decl || decl.type !== 'enum-item') return null;
        const enumName = String(decl.enumName || '').trim();
        const carriesFieldType = !!decl.dims || /^_\s*:/.test(enumName);
        return {
            tag: carriesFieldType ? '' : getEnumItemExpressionTag(decl),
            dims: ''
        };
    }

    function splitTopLevelBinaryExpression(source, escapeChar = getActiveCtrlChar()) {
        return semanticSyntaxCore.flattenRootBinaryExpression(source, {
            escapeChar,
            allowAssignment: false
        });
    }

    function inferTopLevelBinaryExprType(source, allDecls, analysisCache) {
        const binaryExpr = splitTopLevelBinaryExpression(source);
        if (!binaryExpr) return null;
        const comparisonOps = new Set(['&&', '||', '<', '<=', '>', '>=', '==', '!=']);
        if (binaryExpr.operators.some(op => comparisonOps.has(op))) {
            return { tag: 'bool', dims: '' };
        }
        const operandTypes = binaryExpr.parts.map(part => inferArgType(part, allDecls, analysisCache));
        if (operandTypes.some(type => type?.dims)) {
            return { tag: '', dims: '' };
        }
        if (operandTypes.some(type => String(type?.tag || '') === 'Float')) {
            return { tag: 'Float', dims: '' };
        }
        const firstTagged = operandTypes.find(type => type?.tag)?.tag || '';
        if (firstTagged && operandTypes.every(type => !type?.tag || type.tag === firstTagged)) {
            return { tag: firstTagged, dims: '' };
        }
        return { tag: '', dims: '' };
    }

    function isPotentialRootUnaryExpression(source) {
        const text = String(source || '').trim();
        if (!text) return false;
        if (text.startsWith('++') || text.startsWith('--')) return true;
        if (text[0] === '+' || text[0] === '-' || text[0] === '!' || text[0] === '~') return true;
        for (const keyword of ['sizeof', 'tagof', 'defined', 'char']) {
            if (
                text.startsWith(keyword) &&
                !isIdentifierContinueChar(text[keyword.length] || '')
            ) {
                return true;
            }
        }
        return false;
    }

    const hoverTypeAnalysisCacheProto = {
        findDeclByName(name, predicate = null) {
            if (this.lookup?.findAnyLocalDeclByName) {
                return this.lookup.findAnyLocalDeclByName(name, predicate);
            }
            const matches = this.declsByName?.get(name);
            if (!matches?.length) return null;
            if (!predicate) return matches[0];
            for (const decl of matches) {
                if (predicate(decl)) return decl;
            }
            return null;
        },
        findAnyDeclByName(name, predicate = null) {
            if (this.lookup?.findAnyDeclByName) {
                return this.lookup.findAnyDeclByName(name, predicate);
            }
            const localDecl = this.findDeclByName(name, predicate);
            if (localDecl) return localDecl;
            return findDeclByNameCached(BUILTIN_DECLS, name, predicate);
        },
        getParamMeta(paramText) {
            const key = String(paramText || '');
            if (!this.paramMetaByText.has(key)) {
                this.paramMetaByText.set(key, parseParamMeta(key));
            }
            return this.paramMetaByText.get(key);
        },
        getDimParts(dimText) {
            const key = String(dimText || '');
            if (!this.dimPartsByText.has(key)) {
                this.dimPartsByText.set(key, parseDimsParts(key));
            }
            return this.dimPartsByText.get(key);
        },
        getDimSpec(dimText) {
            const key = String(dimText || '');
            if (!this.dimSpecByText.has(key)) {
                this.dimSpecByText.set(key, parseDimSpec(key, this.sourceDecls, new Set(), this));
            }
            return this.dimSpecByText.get(key);
        }
    };

    function createHoverTypeAnalysisCache(allDecls = [], lookup = null) {
        const sourceDecls = Array.isArray(allDecls) ? allDecls : [];
        const cache = Object.create(hoverTypeAnalysisCacheProto);
        cache.sourceDecls = sourceDecls;
        cache.lookup = lookup || null;
        cache.declsByName = lookup?.findAnyLocalDeclByName ? null : (() => {
            const buckets = new Map();
            for (const decl of sourceDecls) {
                if (!decl?.name) continue;
                if (!buckets.has(decl.name)) buckets.set(decl.name, []);
                buckets.get(decl.name).push(decl);
            }
            return buckets;
        })();
        cache.argTypeByExpr = new Map();
        cache.inferInProgressByExpr = new Set();
        cache.unresolvedRefsByExpr = new Map();
        cache.paramMetaByText = new Map();
        cache.dimPartsByText = new Map();
        cache.dimSpecByText = new Map();
        cache.callReturnTypeByExpr = new Map();
        cache.numericExprByText = new Map();
        cache.indexedDimCompatByKey = new Map();
        cache.typeCompatByKey = new Map();
        return cache;
    }

    function inferArgType(expr, allDecls, analysisCache = null) {
        const cacheKey = String(expr || '').trim();
        if (analysisCache?.argTypeByExpr.has(cacheKey)) {
            return analysisCache.argTypeByExpr.get(cacheKey);
        }
        if (analysisCache?.inferInProgressByExpr.has(cacheKey)) {
            return { tag: '', dims: '' };
        }

        const cacheArgTypeResult = result => {
            if (analysisCache) analysisCache.argTypeByExpr.set(cacheKey, result);
            return result;
        };
        analysisCache?.inferInProgressByExpr.add(cacheKey);
        const finish = result => {
            analysisCache?.inferInProgressByExpr.delete(cacheKey);
            return cacheArgTypeResult(result);
        };
        let s = unwrapOuterParens(expr);
        if (!s) return finish({ tag: '', dims: '' });
        const namedArg = semanticSyntaxCore.getRootNamedArgumentExpression(s, { escapeChar: getActiveCtrlChar() });
        if (namedArg) s = unwrapOuterParens(namedArg.expression);
        if (s === '_') return finish({ tag: '', dims: '', isDefaultPlaceholder: true });
        const rootTagCast = semanticSyntaxCore.getRootTagCastExpression(s, { escapeChar: getActiveCtrlChar() });
        if (rootTagCast?.tag === '_') {
            const underlying = inferArgType(rootTagCast.expression, allDecls, analysisCache);
            return finish({
                ...underlying,
                tag: ''
            });
        }
        if (isPotentialRootUnaryExpression(s)) {
            const semanticExpr = semanticSyntaxCore.parsePawnExpression(s, {
                escapeChar: getActiveCtrlChar(),
                buildAst: true,
                allowAssignment: false
            });
            if (semanticExpr.ok && semanticExpr.ast?.kind === 'unary') {
                const operand = semanticSyntaxCore.getNodeSource(s, semanticExpr.ast.expr);
                const underlying = inferArgType(operand, allDecls, analysisCache);
                if (semanticExpr.ast.operator === '!') return finish({ tag: 'bool', dims: '' });
                if (
                    semanticExpr.ast.operator === '~' ||
                    semanticExpr.ast.operator === 'sizeof' ||
                    semanticExpr.ast.operator === 'tagof' ||
                    semanticExpr.ast.operator === 'defined' ||
                    semanticExpr.ast.operator === 'char'
                ) {
                    return finish({ tag: '', dims: '' });
                }
                return finish(underlying);
            }
        }
        const ternaryExpr = semanticSyntaxCore.parseTopLevelTernaryExpression(s, {
            escapeChar: getActiveCtrlChar()
        });
        if (ternaryExpr) {
            const whenTrue = inferArgType(ternaryExpr.whenTrue, allDecls, analysisCache);
            const whenFalse = inferArgType(ternaryExpr.whenFalse, allDecls, analysisCache);
            if (whenTrue.tag === whenFalse.tag && whenTrue.dims === whenFalse.dims) {
                return finish(whenTrue);
            }
            if (whenTrue.dims && whenTrue.dims === whenFalse.dims) {
                return finish({
                    tag: whenTrue.tag === whenFalse.tag ? whenTrue.tag : '',
                    dims: whenTrue.dims
                });
            }
            return finish({ tag: '', dims: '' });
        }
        if (s.includes('=')) {
            const assignmentExpr = semanticSyntaxCore.parsePawnExpression(s, {
                escapeChar: getActiveCtrlChar(),
                buildAst: true,
                allowAssignment: true
            });
            if (assignmentExpr.ok && assignmentExpr.ast?.kind === 'assignment') {
                const lhs = semanticSyntaxCore.getNodeSource(s, assignmentExpr.ast.left);
                const rhs = semanticSyntaxCore.getNodeSource(s, assignmentExpr.ast.right);
                const lhsType = inferArgType(lhs, allDecls, analysisCache);
                if (lhsType?.tag || lhsType?.dims) return finish(lhsType);
                return finish(inferArgType(rhs, allDecls, analysisCache));
            }
        }
        const taggedBraceArray = s.match(/^([A-Za-z_@]\w*)\s*:\s*(\{[\s\S]*\})$/);
        if (taggedBraceArray && !FORBIDDEN.has(taggedBraceArray[1])) {
            const braceArray = parseBraceArrayLiteralExpression(taggedBraceArray[2]);
            if (braceArray) {
                const elementTypes = braceArray.map(part => inferArgType(part, allDecls, analysisCache));
                const firstResolved = elementTypes.find(item => item.tag || item.dims) || { tag: '', dims: '' };
                const sameDims = elementTypes.every(item => item.dims === firstResolved.dims);
                const firstElementTag = taggedBraceArray[1] || '';
                return finish({
                    tag: taggedBraceArray[1],
                    dims: `[${braceArray.length}]${sameDims ? firstResolved.dims : ''}`,
                    elementTag: firstElementTag
                });
            }
        }
        const braceArray = parseBraceArrayLiteralExpression(s);
        if (braceArray) {
            const elementTypes = braceArray.map(part => inferArgType(part, allDecls, analysisCache));
            const firstResolved = elementTypes.find(item => item.tag || item.dims) || { tag: '', dims: '' };
            const sameDims = elementTypes.every(item => item.dims === firstResolved.dims);
            const firstTaggedElement = elementTypes.find(item => item.elementTag || item.tag) || null;
            const firstElementTag = firstTaggedElement?.elementTag || firstTaggedElement?.tag || '';
            const sameElementTag = firstElementTag
                ? elementTypes.every(item =>
                    normalizeTagName(item.elementTag || item.tag || '') === normalizeTagName(firstElementTag)
                )
                : false;
            return finish({
                tag: '',
                dims: `[${braceArray.length}]${sameDims ? firstResolved.dims : ''}`,
                elementTag: sameElementTag ? firstElementTag : ''
            });
        }
        if (s.startsWith('"')) return finish({ tag: '_', dims: '[]' });
        if (s.startsWith("'")) return finish({ tag: '', dims: '' });
        if (/^-?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return finish({ tag: 'Float', dims: '' });
        if (s === 'true' || s === 'false') return finish({ tag: 'bool', dims: '' });
        if (
            s === 'cellmin' ||
            s === 'cellmax' ||
            (!/^[A-Za-z_@]\w*$/.test(s) && evaluatePawnNumericExpr(s, allDecls, new Set(), analysisCache) != null)
        ) {
            return finish({ tag: '', dims: '' });
        }

        const tagCastExpr = rootTagCast || semanticSyntaxCore.getRootTagCastExpression(s, { escapeChar: getActiveCtrlChar() });
        if (tagCastExpr && !FORBIDDEN.has(tagCastExpr.tag)) {
            const underlying = inferArgType(tagCastExpr.expression, allDecls, analysisCache);
            return finish({
                ...underlying,
                tag: tagCastExpr.tag
            });
        }

        const callExpr = parseWholeCallExpression(s);
        if (callExpr) {
            let decl = findAnyDeclByNameFromSources(
                allDecls,
                callExpr.name,
                item => isFunctionLikeDecl(item),
                analysisCache
            );
            if (!decl) {
                const aliasDefine = findAnyDeclByNameFromSources(
                    allDecls,
                    callExpr.name,
                    item => item.type === 'define' && !item.args,
                    analysisCache
                );
                const aliasTargetName = String(aliasDefine?.value || '').trim().match(/^([A-Za-z_@]\w*)$/)?.[1] || '';
                if (aliasTargetName) {
                    decl = findAnyDeclByNameFromSources(
                        allDecls,
                        aliasTargetName,
                        item => isFunctionLikeDecl(item),
                        analysisCache
                    );
                }
            }
            if (decl) {
                if (decl.type === 'define' && decl.macroStyle === 'paren') {
                    const expandedDefineValue = expandFunctionLikeDefineCall(
                        decl,
                        callExpr.argsText,
                        getActiveCtrlChar()
                    );
                    if (expandedDefineValue) {
                        return finish(inferArgType(expandedDefineValue, allDecls, analysisCache));
                    }
                }
                return finish({ tag: decl.typeTag || '', dims: decl.dims || '' });
            }
        }

        const indexedBase = parseIndexedAccessExpression(s);
        if (indexedBase) {
            const decl = findLocalDeclByNameFromSources(
                allDecls,
                indexedBase.baseName,
                item => item.type === 'variable',
                analysisCache
            );
            if (decl) {
                const accessChain = resolveIndexedAccessValidationChain(
                    decl,
                    indexedBase.accesses.map(access => access.slice(1, -1).trim()),
                    allDecls,
                    analysisCache
                );
                const lastStep = accessChain[accessChain.length - 1] || null;
                const remainingDimParts = lastStep?.nextDimParts || [];
                const resultTag = lastStep?.nextTag || decl.typeTag || '';
                const remainingDims = remainingDimParts.map(part => `[${part}]`).join('');
                return finish({ tag: resultTag, dims: remainingDims });
            }
        }

        if (/^[A-Za-z_@]\w*$/.test(s)) {
            const decl = findLocalDeclByNameFromSources(
                allDecls,
                s,
                item => item.type === 'variable',
                analysisCache
            );
            if (decl) {
                const dims = getEffectiveDeclDimParts(decl).map(part => `[${part}]`).join('');
                return finish({ tag: decl.typeTag || '', dims });
            }

            const enumItemDecl = findAnyDeclByNameFromSources(
                allDecls,
                s,
                item => item.type === 'enum-item',
                analysisCache
            );
            const enumItemType = inferEnumItemType(enumItemDecl);
            if (enumItemType) {
                return finish(enumItemType);
            }

            const defineDecl = findAnyDeclByNameFromSources(
                allDecls,
                s,
                item => item.type === 'define' && !item.args,
                analysisCache
            );
            if (defineDecl) {
                const defineValue = String(defineDecl.value || '').trim();
                const aliasTargetName = defineValue.match(/^([A-Za-z_@]\w*)$/)?.[1] || '';
                if (aliasTargetName && aliasTargetName !== s) {
                    return finish(inferArgType(aliasTargetName, allDecls, analysisCache));
                }
                if (defineValue) {
                    return finish(inferArgType(defineValue, allDecls, analysisCache));
                }
            }
        }
        const binaryType = inferTopLevelBinaryExprType(s, allDecls, analysisCache);
        if (binaryType) return finish(binaryType);
        if (evaluatePawnNumericExpr(s, allDecls, new Set(), analysisCache) != null) {
            return finish({ tag: '', dims: '' });
        }
        const expandedTypeSource = expandExpressionMacrosForTypeInference(s, allDecls, analysisCache);
        if (expandedTypeSource) {
            return finish(inferArgType(expandedTypeSource, allDecls, analysisCache));
        }
        return finish({ tag: '', dims: '' });
    }

    function inferEffectiveDimPartsFromValue(baseDimParts, value, escapeChar = getActiveCtrlChar()) {
        return arrayShapeCore.inferEffectiveDimPartsFromValue(baseDimParts, value, { escapeChar });
    }

    function getEffectiveDeclDimParts(decl) {
        if (!decl?.dims) return [];
        if (effectiveDeclDimPartsCache.has(decl)) {
            return effectiveDeclDimPartsCache.get(decl);
        }

        const baseDimParts = parseDimsParts(decl.dims || '');
        const resolvedDimParts = decl.type === 'variable' && decl.value
            ? inferEffectiveDimPartsFromValue(baseDimParts, decl.value)
            : baseDimParts;
        effectiveDeclDimPartsCache.set(decl, resolvedDimParts);
        return resolvedDimParts;
    }

    function getEnumItemCellSpan(memberDecl, allDecls = [], analysisCache = null) {
        if (!memberDecl || memberDecl.type !== 'enum-item') return 1;
        const memberDimParts = getEffectiveDeclDimParts(memberDecl);
        if (!memberDimParts.length) return 1;

        let span = 1;
        for (const part of memberDimParts) {
            const spec = analysisCache?.getDimSpec(part) ||
                parseDimSpec(part, allDecls, new Set(), analysisCache);
            if (spec?.capacity == null) return null;
            span *= spec.capacity;
        }
        return span;
    }

    function getEnumDeclResolvedCapacity(enumDecl, decls = [], seen = new Set(), analysisCache = null) {
        if (!enumDecl || enumDecl.type !== 'enum') return null;
        const enumKey = `enum:${normalizeEnumName(enumDecl.name || enumDecl.enumName || '')}`;
        if (seen.has(enumKey)) return null;
        seen.add(enumKey);

        let maxEnd = null;
        for (const memberDecl of enumDecl.enumMembers || []) {
            const start = evaluatePawnNumericExpr(
                String(memberDecl?.value ?? '').trim(),
                decls,
                seen,
                analysisCache
            );
            if (start == null || start < 0) continue;

            let span = 1;
            for (const part of getEffectiveDeclDimParts(memberDecl)) {
                const spec = parseDimSpec(part, decls, seen, analysisCache);
                if (spec?.capacity == null) {
                    span = null;
                    break;
                }
                span *= Math.max(1, spec.capacity);
            }
            if (span == null) continue;
            maxEnd = Math.max(maxEnd ?? 0, start + Math.max(1, span));
        }

        seen.delete(enumKey);
        return maxEnd;
    }

    function resolveIndexedAccessValidationChain(baseDecl, accesses = [], allDecls = [], analysisCache = null) {
        if (!baseDecl) return [];

        let currentTag = baseDecl.typeTag || '';
        let currentDimParts = getEffectiveDeclDimParts(baseDecl);
        const steps = [];
        const sameDimParts = (left = [], right = []) =>
            left.length === right.length && left.every((part, index) => part === right[index]);
        const canTreatEnumSizedAccessAsScalarIndex = (expr, expectedEnumName = '') => {
            const source = String(expr || '').trim();
            if (!source) return false;

            if (evaluatePawnNumericExpr(source, allDecls, new Set(), analysisCache) != null) {
                return true;
            }

            const bareName = source.match(/^([A-Za-z_@]\w*)$/)?.[1] || '';
            if (bareName) {
                const bareDecl = findAnyDeclByNameFromSources(allDecls, bareName, null, analysisCache);
                if (bareDecl?.type === 'enum-item') {
                    return !!expectedEnumName && normalizeEnumName(bareDecl.enumName) === normalizeEnumName(expectedEnumName);
                }
                if (bareDecl && bareDecl.type === 'variable' && !bareDecl.dims) {
                    const bareTag = String(bareDecl.typeTag || '').toLowerCase();
                    return bareTag !== 'float';
                }
            }

            const actualType = inferArgType(source, allDecls, analysisCache);
            if (actualType?.dims) return false;
            const actualTag = String(actualType?.tag || '').toLowerCase();
            return actualTag !== 'float';
        };
        const resolveEnumMemberBranch = (expr, enumName) => {
            const source = String(expr || '').trim();
            const ternaryExpr = semanticSyntaxCore.parseTopLevelTernaryExpression(source, {
                escapeChar: getActiveCtrlChar()
            });
            if (ternaryExpr) {
                const whenTrue = resolveEnumMemberBranch(ternaryExpr.whenTrue, enumName);
                const whenFalse = resolveEnumMemberBranch(ternaryExpr.whenFalse, enumName);
                if (!whenTrue || !whenFalse) return null;
                return {
                    nextTag: whenTrue.nextTag === whenFalse.nextTag ? whenTrue.nextTag : '',
                    nextDimParts: sameDimParts(whenTrue.nextDimParts, whenFalse.nextDimParts)
                        ? whenTrue.nextDimParts
                        : []
                };
            }

            const memberName = source.match(/^([A-Za-z_@]\w*)$/)?.[1] || '';
            if (!memberName) return null;

            const enumDecl = findLocalDeclByNameFromSources(
                allDecls,
                enumName,
                item => item.type === 'enum',
                analysisCache
            );
            const memberDecl = enumDecl?.enumMembers?.find(item => item.name === memberName) ||
                findLocalDeclByNameFromSources(
                    allDecls,
                    memberName,
                    item => item.type === 'enum-item' && normalizeEnumName(item.enumName) === normalizeEnumName(enumName),
                    analysisCache
                );
            if (!memberDecl) return null;

            return {
                nextTag: memberDecl.typeTag || '',
                nextDimParts: getEffectiveDeclDimParts(memberDecl)
            };
        };
        const getExplicitEnumItemCellTag = expr => {
            const memberName = String(expr || '').trim().match(/^([A-Za-z_@]\w*)$/)?.[1] || '';
            if (!memberName) return '';
            const memberDecl = findAnyDeclByNameFromSources(
                allDecls,
                memberName,
                item => item.type === 'enum-item',
                analysisCache
            );
            return memberDecl?.typeTag || '';
        };
        const resolveNumericDimensionEnumField = (expr, dimSpec) => {
            if (dimSpec?.capacity == null) return null;
            const memberName = String(expr || '').trim().match(/^([A-Za-z_@]\w*)$/)?.[1] || '';
            if (!memberName) return null;

            const memberDecl = findAnyDeclByNameFromSources(
                allDecls,
                memberName,
                item => item.type === 'enum-item',
                analysisCache
            );
            if (!memberDecl?.dims) return null;

            const offset = evaluatePawnNumericExpr(memberName, allDecls, new Set(), analysisCache);
            const span = getEnumItemCellSpan(memberDecl, allDecls, analysisCache);
            if (offset == null || span == null || offset < 0) return null;
            if (offset + span > dimSpec.capacity) return null;

            return memberDecl;
        };

        for (const accessText of accesses) {
            const actualExpr = String(accessText || '').trim();
            const expectedDimPart = currentDimParts.length ? currentDimParts[0] : null;
            const dimSpec = expectedDimPart != null
                ? (analysisCache?.getDimSpec(expectedDimPart) || parseDimSpec(expectedDimPart, allDecls, new Set(), analysisCache))
                : null;
            const enumName = dimSpec?.enumName || '';
            const selectedSourceDimParts = [...currentDimParts];

            const step = {
                tag: currentTag,
                expectedDimPart,
                dimSpec,
                remainingDimParts: [...currentDimParts],
                selectedSourceDimParts
            };

            if (expectedDimPart == null) {
                currentDimParts = [];
                step.nextTag = currentTag;
                step.nextDimParts = [];
                steps.push(step);
                continue;
            }

            if (enumName) {
                const ternaryExpr = semanticSyntaxCore.parseTopLevelTernaryExpression(actualExpr, {
                    escapeChar: getActiveCtrlChar()
                });
                if (ternaryExpr) {
                    const ternaryResolvedBranch = resolveEnumMemberBranch(actualExpr, enumName);
                    if (ternaryResolvedBranch) {
                        currentTag = ternaryResolvedBranch.nextTag || '';
                        currentDimParts = [...(ternaryResolvedBranch.nextDimParts || [])];
                        step.nextTag = currentTag;
                        step.nextDimParts = [...currentDimParts];
                        steps.push(step);
                        continue;
                    }
                }

                const enumDecl = findLocalDeclByNameFromSources(
                    allDecls,
                    enumName,
                    item => item.type === 'enum',
                    analysisCache
                );
                const memberName = actualExpr.match(/^([A-Za-z_@]\w*)$/)?.[1] || '';
                const memberDecl = enumDecl?.enumMembers?.find(item => item.name === memberName) ||
                    findLocalDeclByNameFromSources(
                        allDecls,
                        memberName,
                        item => item.type === 'enum-item' && normalizeEnumName(item.enumName) === normalizeEnumName(enumName),
                        analysisCache
                    );
                if (!memberDecl) {
                    currentDimParts = currentDimParts.slice(1);
                    step.nextTag = currentTag;
                    step.nextDimParts = [...currentDimParts];
                    if (!canTreatEnumSizedAccessAsScalarIndex(actualExpr, enumName)) {
                        currentDimParts = [];
                        step.nextTag = '';
                        step.nextDimParts = [];
                    }
                    steps.push(step);
                    continue;
                }

                const remainingArrayDims = currentDimParts.slice(1);
                if (remainingArrayDims.length) {
                    currentDimParts = remainingArrayDims;
                } else {
                    currentTag = memberDecl.typeTag || currentTag || '';
                    currentDimParts = getEffectiveDeclDimParts(memberDecl);
                }
                step.nextTag = currentTag;
                step.nextDimParts = [...currentDimParts];
                steps.push(step);
                continue;
            }

            const numericDimensionMemberDecl = !enumName
                ? resolveNumericDimensionEnumField(actualExpr, dimSpec)
                : null;
            if (numericDimensionMemberDecl) {
                const remainingArrayDims = currentDimParts.slice(1);
                if (remainingArrayDims.length) {
                    currentDimParts = remainingArrayDims;
                } else {
                    currentTag = numericDimensionMemberDecl.typeTag || currentTag || '';
                    currentDimParts = getEffectiveDeclDimParts(numericDimensionMemberDecl);
                }
                step.nextTag = currentTag;
                step.nextDimParts = [...currentDimParts];
                steps.push(step);
                continue;
            }

            currentDimParts = currentDimParts.slice(1);
            if (!currentDimParts.length) {
                currentTag = currentTag || getExplicitEnumItemCellTag(actualExpr);
            }
            step.nextTag = currentTag;
            step.nextDimParts = [...currentDimParts];
            steps.push(step);
        }

        return steps;
    }

    function findTopLevelDefaultAssignmentIndex(source) {
        let parenDepth = 0;
        let braceDepth = 0;
        let bracketDepth = 0;
        let inString = false;
        let stringChar = '';

        for (let index = 0; index < source.length; index++) {
            const char = source[index];
            const prev = source[index - 1] || '';
            const next = source[index + 1] || '';

            if (inString) {
                if (char === stringChar && !isEscapedQuote?.(source, index)) {
                    inString = false;
                }
                continue;
            }
            if (char === '"' || char === "'") {
                inString = true;
                stringChar = char;
                continue;
            }
            if (char === '(') {
                parenDepth++;
                continue;
            }
            if (char === ')') {
                parenDepth = Math.max(0, parenDepth - 1);
                continue;
            }
            if (char === '[') {
                bracketDepth++;
                continue;
            }
            if (char === ']') {
                bracketDepth = Math.max(0, bracketDepth - 1);
                continue;
            }
            if (char === '{') {
                braceDepth++;
                continue;
            }
            if (char === '}') {
                braceDepth = Math.max(0, braceDepth - 1);
                continue;
            }
            if (parenDepth || braceDepth || bracketDepth) continue;
            if (char === '=' && prev !== '=' && prev !== '!' && next !== '=') {
                return index;
            }
        }

        return -1;
    }

    function parseParamMeta(paramStr) {
        const raw = String(paramStr || '').trim();
        const defaultIndex = findTopLevelDefaultAssignmentIndex(raw);
        const hasDefault = defaultIndex >= 0;
        const p = hasDefault ? raw.slice(0, defaultIndex).trim() : raw;
        let expectedTag = '';
        const dimMatches = p.match(/\[[^\]]*\]/g) || [];
        const expectedDims = dimMatches.join('');
        const expectedDimParts = dimMatches.map(dim => dim.slice(1, -1).trim());
        let name = '';
        let source = p;
        const isConst = /^const\b/.test(source);
        if (isConst) source = source.replace(/^const\b\s*/, '');
        const isByRef = /^&\s*/.test(source);
        if (isByRef) source = source.replace(/^&\s*/, '');
        source = source.trim();
        const tagM = source.match(TAG_RE);
        if (tagM) {
            expectedTag = tagM[1];
            source = source.slice(tagM[0].length);
        }
        const nameMatch = source.match(/^([A-Za-z_@]\w*)/);
        if (nameMatch) name = nameMatch[1];
        return {
            raw,
            name,
            expectedTag,
            expectedDims,
            expectedDimParts,
            hasDefault,
            isConst,
            isByRef
        };
    }

    function parseUnionTagOptions(tagSpec) {
        const raw = String(tagSpec || '').trim();
        if (!raw.startsWith('{') || !raw.endsWith('}')) return [];
        return raw.slice(1, -1)
            .split(',')
            .map(part => part.trim())
            .filter(Boolean);
    }

    const OPERATOR_OVERLOAD_TOKENS = new Set([
        '+', '-', '*', '/', '%', '>', '<', '!', '~', '=',
        '++', '--', '==', '!=', '<=', '>='
    ]);
    const BOOL_RESULT_OPERATOR_TOKENS = new Set(['!', '<', '>', '==', '!=', '<=', '>=']);

    function parseOperatorOverloadToken(name = '') {
        const raw = String(name || '').trim();
        if (!raw.startsWith('operator')) return null;
        const token = raw.slice('operator'.length);
        return token ? token : '';
    }

    function collectOperatorOverloadPolicyIssues(functionDecl, paramTexts = [], analysisCache = null) {
        const token = parseOperatorOverloadToken(functionDecl?.name || '');
        if (token == null) return [];
        const issues = [];

        if (!OPERATOR_OVERLOAD_TOKENS.has(token)) {
            return [{ kind: 'operatorCannotBeRedefined', paramIndex: -1, token }];
        }

        const params = Array.isArray(paramTexts) ? paramTexts : [];
        const metas = params.map(param => analysisCache?.getParamMeta?.(param) || parseParamMeta(param));
        for (let index = 0; index < metas.length; index++) {
            const meta = metas[index] || {};
            const name = meta.name || '';
            if (index < 2 && parseUnionTagOptions(meta.expectedTag || '').length > 1) {
                issues.push({ kind: 'operatorArgumentMayOnlyHaveSingleTag', paramIndex: index, argumentIndex: index + 1 });
            }
            if (token === '~' && index === 0) {
                if (!meta.expectedDims) {
                    issues.push({ kind: 'operatorArgumentMustBeArray', paramIndex: index, name });
                }
            } else if (meta.expectedDims || meta.isByRef) {
                issues.push({ kind: 'operatorArgumentMayNotBeReferenceOrArray', paramIndex: index, name });
            }
        }

        const count = metas.length;
        const expectedCountOk = (() => {
            if (token === '!' || token === '=' || token === '++' || token === '--') return count === 1;
            if (token === '-') return count === 1 || count === 2;
            return count === 2;
        })();
        if (!expectedCountOk) {
            issues.push({ kind: 'operatorOperandCountMismatch', paramIndex: -1, token });
        }

        const tagAt = index => normalizeTagName(metas[index]?.expectedTag || '');
        const firstTag = tagAt(0);
        const secondTag = tagAt(1);
        const resultTag = normalizeTagName(functionDecl?.typeTag || '');
        if (
            !firstTag &&
            (
                (token !== '=' && !secondTag) ||
                (token === '=' && !resultTag)
            )
        ) {
            issues.push({ kind: 'cannotChangePredefinedOperators', paramIndex: -1, token });
        }

        if (BOOL_RESULT_OPERATOR_TOKENS.has(token) && resultTag !== 'bool') {
            issues.push({ kind: 'operatorResultTagMismatch', paramIndex: -1, token, expectedTag: 'bool:' });
        } else if (token === '~' && resultTag && resultTag !== '_') {
            issues.push({ kind: 'operatorResultTagMismatch', paramIndex: -1, token, expectedTag: '_:' });
        }

        return issues;
    }

    function matchPawnTag(expectedTag, actualTag, allowCoerce = true) {
        const expected = normalizeTagName(expectedTag);
        const actual = normalizeTagName(actualTag);
        if (!expected || expected === '_') {
            if (!actual || actual === '_' || isAnyTagName(actual)) return true;
            return !!allowCoerce && !isFixedPawnTagName(actual);
        }
        if (isAnyTagName(expected) || isAnyTagName(actual)) return true;
        return expected === actual;
    }

    function resolveTagSpecAlias(tagSpec, decls = [], analysisCache = null, seen = new Set()) {
        const raw = normalizeTagName(tagSpec);
        if (!raw || raw === '_' || raw.startsWith('{') || seen.has(raw)) return raw;
        const defineDecl = findAnyDeclByNameFromSources(
            decls,
            raw,
            item => item.type === 'define' && !item.args,
            analysisCache
        );
        const value = String(defineDecl?.value || '').trim();
        if (!value) return raw;
        if (value.startsWith('{') && value.endsWith('}')) return value;
        const aliasName = value.match(/^([A-Za-z_@]\w*)$/)?.[1] || '';
        if (!aliasName) return raw;
        seen.add(raw);
        const resolved = resolveTagSpecAlias(aliasName, decls, analysisCache, seen);
        seen.delete(raw);
        return resolved || raw;
    }

    function explainPawnTagCompat(expectedTag, actualTag, decls = [], analysisCache = null) {
        const expected = normalizeTagName(resolveTagSpecAlias(expectedTag, decls, analysisCache));
        const actual = normalizeTagName(actualTag);
        const expectedUnionTags = parseUnionTagOptions(expected);
        if (expectedUnionTags.length) {
            if (expectedUnionTags.some(tag => matchPawnTag(tag, actual, true))) {
                return { status: 'ok', reason: '' };
            }
            if (!actual || actual === '_') {
                return { status: 'warn', reason: t('validation.expectedTag', { tag: expected }) };
            }
            return { status: 'warn', reason: t('validation.tagMismatch', { expected, actual }) };
        }

        if (matchPawnTag(expected, actual, true)) {
            return { status: 'ok', reason: '' };
        }
        if (!expected || expected === '_') {
            return { status: 'warn', reason: t('validation.unexpectedTag', { tag: actual }) };
        }
        if (!actual || actual === '_') {
            return { status: 'warn', reason: t('validation.expectedTag', { tag: expected }) };
        }
        return { status: 'warn', reason: t('validation.tagMismatch', { expected, actual }) };
    }

    function getScalarAssignmentTagIssue(lhsExpr, rhsExpr, decls = [], analysisCache = null, options = {}) {
        const escapeChar = options?.escapeChar ?? getActiveCtrlChar();
        const lhs = String(lhsExpr || '').trim();
        const rhs = String(rhsExpr || '').trim();
        if (!lhs || !rhs || rhs === '_') return null;

        const assignable = options.assignable ||
            getExpressionAssignableInfo(lhs, decls, analysisCache, { escapeChar });
        if (!assignable?.isLValue) return null;

        const rootTagCast = semanticSyntaxCore.getRootTagCastExpression(lhs, { escapeChar });
        const lhsTargetExpr = rootTagCast?.expression || lhs;
        const lhsTargetType = inferArgType(lhsTargetExpr, decls, analysisCache);
        const expectedTargetTag = lhsTargetType?.tag || assignable.baseDecl?.typeTag || '';
        if (rootTagCast && !FORBIDDEN.has(rootTagCast.tag)) {
            const lhsTagResult = explainPawnTagCompat(expectedTargetTag, rootTagCast.tag, decls, analysisCache);
            if (lhsTagResult.status === 'warn' && lhsTagResult.reason) {
                return {
                    status: 'warn',
                    reason: lhsTagResult.reason,
                    expectedTag: expectedTargetTag,
                    actualTag: rootTagCast.tag,
                    rangeTarget: 'lhsTag'
                };
            }
        }

        if (assignable.dims) return null;

        const unresolvedRefs = findUnresolvedReferenceNames(rhs, decls, analysisCache, escapeChar);
        if (unresolvedRefs.length) return null;

        const rhsRootTagCast = getRootTagCastExpressionForValidation(rhs, escapeChar);
        if (rhsRootTagCast?.tag === '_') return null;

        const rhsType = inferArgType(rhs, decls, analysisCache);
        if (rhsType?.dims) return null;

        const expectedTag = expectedTargetTag;
        const actualTag = rhsType?.tag || '';
        const result = explainPawnTagCompat(expectedTag, actualTag, decls, analysisCache);
        if (result.status !== 'warn' || !result.reason) return null;

        return {
            status: 'warn',
            reason: result.reason,
            expectedTag,
            actualTag,
            rangeTarget: 'rhs'
        };
    }

    function parseDimsParts(dimsStr) {
        return String(dimsStr || '')
            .match(/\[[^\]]*\]/g)?.map(dim => dim.slice(1, -1).trim()) || [];
    }

    function findMatchingParenIndex(str, openIndex, escapeChar = getActiveCtrlChar()) {
        if (str[openIndex] !== '(') return -1;
        let depth = 0;
        let inStr = false;
        let strCh = '';
        for (let i = openIndex; i < str.length; i++) {
            const c = str[i];
            if (inStr) {
                if (c === strCh && !isEscapedQuote(str, i, escapeChar)) inStr = false;
                continue;
            }
            if (c === '"' || c === "'") {
                inStr = true;
                strCh = c;
                continue;
            }
            if (c === '(') depth++;
            else if (c === ')') {
                depth--;
                if (depth === 0) return i;
            }
        }
        return -1;
    }

    function parseWholeCallExpression(expr, escapeChar = getActiveCtrlChar()) {
        return semanticSyntaxCore.parseWholeCallExpression(expr, { escapeChar });
    }

    function evaluateParsedPawnNumericExpr(source) {
        const input = String(source || '');
        if (input.length <= PARSED_NUMERIC_EXPR_CACHE_MAX_CHARS && parsedNumericExprCache.has(input)) {
            const cached = parsedNumericExprCache.get(input);
            parsedNumericExprCache.delete(input);
            parsedNumericExprCache.set(input, cached);
            return cached;
        }
        const cacheParsedNumericExprResult = result => {
            if (input.length <= PARSED_NUMERIC_EXPR_CACHE_MAX_CHARS) {
                parsedNumericExprCache.set(input, result);
                while (parsedNumericExprCache.size > PARSED_NUMERIC_EXPR_CACHE_LIMIT) {
                    parsedNumericExprCache.delete(parsedNumericExprCache.keys().next().value);
                }
            }
            return result;
        };
        const parsed = semanticSyntaxCore.parsePawnExpression(input, {
            escapeChar: getActiveCtrlChar(),
            buildAst: true,
            allowAssignment: false
        });
        if (!parsed.ok) return cacheParsedNumericExprResult(null);

        const evaluateAst = ast => {
            if (!ast) return null;
            if (ast.kind === 'group' || ast.kind === 'tag-cast') return evaluateAst(ast.expr);
            if (ast.kind === 'number') {
                const raw = String(ast.value || '');
                const value = /^0[xX]/.test(raw)
                    ? Number.parseInt(raw, 16)
                    : Number(raw);
                return Number.isFinite(value) ? value : null;
            }
            if (ast.kind === 'char') {
                return evaluatePawnCharacterLiteralValue(ast.value, getActiveCtrlChar());
            }
            if (ast.kind === 'identifier') {
                if (ast.name === 'true') return 1;
                if (ast.name === 'false') return 0;
                if (ast.name === 'cellmin') return -2147483648;
                if (ast.name === 'cellmax') return 2147483647;
                return null;
            }
            if (ast.kind === 'unary') {
                const value = evaluateAst(ast.expr);
                if (value == null) return null;
                if (ast.operator === '+') return +value;
                if (ast.operator === '-') return -value;
                if (ast.operator === '~') return ~value;
                if (ast.operator === '!') return value ? 0 : 1;
                if (ast.operator === 'char') return Math.max(0, Math.ceil(value / PAWN_CHARS_PER_CELL));
                return null;
            }
            if (ast.kind === 'postfix') {
                const value = evaluateAst(ast.expr);
                if (value == null) return null;
                if (ast.operator === 'char') return Math.max(0, Math.ceil(value / PAWN_CHARS_PER_CELL));
                return null;
            }
            if (ast.kind === 'binary') {
                const left = evaluateAst(ast.left);
                const right = evaluateAst(ast.right);
                if (left == null || right == null) return null;
                if (ast.operator === '+') return left + right;
                if (ast.operator === '-') return left - right;
                if (ast.operator === '*') return left * right;
                if (ast.operator === '/') return left / right;
                if (ast.operator === '%') return left % right;
                if (ast.operator === '<<') return left << right;
                if (ast.operator === '>>') return left >> right;
                if (ast.operator === '<') return left < right ? 1 : 0;
                if (ast.operator === '<=') return left <= right ? 1 : 0;
                if (ast.operator === '>') return left > right ? 1 : 0;
                if (ast.operator === '>=') return left >= right ? 1 : 0;
                if (ast.operator === '==') return left === right ? 1 : 0;
                if (ast.operator === '!=') return left !== right ? 1 : 0;
                if (ast.operator === '&') return left & right;
                if (ast.operator === '^') return left ^ right;
                if (ast.operator === '|') return left | right;
                if (ast.operator === '&&') return left && right ? 1 : 0;
                if (ast.operator === '||') return left || right ? 1 : 0;
                return null;
            }
            if (ast.kind === 'ternary') {
                const condition = evaluateAst(ast.condition);
                if (condition == null) return null;
                return evaluateAst(condition ? ast.whenTrue : ast.whenFalse);
            }
            return null;
        };

        const result = evaluateAst(parsed.ast);
        return cacheParsedNumericExprResult(Number.isFinite(result) ? result : null);
    }

    function evaluatePawnNumericExpr(expr, decls = [], seen = new Set(), analysisCache = null) {
        const cacheKey = String(expr || '').trim();
        const canUseCache = !!(analysisCache?.numericExprByText && seen?.size === 0);
        if (canUseCache && analysisCache.numericExprByText.has(cacheKey)) {
            return analysisCache.numericExprByText.get(cacheKey);
        }
        const cacheNumericExprResult = result => {
            if (canUseCache) {
                analysisCache.numericExprByText.set(cacheKey, result);
            }
            return result;
        };

        let source = semanticSyntaxCore.stripRootTagCasts(expr, { escapeChar: getActiveCtrlChar() });
        if (!source) return cacheNumericExprResult(null);
        const expanded = macroExpansionCore.expandMacros(source, decls, {
            escapeChar: getActiveCtrlChar(),
            disabledNames: seen,
            getDefine: name => findAnyDeclByNameFromSources(
                decls,
                name,
                item => item.type === 'define',
                analysisCache
            ),
            maxOutputLength: 8192
        });
        if (!expanded.complete) return cacheNumericExprResult(null);
        source = expanded.text;

        if (/[A-Za-z_@]/.test(source)) {
            source = source.replace(/\bsizeof\s*\(\s*([A-Za-z_@]\w*)\s*\)/g, (_, name) => {
                const decl = findAnyDeclByNameFromSources(decls, name, null, analysisCache);
                if (!decl) return 'NaN';
                if (decl.type === 'enum' && /^-?\d+$/.test(String(decl.value || ''))) {
                    return String(decl.value);
                }
                if (decl.dims) {
                    const firstDim = parseDimsParts(decl.dims)[0];
                    const dimSpec = parseDimSpec(firstDim, decls, seen, analysisCache);
                    return dimSpec.capacity != null ? String(dimSpec.capacity) : 'NaN';
                }
                return 'NaN';
            });

            source = source.replace(/\b([A-Za-z_@][A-Za-z0-9_@]*)\b/g, (full, name) => {
                if (FORBIDDEN.has(name)) return full;
                if (seen.has(name)) return 'NaN';

                const decl = findAnyDeclByNameFromSources(decls, name, null, analysisCache);
                if (!decl) return full;

                if (decl.type === 'enum' && /^-?\d+$/.test(String(decl.value || ''))) {
                    return String(decl.value);
                }
                if (decl.type === 'enum-item' && /^-?\d+$/.test(String(decl.value || ''))) {
                    return String(decl.value);
                }
                if (decl.type === 'define') {
                    const defineValue = String(decl.value || '').trim();
                    if (decl.args) return full;
                    if (/^-?\d+$/.test(defineValue)) return defineValue;
                    seen.add(name);
                    const nested = evaluatePawnNumericExpr(defineValue, decls, seen, analysisCache);
                    seen.delete(name);
                    return nested == null ? 'NaN' : String(nested);
                }

                return full;
            });
        }

        const validationSource = source.indexOf('\'') >= 0
            ? replaceNumericCharacterLiteralsForValidation(source, getActiveCtrlChar())
            : source;
        const sanitized = source.replace(/\s+/g, '');
        const validationForTokenGuard = validationSource.replace(/\b(?:char|cellmin|cellmax)\b/g, '');
        const validationSanitized = validationForTokenGuard.replace(/\s+/g, '');
        if (!sanitized) return cacheNumericExprResult(null);
        if (/[A-WYZa-wyz_@]/.test(validationSanitized.replace(/0[xX][0-9a-fA-F]+/g, '0'))) return cacheNumericExprResult(null);

        const withoutHex = validationSanitized.replace(/0[xX][0-9a-fA-F]+/g, '0');
        const withoutCompoundOps = withoutHex.replace(/<<|>>|<=|>=|==|!=|&&|\|\|/g, '');
        if (/[^0-9+\-*/%()|&~^<>!?:]/.test(withoutCompoundOps)) return cacheNumericExprResult(null);

        return cacheNumericExprResult(evaluateParsedPawnNumericExpr(source));
    }

    function parseDimSpec(dimPart, decls = [], seen = new Set(), analysisCache = null) {
        const raw = String(dimPart || '').trim();
        const isChar = /\bchar\b/.test(raw);
        const expr = raw.replace(/\bchar\b/g, '').trim();
        const enumCandidate = extractEnumSymbolName(dimPart);
        const enumDecl = enumCandidate
            ? (() => {
                const candidate = findAnyDeclByNameFromSources(decls, enumCandidate, null, analysisCache);
                return candidate?.type === 'enum' ? candidate : null;
            })()
            : null;
        const enumName = enumDecl
            ? enumCandidate
            : '';
        let capacity = expr ? evaluatePawnNumericExpr(expr, decls, seen, analysisCache) : null;
        if (enumDecl && /^[A-Za-z_@]\w*$/.test(expr || '')) {
            const enumRootCapacity = getEnumDeclResolvedCapacity(enumDecl, decls, seen, analysisCache) ??
                evaluatePawnNumericExpr(
                    String(enumDecl.value ?? '').trim(),
                    decls,
                    seen,
                    analysisCache
                );
            if (enumRootCapacity != null) {
                capacity = enumRootCapacity;
            } else {
                const numericMemberValues = (enumDecl.enumMembers || [])
                    .map(item => Number.parseInt(String(item?.value ?? ''), 10))
                    .filter(value => Number.isFinite(value));
                if (numericMemberValues.length) {
                    capacity = Math.max(...numericMemberValues) + 1;
                }
            }
        }
        return { raw, expr, isChar, capacity, enumName };
    }

    function isResolvedDimSpec(dimSpec) {
        if (!dimSpec) return false;
        if (!dimSpec.raw) return true;
        return dimSpec.capacity != null;
    }

    function findUnresolvedReferenceNames(expr, decls = [], analysisCache = null, escapeChar = getActiveCtrlChar()) {
        const cacheKey = String(expr || '').trim();
        if (analysisCache?.unresolvedRefsByExpr.has(cacheKey)) {
            return analysisCache.unresolvedRefsByExpr.get(cacheKey);
        }

        const source = String(expr || '');
        const unresolved = new Set();
        let inStr = false;
        let strCh = '';

        const hasKnownSymbol = (name, isCallLike) => {
            const predicate = isCallLike
                ? item => isFunctionLikeDecl(item)
                : null;
            if (findAnyDeclByNameFromSources(decls, name, predicate, analysisCache)) return true;
            if (predicate) {
                const aliasDefine = findAnyDeclByNameFromSources(
                    decls,
                    name,
                    item => item.type === 'define' && !item.args,
                    analysisCache
                );
                const aliasTargetName = String(aliasDefine?.value || '').trim().match(/^([A-Za-z_@]\w*)$/)?.[1] || '';
                if (aliasTargetName && findAnyDeclByNameFromSources(decls, aliasTargetName, predicate, analysisCache)) {
                    return true;
                }
                return false;
            }
            return false;
        };

        for (let i = 0; i < source.length; i++) {
            const c = source[i];
            if (inStr) {
                if (c === strCh && !isEscapedQuote(source, i, escapeChar)) inStr = false;
                continue;
            }
            if (c === '"' || c === "'") {
                inStr = true;
                strCh = c;
                continue;
            }
            if (!isIdentifierStartChar(c)) continue;
            if (isHexLiteralIdentifierTail(source, i)) continue;

            const start = i;
            let end = i + 1;
            while (end < source.length && isIdentifierContinueChar(source[end])) end++;
            const name = source.slice(i, end);
            i = end - 1;

            if (
                FORBIDDEN.has(name) ||
                name === '_' ||
                name === 'true' ||
                name === 'false' ||
                name === 'cellmin' ||
                name === 'cellmax' ||
                name === 'char'
            ) {
                continue;
            }

            const prevIndex = findPreviousNonWhitespaceIndex(source, start - 1);
            const nextIndex = findFirstNonWhitespaceIndex(source, end);
            const prevChar = prevIndex >= 0 ? source[prevIndex] : '';
            const nextChar = nextIndex >= 0 ? source[nextIndex] : '';

            if (nextChar === ':') continue;
            if (prevChar === '.' && nextChar === '=') continue;

            const isCallLike = nextChar === '(';
            if (!hasKnownSymbol(name, isCallLike)) {
                unresolved.add(name);
            }
        }

        const result = [...unresolved];
        if (analysisCache) analysisCache.unresolvedRefsByExpr.set(cacheKey, result);
        return result;
    }

    function stripTagsForArrayShape(source) {
        let value = unwrapOuterParens(source);
        while (true) {
            const stripped = semanticSyntaxCore.stripRootTagCasts(value, { escapeChar: getActiveCtrlChar() });
            if (!stripped || stripped === value) break;
            value = unwrapOuterParens(stripped);
        }
        return String(value || '').trim();
    }

    function resolveStringArrayValueExpression(source, decls, analysisCache, seen = new Set()) {
        const expr = stripTagsForArrayShape(source);
        if (!expr) return '';
        if (expr.startsWith('"')) return expr;
        const name = expr.match(/^([A-Za-z_@]\w*)$/)?.[1] || '';
        if (!name || seen.has(name)) return '';
        const decl = findAnyDeclByNameFromSources(decls, name, null, analysisCache);
        if (!decl) return '';
        if (decl.type === 'define' && !decl.args) {
            seen.add(name);
            const resolved = resolveStringArrayValueExpression(decl.value, decls, analysisCache, seen);
            seen.delete(name);
            return resolved;
        }
        if (decl.type === 'variable') {
            const value = String(decl.value || '').trim();
            if (!value) return '';
            seen.add(name);
            const resolved = resolveStringArrayValueExpression(value, decls, analysisCache, seen);
            seen.delete(name);
            return resolved;
        }
        return '';
    }

    function isStringArrayValueExpression(source, decls, analysisCache) {
        return !!resolveStringArrayValueExpression(source, decls, analysisCache);
    }

    function getDimSpecForComparison(dimPart, decls, analysisCache) {
        return analysisCache?.getDimSpec?.(dimPart) ||
            parseDimSpec(dimPart, decls, new Set(), analysisCache);
    }

    function getArrayShapeIssue(expectedDims, actualDims, actualExpr = '', decls = [], analysisCache = null, options = {}) {
        const expectedParts = parseDimsParts(expectedDims || '');
        const actualParts = parseDimsParts(actualDims || '');
        if (!expectedParts.length) {
            return actualParts.length
                ? { kind: 'unexpectedArray', status: 'error' }
                : null;
        }
        const actualSource = String(actualExpr || '').trim();
        const escapeChar = typeof options === 'string'
            ? options
            : (options?.escapeChar ?? getActiveCtrlChar());
        const expectedSingleSpec = expectedParts.length === 1
            ? getDimSpecForComparison(expectedParts[0], decls, analysisCache)
            : null;
        const actualStringLiteral = expectedParts.length === 1
            ? resolveStringArrayValueExpression(actualSource, decls, analysisCache)
            : '';
        if (actualStringLiteral) {
            if (!actualParts.length || actualParts.length === 1) {
                const measured = measurePawnStringLiteral?.(actualStringLiteral, escapeChar);
                if (
                    expectedSingleSpec?.capacity != null &&
                    measured?.bytesWithTerminator != null &&
                    measured.bytesWithTerminator > expectedSingleSpec.capacity
                ) {
                    return {
                        kind: 'size',
                        status: 'error',
                        expectedRaw: expectedSingleSpec.raw,
                        actualRaw: String(measured.bytesWithTerminator)
                    };
                }
                return null;
            }
        }
        if (!actualParts.length) {
            if (options?.allowScalarAssignmentToArrayField) return null;
            return { kind: 'missingArray', status: 'error' };
        }
        if (expectedParts.length !== actualParts.length) {
            return { kind: 'dimensionCount', status: 'error' };
        }
        for (let index = 0; index < expectedParts.length; index++) {
            if (!expectedParts[index]) continue;
            const expectedSpec = getDimSpecForComparison(expectedParts[index], decls, analysisCache);
            const actualSpec = getDimSpecForComparison(actualParts[index], decls, analysisCache);
            const expectedEnum = normalizeEnumName(expectedSpec?.enumName || '');
            const actualEnum = normalizeEnumName(actualSpec?.enumName || '');
            if (expectedEnum && actualEnum && expectedEnum !== actualEnum) {
                return {
                    kind: 'indexTag',
                    status: 'warn',
                    name: actualSpec?.enumName || actualSpec?.raw || expectedSpec?.enumName || expectedSpec?.raw || ''
                };
            }
            if (expectedSpec?.raw && !actualSpec?.raw) {
                return {
                    kind: 'expectedOnly',
                    status: 'warn',
                    expectedRaw: expectedSpec.raw,
                    actualRaw: actualSpec?.raw || ''
                };
            }
            if (!isResolvedDimSpec(expectedSpec) || !isResolvedDimSpec(actualSpec)) {
                return {
                    kind: 'unknownDimensionSymbol',
                    status: 'error',
                    expectedRaw: expectedSpec?.raw || '',
                    actualRaw: actualSpec?.raw || ''
                };
            }
            if (
                expectedSpec?.raw &&
                actualSpec?.raw &&
                expectedSpec.capacity != null &&
                actualSpec.capacity != null
            ) {
                if (expectedSpec.capacity === actualSpec.capacity) {
                    continue;
                }
                if (
                    options?.arrayContext === 'assignment' &&
                    expectedParts.length === 1 &&
                    actualParts.length === 1 &&
                    !expectedEnum &&
                    !actualEnum &&
                    actualSpec.capacity <= expectedSpec.capacity
                ) {
                    continue;
                }
                if (
                    expectedParts.length === 1 &&
                    actualParts.length === 1 &&
                    actualSpec.capacity <= expectedSpec.capacity &&
                    isStringArrayValueExpression(actualSource, decls, analysisCache)
                ) {
                    continue;
                }
                return {
                    kind: 'size',
                    status: 'error',
                    expectedRaw: expectedSpec.raw,
                    actualRaw: actualSpec.raw
                };
            }
            if (expectedSpec?.raw && actualSpec?.raw && expectedSpec.raw !== actualSpec.raw) {
                return {
                    kind: 'rawMismatch',
                    status: 'warn',
                    expectedRaw: expectedSpec.raw,
                    actualRaw: actualSpec.raw
                };
            }
        }
        return null;
    }

    function explainArrayShapeIssue(issue, expectedDims, actualDims) {
        if (!issue) return { status: 'ok', reason: '' };
        switch (issue.kind) {
            case 'missingArray':
                return { status: 'error', reason: t('validation.missingDimensions', { dims: expectedDims }) };
            case 'unexpectedArray':
                return { status: 'warn', reason: t('validation.unexpectedDimensions', { dims: actualDims }) };
            case 'dimensionCount':
                return {
                    status: 'error',
                    reason: t('validation.dimensionCountMismatch', { expected: expectedDims, actual: actualDims })
                };
            case 'expectedOnly':
                return {
                    status: 'warn',
                    reason: t('validation.dimensionMismatchExpectedOnly', { expected: issue.expectedRaw || '' })
                };
            case 'unknownDimensionSymbol':
                return {
                    status: 'error',
                    reason: t('validation.unknownDimensionSymbolExpectedGot', {
                        expected: issue.expectedRaw || '',
                        actual: issue.actualRaw || ''
                    })
                };
            case 'size':
                return {
                    status: 'error',
                    reason: t('validation.dimensionSizeMismatch', {
                        expected: issue.expectedRaw || expectedDims,
                        actual: issue.actualRaw || actualDims
                    })
                };
            case 'indexTag':
                return { status: 'warn', reason: t('validation.indexTagMismatch', { name: issue.name || '' }) };
            case 'rawMismatch':
                return {
                    status: 'warn',
                    reason: t('validation.dimensionMismatchExpectedGot', {
                        expected: issue.expectedRaw || '',
                        actual: issue.actualRaw || ''
                    })
                };
            default:
                return { status: issue.status || 'error', reason: '' };
        }
    }

    function explainArrayShapeDiagnosticIssue(issue) {
        if (!issue) return { status: 'ok', reason: '' };
        switch (issue.kind) {
            case 'missingArray':
                return { status: issue.status || 'error', reason: t('validation.mustBeAssignedToArray') };
            case 'unexpectedArray':
                return {
                    status: issue.status || 'error',
                    reason: t('validation.arrayMustBeIndexed', { name: issue.name || '' })
                };
            case 'dimensionCount':
                return { status: issue.status || 'error', reason: t('validation.arrayDimensionsMustMatch') };
            case 'size':
                return { status: issue.status || 'error', reason: t('validation.arraySizesMustMatch') };
            case 'indexTag':
                return {
                    status: issue.status || 'warn',
                    reason: t('validation.indexTagMismatch', { name: issue.name || '' })
                };
            case 'expectedOnly':
            case 'rawMismatch':
            case 'unknownDimensionSymbol':
                return { status: issue.status || 'warn', reason: t('validation.arraySizesMustMatch') };
            default:
                return { status: issue.status || 'error', reason: '' };
        }
    }

    function explainTypeCompat(paramStr, actualTag, actualDims, actualExpr = '', decls = [], options = {}) {
        const { paramMeta = null, analysisCache = null, allowArrayToScalar = false } = options;
        const compatCacheKey = analysisCache
            ? [
                String(paramStr || ''),
                String(actualTag || ''),
                String(actualDims || ''),
                String(actualExpr || ''),
                allowArrayToScalar ? 'array-ok' : ''
            ].join('\u0000')
            : '';
        if (compatCacheKey && analysisCache.typeCompatByKey.has(compatCacheKey)) {
            return analysisCache.typeCompatByKey.get(compatCacheKey);
        }
        const {
            expectedTag,
            expectedDims,
            hasDefault
        } = paramMeta || analysisCache?.getParamMeta(paramStr) || parseParamMeta(paramStr);
        const actual = String(actualExpr || '').trim();
        const actualRootTagCast = getRootTagCastExpressionForValidation(actual, getActiveCtrlChar());
        const explicitUntypedActual = actualRootTagCast?.tag === '_';
        const isUntaggedBraceArrayActual = !!(
            actual &&
            !actualRootTagCast &&
            actual[0] === '{' &&
            parseBraceArrayLiteralExpression(actual)
        );
        const result = (() => {

            if (!actual || actual === '_') {
                return hasDefault
                    ? { status: 'ok', reason: '' }
                    : { status: 'error', reason: t('validation.argumentHasNoDefaultValue') };
            }

            const unresolvedRefs = findUnresolvedReferenceNames(actual, decls, analysisCache);
            if (unresolvedRefs.length) {
                return {
                    status: 'error',
                    reason: t('validation.unknownSymbol', { symbols: unresolvedRefs.join(', ') })
                };
            }

            let effectiveActualTag = actualTag;
            let effectiveActualDims = actualDims;
            let effectiveActualElementTag = '';
            if (expectedDims && !effectiveActualDims) {
                const actualIndexedSource = stripTagCastsForValidation(actual) || actual;
                const indexedExpr = parseIndexedAccessExpression(actualIndexedSource);
                if (indexedExpr) {
                    const baseDecl = findLocalDeclByNameFromSources(
                        decls,
                        indexedExpr.baseName,
                        item => item.type === 'variable',
                        analysisCache
                    );
                    if (baseDecl) {
                        const accessChain = resolveIndexedAccessValidationChain(
                            baseDecl,
                            indexedExpr.accesses.map(access => access.slice(1, -1).trim()),
                            decls,
                            analysisCache
                        );
                        const lastStep = accessChain[accessChain.length - 1] || null;
                        if (
                            lastStep &&
                            !lastStep.nextDimParts?.length &&
                            Array.isArray(lastStep.selectedSourceDimParts) &&
                            lastStep.selectedSourceDimParts.length === 1
                        ) {
                            effectiveActualDims = '[]';
                        }
                    }
                } else {
                    const inferredCallReturnType = inferArrayLikeCallReturnType(actual, decls, analysisCache);
                    if (inferredCallReturnType?.dims) {
                        effectiveActualTag = inferredCallReturnType.tag || effectiveActualTag;
                        effectiveActualDims = inferredCallReturnType.dims;
                    }
                }
            } else if (expectedDims && !effectiveActualTag && actual && !isUntaggedBraceArrayActual) {
                const inferredActualType = inferArgType(actual, decls, analysisCache);
                effectiveActualElementTag = inferredActualType?.elementTag || '';
            }

            if (!expectedDims) {
                if (effectiveActualDims && effectiveActualDims !== '[]' && !allowArrayToScalar) {
                    return { status: 'warn', reason: t('validation.unexpectedDimensions', { dims: effectiveActualDims }) };
                }
                if (isImplicitBoolToScalarCompat(expectedTag, effectiveActualTag, effectiveActualDims)) {
                    return { status: 'ok', reason: '' };
                }
                if (explicitUntypedActual) {
                    return { status: 'ok', reason: '' };
                }
                return explainPawnTagCompat(expectedTag, effectiveActualTag, decls, analysisCache);
            }

            if (!effectiveActualDims) return { status: 'error', reason: t('validation.expectedArrayStructArgument') };

            const shapeIssue = getArrayShapeIssue(
                expectedDims,
                effectiveActualDims,
                actual,
                decls,
                analysisCache,
                { escapeChar: getActiveCtrlChar() }
            );
            if (shapeIssue) {
                return explainArrayShapeIssue(shapeIssue, expectedDims, effectiveActualDims);
            }

            if (explicitUntypedActual) {
                return { status: 'ok', reason: '' };
            }

            return explainPawnTagCompat(
                expectedTag,
                expectedTag && !effectiveActualTag ? effectiveActualElementTag : effectiveActualTag,
                decls,
                analysisCache
            );
        })();
        if (compatCacheKey) {
            analysisCache.typeCompatByKey.set(compatCacheKey, result);
        }
        return result;
    }

    function checkTypeCompat(paramStr, actualTag, actualDims, actualExpr = '', decls = [], options = {}) {
        return explainTypeCompat(paramStr, actualTag, actualDims, actualExpr, decls, options).status;
    }

    function explainParamDeclCompat(expectedParamStr, actualParamStr, decls = [], options = {}) {
        const { analysisCache = null } = options;
        const expectedMeta = analysisCache?.getParamMeta(expectedParamStr) || parseParamMeta(expectedParamStr);
        const actualMeta = analysisCache?.getParamMeta(actualParamStr) || parseParamMeta(actualParamStr);

        if (!actualMeta?.raw) return { status: 'error', reason: t('validation.missingLocalParameterDeclaration') };
        const unresolvedExpectedDims = findUnresolvedReferenceNames(expectedMeta.expectedDims || '', decls, analysisCache);
        if (unresolvedExpectedDims.length) {
            return {
                status: 'error',
                reason: t('validation.unknownDimensionSymbolIncludeDeclaration', { symbols: unresolvedExpectedDims.join(', ') })
            };
        }
        const unresolvedActualDims = findUnresolvedReferenceNames(actualMeta.expectedDims || '', decls, analysisCache);
        if (unresolvedActualDims.length) {
            return {
                status: 'error',
                reason: t('validation.unknownDimensionSymbolLocalDeclaration', { symbols: unresolvedActualDims.join(', ') })
            };
        }
        if (!!expectedMeta.isByRef !== !!actualMeta.isByRef) {
            return { status: 'error', reason: t('validation.byRefMismatch') };
        }
        if (!!expectedMeta.isConst !== !!actualMeta.isConst) {
            return { status: 'error', reason: t('validation.constQualifierMismatch') };
        }

        const expectedTag = expectedMeta.expectedTag || '';
        const actualTag = actualMeta.expectedTag || '';
        const expectedDims = expectedMeta.expectedDims || '';
        const actualDims = actualMeta.expectedDims || '';

        const isAnyTag = String(expectedTag || '').toLowerCase() === 'any';
        const isActualAnyTag = String(actualTag || '').toLowerCase() === 'any';

        if (!expectedTag || expectedTag === '_' || isAnyTag) {
            if (expectedDims) {
                if (!actualDims) return { status: 'error', reason: t('validation.expectedArrayStructParameter') };
            } else {
                if (actualDims) return { status: 'error', reason: t('validation.expectedScalarParameterGotArrayStruct') };
                if (isImplicitBoolToScalarCompat(expectedTag, actualTag, actualDims)) {
                    return { status: 'ok', reason: '' };
                }
                if (actualTag && !isActualAnyTag && !isAnyTag) {
                    return { status: 'error', reason: t('validation.unexpectedTag', { tag: actualTag }) };
                }
            }
        } else {
            const expectedUnionTags = parseUnionTagOptions(expectedTag);
            if (expectedUnionTags.length) {
                const allowedTags = expectedUnionTags.map(tag => tag.toLowerCase());
                if (!actualTag) {
                    return allowedTags.includes('_')
                        ? { status: 'ok', reason: '' }
                        : { status: 'warn', reason: t('validation.expectedTag', { tag: expectedTag }) };
                }
                if (!allowedTags.includes(String(actualTag).toLowerCase())) {
                    if (isActualAnyTag) {
                        return { status: 'ok', reason: '' };
                    }
                    return { status: 'error', reason: t('validation.tagMismatch', { expected: expectedTag, actual: actualTag }) };
                }
            } else {
                if (!actualTag) return { status: 'error', reason: t('validation.missingTag', { tag: expectedTag }) };
                if (isActualAnyTag) return { status: 'ok', reason: '' };
                if (expectedTag.toLowerCase() !== actualTag.toLowerCase()) {
                    return { status: 'error', reason: t('validation.tagMismatch', { expected: expectedTag, actual: actualTag }) };
                }
            }
        }

        if (!expectedDims) {
            return actualDims
                ? { status: 'error', reason: t('validation.unexpectedDimensions', { dims: actualDims }) }
                : { status: 'ok', reason: '' };
        }

        if (!actualDims) return { status: 'error', reason: t('validation.missingDimensions', { dims: expectedDims }) };

        const shapeIssue = getArrayShapeIssue(
            expectedDims,
            actualDims,
            '',
            decls,
            analysisCache,
            { escapeChar: getActiveCtrlChar() }
        );
        if (shapeIssue) {
            return explainArrayShapeIssue(shapeIssue, expectedDims, actualDims);
        }

        return { status: 'ok', reason: '' };
    }

    function checkParamDeclCompat(expectedParamStr, actualParamStr, decls = [], options = {}) {
        return explainParamDeclCompat(expectedParamStr, actualParamStr, decls, options).status;
    }

    return {
        createHoverTypeAnalysisCache,
        inferCallReturnType,
        inferArrayLikeCallReturnType,
        getArrayShapeIssue,
        explainArrayShapeIssue,
        explainArrayShapeDiagnosticIssue,
        inferArgType,
        inferArrayShapeActualType,
        getExpressionAssignableInfo,
        isSyntacticAssignableExpression,
        findArrayMustBeIndexedIssue,
        getScalarAssignmentTagIssue,
        stripTagCastsForValidation,
        unwrapExpressionForValidation,
        stripTrailingSemicolon,
        findFirstNonWhitespaceIndex,
        findPreviousNonWhitespaceIndex,
        findBalancedGroupEnd,
        hasUnclosedFunctionCallGroup,
        isConstVariableDecl,
        isIdentifierStartChar,
        isIdentifierContinueChar,
        isHexLiteralIdentifierTail,
        normalizeEnumName,
        getEnumItemCellSpan,
        inferEffectiveDimPartsFromValue,
        getEffectiveDeclDimParts,
        resolveIndexedAccessValidationChain,
        parseParamMeta,
        parseDimsParts,
        parseWholeCallExpression,
        parseOperatorOverloadToken,
        collectOperatorOverloadPolicyIssues,
        evaluatePawnNumericExpr,
        parseDimSpec,
        isResolvedDimSpec,
        findUnresolvedReferenceNames,
        explainTypeCompat,
        checkTypeCompat,
        explainParamDeclCompat,
        checkParamDeclCompat
    };
}

module.exports = { createValidationCore };
