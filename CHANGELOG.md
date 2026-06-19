# Changelog

All notable changes to the **MOGWAI Language Support** extension are documented in this file.

## [1.3.2]

### Added
- `post` keyword recognized in syntax highlighting and autocompletion

### Fixed
- Missing `README.md` in the published package (extension page was showing "No README available")

## [1.3.1]

### Fixed
- All six function declaration forms — including the optional `returns (...)` clause — are now correctly recognized by the Outline, Go to Definition, local function coloring, and Insert Function Call

## [1.3.0]

### Added
- **Insert Function Call** command — Quick Pick of all declared functions, inserts the selected name at the cursor position (Command Palette and right-click context menu)

## [1.2.0]

### Added
- Locally declared functions are colored in golden italic, distinct from keywords and runtime primitives
- **Go to Definition** (`F12` or right-click) jumps directly to a function's declaration
- Runtime primitives always take priority over a locally declared function with the same name

## [1.1.0]

### Added
- Function list in the **Outline** panel, with full signatures
- **Go to Symbol** (`Ctrl+Shift+O`) support for declared functions

## [1.0.3]

### Added
- Multi-file step-by-step debugging — when a script includes other files via `mogwai.include`, the debugger follows execution across files, opening included files side by side automatically
- **TRON mode** (`debug.tron`) now follows execution across included files in real time
- Source files are set read-only while a debug session is active

### Fixed
- Editor focus reliably returns to the correct `.mog` file after execution, even if the Output Channel had focus
- Unexpected runtime disconnection (e.g. `ECONNRESET`) now cleanly resets the extension state (status bar, toolbar, Runtime panel)
- The instruction pointer correctly returns to the main file after executing code in an included file

## [1.0.0]

### Added
- Initial release
- Static and dynamic syntax highlighting (keywords, operators, sigils, strings, primitives by group)
- Snippets for common MOGWAI structures
- UDP runtime discovery and persistent TCP connection
- Run and Debug (pause / step / resume / halt)
- Error navigation with precise position highlighting
- Runtime panel — Stack, Local Variables, Global Variables
- Autocompletion for keywords and runtime primitives
