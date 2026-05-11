function createSyntaxConstantCore(t) {
    const INCLUDE_LINE_RE = /^\s*#\s*(?:include|tryinclude)\s+(?:<([^>"]+)>\s*|"([^"]+)"\s*|([A-Za-z0-9_./\\-]+))/;

    const FORBIDDEN = new Set([
        'if','for','while','switch','return','else','delete','break',
        'continue','case','default','do','sizeof','defined','state',
        'goto','assert','sleep','exit','enum'
    ]);

    const BUILTIN_DECLS = [
        {
            name: 'sizeof',
            args: 'symbol',
            type: 'builtin',
            typeTag: '',
            modifiers: [],
            dims: '',
            file: '',
            filePath: '',
            lineNumber: 0,
            value: '',
            docs: t('builtin.sizeof.docs')
        },
        {
            name: 'true',
            args: '',
            type: 'builtin',
            typeTag: 'bool',
            modifiers: [],
            dims: '',
            file: '',
            filePath: '',
            lineNumber: 0,
            value: '1',
            docs: t('builtin.true.docs')
        },
        {
            name: 'false',
            args: '',
            type: 'builtin',
            typeTag: 'bool',
            modifiers: [],
            dims: '',
            file: '',
            filePath: '',
            lineNumber: 0,
            value: '0',
            docs: t('builtin.false.docs')
        },
        {
            name: 'cellmin',
            args: '',
            type: 'builtin',
            typeTag: '',
            modifiers: [],
            dims: '',
            file: '',
            filePath: '',
            lineNumber: 0,
            value: '',
            docs: t('builtin.cellmin.docs')
        },
        {
            name: 'cellmax',
            args: '',
            type: 'builtin',
            typeTag: '',
            modifiers: [],
            dims: '',
            file: '',
            filePath: '',
            lineNumber: 0,
            value: '',
            docs: t('builtin.cellmax.docs')
        },
        {
            name: 'EOS',
            args: '',
            type: 'builtin',
            typeTag: '',
            modifiers: [],
            dims: '',
            file: '',
            filePath: '',
            lineNumber: 0,
            value: '0',
            docs: ''
        }
    ];

    const VAR_MODS = new Set(['new','static','stock','public','const','private']);
    const OPERATOR_SYMBOLS = [
        '<<=','>>=','==','!=','<=','>=','++','--','&&','||','<<','>>',
        '%','*','/','+','-','<','>','=','!','&','|','^','~'
    ];

    const MOD_RE  = /^(stock|public|static|new|const|native|forward|private)\s+/;
    const TAG_RE  = /^((?:[A-Za-z_@]\w*)|(?:\{[^}]+\}))\s*:\s*/;
    const NAME_RE = /^(operator(?:<<=|>>=|==|!=|<=|>=|\+\+|--|&&|\|\||<<|>>|[%*/+\-<>=!&|^~]+)|[A-Za-z_@]\w*)/;

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
