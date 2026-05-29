# AMXX Pawn All-In

AMXX Pawn All-In is a Visual Studio Code extension for AMX Mod X / Pawn development.
It brings syntax highlighting, semantic hovers, completion, rename support, live diagnostics, include-aware analysis, and compiler integration into one focused workflow for AMXX Pawn projects.

Recommended AMX Mod X version: 1.9.0 or newer.

## Features

### Language & Syntax

1. AMXX Pawn syntax highlighting for source files and compiler-recognized include files, with configurable file extensions.
2. Automatic Pawn language detection for custom file extensions when a file includes Pawn headers and contains Pawn-specific syntax, while avoiding documentation and C/C++ snippets.
3. TextMate grammar support for AMXX Pawn declarations, enums, tags, macros, preprocessor directives, comments, strings, and compiler-style include forms.
4. Built-in AMXX/Pawn compiler constants and preprocessor symbols such as `__FILE__` and `__LINE__` are understood in expression/preprocessor contexts.

### Includes & Preprocessor

1. Include-aware declarations, symbols, functions, enums, stocks, natives, forwards, macros, and project/global include paths.
2. Compiler-style include resolution for `.inc`, `.p`, `.i`, `.pawn`, plus configurable extra include suffixes such as `.inl`.
3. Correct quoted-vs-angle include search semantics: quoted includes prefer the current source directory first, while angle includes use configured/project include roots.
4. `#include` and `#tryinclude` support for diagnostics, context, go to definition, and include path completion.
5. `#define`, function-like macros, object-like macros, conditional `#if/#ifdef/#elseif/#else/#endif`, `#pragma`, `#error`, and `#assert` analysis for live diagnostics.
6. Preprocessor directive completion after `#`, including AMXX Pawn `#pragma` variants with descriptions.
7. Macro-aware local analysis for function-like macros that expand into common control/declaration patterns.

### Completion

1. Fast completion for functions, natives, variables, arguments, enum fields, compiler symbols, preprocessor directives, include paths, and include declarations.
2. Scope-aware completion that understands the current function/block, so local variables and arguments are suggested only where they are actually visible.
3. Context-aware filtering: top-level function declarations prefer forwards, function-call contexts hide declaration-only forwards, and declaration keywords avoid noisy duplicate suggestions.
4. Completion ordering prefers active micro-scope locals from nested blocks, branches, and `for` declarations, then regular function locals, function arguments, globals, and include declarations.
5. Function-call completion avoids duplicating an already typed argument block, does not expand call snippets inside strings, and uses clean parameter-name placeholders for calls.
6. Configurable call snippet argument mode: insert all arguments or only required arguments before the first default value.
7. Forward completion can generate a new implementation body while preserving the full forward signature for declarations.
8. Deprecated declarations are marked in completion items when source metadata exposes them.
9. Fuzzy/partial symbol matching helps find names even when only a compact abbreviation is typed.
10. Array dimension completion suggests numeric defines, enum constants, and compile-time size helpers where they are valid.
11. Optional completion auto-hide reduces UI noise after idle typing or when the typed text already resolves the only suggestion.

### Hover & Navigation

1. Semantic hover for globals, locals, function arguments, functions, includes, enum members, struct-like enum fields, bitmasks, array/indexed access, macro aliases, and call signatures.
2. Hover can show inferred initializer/array shapes, enum-backed dimensions, bitmask values, function signatures, source include names, and validation context.
3. Hover modes: normal hover, disabled hover, or experimental Ctrl/Shift/Alt-only modes for Windows.
4. Compact/full/signature-only hover content modes.
5. Optional Go to Definition links inside hover content.
6. Go to Definition support for symbols and include declarations.
7. Format-string placeholder hover/highlighting that maps placeholders such as `%s`, `%i`, `%f`, and multi-argument `%L` to the arguments they consume.
8. Document highlights for symbol occurrences, including variables and functions, using VS Code's built-in highlight/overview behavior.

### Refactor

1. Rename Symbol support for local variables, function arguments, current-file globals, current-file functions, and unresolved scoped names in the edited source.
2. Scope-aware reference matching to avoid renaming unrelated symbols with the same name in another function/block.
3. Include declarations are intentionally not renamed.
4. PawnDoc stub generation for undocumented `native` and `forward` declarations in include files.
5. PawnDoc quick action generation at the current cursor/selection for declarations or a selected code block.
6. PawnDoc generation asks each run whether to create a backup, skip backup, or cancel.

### Live Diagnostics

