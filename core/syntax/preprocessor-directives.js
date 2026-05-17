const { getPreprocessorDirectiveStartIndex } = require('./preprocessor-lines');
const { isPawnIdentifierContinueChar } = require('./identifiers');
const { isPawnHorizontalWhitespaceCode } = require('./whitespace');

const PREPROCESSOR_DIRECTIVE_COMPLETIONS = Object.freeze([
    { name: 'assert', detail: 'preprocessor directive', insertText: 'assert ${1:condition}' },
    { name: 'define', detail: 'preprocessor directive', insertText: 'define ${1:NAME} ${0:value}' },
    { name: 'else', detail: 'preprocessor directive', insertText: 'else' },
    { name: 'elseif', detail: 'preprocessor directive', insertText: 'elseif ${1:condition}' },
    { name: 'emit', detail: 'preprocessor directive', insertText: 'emit ${1:opcode}' },
    { name: 'endif', detail: 'preprocessor directive', insertText: 'endif' },
    { name: 'endinput', detail: 'preprocessor directive', insertText: 'endinput' },
    { name: 'error', detail: 'preprocessor directive', insertText: 'error ${1:message}' },
    { name: 'file', detail: 'preprocessor directive', insertText: 'file \"${1:file}\"' },
    { name: 'elif', detail: 'preprocessor directive', insertText: 'elif ${1:condition}' },
    { name: 'if', detail: 'preprocessor directive', insertText: 'if ${1:condition}' },
    { name: 'ifdef', detail: 'preprocessor directive', insertText: 'ifdef ${1:SYMBOL}' },
    { name: 'ifndef', detail: 'preprocessor directive', insertText: 'ifndef ${1:SYMBOL}' },
    { name: 'include', detail: 'preprocessor directive', insertText: 'include <${1:include}>' },
    { name: 'line', detail: 'preprocessor directive', insertText: 'line ${1:number}' },
    { name: 'pragma', detail: 'preprocessor directive', insertText: 'pragma ${1:name}' },
    { name: 'section', detail: 'preprocessor directive', insertText: 'section ${1:name}' },
    { name: 'tryinclude', detail: 'preprocessor directive', insertText: 'tryinclude <${1:include}>' },
    { name: 'undef', detail: 'preprocessor directive', insertText: 'undef ${1:SYMBOL}' }
]);

