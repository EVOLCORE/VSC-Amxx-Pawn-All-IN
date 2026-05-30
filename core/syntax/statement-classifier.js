const { createPawnIdentifierReader } = require('./identifiers');
const { PAWN_STRUCTURAL_KEYWORD_SET } = require('./keywords');
const {
    findTopLevelChar: findTopLevelCharCore,
    findTopLevelSequence
} = require('./top-level');

function createStatementClassifier(deps) {
    const {
        isEscapedQuote,
        isIdentifierStartChar,
        isIdentifierContinueChar,
        findFirstNonWhitespaceIndex,
        findBalancedGroupEnd,
        stripTrailingSemicolon,
        splitTopLevel,
        evaluatePawnNumericExpr,
        looksLikePawnExpressionFragment
    } = deps;

    function isIdentifierBoundaryBefore(source, index) {
        return index <= 0 || !isIdentifierContinueChar(source[index - 1] || '');
    }

    function isIdentifierBoundaryAfter(source, index) {
        return index >= source.length || !isIdentifierContinueChar(source[index] || '');
    }

    function isKeywordAt(source, index, keyword) {
        const text = String(source || '');
        return text.slice(index, index + keyword.length) === keyword &&
            isIdentifierBoundaryBefore(text, index) &&
            isIdentifierBoundaryAfter(text, index + keyword.length);
    }

    const readIdentifierAt = createPawnIdentifierReader({
        isIdentifierStartChar,
        isIdentifierContinueChar
    });
    const STATEMENT_LEVEL_KEYWORDS = [
        'break',
        'continue',
        'switch',
        'for',
        'while',
        'do',
        'return'
    ];
    const hasWantedIdentifier = (wantedList, wantedSet, name) =>
        wantedList
            ? wantedList.indexOf(name) >= 0
            : wantedSet.has(name);

    function collectStatementLevelIdentifiers(source, names = null) {
        const text = String(source || '');
        const wantedList = Array.isArray(names) && names.length <= 12 ? names : null;
        const wantedSet = names && !wantedList ? new Set(names) : null;
        const identifiers = [];
        let parenDepth = 0;
        let bracketDepth = 0;
        let inStr = false;
        let strCh = '';

        for (let index = 0; index < text.length; index++) {
            const char = text[index];
            if (inStr) {
                if (char === strCh && !isEscapedQuote(text, index)) inStr = false;
                continue;
            }
            if (char === '"' || char === "'") {
                inStr = true;
                strCh = char;
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
            if (parenDepth || bracketDepth) continue;

            const ident = readIdentifierAt(text, index);
            if (!ident) continue;
            if (!names || hasWantedIdentifier(wantedList, wantedSet, ident.text)) {
                identifiers.push(ident);
            }
            index = ident.end - 1;
        }

        return identifiers;
    }

    function findTopLevelChar(source, targetChar, startIndex = 0) {
        return findTopLevelCharCore(source, targetChar, { startIndex, isEscapedQuote });
    }

    function findTopLevelRangeOperator(source) {
        return findTopLevelSequence(source, '..', { isEscapedQuote });
    }

    function parseSwitchLabelAt(source, startIndex = 0) {
        const text = String(source || '');
        let index = findFirstNonWhitespaceIndex(text, startIndex);
        const keyword = isKeywordAt(text, index, 'case')
            ? 'case'
            : (isKeywordAt(text, index, 'default') ? 'default' : '');
        if (!keyword) return null;

        const keywordStart = index;
        index += keyword.length;
        if (keyword === 'default') {
            const colonIndex = findTopLevelChar(text, ':', index);
            if (colonIndex < 0) return null;
            return {
                kind: 'default',
                label: '',
                keywordStart,
                colonIndex,
                matchText: text.slice(keywordStart, colonIndex + 1),
                inlineBody: text.slice(colonIndex + 1).trim()
            };
        }

        index = findFirstNonWhitespaceIndex(text, index);
        const labelStart = index;
        const colonIndex = findTopLevelChar(text, ':', index);
        if (colonIndex < 0) return null;
        let labelEnd = colonIndex;
        while (labelEnd > labelStart && /\s/.test(text[labelEnd - 1])) labelEnd--;
        return {
            kind: 'case',
            label: text.slice(labelStart, colonIndex).trim(),
            labelStart,
            labelEnd,
            keywordStart,
            colonIndex,
            matchText: text.slice(keywordStart, colonIndex + 1),
            inlineBody: text.slice(colonIndex + 1).trim()
        };
    }

    function findKeywordOccurrences(source, keywords) {
        return collectStatementLevelIdentifiers(source, keywords).map(ident => ({
            keyword: ident.text,
            start: ident.start,
            end: ident.end
        }));
    }

    function skipInlineControlHeader(source, keywordStart, keyword) {
        const text = String(source || '');
        let index = keywordStart + keyword.length;
        if (keyword === 'else') {
            return findFirstNonWhitespaceIndex(text, index);
        }
        if (keyword === 'do') {
            return findFirstNonWhitespaceIndex(text, index);
        }
        index = findFirstNonWhitespaceIndex(text, index);
        if (text[index] !== '(') return -1;
        const closeIndex = findBalancedGroupEnd(text, index, '(', ')');
        if (closeIndex < 0) return -1;
        return findFirstNonWhitespaceIndex(text, closeIndex + 1);
    }

    function classifyPawnStatementLine(source) {
        const text = String(source || '');
        const start = findFirstNonWhitespaceIndex(text, 0);
        const trimmed = text.slice(start).trim();
        const firstIdentifier = readIdentifierAt(text, start);
        const firstKeyword = firstIdentifier && PAWN_STRUCTURAL_KEYWORD_SET.has(firstIdentifier.text)
            ? firstIdentifier.text
            : '';
        const switchLabel = parseSwitchLabelAt(text, start);
        const controlOccurrences = [];
        const controlStarts = [];
        let returnOccurrence = null;

        for (const ident of collectStatementLevelIdentifiers(text.slice(start), STATEMENT_LEVEL_KEYWORDS)) {
            const absoluteStart = start + ident.start;
            const absoluteEnd = start + ident.end;
            switch (ident.text) {
                case 'break':
                case 'continue':
                    controlOccurrences.push({
                        keyword: ident.text,
                        start: absoluteStart,
                        end: absoluteEnd
                    });
                    break;
                case 'switch':
                case 'for':
                case 'while':
                case 'do':
                    controlStarts.push({
                        keyword: ident.text,
                        start: absoluteStart,
                        end: absoluteEnd
                    });
                    break;
                case 'return':
                    if (!returnOccurrence) {
                        returnOccurrence = {
                            keyword: ident.text,
                            start: absoluteStart,
                            end: absoluteEnd
                        };
                    }
                    break;
            }
        }

        const returnInfo = returnOccurrence
            ? {
                start: returnOccurrence.start,
                valueText: stripTrailingSemicolon(text.slice(returnOccurrence.end))
            }
            : null;

        return {
            text,
            start,
            trimmed,
            firstKeyword,
            firstKeywordStart: firstIdentifier?.start ?? -1,
            switchLabel,
            controlOccurrences,
            controlStarts,
            returnInfo
        };
    }

    function getNoEffectConstantStatementIssue(source) {
        const text = String(source || '');
        const start = findFirstNonWhitespaceIndex(text, 0);
        if (start >= text.length) return null;

        let end = text.length;
        while (end > start && /\s/.test(text[end - 1])) end--;
        if (text[end - 1] === ';') {
            end--;
            while (end > start && /\s/.test(text[end - 1])) end--;
        }

        const expr = text.slice(start, end).trim();
        if (!expr) return null;
        if (/[=,{}[\]]/.test(expr) || /\+\+|--/.test(expr)) return null;
        if (!looksLikePawnExpressionFragment(expr, { allowAssignment: false })) {
            return null;
        }

        const numericValue = evaluatePawnNumericExpr(expr);
        const isFloatLiteralOnly = /^[+\-]?\s*(?:\d+\.\d*|\.\d+)(?:[eE][+\-]?\d+)?\s*$/.test(expr);
        const isCharLiteralOnly = /^'.*'$/.test(expr);
        if (numericValue == null && !isFloatLiteralOnly && !isCharLiteralOnly) return null;

        return {
            start,
            text: text.slice(start, end)
        };
    }

    function stripLeadingInlineStatementPrefix(source) {
        const text = String(source || '');
        let index = 0;
        const prefixes = [];

        index = findFirstNonWhitespaceIndex(text, index);
        let changed = false;

        while (index < text.length) {
            if (isKeywordAt(text, index, 'else')) {
                prefixes.push({ kind: 'else', start: index, end: index + 4 });
                index += 4;
                index = findFirstNonWhitespaceIndex(text, index);
                changed = true;
                continue;
            }

            const switchLabel = parseSwitchLabelAt(text, index);
            if (switchLabel) {
                prefixes.push({
                    kind: switchLabel.kind,
                    start: switchLabel.keywordStart,
                    end: switchLabel.colonIndex + 1
                });
                index = findFirstNonWhitespaceIndex(text, switchLabel.colonIndex + 1);
                changed = true;
                continue;
            }

            const identifier = readIdentifierAt(text, index);
            const controlKeyword = (
                identifier &&
                (
                    identifier.text === 'if' ||
                    identifier.text === 'for' ||
                    identifier.text === 'while' ||
                    identifier.text === 'switch' ||
                    identifier.text === 'do'
                )
            )
                ? identifier.text
                : '';
            if (!controlKeyword) break;

            const keywordStart = index;
            index += controlKeyword.length;
            index = findFirstNonWhitespaceIndex(text, index);
            if (controlKeyword !== 'do') {
                if (text[index] !== '(') {
                    index = keywordStart;
                    break;
                }
                const closeIndex = findBalancedGroupEnd(text, index, '(', ')');
                if (closeIndex < 0) {
                    index = keywordStart;
                    break;
                }
                index = closeIndex + 1;
            }
            prefixes.push({ kind: controlKeyword, start: keywordStart, end: index });
            index = findFirstNonWhitespaceIndex(text, index);
            changed = true;
        }

        return changed
            ? { text: text.slice(index), startOffset: index, prefixes }
            : { text, startOffset: 0, prefixes };
    }

    function mayHaveInlineStatementPrefix(source) {
        const text = String(source || '');
        const index = findFirstNonWhitespaceIndex(text, 0);
        if (index >= text.length) return false;
        switch (text[index]) {
            case 'e': return isKeywordAt(text, index, 'else');
            case 'i': return isKeywordAt(text, index, 'if');
            case 'f': return isKeywordAt(text, index, 'for');
            case 'w': return isKeywordAt(text, index, 'while');
            case 's': return isKeywordAt(text, index, 'switch');
            case 'c': return isKeywordAt(text, index, 'case');
            case 'd': return isKeywordAt(text, index, 'default') || isKeywordAt(text, index, 'do');
            default: return false;
        }
    }

    function isLocalDeclarationStatementStart(source) {
        const text = String(source || '');
        const start = findFirstNonWhitespaceIndex(text, 0);
        const ident = readIdentifierAt(text, start);
        return ident?.text === 'new' || ident?.text === 'static';
    }

    function hasControlInlinePrefix(inlinePrefix) {
        return (inlinePrefix?.prefixes || []).some(prefix =>
            prefix.kind === 'if' ||
            prefix.kind === 'for' ||
            prefix.kind === 'while' ||
            prefix.kind === 'switch' ||
            prefix.kind === 'do' ||
            prefix.kind === 'else'
        );
    }

    function countTopLevelSemicolonStatements(source) {
        const text = String(source || '');
        let count = 0;
        let inStr = false;
        let strCh = '';
        let parenDepth = 0;
        let bracketDepth = 0;
        let braceDepth = 0;
        let segmentHasToken = false;

        for (let index = 0; index < text.length; index++) {
            const char = text[index];
            if (inStr) {
                segmentHasToken = true;
                if (char === strCh && !isEscapedQuote(text, index)) inStr = false;
                continue;
            }
            if (char === '"' || char === '\'') {
                inStr = true;
                strCh = char;
                segmentHasToken = true;
                continue;
            }
            if (char === '(') {
                parenDepth++;
                segmentHasToken = true;
                continue;
            }
            if (char === ')') {
                parenDepth = Math.max(0, parenDepth - 1);
                segmentHasToken = true;
                continue;
            }
            if (char === '[') {
                bracketDepth++;
                segmentHasToken = true;
                continue;
            }
            if (char === ']') {
                bracketDepth = Math.max(0, bracketDepth - 1);
                segmentHasToken = true;
                continue;
            }
            if (char === '{') {
                braceDepth++;
                segmentHasToken = true;
                continue;
            }
            if (char === '}') {
                braceDepth = Math.max(0, braceDepth - 1);
                segmentHasToken = true;
                continue;
            }
            if (char === ';' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
                if (segmentHasToken) count++;
                segmentHasToken = false;
                continue;
            }
            if (!/\s/.test(char)) {
                segmentHasToken = true;
            }
        }

        if (segmentHasToken) count++;
        return count;
    }

    function resolveSwitchCaseLabelValues(labelText, allDecls = [], options = {}) {
        const pieces = splitTopLevel(String(labelText || ''), undefined, true)
            .map(part => String(part || '').trim())
            .filter(Boolean);
        const entries = [];
        let invalidRange = false;
        let invalidConstant = false;

        const normalizeInvalidCaseLabelValue = source => source.replace(/\s+/g, ' ');
        const isMalformedConstantExpr = source => {
            const text = String(source || '').trim();
            if (!text) return true;
            return !looksLikePawnExpressionFragment(text, { allowAssignment: false });
        };
        const evaluate = source => {
            const text = String(source || '').trim();
            if (/^true$/i.test(text)) return 1;
            if (/^false$/i.test(text)) return 0;
            if (/^[+\-]?(?:\d+\.\d*|\.\d+)(?:[eE][+\-]?\d+)?$/.test(text)) return Number(text);
            return evaluatePawnNumericExpr(text, allDecls, null, options.analysisCache || null);
        };

        for (const piece of pieces) {
            const rangeIndex = findTopLevelRangeOperator(piece);
            if (rangeIndex >= 0) {
                const startExpr = piece.slice(0, rangeIndex).trim();
                const endExpr = piece.slice(rangeIndex + 2).trim();
                const startValue = evaluate(startExpr);
                const endValue = evaluate(endExpr);
                if (startValue != null && endValue != null) {
                    if (endValue <= startValue) {
                        invalidRange = true;
                        entries.push({ kind: 'value', value: String(startValue) });
                        continue;
                    }
                    entries.push({
                        kind: 'range',
                        start: Number(startValue),
                        end: Number(endValue)
                    });
                    continue;
                }
                invalidConstant = true;
                entries.push({ kind: 'invalid', value: normalizeInvalidCaseLabelValue(piece) });
                continue;
            }

            const numericValue = evaluate(piece);
            if (numericValue == null) {
                invalidConstant = true;
                entries.push({ kind: 'invalid', value: normalizeInvalidCaseLabelValue(piece) });
                continue;
            }
            entries.push({
                kind: 'value',
                value: String(numericValue)
            });
        }

        return { entries, invalidRange, invalidConstant };
    }

    function findDuplicateSwitchCaseEntry(switchContext, entry) {
        if (!switchContext || !entry) return '';
        if (entry.kind === 'invalid') return '';
        if (entry.kind === 'range') {
            let duplicateValue = null;
            for (const range of switchContext.caseRanges || []) {
                if (entry.start <= range.end && range.start <= entry.end) {
                    duplicateValue = Math.max(entry.start, range.start);
                    break;
                }
            }
            for (const value of switchContext.caseValues || []) {
                const numericValue = Number(value);
                if (!Number.isFinite(numericValue)) continue;
                if (numericValue < entry.start || numericValue > entry.end) continue;
                duplicateValue = duplicateValue == null
                    ? numericValue
                    : Math.min(duplicateValue, numericValue);
            }
            return duplicateValue == null ? '' : String(duplicateValue);
        }

        const value = String(entry.value ?? '');
        if (switchContext.caseValues?.has(value)) return value;
        const numericValue = Number(value);
        if (Number.isFinite(numericValue)) {
            for (const range of switchContext.caseRanges || []) {
                if (numericValue >= range.start && numericValue <= range.end) {
                    return value;
                }
            }
        }
        return '';
    }

    function rememberSwitchCaseEntry(switchContext, entry) {
        if (!switchContext || !entry) return;
        if (entry.kind === 'invalid') return;
        if (entry.kind === 'range') {
            if (!Array.isArray(switchContext.caseRanges)) switchContext.caseRanges = [];
            switchContext.caseRanges.push({ start: entry.start, end: entry.end });
            return;
        }
        if (!switchContext.caseValues) switchContext.caseValues = new Set();
        switchContext.caseValues.add(String(entry.value ?? ''));
    }

    function countStructuralBraces(source) {
        const text = String(source || '');
        let delta = 0;
        let inStr = false;
        let strCh = '';

        for (let index = 0; index < text.length; index++) {
            const char = text[index];
            if (inStr) {
                if (char === strCh) inStr = false;
                continue;
            }
            if (char === '"' || char === '\'') {
                inStr = true;
                strCh = char;
                continue;
            }
            if (char === '{') delta++;
            else if (char === '}') delta--;
        }

        return delta;
    }

    return {
        isKeywordAt,
        readIdentifierAt,
        collectStatementLevelIdentifiers,
        findTopLevelChar,
        findTopLevelRangeOperator,
        parseSwitchLabelAt,
        findKeywordOccurrences,
        skipInlineControlHeader,
        classifyPawnStatementLine,
        getNoEffectConstantStatementIssue,
        stripLeadingInlineStatementPrefix,
        mayHaveInlineStatementPrefix,
        isLocalDeclarationStatementStart,
        hasControlInlinePrefix,
        countTopLevelSemicolonStatements,
        resolveSwitchCaseLabelValues,
        findDuplicateSwitchCaseEntry,
        rememberSwitchCaseEntry,
        countStructuralBraces
    };
}

module.exports = { createStatementClassifier };
