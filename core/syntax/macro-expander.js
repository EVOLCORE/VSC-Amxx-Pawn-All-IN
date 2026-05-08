function createMacroExpansionSyntaxCore(deps = {}) {
    const {
        isEscapedQuote,
        isIdentifierStartChar,
        isIdentifierContinueChar,
        splitTopLevel
    } = deps;

    const MAX_MACRO_EXPANSION_PASSES = 32;
    const MAX_MACRO_EXPANDED_LENGTH = 16384;
    const macroArgInfoCache = new WeakMap();
    const macroDeclLookupCache = new WeakMap();

    const isIdentifierStart = char => (
        typeof isIdentifierStartChar === 'function'
            ? isIdentifierStartChar(char || '')
            : /[A-Za-z_@]/.test(char || '')
    );
    const isIdentifierContinue = char => (
        typeof isIdentifierContinueChar === 'function'
            ? isIdentifierContinueChar(char || '')
            : /[A-Za-z0-9_@]/.test(char || '')
    );
    const isQuoteEscaped = (source, index, escapeChar) => (
        typeof isEscapedQuote === 'function'
            ? isEscapedQuote(source, index, escapeChar)
            : false
    );
    const isWhitespace = char => /\s/.test(char || '');
    const isIdentifierName = value => /^[A-Za-z_@][A-Za-z0-9_@]*$/.test(String(value || ''));

    function readIdentifierAt(source, index) {
        const text = String(source || '');
        if (!isIdentifierStart(text[index])) return null;
        let end = index + 1;
        while (end < text.length && isIdentifierContinue(text[end])) end++;
        return {
            name: text.slice(index, end),
            start: index,
            end
        };
    }

    function findMatchingParenIndex(source, openIndex, escapeChar = '') {
        const text = String(source || '');
        if (text[openIndex] !== '(') return -1;
        let depth = 0;
        let inString = false;
        let stringChar = '';
        for (let index = openIndex; index < text.length; index++) {
            const char = text[index];
            if (inString) {
                if (char === stringChar && !isQuoteEscaped(text, index, escapeChar)) {
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

    function findMatchingBracketIndex(source, openIndex, escapeChar = '') {
        const text = String(source || '');
        if (text[openIndex] !== '[') return -1;
        let depth = 0;
        let parenDepth = 0;
        let braceDepth = 0;
        let inString = false;
        let stringChar = '';
        for (let index = openIndex; index < text.length; index++) {
            const char = text[index];
            if (inString) {
                if (char === stringChar && !isQuoteEscaped(text, index, escapeChar)) {
                    inString = false;
                }
                continue;
            }
            if (char === '"' || char === "'") {
                inString = true;
                stringChar = char;
                continue;
            }
            if (char === '[') {
                depth++;
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
            if (char === '{') {
                braceDepth++;
                continue;
            }
            if (char === '}') {
                braceDepth = Math.max(0, braceDepth - 1);
                continue;
            }
            if (char === ']') {
                if (parenDepth || braceDepth) continue;
                depth--;
                if (depth === 0) return index;
            }
        }
        return -1;
    }

    function splitMacroArguments(source, escapeChar = '') {
        if (typeof splitTopLevel === 'function') {
            return splitTopLevel(String(source || ''), escapeChar, true);
        }

        const text = String(source || '');
        if (!text.trim()) return [];
        const parts = [];
        let depth = 0;
        let inString = false;
        let stringChar = '';
        let start = 0;
        for (let index = 0; index < text.length; index++) {
            const char = text[index];
            if (inString) {
                if (char === stringChar && !isQuoteEscaped(text, index, escapeChar)) inString = false;
                continue;
            }
            if (char === '"' || char === "'") {
                inString = true;
                stringChar = char;
                continue;
            }
            if (char === '(' || char === '[' || char === '{') depth++;
            else if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1);
            else if (char === ',' && depth === 0) {
                parts.push(text.slice(start, index).trim());
                start = index + 1;
            }
        }
        parts.push(text.slice(start).trim());
        return parts;
    }

    function getParameterizedDefineArgInfos(decl) {
        const argSource = decl?.macroStyle === 'bracket'
            ? decl.macroIndexer
            : decl?.args;
        if (!decl || !argSource) return [];
        const cached = macroArgInfoCache.get(decl);
        if (cached) return cached;

        const infos = splitMacroArguments(argSource, '')
            .map(part => String(part || '').trim())
            .filter(Boolean)
            .map(name => ({
                name,
                identifier: isIdentifierName(name)
            }));
        macroArgInfoCache.set(decl, infos);
        return infos;
    }

    function getDefineLookup(defineDecls = []) {
        if (!Array.isArray(defineDecls) || !defineDecls.length) return null;
        let lookup = macroDeclLookupCache.get(defineDecls);
        if (lookup) return lookup;
        lookup = new Map();
        for (const decl of defineDecls) {
            if (!decl?.name || decl.type !== 'define') continue;
            lookup.set(decl.name, decl);
        }
        macroDeclLookupCache.set(defineDecls, lookup);
        return lookup;
    }

    function getDefineByName(name, defineDecls = [], options = {}) {
        if (!name) return null;
        if (typeof options.getDefine === 'function') {
            const decl = options.getDefine(name);
            return decl?.type === 'define' ? decl : null;
        }
        if (options.defineLookup instanceof Map) {
            const decl = options.defineLookup.get(name) || null;
            return decl?.type === 'define' ? decl : null;
        }
        const lookup = getDefineLookup(defineDecls);
        return lookup?.get(name) || null;
    }

    function appendOutsideStringReplacements(source, replacements, escapeChar = '') {
        const text = String(source || '');
        if (!replacements?.size || !text) return text;
        const literalReplacements = [...replacements]
            .filter(([name]) => name && !isIdentifierName(name))
            .sort((left, right) => String(right[0]).length - String(left[0]).length);
        let output = '';
        let cursor = 0;
        let inString = false;
        let stringChar = '';

        for (let index = 0; index < text.length;) {
            const char = text[index];
            if (inString) {
                if (char === stringChar && !isQuoteEscaped(text, index, escapeChar)) inString = false;
                index++;
                continue;
            }
            if (char === '"' || char === "'") {
                inString = true;
                stringChar = char;
                index++;
                continue;
            }

            const identifier = readIdentifierAt(text, index);
            if (identifier) {
                if (replacements.has(identifier.name)) {
                    output += text.slice(cursor, identifier.start) + replacements.get(identifier.name);
                    cursor = identifier.end;
                }
                index = identifier.end;
                continue;
            }

            let matchedLiteral = null;
            for (const [name, replacement] of literalReplacements) {
                if (!text.startsWith(name, index)) continue;
                const end = index + name.length;
                const previous = text[index - 1] || '';
                const next = text[end] || '';
                if (isIdentifierContinue(name[0]) && isIdentifierContinue(previous)) continue;
                if (isIdentifierContinue(name[name.length - 1]) && isIdentifierContinue(next)) continue;
                matchedLiteral = { name, replacement, end };
                break;
            }
            if (matchedLiteral) {
                output += text.slice(cursor, index) + matchedLiteral.replacement;
                cursor = matchedLiteral.end;
                index = matchedLiteral.end;
                continue;
            }
            index++;
        }

        return cursor > 0 ? output + text.slice(cursor) : text;
    }

    function expandParameterizedDefineCall(decl, argsText = '', options = {}) {
        if (!decl || decl.type !== 'define' || (decl.macroStyle !== 'paren' && decl.macroStyle !== 'bracket')) {
            return String(decl?.value || '').trim();
        }
        const escapeChar = options.escapeChar || '';
        const argInfos = getParameterizedDefineArgInfos(decl);
        const actualArgs = splitMacroArguments(argsText, escapeChar);
        let expanded = String(decl.value || '');
        if (!argInfos.length) return expanded.trim();

        const replacements = new Map();
        for (let index = 0; index < argInfos.length; index++) {
            const argInfo = argInfos[index];
            if (!argInfo?.name) continue;
            const rawArg = String(actualArgs[index] || '').trim();
            const expandedArg = options.expandActualArgs === false
                ? rawArg
                : expandMacros(rawArg, options.defineDecls || [], {
                    ...options,
                    disabledNames: options.disabledNames || new Set()
                }).text;
            replacements.set(argInfo.name, expandedArg);
        }

        expanded = appendOutsideStringReplacements(expanded, replacements, escapeChar);
        return expanded.trim();
    }

    const getFunctionLikeDefineArgInfos = getParameterizedDefineArgInfos;

    function expandFunctionLikeDefineCall(decl, argsText = '', options = {}) {
        return expandParameterizedDefineCall(decl, argsText, options);
    }

    function expandMacrosOnce(source, defineDecls = [], options = {}) {
        const text = String(source || '');
        if (!text || text.length > (options.maxInputLength || MAX_MACRO_EXPANDED_LENGTH)) {
            return { text, changed: false };
        }
        const escapeChar = options.escapeChar || '';
        const disabledNames = options.disabledNames instanceof Set
            ? options.disabledNames
            : new Set();
        let output = '';
        let changed = false;
        let cursor = 0;
        let inString = false;
        let stringChar = '';

        for (let index = 0; index < text.length;) {
            const char = text[index];
            if (inString) {
                if (char === stringChar && !isQuoteEscaped(text, index, escapeChar)) inString = false;
                index++;
                continue;
            }
            if (char === '"' || char === "'") {
                inString = true;
                stringChar = char;
                index++;
                continue;
            }

            const identifier = readIdentifierAt(text, index);
            if (!identifier) {
                index++;
                continue;
            }

            const decl = disabledNames.has(identifier.name)
                ? null
                : getDefineByName(identifier.name, defineDecls, options);
            if (!decl || decl.type !== 'define') {
                index = identifier.end;
                continue;
            }

            let next = identifier.end;
            while (next < text.length && isWhitespace(text[next])) next++;
            const callOpen = decl.macroStyle === 'paren'
                ? '('
                : (decl.macroStyle === 'bracket' ? '[' : '');
            const callClose = callOpen === '(' ? ')' : (callOpen === '[' ? ']' : '');
            const isParameterizedCall = callOpen && text[next] === callOpen;
            if (callOpen && !isParameterizedCall) {
                index = identifier.end;
                continue;
            }

            let replacement = '';
            let replacementEnd = identifier.end;
            if (isParameterizedCall) {
                const closeIndex = callOpen === '('
                    ? findMatchingParenIndex(text, next, escapeChar)
                    : findMatchingBracketIndex(text, next, escapeChar);
                if (closeIndex < 0) {
                    index = identifier.end;
                    continue;
                }
                const nestedDisabled = new Set(disabledNames);
                nestedDisabled.add(identifier.name);
                replacement = expandParameterizedDefineCall(
                    decl,
                    text.slice(next + 1, closeIndex),
                    {
                        ...options,
                        defineDecls,
                        disabledNames: nestedDisabled
                    }
                );
                replacement = expandMacros(replacement, defineDecls, {
                    ...options,
                    disabledNames: nestedDisabled
                }).text;
                replacementEnd = closeIndex + 1;
            } else {
                replacement = String(decl.value || '').trim();
                if (!replacement || replacement === identifier.name) {
                    index = identifier.end;
                    continue;
                }
            }

            output += text.slice(cursor, identifier.start) + replacement;
            cursor = replacementEnd;
            index = replacementEnd;
            changed = true;
            if (output.length > (options.maxOutputLength || MAX_MACRO_EXPANDED_LENGTH)) {
                return { text, changed: false, overflow: true };
            }
        }

        return changed
            ? { text: output + text.slice(cursor), changed: true }
            : { text, changed: false };
    }

    function expandMacros(source, defineDecls = [], options = {}) {
        let text = String(source || '');
        const maxPasses = Math.max(1, options.maxPasses || MAX_MACRO_EXPANSION_PASSES);
        for (let pass = 0; pass < maxPasses; pass++) {
            const result = expandMacrosOnce(text, defineDecls, options);
            if (!result.changed) {
                return {
                    text: result.text,
                    changed: result.text !== String(source || ''),
                    complete: !result.overflow,
                    passes: pass
                };
            }
            text = result.text;
            if (text.length > (options.maxOutputLength || MAX_MACRO_EXPANDED_LENGTH)) {
                return {
                    text: String(source || ''),
                    changed: false,
                    complete: false,
                    passes: pass + 1
                };
            }
        }
        return {
            text,
            changed: text !== String(source || ''),
            complete: false,
            passes: maxPasses
        };
    }

    return {
        getFunctionLikeDefineArgInfos,
        expandFunctionLikeDefineCall,
        expandMacros,
        findMatchingParenIndex,
        findMatchingBracketIndex,
        splitMacroArguments,
        replaceMacroParameters: appendOutsideStringReplacements
    };
}

module.exports = { createMacroExpansionSyntaxCore };
