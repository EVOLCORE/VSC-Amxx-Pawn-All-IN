function defaultIsEscapedQuote(source, index) {
    return String(source || '')[index - 1] === '\\';
}

const EXISTING_CALL_ARGUMENT_LOOKAHEAD_LINES = 8;
const COMPLETION_CALL_ARGUMENT_MODE_ALL = 'all';
const COMPLETION_CALL_ARGUMENT_MODE_REQUIRED_BEFORE_DEFAULT = 'required-before-default';

function normalizeCompletionCallArgumentMode(value) {
    const text = String(value || '').trim().toLowerCase();
    if (text === COMPLETION_CALL_ARGUMENT_MODE_ALL) return COMPLETION_CALL_ARGUMENT_MODE_ALL;
    return COMPLETION_CALL_ARGUMENT_MODE_REQUIRED_BEFORE_DEFAULT;
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

    function getCallSnippetArgs(argsText, options = {}) {
        const args = splitArgs(argsText);
        if (normalizeCompletionCallArgumentMode(options.callArgumentMode) === COMPLETION_CALL_ARGUMENT_MODE_ALL) {
            return args;
        }

        const result = [];
        for (const arg of args) {
            const parsed = typeof parseParamMeta === 'function'
                ? parseParamMeta(arg)
                : null;
            if (parsed?.hasDefault) break;
            result.push(arg);
        }
        return result;
    }

    function buildCallArgSnippetText(argsText, options = {}) {
        return getCallSnippetArgs(argsText, options)
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

    function getDocumentLineText(document, lineNumber) {
        try {
            return String(document?.lineAt?.(lineNumber)?.text || '');
        } catch {
            return '';
        }
    }

    function findExistingCallArgumentBlockAfterCompletion(document, position, replaceRange) {
        const line = Number.isInteger(position?.line) ? position.line : -1;
        if (line < 0) return null;
        const endCharacter = Number.isInteger(replaceRange?.end?.character)
            ? replaceRange.end.character
            : (Number.isInteger(position?.character) ? position.character : 0);
        const lineCount = Number.isInteger(document?.lineCount)
            ? document.lineCount
            : line + 1;
        const lastLine = Math.min(
            Math.max(line, lineCount - 1),
            line + EXISTING_CALL_ARGUMENT_LOOKAHEAD_LINES
        );
        let inBlockComment = false;
        let open = null;

        for (let lineNumber = line; lineNumber <= lastLine; lineNumber++) {
            const lineText = getDocumentLineText(document, lineNumber);
            let index = lineNumber === line
                ? Math.max(0, Math.min(lineText.length, endCharacter))
                : 0;

            while (index < lineText.length) {
                if (inBlockComment) {
                    const blockEnd = lineText.indexOf('*/', index);
                    if (blockEnd < 0) {
                        index = lineText.length;
                        continue;
                    }
                    inBlockComment = false;
                    index = blockEnd + 2;
                    continue;
                }

                const char = lineText[index] || '';
                const next = lineText[index + 1] || '';
                if (/\s/.test(char)) {
                    index++;
                    continue;
                }
                if (char === '/' && next === '*') {
                    inBlockComment = true;
                    index += 2;
                    continue;
                }
                if (char === '/' && next === '/') {
                    break;
                }
                if (char !== '(') return null;
                open = { line: lineNumber, character: index };
                break;
            }
            if (open) break;
        }

        if (!open) return null;

        let depth = 0;
        let inString = false;
        let stringChar = '';
        inBlockComment = false;
        for (let lineNumber = open.line; lineNumber <= lastLine; lineNumber++) {
            const lineText = getDocumentLineText(document, lineNumber);
            let index = lineNumber === open.line ? open.character : 0;
            while (index < lineText.length) {
                if (inBlockComment) {
                    const blockEnd = lineText.indexOf('*/', index);
                    if (blockEnd < 0) {
                        index = lineText.length;
                        continue;
                    }
                    inBlockComment = false;
                    index = blockEnd + 2;
                    continue;
                }

                const char = lineText[index] || '';
                const next = lineText[index + 1] || '';
                if (inString) {
                    if (char === stringChar && !isEscapedQuote(lineText, index)) {
                        inString = false;
                    }
                    index++;
                    continue;
                }
                if (char === '/' && next === '*') {
                    inBlockComment = true;
                    index += 2;
                    continue;
                }
                if (char === '/' && next === '/') break;
                if (char === '"' || char === "'") {
                    inString = true;
                    stringChar = char;
                    index++;
                    continue;
                }
                if (char === '(') {
                    depth++;
                } else if (char === ')') {
                    depth--;
                    if (depth <= 0) {
                        return {
                            open,
                            close: { line: lineNumber, character: index }
                        };
                    }
                }
                index++;
            }
        }

        return { open, close: null };
    }

    function hasExistingCallArgumentsAfterCompletion(document, position, replaceRange) {
        return !!findExistingCallArgumentBlockAfterCompletion(document, position, replaceRange);
    }

    function getFunctionCompletionInsertionContext(document, position, replaceRange, options = {}) {
        const line = Number.isInteger(position?.line) ? position.line : -1;
        const character = Number.isInteger(position?.character) ? position.character : 0;
        const lineText = line >= 0 ? String(document?.lineAt?.(line)?.text || '') : '';
        const escapeChar = options.escapeChar || '';
        const insideString = isInsideStringLiteralOnLine(lineText, character, escapeChar);
        const existingArgumentBlock = findExistingCallArgumentBlockAfterCompletion(document, position, replaceRange);
        const hasExistingCallArguments = !!existingArgumentBlock;
        return {
            insideString,
            existingArgumentBlock,
            hasExistingCallArguments,
            shouldInsertCallArguments: !insideString && !hasExistingCallArguments
        };
    }

    return {
        buildCallArgSnippetText,
        buildDeclarationArgSnippetText,
        getCallSnippetArgs,
        getCallParamPlaceholderName,
        getFunctionCompletionInsertionContext,
        findExistingCallArgumentBlockAfterCompletion,
        hasExistingCallArgumentsAfterCompletion,
        isInsideStringLiteralOnLine
    };
}

module.exports = {
    COMPLETION_CALL_ARGUMENT_MODE_ALL,
    COMPLETION_CALL_ARGUMENT_MODE_REQUIRED_BEFORE_DEFAULT,
    createCompletionInsertTextCore,
    normalizeCompletionCallArgumentMode
};