const PRAGMA_DIRECTIVE_COMPLETIONS = Object.freeze([
    {
        name: 'align',
        detail: '#pragma - alignment',
        insertText: 'align ${1:value}',
        documentation: 'Sets the alignment used by the compiler for generated AMX data/code layout.'
    },
    {
        name: 'amxlimit',
        detail: '#pragma - AMX size limit',
        insertText: 'amxlimit ${1:size}',
        documentation: 'Sets the maximum allowed size for the generated AMX image.'
    },
    {
        name: 'amxram',
        detail: '#pragma - AMX RAM budget',
        insertText: 'amxram ${1:size}',
        documentation: 'Sets the available RAM budget for data, heap, and stack checks.'
    },
    {
        name: 'codepage',
        detail: '#pragma - source code page',
        insertText: 'codepage ${1:name}',
        documentation: 'Selects the source code page used by the compiler for character translation.'
    },
    {
        name: 'compress',
        detail: '#pragma - AMX compression',
        insertText: 'compress ${1:1}',
        documentation: 'Enables or disables compression for the generated AMX output.'
    },
    {
        name: 'ctrlchar',
        detail: '#pragma - string escape char',
        insertText: "ctrlchar '${1:\\\\}'",
        documentation: 'Changes the control/escape character used inside strings.'
    },
    {
        name: 'deprecated',
        detail: '#pragma - deprecation marker',
        insertText: 'deprecated ${1:message}',
        documentation: 'Marks the following native, forward, stock, or function declaration as deprecated.'
    },
    {
        name: 'defclasslib',
        detail: '#pragma - default module class library',
        insertText: 'defclasslib ${1:class} ${2:library}',
        documentation: 'Defines a default AMXX module library for a required library class.'
    },
    {
        name: 'dynamic',
        detail: '#pragma - dynamic stack/heap',
        insertText: 'dynamic ${1:size}',
        documentation: 'Sets the dynamic stack/heap size used by the compiled plugin.'
    },
    {
        name: 'expectclass',
        detail: '#pragma - expected module class',
        insertText: 'expectclass ${1:class} ${2:library}',
        documentation: 'AMXX module autoload pragma: if a class is missing, try loading the given library.'
    },
    {
        name: 'expectlib',
        detail: '#pragma - expected module library',
        insertText: 'expectlib ${1:library} ${2:fallback_library}',
        documentation: 'AMXX module autoload pragma: if a library is missing, try loading another library.'
    },
    {
        name: 'expclass',
        detail: '#pragma - expected module class alias',
        insertText: 'expclass ${1:class} ${2:library}',
        documentation: 'Compiler-recognized AMXX module autoload alias for expectclass.'
    },
    {
        name: 'explib',
        detail: '#pragma - expected module library alias',
        insertText: 'explib ${1:library} ${2:fallback_library}',
        documentation: 'Compiler-recognized AMXX module autoload alias for expectlib.'
    },
    {
        name: 'library',
        detail: '#pragma - module library',
        insertText: 'library ${1:library}',
        documentation: 'Declares the AMXX module/library associated with declarations in an include file.'
    },
    {
        name: 'loadlib',
        detail: '#pragma - autoload module library',
        insertText: 'loadlib ${1:library}',
        documentation: 'Requests that AMXX automatically loads the named module library.'
    },
    {
        name: 'pack',
        detail: '#pragma - packed string mode',
        insertText: 'pack ${1:true}',
        documentation: 'Changes the default packed-string mode for following string literals.'
    },
    {
        name: 'rational',
        detail: '#pragma - rational literal tag',
        insertText: 'rational ${1:Float}',
        documentation: 'Defines the tag used for rational/float literals, optionally with precision.'
    },
    {
        name: 'reqclass',
        detail: '#pragma - required module class',
        insertText: 'reqclass ${1:class}',
        documentation: 'Requires that an AMXX module library class is available.'
    },
    {
        name: 'reqlib',
        detail: '#pragma - required module library',
        insertText: 'reqlib ${1:library}',
        documentation: 'Requires that an AMXX module library is available.'
    },
    {
        name: 'semicolon',
        detail: '#pragma - semicolon mode',
        insertText: 'semicolon ${1:1}',
        documentation: 'Enables or disables required semicolons.'
    },
    {
        name: 'showstackusageinfo',
        detail: '#pragma - stack usage report',
        insertText: 'showstackusageinfo ${1:1}',
        documentation: 'Requests compiler stack-usage reporting when supported by the AMXX compiler.'
    },
    {
        name: 'tabsize',
        detail: '#pragma - tab width',
        insertText: 'tabsize ${1:4}',
        documentation: 'Sets the tab width used for indentation and loose-indentation checks.'
    },
    {
        name: 'unused',
        detail: '#pragma - unused warning suppression',
        insertText: 'unused ${1:symbol}',
        documentation: 'Suppresses unused-symbol warnings for one or more symbols.'
    }
]);

const PREPROCESSOR_DIRECTIVE_NAMES = Object.freeze(PREPROCESSOR_DIRECTIVE_COMPLETIONS.map(item => item.name));
const PREPROCESSOR_DIRECTIVE_NAME_SET = new Set(PREPROCESSOR_DIRECTIVE_NAMES);
const PRAGMA_DIRECTIVE_NAMES = Object.freeze(PRAGMA_DIRECTIVE_COMPLETIONS.map(item => item.name));
const PRAGMA_DIRECTIVE_NAME_SET = new Set(PRAGMA_DIRECTIVE_NAMES);

