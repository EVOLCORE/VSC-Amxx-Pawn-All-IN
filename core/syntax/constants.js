const { PAWN_INCLUDE_LINE_RE } = require('./includes');
const { createCompilerBuiltinDecls } = require('./compiler-builtins');
const { PAWN_IDENTIFIER_SOURCE } = require('./identifiers');

function createSyntaxConstantCore(t) {
    const INCLUDE_LINE_RE = PAWN_INCLUDE_LINE_RE;

    const FORBIDDEN = new Set([
        'if','for','while','switch','return','else','delete','break',
        'continue','case','default','do','sizeof','defined','state',
        'goto','assert','sleep','exit','enum'
    ]);

    const BUILTIN_DECLS = createCompilerBuiltinDecls(t);

    const VAR_MODS = new Set(['new','static','stock','public','const','private']);
    const OPERATOR_SYMBOLS = [
        '<<=','>>=','==','!=','<=','>=','++','--','&&','||','<<','>>',
        '%','*','/','+','-','<','>','=','!','&','|','^','~'
    ];

    const MOD_RE  = /^(stock|public|static|new|const|native|forward|private)\s+/;
    const TAG_RE  = new RegExp(`^((?:${PAWN_IDENTIFIER_SOURCE})|(?:\\{[^}]+\\}))\\s*:\\s*`);
    const NAME_RE = new RegExp(`^(operator(?:<<=|>>=|==|!=|<=|>=|\\+\\+|--|&&|\\|\\||<<|>>|[%*/+\\-<>=!&|^~]+)|${PAWN_IDENTIFIER_SOURCE})`);

    return {
        INCLUDE_LINE_RE,
        FORBIDDEN,
        BUILTIN_DECLS,
        VAR_MODS,
        OPERATOR_SYMBOLS,
        MOD_RE,
        TAG_RE,
        NAME_RE
    };
}

module.exports = { createSyntaxConstantCore };
