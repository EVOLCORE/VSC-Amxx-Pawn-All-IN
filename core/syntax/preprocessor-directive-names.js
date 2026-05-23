const PREPROCESSOR_DIRECTIVE_NAMES = Object.freeze([
    'assert',
    'define',
    'else',
    'elseif',
    'emit',
    'endif',
    'endinput',
    'error',
    'file',
    'elif',
    'if',
    'ifdef',
    'ifndef',
    'include',
    'line',
    'pragma',
    'section',
    'tryinclude',
    'undef'
]);

const PRAGMA_DIRECTIVE_NAMES = Object.freeze([
    'align',
    'amxlimit',
    'amxram',
    'codepage',
    'compress',
    'ctrlchar',
    'deprecated',
    'defclasslib',
    'dynamic',
    'expectclass',
    'expectlib',
    'expclass',
    'explib',
    'library',
    'loadlib',
    'pack',
    'rational',
    'reqclass',
    'reqlib',
    'semicolon',
    'showstackusageinfo',
    'tabsize',
    'unused'
]);

const PREPROCESSOR_DIRECTIVE_NAME_SET = new Set(PREPROCESSOR_DIRECTIVE_NAMES);
const PRAGMA_DIRECTIVE_NAME_SET = new Set(PRAGMA_DIRECTIVE_NAMES);

function isPreprocessorDirectiveName(value) {
    return PREPROCESSOR_DIRECTIVE_NAME_SET.has(String(value || '').toLowerCase());
}

function isPragmaDirectiveName(value) {
    return PRAGMA_DIRECTIVE_NAME_SET.has(String(value || '').toLowerCase());
}

module.exports = {
    PREPROCESSOR_DIRECTIVE_NAMES,
    PRAGMA_DIRECTIVE_NAMES,
    isPreprocessorDirectiveName,
    isPragmaDirectiveName
};