function isPreprocessorDirectiveIdentifierChar(char) {
    return isPawnIdentifierContinueChar(char || '');
}

function isPreprocessorDirectiveName(value) {
    return PREPROCESSOR_DIRECTIVE_NAME_SET.has(String(value || '').toLowerCase());
}

function isPragmaDirectiveName(value) {
    return PRAGMA_DIRECTIVE_NAME_SET.has(String(value || '').toLowerCase());
}

function getPreprocessorDirectiveCompletionContext(line = '', character = 0) {
    const source = String(line || '');
    const cursor = Math.max(0, Math.min(source.length, character | 0));
    const hashStart = getPreprocessorDirectiveStartIndex(source);
    if (hashStart < 0 || cursor <= hashStart) {
        return {
            inPreprocessorLine: false,
            canCompleteDirective: false,
            hashStart: -1,
            directiveName: '',
            prefix: '',
            replaceStart: cursor,
            replaceEnd: cursor
        };
    }

    let tokenStart = hashStart + 1;
    while (
        tokenStart < source.length &&
        isPawnHorizontalWhitespaceCode(source.charCodeAt(tokenStart))
    ) {
        tokenStart++;
    }

    if (cursor < tokenStart) {
        return {
            inPreprocessorLine: true,
            canCompleteDirective: true,
            canCompletePragma: false,
            hashStart,
            directiveName: '',
            prefix: '',
            replaceStart: cursor,
            replaceEnd: cursor
        };
    }

    let tokenEnd = tokenStart;
    while (
        tokenEnd < source.length &&
        isPreprocessorDirectiveIdentifierChar(source[tokenEnd])
    ) {
        tokenEnd++;
    }

    if (cursor <= tokenEnd) {
        return {
            inPreprocessorLine: true,
            canCompleteDirective: true,
            canCompletePragma: false,
            hashStart,
            directiveName: source.slice(tokenStart, tokenEnd).toLowerCase(),
            prefix: source.slice(tokenStart, cursor),
            replaceStart: tokenStart,
            replaceEnd: tokenEnd
        };
    }

    const directiveName = source.slice(tokenStart, tokenEnd).toLowerCase();
    if (directiveName === 'pragma') {
        let pragmaStart = tokenEnd;
        while (
            pragmaStart < source.length &&
            isPawnHorizontalWhitespaceCode(source.charCodeAt(pragmaStart))
        ) {
            pragmaStart++;
        }

        if (cursor < pragmaStart) {
            return {
                inPreprocessorLine: true,
                canCompleteDirective: false,
                canCompletePragma: true,
                hashStart,
                directiveName,
                prefix: '',
                replaceStart: cursor,
                replaceEnd: cursor
            };
        }

        let pragmaEnd = pragmaStart;
        while (
            pragmaEnd < source.length &&
            isPreprocessorDirectiveIdentifierChar(source[pragmaEnd])
        ) {
            pragmaEnd++;
        }

        if (cursor <= pragmaEnd) {
            return {
                inPreprocessorLine: true,
                canCompleteDirective: false,
                canCompletePragma: true,
                hashStart,
                directiveName,
                prefix: source.slice(pragmaStart, cursor),
                replaceStart: pragmaStart,
                replaceEnd: pragmaEnd
            };
        }
    }

    return {
        inPreprocessorLine: true,
        canCompleteDirective: false,
        canCompletePragma: false,
        hashStart,
        directiveName,
        prefix: '',
        replaceStart: cursor,
        replaceEnd: cursor
    };
}

module.exports = {
    PREPROCESSOR_DIRECTIVE_COMPLETIONS,
    PREPROCESSOR_DIRECTIVE_NAMES,
    PRAGMA_DIRECTIVE_COMPLETIONS,
    PRAGMA_DIRECTIVE_NAMES,
    getPreprocessorDirectiveCompletionContext,
    isPreprocessorDirectiveName,
    isPragmaDirectiveName
};
