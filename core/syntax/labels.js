const {
    isPawnIdentifierContinueChar,
    isPawnIdentifierStartChar,
    readPawnIdentifierAt
} = require('./identifiers');
const { normalizeDeclaredPawnTagName } = require('./tags');
const { skipPawnWhitespace } = require('./whitespace');

function createLabelSyntaxCore() {
    const BUILTIN_TAG_NAMES = new Set(['Float', 'bool']);

    function readIdentifier(source, index) {
        return readPawnIdentifierAt(source, index);
    }

    function addTagName(target, value) {
        const name = normalizeDeclaredPawnTagName(value);
        if (name) target.add(name);
    }

    function addTagSpecNames(target, value) {
        const raw = String(value || '').trim();
        if (!raw) return;
        const union = raw.match(/^\{\s*([^}]+)\s*\}$/);
        if (union) {
            for (const part of union[1].split(',')) {
                addTagName(target, part);
            }
            return;
        }
        addTagName(target, raw);
    }

    function getEnumTagName(enumDecl) {
        const enumName = String(enumDecl?.enumName || enumDecl?.name || '').trim();
        if (!enumName) return '';
        const taggedEnum = enumName.match(/^([A-Za-z_@]\w*|_)\s*:\s*([A-Za-z_@]\w*)$/);
        if (taggedEnum) {
            return normalizeDeclaredPawnTagName(taggedEnum[1]);
        }
        return normalizeDeclaredPawnTagName(enumName);
    }

    function collectDeclaredTagNames(decls = []) {
        const tags = new Set(BUILTIN_TAG_NAMES);
        for (const decl of decls || []) {
            if (!decl) continue;
            addTagSpecNames(tags, decl.typeTag);
            if (decl.type === 'enum') {
                addTagName(tags, getEnumTagName(decl));
            }
        }
        return tags;
    }

    function getLabelDeclarationIssues(labelName, decls = []) {
        const name = String(labelName || '').trim();
        if (!name) return [];
        if (!collectDeclaredTagNames(decls).has(name)) return [];
        return [{
            kind: 'labelShadowsTagname',
            messageKey: 'validation.labelNameShadowsTagname',
            name,
            severity: 'warning'
        }];
    }

    function parseLabelDeclaration(source, options = {}) {
        const text = String(source || '');
        const start = skipPawnWhitespace(text, options.startOffset || 0);
        const ident = readIdentifier(text, start);
        if (!ident) return null;
        const colonIndex = skipPawnWhitespace(text, ident.end);
        if (text[colonIndex] !== ':') return null;
        const afterColon = text[colonIndex + 1] || '';
        if (afterColon && !/\s/.test(afterColon)) return null;
        return {
            name: ident.name,
            nameIndex: ident.start,
            colonIndex,
            endOffset: colonIndex + 1
        };
    }

    function collectGotoReferences(source) {
        const text = String(source || '');
        const refs = [];
        for (let index = 0; index < text.length; index++) {
            if (!isPawnIdentifierStartChar(text[index] || '')) continue;
            if (index > 0 && isPawnIdentifierContinueChar(text[index - 1])) continue;
            const word = readIdentifier(text, index);
            if (!word) continue;
            index = word.end - 1;
            if (word.name !== 'goto') continue;
            const targetStart = skipPawnWhitespace(text, word.end);
            const label = readIdentifier(text, targetStart);
            if (!label) {
                refs.push({
                    labelName: '',
                    labelIndex: Math.min(text.length, targetStart),
                    labelEnd: Math.min(text.length, targetStart + 1),
                    keywordIndex: word.start,
                    issue: {
                        kind: 'invalidSymbolName',
                        messageKey: 'validation.invalidSymbolName',
                        params: { name: text[targetStart] || '' }
                    }
                });
                continue;
            }
            refs.push({
                labelName: label.name,
                labelIndex: label.start,
                labelEnd: label.end,
                keywordIndex: word.start
            });
        }
        return refs;
    }

    return {
        collectDeclaredTagNames,
        getLabelDeclarationIssues,
        parseLabelDeclaration,
        collectGotoReferences
    };
}

module.exports = { createLabelSyntaxCore };