1. Live validation in `edited` or `full` mode.
2. Live validation issue modes: errors only or errors and warnings.
3. Compiler-like diagnostics for common Pawn errors: missing/extra arguments, tag mismatches, array dimension issues, invalid indexed access, invalid statements, invalid characters, preprocessor issues, enum/initializer problems, lvalue/const issues, return-style problems, unreachable code, deprecated symbols, unused symbols, and more.
4. Configurable include validation mode for balancing strict include checks with real-world AMXX include usage.
5. Configurable callback signature mode for strict or compiler-like forward callback checks.
6. Configurable unused `stock` validation mode.
7. Detection of invalid non-Pawn characters outside strings/comments.
8. Dynamic stack usage warning that can suggest increasing `#pragma dynamic`.

### Compiler Integration

1. AMXX compiler integration with a toolbar command.
2. Configurable compiler path, output directory, compiler options, result toasts, output reveal behavior, and diagnostic reveal priority.
3. Compiler include paths are passed in the same project/global priority order used by the extension, with duplicate `-i` options filtered out.

### Performance & Caching

1. Include graph and diagnostics caches for faster repeated analysis.
2. Persistent include declaration cache with dependency stamps.
3. External include watching, including tracked resolved includes.
4. Optional include document warmup for smoother first hovers/completions after opening a script.
5. Version-aware diagnostics/context caches to keep edited-file feedback responsive.

### Themes & Localization

1. Bundled color themes tuned for AMXX Pawn hovers and diagnostics:
   - AmxxPawnAllIn Olive
   - AmxxPawnAllIn Dark
   - AmxxPawnAllIn Light
   - AmxxPawnAllIn Graphite
   - AmxxPawnAllIn Aurora
2. UI localization for English and Russian using the standard VS Code NLS mechanism.

## Installation

### Install from Visual Studio Marketplace

The recommended installation path is the Visual Studio Marketplace:

https://marketplace.visualstudio.com/items?itemName=Faktor.amxx-pawn-all-in

You can also install it from inside VS Code:

1. Open the Extensions view.
2. Search for `AMXX Pawn All-In`.
3. Click `Install`.

Marketplace installs receive normal VS Code extension updates.

### Install from a VSIX release

Use this path for manual/offline installs or test builds:

1. Download the latest `.vsix` file from the repository Releases page: https://github.com/droads/VSC-Amxx-Pawn-All-IN/releases
2. Open Visual Studio Code.
3. Open the Extensions view.
4. Click the `...` menu in the top-right corner.
5. Choose `Install from VSIX...`.
6. Select the downloaded `.vsix` file.
7. Reload VS Code if prompted.

You can also install from the command line:

```bash
code --install-extension amxx-pawn-all-in-*.vsix
```

## Quick Start

1. Open an AMXX project folder in VS Code.
2. Open a `.sma`, `.inc`, `.p`, `.i`, `.pawn`, `.inl`, or configured include file.
3. Configure include paths if your project uses custom include folders:

```json
{
  "amxxPawnAllIn.projectLocalIncludePaths": ["include"],
  "amxxPawnAllIn.globalIncludePaths": []
}
```

4. Enable live validation if desired:

```json
{
  "amxxPawnAllIn.liveValidationMode": "edited",
  "amxxPawnAllIn.liveValidationIssueMode": "errors-and-warnings",
  "amxxPawnAllIn.liveValidationTypingDelayMs": 700
}
```

5. Configure the compiler path if you want to compile directly from VS Code:

```json
{
  "amxxPawnAllIn.globalCompilerPath": "C:/path/to/amxxpc.exe"
}
```

Then use the `AMXX Pawn All-In: Compile Current File` command or the editor title button.

For include API files, use `AMXX Pawn All-In: Generate PawnDoc Stubs` from the editor title button or command palette to add basic PawnDoc blocks above undocumented `native` and `forward` declarations. For a single declaration or selected code block in any AMXX Pawn file, use `AMXX Pawn All-In: Generate PawnDoc Here` from the command palette or VS Code code actions.

## Important Settings

- `amxxPawnAllIn.fileExtensions`
  Source file extensions. Defaults to `[".sma"]`.

- `amxxPawnAllIn.includeFileExtensions`
  Extra include file extensions used for Pawn include resolution and language activation. Compiler-style include suffixes are always enabled and cannot be removed: `.inc`, `.p`, `.i`, `.pawn`. The default extra suffix is `.inl`.

- `amxxPawnAllIn.detectPawnLanguageByIncludes`
  Detect Pawn files by resolved Pawn `#include` usage plus Pawn-specific syntax even when the file extension is custom. Documentation and common C/C++ files are ignored.

- `amxxPawnAllIn.projectLocalIncludePaths`
  Project-relative include directories. Defaults to `["include"]`.

- `amxxPawnAllIn.globalIncludePaths`
  Global include directories.

- `amxxPawnAllIn.liveValidationMode`
  `off`, `edited`, or `full`.

- `amxxPawnAllIn.liveValidationIssueMode`
  `errors-only` or `errors-and-warnings`.

