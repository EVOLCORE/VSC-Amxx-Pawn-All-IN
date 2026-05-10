const { createMacroExpansionSyntaxCore } = require('../syntax/macro-expander');

function createSymbolUsageDiagnostics(deps = {}) {
    const {
        getSymbolNeverUsedIssue,
        getSymbolAssignedValueNeverUsedIssue,
        isEscapedQuote,
        splitTopLevel
    } = deps;
    const macroExpansionCore = createMacroExpansionSyntaxCore({
        isEscapedQuote,
        isIdentifierStartChar,
        isIdentifierContinueChar,
        splitTopLevel
    });

    function isIdentifierStartChar(char) {
        if (!char) return false;
        const code = char.charCodeAt(0);
        return isIdentifierStartCode(code);
    }

    function isIdentifierStartCode(code) {
        return (
            (code >= 65 && code <= 90) ||
            (code >= 97 && code <= 122) ||
            code === 95 ||
            code === 64
        );
    }

    function isIdentifierContinueChar(char) {
        if (!char) return false;
        const code = char.charCodeAt(0);
        return isIdentifierContinueCode(code);
    }

    function isIdentifierContinueCode(code) {
        return (
            (code >= 65 && code <= 90) ||
            (code >= 97 && code <= 122) ||
            (code >= 48 && code <= 57) ||
            code === 95 ||
            code === 64
        );
    }

    function isWhitespaceChar(char) {
        if (!char) return false;
        const code = char.charCodeAt(0);
        return code === 32 || code === 9 || code === 10 || code === 13 || code === 11 || code === 12;
    }
    const normalizePath = value => String(value || '').replace(/\\/g, '/').toLowerCase();

    function findNextNonWhitespaceIndex(source, index) {
        for (let cursor = Math.max(0, index); cursor < source.length; cursor++) {
            if (!isWhitespaceChar(source[cursor])) return cursor;
        }
        return -1;
    }

    function findPreviousNonWhitespaceIndex(source, index) {
        for (let cursor = Math.min(source.length - 1, index); cursor >= 0; cursor--) {
            if (!isWhitespaceChar(source[cursor])) return cursor;
        }
        return -1;
    }

    function findMatchingBracket(source, openIndex) {
        if (source[openIndex] !== '[') return -1;
        let depth = 0;
        let inString = false;
        let stringChar = '';
        for (let index = openIndex; index < source.length; index++) {
            const char = source[index];
            if (inString) {
                if (char === stringChar) inString = false;
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
            if (char === ']') {
                depth--;
                if (depth === 0) return index;
            }
        }
        return -1;
    }

    function skipIndexedAccesses(source, index) {
        let cursor = findNextNonWhitespaceIndex(source, index);
        while (cursor >= 0 && source[cursor] === '[') {
            const closeIndex = findMatchingBracket(source, cursor);
            if (closeIndex < 0) return cursor;
            cursor = findNextNonWhitespaceIndex(source, closeIndex + 1);
        }
        return cursor;
    }

    function getAssignmentOperatorAt(source, index) {
        const char = source[index] || '';
        const next = source[index + 1] || '';
        const previous = source[index - 1] || '';
        if (char === '=' && previous !== '=' && previous !== '!' && previous !== '<' && previous !== '>' && next !== '=') {
            return '=';
        }
        if ((char === '+' || char === '-' || char === '*' || char === '/' || char === '%' || char === '&' || char === '|' || char === '^') && next === '=') {
            return `${char}=`;
        }
        if ((char === '<' || char === '>') && next === source[index] && source[index + 2] === '=') {
            return `${char}${next}=`;
        }
        return '';
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
        const sortedEntries = [...entries].sort((left, right) =>
            (left.decl.lineNumber ?? 0) - (right.decl.lineNumber ?? 0)
        );
        const entriesByLine = new Map();
        for (const entry of sortedEntries) {
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

    function collectPragmaUnusedNames(lines) {
        const names = new Set();
        for (const line of lines || []) {
            const match = String(line || '').trim().match(/^#\s*pragma\s+unused\b([\s\S]*)$/i);
            if (!match) continue;
            for (const piece of match[1].split(',')) {
                const name = piece.trim().match(/^([A-Za-z_@][A-Za-z0-9_@]*)/)?.[1] || '';
                if (name) names.add(name);
            }
        }
        return names;
    }

    function collectSyntheticLocalDeclarationNames(source) {
        const names = new Set();
        const text = String(source || '');
        let inString = false;
        let stringCharCode = 0;
        let inBlockComment = false;
        let lineComment = false;
        const readIdentifier = start => {
            if (!isIdentifierStartCode(text.charCodeAt(start))) return null;
            let end = start + 1;
            while (end < text.length && isIdentifierContinueCode(text.charCodeAt(end))) end++;
            return { text: text.slice(start, end), start, end };
        };
        const nextNonWhitespace = start => {
            for (let index = start; index < text.length; index++) {
                if (!isWhitespaceChar(text[index])) return index;
            }
            return -1;
        };
        const skipBalanced = (start, openChar, closeChar) => {
            let depth = 0;
            let nestedString = false;
            let nestedStringChar = '';
            for (let index = start; index < text.length; index++) {
                const char = text[index];
                if (nestedString) {
                    if (char === nestedStringChar) nestedString = false;
                    continue;
                }
                if (char === '"' || char === "'") {
                    nestedString = true;
                    nestedStringChar = char;
                    continue;
                }
                if (char === openChar) {
                    depth++;
                    continue;
                }
                if (char === closeChar) {
                    depth--;
                    if (depth === 0) return index + 1;
                }
            }
            return text.length;
        };
        const skipInitializer = start => {
            let parenDepth = 0;
            let bracketDepth = 0;
            let braceDepth = 0;
            let nestedString = false;
            let nestedStringChar = '';
            for (let index = start; index < text.length; index++) {
                const char = text[index];
                if (nestedString) {
                    if (char === nestedStringChar) nestedString = false;
                    continue;
                }
                if (char === '"' || char === "'") {
                    nestedString = true;
                    nestedStringChar = char;
                    continue;
                }
                if (char === '(') parenDepth++;
                else if (char === ')' && parenDepth > 0) parenDepth--;
                else if (char === '[') bracketDepth++;
                else if (char === ']' && bracketDepth > 0) bracketDepth--;
                else if (char === '{') braceDepth++;
                else if (char === '}' && braceDepth > 0) braceDepth--;
                if (parenDepth || bracketDepth || braceDepth) continue;
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
                names.add(nameIdent.text);
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
        return names;
    }

    function collectFunctionLikeDefineDecls(rootCtx) {
        const defineDecls = rootCtx?.preprocessedState?.defineDecls || [];
        if (!Array.isArray(defineDecls) || !defineDecls.length) return [];
        return defineDecls.filter(decl =>
            decl?.type === 'define' &&
            decl.macroStyle === 'paren' &&
            decl.name
        );
    }

    function getFunctionLikeDefineDeclMap(rootCtx) {
        const map = new Map();
        for (const decl of collectFunctionLikeDefineDecls(rootCtx)) {
            map.set(decl.name, decl);
        }
        return map;
    }

    function collectSymbolUsageIssues(rootCtx, options = {}) {
        const parsedDecls = rootCtx?.parsedDecls || {};
        const rawLines = rootCtx?.rawLines || String(rootCtx?.text || '').split(/\r?\n/);
        const preprocessedLines = String(rootCtx?.preprocessedState?.content || '').split(/\r?\n/);
        const scanLines = preprocessedLines.length === rawLines.length
            ? preprocessedLines
            : rawLines;
        const documentPath = normalizePath(rootCtx?.fp || '');
        const functionRanges = options.functionRangeMaps || {};
        const functionBodyRangeByLine = functionRanges.byLine || [];
        const functionBodyRangeByFunction = functionRanges.byFunction || new Map();
        const defineDecls = Array.isArray(rootCtx?.preprocessedState?.defineDecls)
            ? rootCtx.preprocessedState.defineDecls
            : [];
        const functionLikeDefinesByName = getFunctionLikeDefineDeclMap(rootCtx);
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

        const functionByHeaderLine = new Map();
        for (const func of parsedDecls.functions || []) {
            const startLine = func.startLine ?? func.lineNumber ?? -1;
            const endLine = func.headerEndLine ?? startLine;
            for (let line = startLine; line <= endLine; line++) {
                if (line >= 0) functionByHeaderLine.set(line, func);
            }
        }

        const addGlobalVariableDecls = decls => {
            for (const decl of decls || []) {
                if (decl?.type !== 'variable') continue;
                if (!isCurrentDocumentDecl(decl, documentPath)) continue;
                const modifiers = new Set(decl.modifiers || []);
                const isPublicVariable = modifiers.has('public');
                addEntry(createEntry(decl, 'variable', {
                    read: isPublicVariable,
                    written: isPublicVariable,
                    public: isPublicVariable,
                    stock: modifiers.has('stock'),
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
                const modifiers = new Set(decl.modifiers || []);
                const functionDecl = decl.isArg
                    ? functionByHeaderLine.get(decl.lineNumber ?? -1) || null
                    : (functionBodyRangeByLine[decl.lineNumber ?? -1]?.func || null);
                if (!functionDecl) {
                    continue;
                }
                const functionType = String(functionDecl?.type || '');
                const functionModifiers = new Set(functionDecl?.modifiers || []);
                if (decl.isArg && (
                    functionType === 'native' ||
                    functionType === 'forward' ||
                    functionModifiers.has('native') ||
                    functionModifiers.has('forward')
                )) {
                    continue;
                }
                const functionRange = functionDecl ? functionBodyRangeByFunction.get(functionDecl) : null;
                const isStockFunction = !!(
                    functionType === 'stock' ||
                    functionModifiers.has('stock')
                );
                const isPublicArg = !!(decl.isArg && functionDecl && (
                    functionDecl.type === 'public' ||
                    (functionDecl.modifiers || []).includes('public') ||
                    functionDecl.name === 'main' ||
                    functionDecl.name === 'entry'
                ));
                const isReferenceArg = !!(decl.isArg && (modifiers.has('&') || String(decl.dims || '').trim()));
                const isPublicVariable = modifiers.has('public');
                addEntry(createEntry(decl, 'variable', {
                    read: isPublicArg || isReferenceArg || isPublicVariable,
                    written: !!String(decl.value || '').trim() || isPublicVariable,
                    public: isPublicVariable,
                    stock: modifiers.has('stock') || isStockFunction,
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

        const resolveVariableEntry = (name, lineNumber) => {
            const candidates = variableEntriesByName.get(name) || [];
            let best = null;
            for (const entry of candidates) {
                if (lineNumber < entry.scopeStartLine || lineNumber > entry.scopeEndLine) continue;
                if (
                    entry.functionDecl &&
                    functionBodyRangeByLine[lineNumber]?.func !== entry.functionDecl &&
                    !entry.decl.isArg
                ) {
                    continue;
                }
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

        const markVariableOccurrence = (name, lineNumber, source, start, end, options = {}) => {
            if (options.syntheticLocalNames?.has?.(name)) {
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
            const occurrence = classifyVariableOccurrence(source, start, end);
            if (occurrence.skip) return false;
            if (occurrence.read) variableEntry.read = true;
            if (occurrence.written) variableEntry.written = true;
            return true;
        };

        const scanVariableUsageSource = (source, lineNumber, options = {}) => {
            const text = String(source || '');
            if (!text) return;
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

        const applyFunctionLikeDefineUsage = (decl, line, lineNumber, start, openIndex, closeIndex) => {
            if (!decl || !line || openIndex < 0) return;
            const escapeChar = rootCtx?.lineCtrlChars?.[lineNumber] || '';
            let expansionSource = '';
            if (closeIndex >= 0) {
                const invocation = line.slice(start, closeIndex + 1);
                const expanded = macroExpansionCore.expandMacros(invocation, defineDecls, {
                    escapeChar,
                    maxOutputLength: 8192
                });
                if (expanded.complete && expanded.changed) {
                    expansionSource = expanded.text;
                } else {
                    expansionSource = macroExpansionCore.expandFunctionLikeDefineCall(
                        decl,
                        line.slice(openIndex + 1, closeIndex),
                        {
                            escapeChar,
                            defineDecls,
                            expandActualArgs: false
                        }
                    );
                }
            } else {
                expansionSource = String(decl.value || '');
            }
            scanVariableUsageSource(expansionSource, lineNumber, {
                synthetic: true,
                syntheticLocalNames: collectSyntheticLocalDeclarationNames(expansionSource)
            });
        };

        let inBlockComment = false;
        let activeUsageScopeLineCount = 0;
        for (let lineNumber = 0; lineNumber < scanLines.length; lineNumber++) {
            if (usageScopeLineDiff) activeUsageScopeLineCount += usageScopeLineDiff[lineNumber];
            if (activeUsageScopeLineCount <= 0) continue;
            const line = String(scanLines[lineNumber] || '');
            const rawLine = String(rawLines[lineNumber] || '');
            const syntheticLocalNames = line !== rawLine
                ? collectSyntheticLocalDeclarationNames(line)
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

                const start = index;
                let end = index + 1;
                while (end < line.length && isIdentifierContinueCode(line.charCodeAt(end))) end++;
                const name = line.slice(start, end);
                index = end - 1;
                if (syntheticLocalNames?.has(name)) continue;
                const nextNonWhitespace = findNextNonWhitespaceIndex(line, end);
                if (nextNonWhitespace >= 0 && line[nextNonWhitespace] === '(') {
                    const defineDecl = functionLikeDefinesByName.get(name);
                    if (defineDecl) {
                        applyFunctionLikeDefineUsage(
                            defineDecl,
                            line,
                            lineNumber,
                            start,
                            nextNonWhitespace,
                            macroExpansionCore.findMatchingParenIndex(
                                line,
                                nextNonWhitespace,
                                rootCtx?.lineCtrlChars?.[lineNumber] || ''
                            )
                        );
                    }
                    continue;
                }
                if (code >= variableNameFirstCharCodes.length || !variableNameFirstCharCodes[code]) continue;
                markVariableOccurrence(name, lineNumber, line, start, end);
            }
        }

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
