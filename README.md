# MOGWAI Language Support for Visual Studio Code

Full language support for [MOGWAI](https://www.mogwai.eu.com) — a stack-based RPN scripting engine for .NET

---

## Features

### Syntax Highlighting

MOGWAI `.mog` files are fully colorized out of the box:

- **Control keywords** — `if`, `then`, `else`, `while`, `for`, `foreach`, `forever`, `switch`, `guard`, `trap`, `task`, `class`, and more
- **Operators** — `->` (store), `=>` (typed store), `-->` (pipeline), `->+` `->-` `->*` `->/` (compound store)
- **Sigils** — `&A` (in-place reference), `@A` (static eval), `!A` (auto-eval)
- **Strings** — with `{! ... }` interpolation blocks
- **Variable names** — `'A'`, `'myVar'`
- **Numbers** — integers, floats, hexadecimal
- **Constants** — `true`, `false`, `null`, `empty`
- **Comments** — `# line comment`
- **Delimiters** — `«»` (functions), `{}` (blocks), `[]` (records), `()` (lists)

### Dynamic Primitive Highlighting

When connected to a MOGWAI runtime, all runtime primitives are colorized according to their group:

| Group | Category | Color |
|-------|----------|-------|
| `GE` | General | function color |
| `MH` | Math | numeric color |
| `SK` | Stack | keyword color |
| `RT` | Runtime | macro color |
| `ER` | Error | type color |
| `DG` | Debug | comment color (dimmed) |

The highlighting updates automatically when you connect to a different runtime.

### Locally Declared Functions

Functions you declare with `to '...' do { }`, `to '...' with [...] do { }`, `to '...' params [...] do { }`, with or without a `returns (...)` clause, are automatically recognized:

- **Colored in golden italic** — visually distinct from language keywords and runtime primitives
- **Go to Definition** (`F12` or right-click) — jump directly to a function's declaration from any call site
- **Insert Function Call** — Quick Pick of all declared functions, insert the selected name at the cursor position

If a function name conflicts with a runtime primitive, the primitive color takes priority. This feature works even without a connected runtime.

### Function List

All functions declared in the current file are listed in two places:

- **Outline panel** (Explorer sidebar) — full signature for each function
- **Go to Symbol** (`Ctrl+Shift+O`) — filter by name, jump directly to the declaration

### Snippets

Ready-to-use snippets for all common structures:

| Prefix | Structure |
|--------|-----------|
| `if` | if / then |
| `ife` | if / then / else |
| `while` | while / do |
| `dowhile` | do / while |
| `for` | for loop |
| `fors` | for loop with step |
| `repeat` | repeat N times |
| `forever` | infinite loop |
| `foreach` | foreach / do |
| `transform` | foreach / transform (map) |
| `filter` | foreach / filter |
| `switch` | switch block |
| `to` | function declaration |
| `tow` | function with typed parameters |
| `top` | function with default parameters |
| `store` | `->` variant store |
| `storet` | `=>` typed store |
| `interp` | string interpolation |

### Runtime Connection & Execution

The extension connects directly to a running MOGWAI runtime over TCP/IP.

- **Auto-discovery** — broadcasts a UDP discovery message on the local network and lists all responding runtimes
- **Quick Pick** — select the runtime to connect to (name, IP:port, version, OS, framework)
- **Run** — executes the current `.mog` file, results stream to the MOGWAI Output Channel
- **Error navigation** — on execution error, the cursor jumps to the exact error position and the zone is highlighted in red
- **Status bar** — shows the connected runtime name and version

### Debugging

- **Debug mode** — honors breakpoints (`debug.halt` primitive or `¤` symbol)
- **Pause / Step / Resume / Halt** — full control over execution from the editor toolbar
- **Current instruction highlighted in blue** while paused
- **Multi-file debugging** — when a script includes other files via `mogwai.include`, the debugger follows execution across files, opening included files side by side automatically
- **TRON mode** — `debug.tron` animates execution instruction by instruction with a configurable delay, following the code in real time across included files too

### Runtime Panel

A dedicated **MOGWAI** panel in the sidebar shows, in real time:

- **Stack** — current contents of the MOGWAI stack (RPN)
- **Local Variables** — name, type, and value
- **Global Variables** — name, type, and value

Refreshes automatically after each execution, pause, or step. Manual refresh available.

### Autocompletion

Suggestions as you type:

- MOGWAI static keywords (`if`, `while`, `foreach`, `forever`, `class`...)
- Primitives from the connected runtime, with their group shown as detail

---

## Requirements

- A running MOGWAI runtime (v8.0 or later) with the studio mode active
- The runtime must be reachable on the local network (UDP port 1968 for discovery, TCP port provided by the runtime)

---

## Getting Started

1. Open any `.mog` file — syntax highlighting activates automatically
2. Click **`$(plug) MOGWAI: not connected`** in the status bar, or run **MOGWAI: Connect to Runtime** from the Command Palette (`Ctrl+Shift+P`)
3. Select a runtime from the list
4. Click the **▶** button in the editor toolbar or run **MOGWAI: Run Current File**

---

## Commands

| Command | Description |
|---------|--------------|
| `MOGWAI: Connect to Runtime` | Discover and connect to a MOGWAI runtime |
| `MOGWAI: Disconnect` | Disconnect from the current runtime |
| `MOGWAI: Run Current File` | Execute the current `.mog` file |
| `MOGWAI: Debug Current File` | Execute with breakpoint support |
| `MOGWAI: Pause` | Pause execution |
| `MOGWAI: Step` | Execute the next instruction |
| `MOGWAI: Resume` | Resume execution |
| `MOGWAI: Halt` | Stop execution immediately |
| `MOGWAI: Refresh` | Refresh the Runtime panel |
| `MOGWAI: Insert Function Call` | Insert a declared function's name at the cursor |

---

## Extension Settings

| Setting | Default | Description |
|---------|---------|--------------|
| `mogwai.runtime.udpPort` | `1968` | UDP port used for runtime discovery |
| `mogwai.runtime.discoveryTimeoutMs` | `5000` | Discovery timeout in milliseconds |

---

## About MOGWAI

MOGWAI is a stack-based RPN scripting engine for .NET, inspired by HP RPL (HP 28S, HP 48). It has been in development for over 10 years and was open-sourced in February 2026 under the Apache 2.0 license.

→ [MOGWAI on GitHub](https://github.com/Sydney680928/mogwai)

→ [Full VS Code integration guide](https://github.com/Sydney680928/mogwai/tree/main/docs/EN/MOGWAI_VSCODE.md)