- `amxxPawnAllIn.liveValidationTypingDelayMs`
  Delay before live validation runs after typing. Increase it if temporary diagnostics appear while a token is still being entered. `0` means validate only after the edit crosses a line boundary or the cursor leaves the edited line.

- `amxxPawnAllIn.hoverMode`
  `disabled`, `normal`, `ctrl-hack`, `shift-hack`, or `alt-hack`. The `*-hack` modes are experimental Windows-only modes that try to show the extension hover only while the selected modifier key is held; on other platforms they fall back to normal mode.

- `amxxPawnAllIn.hoverContentMode`
  `full`, `compact`, or `signature-only`.

- `amxxPawnAllIn.completionEnabled`
  Enable or disable completion provider.

- `amxxPawnAllIn.completionForwardDeclarationStyle`
  Controls whether forward suggestions at top level insert only a signature, a same-line body, or a next-line body. The same brace placement is used by statement snippets such as `if`, `else`, `for`, `while`, `switch`, `case`, and `default`, and by Enter-assisted bodies for manually typed function declarations.

- `amxxPawnAllIn.completionCallArgumentMode`
  Controls whether call snippets insert all arguments or only the required arguments before the first default value.

- `amxxPawnAllIn.completionAutoHideDelayMs`
  Automatically hides the completion widget after this many milliseconds without another completion request. `0` keeps VS Code's normal behavior. Empty results and a single already fully typed suggestion are hidden automatically.

- `amxxPawnAllIn.callbackSignatureMode`
  `strict` keeps full forward-backed callback signature checks. `compiler-like` is more tolerant of partial callback signatures and unused forward callback parameters.

- `amxxPawnAllIn.persistentIncludeDeclarationCacheMaxMB`
  Disk cache limit for include declaration and include graph snapshots. `0` disables this cache.

- `amxxPawnAllIn.documentContextCacheFileLimit`
  In-memory document context cache file limit.

- `amxxPawnAllIn.externalIncludeWatchMode`
  Controls how external include files are watched and invalidated.

## Compiler Integration

The extension can run `amxxpc` for the current file.
It can use a compiler from the current project, from the source file directory, or from `amxxPawnAllIn.globalCompilerPath`, depending on your configuration.

When compiling, AMXX Pawn All-In passes configured include folders to `amxxpc` as include paths.
Project-local include paths are emitted first, global include paths follow, and duplicate folders are removed by absolute path.
Quoted includes still keep compiler-style local-file lookup first; angle includes rely on the configured project/global include path order.
Managed include and output arguments are protected from `amxxPawnAllIn.compilerOptions`: duplicate include paths are skipped, unique manual include paths are kept after managed paths, and custom `-o` options cannot override the configured output file.

Compiler output can be written to a configurable output directory, and the extension can reveal live errors, compiler errors, warnings, or all issues depending on your workflow.

## Localization

AMXX Pawn All-In supports English and Russian using the standard VS Code localization system:

- `package.nls.json` for English extension metadata.
- `package.nls.ru.json` for Russian extension metadata.
- `localization/en.json` for runtime strings.
- `localization/ru.json` for runtime strings.

VS Code chooses the UI language according to its configured locale.

## Performance Notes

The extension uses shared document snapshots, include graph caching, persistent include declaration caching, dependency stamps, and version-aware diagnostics caching.
Caches are invalidated when documents, includes, nested includes, settings, or watched external include files change.

For most projects, `edited` live validation gives the best balance between responsiveness and safety.
Use `full` mode when you want the most aggressive continuous validation.

## Supported File Types

Primary file types:

- `.sma`
- `.inc`
- `.p`
- `.i`
- `.pawn`

When an include is written without an extension, for example `#include <test>`, AMXX Pawn All-In follows the compiler-style include suffix list and checks `.inc`, `.p`, `.i`, and `.pawn` before any extra configured suffixes. `.inl` is only a default extra include suffix and can be removed from `amxxPawnAllIn.includeFileExtensions`. Custom source and extra include extensions can be configured in VS Code settings.

Include path completion follows the same search semantics: quoted includes prefer files relative to the current source before configured include roots, while angle includes use configured/project include roots.

## Repository Layout

- `extension.js`
  Thin VS Code activation entrypoint.
- `bootstrap/`
  Runtime wiring and feature composition.
- `core/`
  Shared parsing, syntax, declaration, validation, include, and document-context logic.
- `features/`
  User-facing VS Code features such as hover, live validation, completion, rename, and persistent hover.
- `services/`
  Settings, localization, compiler integration, cache maintenance, and infrastructure.
- `syntaxes/`
  TextMate grammar.
- `themes/`
  Bundled AMXX Pawn themes.
- `localization/`
  Runtime localization files.

## Status

This project is under active development.
The goal is practical, fast, include-aware AMXX Pawn tooling with compiler-like diagnostics where it is useful for live editing.
