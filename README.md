# AMXX Pawn All-In

AMXX Pawn All-In is a Visual Studio Code extension for AMX Mod X / Pawn development.
It brings syntax highlighting, semantic hovers, completion, live diagnostics, include-aware analysis, and compiler integration into one focused workflow for AMXX Pawn projects.

Recommended AMX Mod X version: 1.9.0 or newer.

## Features

- AMXX Pawn syntax highlighting for source files and compiler-recognized include files, with configurable file extensions.
- Automatic Pawn language detection for custom file extensions when a file includes Pawn headers.
- Include-aware declarations, symbols, functions, enums, stocks, natives, forwards, macros, and project/global include paths.
- Fast completion for functions, variables, arguments, enum fields, compiler symbols, and include declarations.
- Scope-aware completion that understands the current function/block, so local variables and arguments are suggested only where they are actually visible.
- Completion ordering prefers active micro-scope locals from nested blocks, branches, and `for` declarations, then regular function locals, function arguments, globals, and include declarations.
- Function-call completion avoids duplicating an already typed argument block, does not expand call snippets inside strings, and uses clean parameter-name placeholders for calls.
- Forward completion can generate a new implementation body while preserving the full forward signature for declarations.
- Semantic hover for globals, locals, function arguments, functions, includes, enum members, struct-like enum fields, bitmasks, array/indexed access, and call signatures.
- Hover modes: normal hover, disabled hover, or experimental Ctrl/Shift/Alt-only modes for Windows.
- Compact/full/signature-only hover content modes.
- Optional Go to Definition links inside hover content.
- Persistent hover support for regular symbols and diagnostic/error context.
- Live validation in `edited` or `full` mode.
- Live validation issue modes: errors only or errors and warnings.
- Compiler-like diagnostics for common Pawn errors: missing/extra arguments, tag mismatches, array dimension issues, invalid indexed access, invalid statements, invalid characters, preprocessor issues, enum/initializer problems, lvalue/const issues, return-style problems, unreachable code, deprecated symbols, unused symbols, and more.
- `#include`, `#define`, `#if/#elseif/#else/#endif`, `#pragma`, `#error`, and `#assert` analysis for live diagnostics.
- Macro-aware local analysis for function-like macros that expand into common control/declaration patterns.
- Detection of invalid non-Pawn characters outside strings/comments.
- Dynamic stack usage warning that can suggest increasing `#pragma dynamic`.
- Configurable include validation mode for balancing strict include checks with real-world AMXX include usage.
- Configurable callback signature mode.
- Configurable unused `stock` validation mode.
- AMXX compiler integration with a toolbar command.
- Configurable compiler path, output directory, compiler options, result toasts, output reveal behavior, and diagnostic reveal priority.
- Include graph and diagnostics caches for faster repeated analysis.
- External include watching, including tracked resolved includes.
- Optional include document warmup for smoother first hovers/completions after opening a script.
- Bundled color themes tuned for AMXX Pawn hovers and diagnostics:
  - AmxxPawnAllIn Olive
  - AmxxPawnAllIn Dark
  - AmxxPawnAllIn Light
  - AmxxPawnAllIn Graphite
  - AmxxPawnAllIn Aurora
- UI localization for English and Russian using the standard VS Code NLS mechanism.

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

## Important Settings

- `amxxPawnAllIn.fileExtensions`
  Source file extensions. Defaults to `[".sma"]`.

- `amxxPawnAllIn.includeFileExtensions`
  Extra include file extensions used for Pawn include resolution and language activation. Compiler-style include suffixes are always enabled and cannot be removed: `.inc`, `.p`, `.i`, `.pawn`. The default extra suffix is `.inl`.

- `amxxPawnAllIn.detectPawnLanguageByIncludes`
  Detect Pawn files by `#include` usage even when the file extension is custom.

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
  Controls whether forward suggestions at top level insert only a signature, a same-line body, or a next-line body.

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

## Repository Layout

- `extension.js`
  Thin VS Code activation entrypoint.
- `bootstrap/`
  Runtime wiring and feature composition.
- `core/`
  Shared parsing, syntax, declaration, validation, include, and document-context logic.
- `features/`
  User-facing VS Code features such as hover, live validation, completion, and persistent hover.
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
