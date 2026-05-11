const { findNextNonWhitespaceIndex } = require('../syntax/whitespace');

function defaultIsEscapedQuote(source, index) {
    return String(source || '')[index - 1] === '\\';
}

function createCompletionInsertTextCore(deps = {}) {
    const {
        splitTopLevel,
        parseParamMeta = null,
        isEscapedQuote = defaultIsEscapedQuote
    } = deps;

    const splitArgs = value => typeof splitTopLevel === 'function'
        ? splitTopLevel(value)
        : String(value || '').split(',').map(part => part.trim()).filter(Boolean);

    function escapeSnippetPlaceholderText(value) {
        return String(value || '').replace(/[$}\\]/g, '\\$&');
    }

    function getCallParamPlaceholderName(paramText, index = 0, options = {}) {
        const raw = String(paramText || '').trim();
        if (!raw) return `arg${index + 1}`;
        const parsed = typeof parseParamMeta === 'function'
            ? parseParamMeta(raw)
            : null;
        const name = String(parsed?.name || '').trim();
        if (name) return name;
        if (raw === '...' || /\.\.\./.test(raw)) return 'args';
        return `arg${index + 1}`;
    }

    function buildDeclarationArgSnippetText(argsText) {
        return splitArgs(argsText)
            .map((arg, index) => `\${${index + 1}:${escapeSnippetPlaceholderText(String(arg || '').trim())}}`)
            .join(', ');
    }

    function buildCallArgSnippetText(argsText, options = {}) {
        return splitArgs(argsText)
            .map((arg, index) => {
                const placeholder = getCallParamPlaceholderName(arg, index, options);
                return `\${${index + 1}:${escapeSnippetPlaceholderText(placeholder)}}`;
            })
            .join(', ');
    }

    function isInsideStringLiteralOnLine(lineText, character, escapeChar = '') {
        const text = String(lineText || '');
        const end = Math.max(0, Math.min(text.length, Number.isInteger(character) ? character : 0));
        let inString = false;
        let stringChar = '';
        for (let index = 0; index < end; index++) {
            const char = text[index];
            if (inString) {
                if (char === stringChar && !isEscapedQuote(text, index, escapeChar)) {
                    inString = false;
                }
                continue;
            }
            if (char === '"' || char === "'") {
                inString = true;
                stringChar = char;
                continue;
            }
            if (char === '/' && text[index + 1] === '/') break;
        }
        return inString;
    }

    function hasExistingCallArgumentsAfterCompletion(document, position, replaceRange) {
        const line = Number.isInteger(position?.line) ? position.line : -1;
        if (line < 0) return false;
        const lineText = String(document?.lineAt?.(line)?.text || '');
        const endCharacter = Number.isInteger(replaceRange?.end?.character)
            ? replaceRange.end.character
            : (Number.isInteger(position?.character) ? position.character : 0);
        const nextIndex = findNextNonWhitespaceIndex(lineText, endCharacter);
        return nextIndex >= 0 && lineText[nextIndex] === '(';
    }

    function getFunctionCompletionInsertionContext(document, position, replaceRange, options = {}) {
        const line = Number.isInteger(position?.line) ? position.line : -1;
        const character = Number.isInteger(position?.character) ? position.character : 0;
        const lineText = line >= 0 ? String(document?.lineAt?.(line)?.text || '') : '';
        const escapeChar = options.escapeChar || '';
        const insideString = isInsideStringLiteralOnLine(lineText, character, escapeChar);
        const hasExistingCallArguments = hasExistingCallArgumentsAfterCompletion(document, position, replaceRange);
        return {
            insideString,
            hasExistingCallArguments,
            shouldInsertCallArguments: !insideString && !hasExistingCallArguments
        };
    }

    return {
        buildCallArgSnippetText,
        buildDeclarationArgSnippetText,
        getCallParamPlaceholderName,
        getFunctionCompletionInsertionContext,
        hasExistingCallArgumentsAfterCompletion,
        isInsideStringLiteralOnLine
    };
}

module.exports = { createCompletionInsertTextCore };
