// Enum-initializer hover parsing is specific to hover UX: it discovers which
// enum member inside a structured initializer the cursor currently points at.
function createHoverEnumInitializerFeature(deps) {
    const {
        vscode,
        getActiveCtrlChar,
        isEscapedQuote,
        getDocumentTextAndResolver,
        parseDimsParts,
        extractEnumSymbolName
    } = deps;

    function findMatchingBraceOffset(text, openOffset, ctrlCharResolver = null) {
        let depth = 0, inStr = false, strChar = '', lineComment = false, blockComment = false;
        for (let i = openOffset; i < text.length; i++) {
            const c = text[i];
            const n = text[i + 1] || '';
            const escapeChar = ctrlCharResolver?.ctrlCharAtOffset(i) || getActiveCtrlChar();

            if (blockComment) {
                if (c === '*' && n === '/') { blockComment = false; i++; }
                continue;
            }
            if (lineComment) {
                if (c === '\n') lineComment = false;
                continue;
            }
            if (inStr) {
                if (c === strChar && !isEscapedQuote(text, i, escapeChar)) inStr = false;
                continue;
            }

            if (c === '/' && n === '/') { lineComment = true; i++; continue; }
            if (c === '/' && n === '*') { blockComment = true; i++; continue; }
            if (c === '"' || c === "'") { inStr = true; strChar = c; continue; }
            if (c === '{') depth++;
            else if (c === '}') {
                depth--;
                if (depth === 0) return i;
            }
        }
        return -1;
    }

    function findInitializerOpenOffset(text, startOffset, ctrlCharResolver = null) {
        let seenAssign = false;
        let depthParen = 0, depthBracket = 0;
        let inStr = false, strChar = '', lineComment = false, blockComment = false;

        for (let i = startOffset; i < text.length; i++) {
            const c = text[i];
            const n = text[i + 1] || '';
            const escapeChar = ctrlCharResolver?.ctrlCharAtOffset(i) || getActiveCtrlChar();

            if (blockComment) {
                if (c === '*' && n === '/') { blockComment = false; i++; }
                continue;
            }
            if (lineComment) {
                if (c === '\n') lineComment = false;
                continue;
            }
            if (inStr) {
                if (c === strChar && !isEscapedQuote(text, i, escapeChar)) inStr = false;
                continue;
            }

            if (c === '/' && n === '/') { lineComment = true; i++; continue; }
            if (c === '/' && n === '*') { blockComment = true; i++; continue; }
            if (c === '"' || c === "'") { inStr = true; strChar = c; continue; }
            if (c === '(') depthParen++;
            else if (c === ')') depthParen = Math.max(0, depthParen - 1);
            else if (c === '[') depthBracket++;
            else if (c === ']') depthBracket = Math.max(0, depthBracket - 1);
            else if (depthParen === 0 && depthBracket === 0) {
                if (c === '=' && !seenAssign) {
                    seenAssign = true;
                    continue;
                }
                if (seenAssign && c === '{') return i;
                if (seenAssign && c === ';') return -1;
            }
        }

        return -1;
    }

    function extractTopLevelFields(text, openOffset, closeOffset, ctrlCharResolver = null) {
        const fields = [];
        let depthParen = 0, depthBracket = 0, depthBrace = 0;
        let inStr = false, strChar = '', lineComment = false, blockComment = false;
        let fieldStart = openOffset + 1;

        for (let i = openOffset + 1; i < closeOffset; i++) {
            const c = text[i];
            const n = text[i + 1] || '';
            const escapeChar = ctrlCharResolver?.ctrlCharAtOffset(i) || getActiveCtrlChar();

            if (blockComment) {
                if (c === '*' && n === '/') { blockComment = false; i++; }
                continue;
            }
            if (lineComment) {
                if (c === '\n') lineComment = false;
                continue;
            }
            if (inStr) {
                if (c === strChar && !isEscapedQuote(text, i, escapeChar)) inStr = false;
                continue;
            }

            if (c === '/' && n === '/') { lineComment = true; i++; continue; }
            if (c === '/' && n === '*') { blockComment = true; i++; continue; }
            if (c === '"' || c === "'") { inStr = true; strChar = c; continue; }
            if (c === '(') depthParen++;
            else if (c === ')') depthParen = Math.max(0, depthParen - 1);
            else if (c === '[') depthBracket++;
            else if (c === ']') depthBracket = Math.max(0, depthBracket - 1);
            else if (c === '{') depthBrace++;
            else if (c === '}') depthBrace = Math.max(0, depthBrace - 1);
            else if (c === ',' && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
                fields.push({ start: fieldStart, end: i, text: text.slice(fieldStart, i).trim() });
                fieldStart = i + 1;
            }
        }

        fields.push({ start: fieldStart, end: closeOffset, text: text.slice(fieldStart, closeOffset).trim() });
        return fields;
    }

    function findEnumInitializerMemberContext(document, position, decls) {
        const { text, resolver } = getDocumentTextAndResolver(document);
        const cursorOffset = document.offsetAt(position);
        const sourceDecls = Array.isArray(decls) ? decls : [];
        const enumDeclsByName = new Map();
        const enumItemsByKey = new Map();
        for (const decl of sourceDecls) {
            if (decl?.type === 'enum' && decl.name && !enumDeclsByName.has(decl.name)) {
                enumDeclsByName.set(decl.name, decl);
            } else if (decl?.type === 'enum-item' && decl.enumName && decl.name) {
                enumItemsByKey.set(`${decl.enumName}::${decl.name}`, decl);
            }
        }

        const candidateDecls = [];
        for (const decl of sourceDecls) {
            if (decl?.type !== 'variable' || !decl.dims) continue;
            if ((decl.lineNumber ?? 0) > position.line) continue;
            if (String(decl.value || '').indexOf('{') < 0) continue;
            candidateDecls.push(decl);
        }
        if (!candidateDecls.length) return null;

        for (const decl of candidateDecls) {
            const dimParts = parseDimsParts(decl.dims);
            const enumDimIndex = dimParts.findIndex(part => !!extractEnumSymbolName(part));
            if (enumDimIndex < 0) continue;

            const enumName = extractEnumSymbolName(dimParts[enumDimIndex]);
            const enumDecl = enumDeclsByName.get(enumName);
            if (!enumDecl?.enumMembers?.length) continue;

            const startOffset = document.offsetAt(new vscode.Position(decl.lineNumber, 0));
            const initializerOpenOffset = findInitializerOpenOffset(text, startOffset, resolver);
            if (initializerOpenOffset < 0 || cursorOffset < initializerOpenOffset) continue;

            const initializerCloseOffset = findMatchingBraceOffset(text, initializerOpenOffset, resolver);
            if (initializerCloseOffset < 0 || cursorOffset > initializerCloseOffset) continue;

            const targetBraceDepth = enumDimIndex + 1;
            const braceStack = [];
            let inStr = false, strChar = '', lineComment = false, blockComment = false;
            let depthParen = 0, depthBracket = 0;

            for (let i = initializerOpenOffset; i < Math.min(cursorOffset + 1, text.length); i++) {
                const c = text[i];
                const n = text[i + 1] || '';
                const escapeChar = resolver.ctrlCharAtOffset(i);

                if (blockComment) {
                    if (c === '*' && n === '/') { blockComment = false; i++; }
                    continue;
                }
                if (lineComment) {
                    if (c === '\n') lineComment = false;
                    continue;
                }
                if (inStr) {
                    if (c === strChar && !isEscapedQuote(text, i, escapeChar)) inStr = false;
                    continue;
                }

                if (c === '/' && n === '/') { lineComment = true; i++; continue; }
                if (c === '/' && n === '*') { blockComment = true; i++; continue; }
                if (c === '"' || c === "'") { inStr = true; strChar = c; continue; }
                if (c === '(') depthParen++;
                else if (c === ')') depthParen = Math.max(0, depthParen - 1);
                else if (c === '[') depthBracket++;
                else if (c === ']') depthBracket = Math.max(0, depthBracket - 1);
                else if (depthParen === 0 && depthBracket === 0) {
                    if (c === '{') {
                        braceStack.push({ openOffset: i, commaCount: 0 });
                    } else if (c === '}') {
                        if (braceStack.length) braceStack.pop();
                    } else if (c === ',' && braceStack.length) {
                        braceStack[braceStack.length - 1].commaCount++;
                    }
                }
            }

            if (braceStack.length < targetBraceDepth) continue;
            const targetBrace = braceStack[targetBraceDepth - 1];
            const closeOffset = findMatchingBraceOffset(text, targetBrace.openOffset, resolver);
            if (closeOffset < 0 || cursorOffset > closeOffset) continue;

            const fields = extractTopLevelFields(text, targetBrace.openOffset, closeOffset, resolver);
            const fieldIndex = targetBrace.commaCount;
            const memberName = enumDecl.enumMembers[fieldIndex]?.name || '';
            const member = enumItemsByKey.get(`${enumDecl.enumName}::${memberName}`) ||
                enumDecl.enumMembers[fieldIndex];
            const field = fields[fieldIndex];
            if (!member || !field) continue;

            return {
                enumDecl,
                member,
                fieldExpr: field.text,
                escapeChar: resolver.ctrlCharAtOffset(field.start),
                fieldIndex
            };
        }

        return null;
    }

    return {
        findEnumInitializerMemberContext
    };
}

module.exports = { createHoverEnumInitializerFeature };
