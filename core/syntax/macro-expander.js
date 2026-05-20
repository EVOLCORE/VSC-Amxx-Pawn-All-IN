const {
    createPawnIdentifierReader,
    isPawnIdentifierName,
} = require('./identifiers');
const { findBalancedGroupEnd } = require('./balanced');

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

    const isIdentifierStart = char => isIdentifierStartChar(char || '');
    const isIdentifierContinue = char => isIdentifierContinueChar(char || '');
    const isQuoteEscaped = (source, index, escapeChar) => isEscapedQuote(source, index, escapeChar);
    const isWhitespace = char => /\s/.test(char || '');
    const readIdentifierAt = createPawnIdentifierReader({
        isIdentifierStartChar: isIdentifierStart,
        isIdentifierContinueChar: isIdentifierContinue
    });

    function findMatchingParenIndex(source, openIndex, escapeChar = '') {
        return findBalancedGroupEnd(source, openIndex, '(', ')', {
            escapeChar,
            isEscapedQuote: isQuoteEscaped
        });
    }

    function findMatchingBracketIndex(source, openIndex, escapeChar = '') {
        return findBalancedGroupEnd(source, openIndex, '[', ']', {
            escapeChar,
            isEscapedQuote: isQuoteEscaped,
            shieldGroups: [
                ['(', ')'],
                ['{', '}']
            ]
        });
    }

    function getBracketMacroIndexerSegmentCount(decl) {
        const source = String(decl?.macroIndexer || '').trim();
        if (!source) return 1;
        return Math.max(1, source.split('][').length);
    }

    function readBracketMacroCallArgs(source, openIndex, decl, escapeChar = '') {
        const text = String(source || '');
        let cursor = Math.max(0, openIndex | 0);
        const segmentCount = getBracketMacroIndexerSegmentCount(decl);
        const parts = [];
        for (let segment = 0; segment < segmentCount; segment++) {
            while (segment > 0 && cursor < text.length && isWhitespace(text[cursor])) cursor++;
            if (text[cursor] !== '[') return null;
            const closeIndex = findMatchingBracketIndex(text, cursor, escapeChar);
            if (closeIndex < 0) return null;
            parts.push(text.slice(cursor + 1, closeIndex));
            cursor = closeIndex + 1;
        }
        return {
            argsText: parts.join(']['),
            end: cursor
        };
    }

    function readParameterizedDefineCallArgs(source, openIndex, decl, escapeChar = '') {
        if (!decl || decl.type !== 'define') return null;
        if (decl.macroStyle === 'paren') {
            const closeIndex = findMatchingParenIndex(source, openIndex, escapeChar);
            return closeIndex >= 0
                ? { argsText: String(source || '').slice(openIndex + 1, closeIndex), end: closeIndex + 1 }
                : null;
        }
        if (decl.macroStyle === 'bracket') {
            return readBracketMacroCallArgs(source, openIndex, decl, escapeChar);
        }
        return null;
    }

    function splitMacroArguments(source, escapeChar = '') {
        return splitTopLevel(String(source || ''), escapeChar, true);
    }

    function getParameterizedDefineArgInfos(decl) {
        const argSource = decl?.macroStyle === 'bracket'
            ? decl.macroIndexer
            : decl?.args;
        if (!decl || !argSource) return [];
        const cached = macroArgInfoCache.get(decl);
        if (cached) return cached;

        const placeholderMatches = [...String(argSource || '').matchAll(/%\d+/g)];
        const infos = placeholderMatches.length
            ? placeholderMatches
                .map(match => match[0])
                .filter((name, index, names) => names.indexOf(name) === index)
                .map(name => ({
                    name,
                    identifier: false
                }))
            : splitMacroArguments(argSource, '')
                .map(part => String(part || '').trim())
                .filter(Boolean)
                .map(name => ({
                    name,
                    identifier: isPawnIdentifierName(name)
                }));
        macroArgInfoCache.set(decl, infos);
        return infos;
    }

    function escapeRegexLiteral(source = '') {
        let output = '';
        for (const char of String(source || '')) {
            if (/\s/.test(char)) {
                output += '\\s*';
            } else {
                output += `\\s*${char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`;
            }
        }
        return output;
    }

    function getStructuredMacroActualArgs(decl, argsText = '') {
        const argSource = decl?.macroStyle === 'bracket'
            ? decl.macroIndexer
            : decl?.args;
        const patternSource = String(argSource || '').trim();
        if (!patternSource || !/%\d+/.test(patternSource)) return null;
        if (/^%\d+(?:\s*,\s*%\d+)*$/.test(patternSource)) return null;

        const captures = [];
        let regexSource = '^\\s*';
        let cursor = 0;
        const matches = [...patternSource.matchAll(/%\d+/g)];
        for (let index = 0; index < matches.length; index++) {
            const match = matches[index];
            const literal = patternSource.slice(cursor, match.index);
            regexSource += escapeRegexLiteral(literal);
            captures.push(match[0]);
            regexSource += '([\\s\\S]*?)';
            cursor = match.index + match[0].length;
        }
        regexSource += escapeRegexLiteral(patternSource.slice(cursor)) + '\\s*$';

        let match = null;
        try {
            match = new RegExp(regexSource).exec(String(argsText || ''));
        } catch {
            return null;
        }
        if (!match) return null;

        const valuesByName = new Map();
        for (let index = 0; index < captures.length; index++) {
            const name = captures[index];
            if (!valuesByName.has(name)) {
                valuesByName.set(name, String(match[index + 1] || '').trim());
            }
        }
        return valuesByName;
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
            .filter(([name]) => name && !isPawnIdentifierName(name))
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
        const structuredActualArgs = getStructuredMacroActualArgs(decl, argsText);
        const splitActualArgs = structuredActualArgs ? null : splitMacroArguments(argsText, escapeChar);
        let expanded = String(decl.value || '');
        if (!argInfos.length) return expanded.trim();

        const replacements = new Map();
        for (let index = 0; index < argInfos.length; index++) {
            const argInfo = argInfos[index];
            if (!argInfo?.name) continue;
            const rawArg = String(structuredActualArgs?.get(argInfo.name) ?? splitActualArgs?.[index] ?? '').trim();
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
                const callArgs = readParameterizedDefineCallArgs(text, next, decl, escapeChar);
                if (!callArgs) {
                    index = identifier.end;
                    continue;
                }
                const nestedDisabled = new Set(disabledNames);
                nestedDisabled.add(identifier.name);
                replacement = expandParameterizedDefineCall(
                    decl,
                    callArgs.argsText,
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
                replacementEnd = callArgs.end;
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
        readParameterizedDefineCallArgs,
        splitMacroArguments,
        replaceMacroParameters: appendOutsideStringReplacements
    };
}

module.exports = { createMacroExpansionSyntaxCore };
