function createRationalPolicySyntaxCore(deps = {}) {
    const {
        evaluatePawnNumericExpr
    } = deps;

    const createIssue = (kind, messageKey, params = {}, severity = '') => ({
        kind,
        messageKey,
        params,
        severity
    });
    const isIdentifierStart = char => /[A-Za-z_@]/.test(char || '');
    const isIdentifierContinue = char => /[A-Za-z0-9_@]/.test(char || '');
    const isIdentifierBoundary = char => !isIdentifierContinue(char || '');

    function skipSpaces(source, index) {
        let cursor = Math.max(0, index | 0);
        while (cursor < source.length && /\s/.test(source[cursor])) cursor++;
        return cursor;
    }

    function readIdentifier(source, index) {
        const start = skipSpaces(String(source || ''), index);
        if (!isIdentifierStart(source[start] || '')) return null;
        let end = start + 1;
        while (end < source.length && isIdentifierContinue(source[end])) end++;
        return {
            name: source.slice(start, end),
            start,
            end
        };
    }

    function findSimpleClosingParen(source, openIndex) {
        if (source[openIndex] !== '(') return -1;
        let depth = 0;
        for (let index = openIndex; index < source.length; index++) {
            const char = source[index];
            if (char === '(') {
                depth++;
                continue;
            }
            if (char === ')') {
                depth--;
                if (depth === 0) return index;
            }
        }
        return -1;
    }

    function parseRationalPragmaPayload(payload, defineDecls = []) {
        const source = String(payload || '');
        const tagInfo = readIdentifier(source, 0);
        const tagName = tagInfo?.name || '';
        let cursor = tagInfo?.end ?? skipSpaces(source, 0);
        cursor = skipSpaces(source, cursor);

        const parsed = {
            tagName,
            tagStart: tagInfo?.start ?? cursor,
            tagEnd: tagInfo?.end ?? cursor,
            hasPrecision: false,
            digits: 0,
            precisionStart: cursor,
            precisionEnd: cursor,
            invalidPrecision: false
        };

        if (source[cursor] !== '(') return parsed;
        const closeIndex = findSimpleClosingParen(source, cursor);
        const expressionEnd = closeIndex >= 0 ? closeIndex : source.length;
        const expression = source.slice(cursor + 1, expressionEnd).trim();
        const evaluated = evaluatePawnNumericExpr(expression, defineDecls);
        const digits = Number(evaluated);

        parsed.hasPrecision = true;
        parsed.digits = Number.isFinite(digits) ? digits : 0;
        parsed.precisionStart = cursor;
        parsed.precisionEnd = closeIndex >= 0 ? closeIndex + 1 : source.length;
        parsed.invalidPrecision = (
            !Number.isInteger(digits) ||
            digits <= 0 ||
            digits > 9
        );
        if (parsed.invalidPrecision) {
            parsed.digits = 0;
        }
        return parsed;
    }

    function createRationalStateFromPragma(parsed) {
        if (!parsed?.tagName) return null;
        return {
            tagName: parsed.tagName,
            digits: parsed.invalidPrecision ? 0 : (parsed.digits | 0)
        };
    }

    function areRationalStatesEqual(left, right) {
        return !!left && !!right &&
            String(left.tagName || '') === String(right.tagName || '') &&
            (left.digits | 0) === (right.digits | 0);
    }

    function getInvalidRationalPrecisionIssue(parsed) {
        if (!parsed?.hasPrecision || !parsed.invalidPrecision) return null;
        return createIssue(
            'invalidRationalPrecision',
            'validation.invalidRationalPrecision'
        );
    }

    function getRationalFormatAlreadyDefinedIssue(previousState, nextState) {
        if (!previousState || !nextState) return null;
        if (areRationalStatesEqual(previousState, nextState)) return null;
        return createIssue(
            'rationalFormatAlreadyDefined',
            'validation.rationalFormatAlreadyDefined'
        );
    }

    function getRationalPrecisionExceededIssue(rationalState) {
        if (!rationalState || (rationalState.digits | 0) <= 0) return null;
        return createIssue(
            'rationalPrecisionExceeded',
            'validation.rationalPrecisionExceeded',
            {},
            'warning'
        );
    }

    function getRationalSupportNotEnabledIssue() {
        return createIssue(
            'rationalSupportNotEnabled',
            'validation.rationalSupportNotEnabled'
        );
    }

    function collectRationalLiteralIssues(source, rationalState) {
        const issues = [];
        const text = String(source || '');

        for (let index = 0; index < text.length; index++) {
            const char = text[index];
            if (char < '0' || char > '9') continue;
            const previous = text[index - 1] || '';
            if (!isIdentifierBoundary(previous) || previous === '.') continue;

            const literalStart = index;
            while (index < text.length && /[0-9_]/.test(text[index])) index++;
            if (text[index] !== '.' || !/[0-9]/.test(text[index + 1] || '')) {
                index = Math.max(index, literalStart);
                continue;
            }
            index++;

            let fractionalDigits = 0;
            while (index < text.length && /[0-9_]/.test(text[index])) {
                if (/[0-9]/.test(text[index])) fractionalDigits++;
                index++;
            }
            if ((text[index] || '').toLowerCase() === 'e') {
                const exponentStart = index;
                let cursor = index + 1;
                if (text[cursor] === '+' || text[cursor] === '-') cursor++;
                if (/[0-9]/.test(text[cursor] || '')) {
                    cursor++;
                    while (/[0-9]/.test(text[cursor] || '')) cursor++;
                    index = cursor;
                } else {
                    index = exponentStart;
                }
            }

            const literalEnd = index;
            if (!rationalState) {
                const issue = getRationalSupportNotEnabledIssue();
                issues.push({
                    ...issue,
                    start: literalStart,
                    end: literalEnd
                });
            } else if ((rationalState.digits | 0) > 0 && fractionalDigits > (rationalState.digits | 0)) {
                const issue = getRationalPrecisionExceededIssue(rationalState);
                if (issue) {
                    issues.push({
                        ...issue,
                        start: literalStart,
                        end: literalEnd
                    });
                }
            }
            index = Math.max(literalEnd - 1, literalStart);
        }
        return issues;
    }

    function collectRationalLiteralPrecisionIssues(source, rationalState) {
        if (!rationalState || (rationalState.digits | 0) <= 0) return [];
        return collectRationalLiteralIssues(source, rationalState)
            .filter(issue => issue.kind === 'rationalPrecisionExceeded');
    }

    return {
        parseRationalPragmaPayload,
        createRationalStateFromPragma,
        areRationalStatesEqual,
        getInvalidRationalPrecisionIssue,
        getRationalFormatAlreadyDefinedIssue,
        getRationalPrecisionExceededIssue,
        getRationalSupportNotEnabledIssue,
        collectRationalLiteralIssues,
        collectRationalLiteralPrecisionIssues
    };
}

module.exports = { createRationalPolicySyntaxCore };
