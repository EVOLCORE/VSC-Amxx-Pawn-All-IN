const { skipPawnWhitespace } = require('./whitespace');

function createTagOverridePolicySyntaxCore(deps = {}) {
    const {
        isIdentifierStartChar,
        isIdentifierContinueChar
    } = deps;

    const createWarningIssue = (start, end, tagName) => ({
        kind: 'tagOverrideMustBeParenthesized',
        messageKey: 'validation.tagOverrideMustBeParenthesized',
        params: { tag: tagName || '' },
        severity: 'warning',
        start,
        end
    });

    const previousSignificantChar = (source, index) => {
        for (let probe = index - 1; probe >= 0; probe--) {
            if (!/\s/.test(source[probe] || '')) return source[probe];
        }
        return '';
    };

    const isGroupingParenOpen = (source, openIndex) => {
        const previous = previousSignificantChar(source, openIndex);
        return !previous ||
            previous === '(' ||
            previous === '[' ||
            previous === '{' ||
            previous === ',' ||
            previous === '?' ||
            previous === ':' ||
            previous === '=' ||
            previous === '+' ||
            previous === '-' ||
            previous === '*' ||
            previous === '/' ||
            previous === '%' ||
            previous === '&' ||
            previous === '|' ||
            previous === '^' ||
            previous === '~' ||
            previous === '!' ||
            previous === '<' ||
            previous === '>';
    };

    function readTagBeforeColon(source, colonIndex, knownTags) {
        if (source[colonIndex] !== ':' || source[colonIndex + 1] === ':' || source[colonIndex - 1] === ':') {
            return null;
        }
        let end = colonIndex;
        while (end > 0 && /\s/.test(source[end - 1] || '')) end--;
        let start = end;
        while (start > 0 && isIdentifierContinueChar(source[start - 1] || '')) start--;
        if (start >= end || !isIdentifierStartChar(source[start] || '')) return null;
        if (start > 0 && isIdentifierContinueChar(source[start - 1] || '')) return null;
        const tagName = source.slice(start, end);
        if (!knownTags?.has(tagName)) return null;
        return { tagName, start, end: colonIndex + 1 };
    }

    function matchesKeywordAt(source, index, keyword) {
        return source.slice(index, index + keyword.length) === keyword &&
            (index <= 0 || !isIdentifierContinueChar(source[index - 1] || '')) &&
            (index + keyword.length >= source.length || !isIdentifierContinueChar(source[index + keyword.length] || ''));
    }

    function scanCaseExpression(source, caseStart, knownTags, issues) {
        let index = skipPawnWhitespace(source, caseStart + 4);
        const expressionStart = index;
        const end = source.length;
        const parenAllowsTagStack = [];
        let allowTagParenDepth = 0;

        for (; index < end; index++) {
            const char = source[index];
            if (char === '(') {
                const beforeParen = source.slice(expressionStart, index).trim();
                const allowsTag = beforeParen === '' || isGroupingParenOpen(source, index);
                parenAllowsTagStack.push(allowsTag);
                if (allowsTag) allowTagParenDepth++;
                continue;
            }
            if (char === ')') {
                const allowsTag = parenAllowsTagStack.pop();
                if (allowsTag) allowTagParenDepth = Math.max(0, allowTagParenDepth - 1);
                continue;
            }
            if (char !== ':') continue;
            const tag = readTagBeforeColon(source, index, knownTags);
            if (tag && allowTagParenDepth === 0) {
                issues.push(createWarningIssue(tag.start, tag.end, tag.tagName));
                continue;
            }
            return index + 1;
        }
        return index;
    }

    function collectCaseTagOverrideIssues(source, knownTags) {
        const issues = [];
        const text = String(source || '');
        for (let index = 0; index < text.length; index++) {
            if (!matchesKeywordAt(text, index, 'case')) continue;
            index = Math.max(index, scanCaseExpression(text, index, knownTags, issues) - 1);
        }
        return issues;
    }

    function collectTernaryTagOverrideIssues(source, knownTags) {
        const issues = [];
        const text = String(source || '');
        const ternaryFrames = [];
        const parenAllowsTagStack = [];
        let parenDepth = 0;
        let bracketDepth = 0;
        let braceDepth = 0;
        let allowTagParenDepth = 0;

        const isInForbiddenTernaryTrueBranch = () => {
            for (let index = ternaryFrames.length - 1; index >= 0; index--) {
                const frame = ternaryFrames[index];
                if (
                    parenDepth >= frame.parenDepth &&
                    bracketDepth >= frame.bracketDepth &&
                    braceDepth >= frame.braceDepth &&
                    allowTagParenDepth <= frame.allowTagParenDepth
                ) {
                    return true;
                }
            }
            return false;
        };

        for (let index = 0; index < text.length; index++) {
            const char = text[index];
            if (char === '(') {
                const allowsTag = isGroupingParenOpen(text, index);
                parenAllowsTagStack.push(allowsTag);
                parenDepth++;
                if (allowsTag) allowTagParenDepth++;
                continue;
            }
            if (char === ')') {
                const allowsTag = parenAllowsTagStack.pop();
                parenDepth = Math.max(0, parenDepth - 1);
                if (allowsTag) allowTagParenDepth = Math.max(0, allowTagParenDepth - 1);
                while (
                    ternaryFrames.length &&
                    ternaryFrames[ternaryFrames.length - 1].parenDepth > parenDepth
                ) {
                    ternaryFrames.pop();
                }
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
            if (char === '?') {
                ternaryFrames.push({
                    parenDepth,
                    bracketDepth,
                    braceDepth,
                    allowTagParenDepth
                });
                continue;
            }
            if (char !== ':') continue;
            const tag = readTagBeforeColon(text, index, knownTags);
            if (tag && isInForbiddenTernaryTrueBranch()) {
                issues.push(createWarningIssue(tag.start, tag.end, tag.tagName));
                continue;
            }
            const frame = ternaryFrames[ternaryFrames.length - 1];
            if (
                frame &&
                frame.parenDepth === parenDepth &&
                frame.bracketDepth === bracketDepth &&
                frame.braceDepth === braceDepth
            ) {
                ternaryFrames.pop();
            }
        }
        return issues;
    }

    function collectTagOverrideParenthesesIssues(source, knownTags) {
        if (!knownTags?.size || String(source || '').indexOf(':') < 0) return [];
        return [
            ...collectCaseTagOverrideIssues(source, knownTags),
            ...collectTernaryTagOverrideIssues(source, knownTags)
        ];
    }

    return {
        collectTagOverrideParenthesesIssues
    };
}

module.exports = { createTagOverridePolicySyntaxCore };
