// Copyright 2026 Stéphane Sibué
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as vscode from "vscode";
import * as dgram  from "dgram";
import * as net    from "net";
import * as os     from "os";

// ─────────────────────────────────────────────────────────────────────────────
// PROTOCOL
// ─────────────────────────────────────────────────────────────────────────────

interface ServerMessage {
    Source:     string;
    Function:   string;
    Parameters: string[];
}

const PROTOCOL = {
    SOURCE:      "MOGWAI STUDIO",
    WHO_IS_HERE: "WHO IS HERE",  // broadcast envoyé par le client
    I_AM_HERE:   "I AM HERE",    // réponse du runtime
    RUN:         "RUN",
    DEBUG:       "DEBUG",
    TROFF:       "TROFF",
    PAUSE:       "PAUSE",
    RESUME:      "RESUME",
    STEP:        "STEP",
    HALT:        "HALT",
    // messages reçus du runtime
    PRG_START:   "PRG START",
    PRG_STOP:    "PRG STOP",
    PRG_ERROR:   "PRG ERROR",
    PRG_PAUSE:   "PRG PAUSE",
    PRG_RESUME:  "PRG RESUME",
    PRG_INFO:    "PRG INFO",
    TRACE:       "TRACE",
    IAH: {
        NAME:       0,
        PORT:       1,
        VERSION:    2,
        PLATFORM:   3,
        ARCH:       4,
        OS:         5,
        FRAMEWORK:  6,
        SKILLS:     7,  // toujours vide
        PRIMITIVES: 8,  // "nom GE\tnom MH\t..."
        EXTERNALS:  9   // primitives externes, même format
    }
} as const;

function makeMessage(fn: string, ...params: string[]): ServerMessage {
    return {
        Source:     PROTOCOL.SOURCE,
        Function:   fn,
        Parameters: params
    };
}

function serialize(msg: ServerMessage): Buffer {
    return Buffer.from(JSON.stringify(msg), "utf8");
}

function deserialize(data: Buffer): ServerMessage | null {
    try {
        const msg = JSON.parse(data.toString("utf8")) as ServerMessage;
        if (
            typeof msg.Source   === "string" &&
            typeof msg.Function === "string" &&
            Array.isArray(msg.Parameters)
        ) {
            return msg;
        }
        return null;
    } catch {
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface PrimitiveEntry {
    name:  string;  // ex: "->upper"
    group: string;  // ex: "GE", "MH", "SK", "RT", "ER", "DG"
}

interface RuntimeInfo {
    name:       string;
    ip:         string;  // source du paquet UDP
    port:       number;  // P1
    version:    string;  // P2
    platform:   string;  // P3
    arch:       string;  // P4
    os:         string;  // P5
    framework:  string;  // P6
    primitives: PrimitiveEntry[];  // P8 parsé
    externals:  PrimitiveEntry[];  // P9 parsé
}

interface RuntimeQuickPickItem extends vscode.QuickPickItem {
    runtime: RuntimeInfo;
}

// ─────────────────────────────────────────────────────────────────────────────
// PARSING
// ─────────────────────────────────────────────────────────────────────────────

function parsePrimitives(raw: string): PrimitiveEntry[] {
    if (!raw) { return []; }
    return raw
        .split("\t")
        .map(entry => entry.trim())
        .filter(entry => entry.length > 0)
        .map(entry => {
            const lastSpace = entry.lastIndexOf(" ");
            if (lastSpace === -1) {
                return { name: entry, group: "GE" };
            }
            return {
                name:  entry.substring(0, lastSpace).trim(),
                group: entry.substring(lastSpace + 1).trim()
            };
        });
}

function parseIAmHere(msg: ServerMessage, ip: string): RuntimeInfo | null {
    const p = msg.Parameters;
    if (msg.Function !== PROTOCOL.I_AM_HERE || p.length < 9) {
        return null;
    }
    return {
        name:       p[PROTOCOL.IAH.NAME],
        ip,
        port:       parseInt(p[PROTOCOL.IAH.PORT], 10),
        version:    p[PROTOCOL.IAH.VERSION],
        platform:   p[PROTOCOL.IAH.PLATFORM],
        arch:       p[PROTOCOL.IAH.ARCH],
        os:         p[PROTOCOL.IAH.OS],
        framework:  p[PROTOCOL.IAH.FRAMEWORK],
        primitives: parsePrimitives(p[PROTOCOL.IAH.PRIMITIVES]),
        externals:  parsePrimitives(p[PROTOCOL.IAH.EXTERNALS] ?? "")
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// UDP DISCOVERY
// ─────────────────────────────────────────────────────────────────────────────

// Calcule les adresses de broadcast de toutes les interfaces réseau actives
function getBroadcastAddresses(): string[] {
    const results: string[] = [];
    const interfaces = os.networkInterfaces();
    for (const iface of Object.values(interfaces)) {
        if (!iface) { continue; }
        for (const info of iface) {
            // IPv4 uniquement, pas loopback
            if (info.family !== "IPv4" || info.internal) { continue; }
            // calcul de l'adresse de broadcast : ip | ~mask
            const ipParts   = info.address.split(".").map(Number);
            const maskParts = info.netmask.split(".").map(Number);
            const broadcast = ipParts
                .map((b, i) => (b | (~maskParts[i] & 0xff)))
                .join(".");
            results.push(broadcast);
        }
    }
    // fallback si aucune interface trouvée
    if (results.length === 0) { results.push("255.255.255.255"); }
    return results;
}

function discoverRuntimes(
    udpPort:   number,
    timeoutMs: number
): Promise<RuntimeInfo[]> {
    return new Promise((resolve) => {
        const found  = new Map<string, RuntimeInfo>(); // clé = "ip:port"
        const socket = dgram.createSocket("udp4");

        socket.on("message", (data, rinfo) => {
            const msg  = deserialize(data);
            if (!msg) { return; }
            // ignorer nos propres broadcasts WHO IS HERE
            if (msg.Function === PROTOCOL.WHO_IS_HERE) { return; }
            const info = parseIAmHere(msg, rinfo.address);
            if (!info) { return; }
            const key  = `${info.name}:${info.port}`;
            found.set(key, info); // déduplique si même runtime répond 2x
        });

        socket.on("error", (err: Error) => {
            socket.close();
            resolve([...found.values()]);
        });

        socket.bind(0, () => { // port aléatoire — le runtime répond au port source de notre message
            socket.setBroadcast(true);
            const msg       = makeMessage(PROTOCOL.WHO_IS_HERE);
            const buf       = serialize(msg);
            const addresses = getBroadcastAddresses();
            // envoi sur chaque adresse de broadcast des interfaces réseau
            for (const addr of addresses) {
                socket.send(buf, udpPort, addr, (err) => {
                    if (err) { console.error(`[MOGWAI] UDP broadcast error on ${addr}: ${err.message}`); }
                });
            }
        });

        // on attend timeoutMs puis on collecte
        setTimeout(() => {
            socket.close();
            resolve([...found.values()]);
        }, timeoutMs);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// QUICK PICK
// ─────────────────────────────────────────────────────────────────────────────

function toQuickPickItem(info: RuntimeInfo): RuntimeQuickPickItem {
    return {
        label:       `$(server) ${info.name}`,
        description: `${info.ip}:${info.port}  —  MOGWAI ${info.version}`,
        detail:      `${info.os}  •  ${info.framework}  •  ${info.arch}`,
        runtime:     info
    };
}

async function selectRuntime(): Promise<RuntimeInfo | undefined> {
    const config  = vscode.workspace.getConfiguration("mogwai");
    const udpPort = config.get<number>("runtime.udpPort",          1968);
    const timeout = config.get<number>("runtime.discoveryTimeoutMs", 5000);

    const runtimes = await vscode.window.withProgress(
        {
            location:    vscode.ProgressLocation.Notification,
            title:       "MOGWAI: Discovering runtimes…",
            cancellable: false
        },
        () => discoverRuntimes(udpPort, timeout)
    );

    if (runtimes.length === 0) {
        // fallback : connexion directe ip:port
        const input = await vscode.window.showInputBox({
            title:       "MOGWAI: Direct connection",
            prompt:      "No runtime found via UDP. Enter the runtime address manually.",
            placeHolder: "192.168.1.34:1968",
            validateInput: (v) => {
                const parts = v.split(":");
                if (parts.length !== 2 || isNaN(parseInt(parts[1], 10))) {
                    return "Format must be ip:port (ex: 192.168.1.34:1968)";
                }
                return null;
            }
        });
        if (!input) { return undefined; }
        const [ip, portStr] = input.split(":");
        return {
            name:       "MOGWAI Runtime",
            ip,
            port:       parseInt(portStr, 10),
            version:    "unknown",
            platform:   "unknown",
            arch:       "unknown",
            os:         "unknown",
            framework:  "unknown",
            primitives: [],
            externals:  []
        };
    }

    // Quick Pick dans tous les cas
    const items  = runtimes.map(toQuickPickItem);
    const picked = await vscode.window.showQuickPick(items, {
        title:              "MOGWAI: Select a runtime",
        placeHolder:        "Choose a runtime to connect to…",
        matchOnDescription: true,
        matchOnDetail:      true
    });

    return picked?.runtime;
}

// ─────────────────────────────────────────────────────────────────────────────
// RUNTIME CLIENT (TCP)
// ─────────────────────────────────────────────────────────────────────────────

class RuntimeClient {

    private readonly _info:   RuntimeInfo;
    private readonly _output: vscode.OutputChannel;
    private          _socket: net.Socket | undefined;
    private          _busy:   boolean = false;
    public           _lastInfo: { posStart: number; posEnd: number; filePath: string } | undefined;
    public           onUnexpectedDisconnect: (() => void) | undefined;

    constructor(info: RuntimeInfo, output: vscode.OutputChannel) {
        this._info   = info;
        this._output = output;
    }

    get primitives(): PrimitiveEntry[] {
        return [...this._info.primitives, ...this._info.externals];
    }

    get info():        RuntimeInfo { return this._info;                   }
    get isBusy():      boolean     { return this._busy;                   }
    get isConnected(): boolean     { return this._socket !== undefined;   }

    // ── Connexion persistante ────────────────────────────────────────────────
    public connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            const socket = new net.Socket();

            socket.connect(this._info.port, this._info.ip, () => {
                socket.setNoDelay(true); // désactive l'algorithme de Nagle — envoi immédiat
                this._socket = socket;
                this._output.appendLine(
                    `[MOGWAI] TCP connected to ${this._info.ip}:${this._info.port}`
                );
                resolve();
            });

            // buffer pour les messages fragmentés TCP
            let _buffer = "";

            socket.on("data", (chunk: Buffer) => {
                _buffer += chunk.toString("utf8");
                // le runtime envoie des lignes terminées par \n
                const lines = _buffer.split("\n");
                // la dernière entrée est soit vide soit un fragment incomplet
                _buffer = lines.pop() ?? "";

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) { continue; }

                    // tentative de parsing comme ServerMessage
                    let msg: ServerMessage | null = null;
                    try {
                        const parsed = JSON.parse(trimmed);
                        if (parsed.Source && parsed.Function && Array.isArray(parsed.Parameters)) {
                            msg = parsed as ServerMessage;
                        }
                    } catch { /* pas du JSON — texte brut */ }

                    if (msg) {
                        switch (msg.Function) {
                            case PROTOCOL.PRG_START: {
                                const debug = msg.Parameters[0] === "1" ? " [DEBUG]" : "";
                                this._output.appendLine(`▶ Running…${debug}`);
                                _debugState = "running";
                                clearDebugDecorations();
                                setStatusDebug();
                                break;
                            }
                            case PROTOCOL.PRG_STOP: {
                                this._output.appendLine(`■ Done in ${msToTimeSpan(msg.Parameters[0])}`);
                                this._busy    = false;
                                _debugState   = "idle";
                                _isDebugging  = false;
                                endDebugSession();
                                setStatusDebug();
                                refreshPanel();
                                restoreFocusToEditor();
                                break;
                            }
                            case PROTOCOL.PRG_ERROR: {
                                const errCode  = msg.Parameters[0];
                                const errMsg   = msg.Parameters[1];
                                const posStart = parseInt(msg.Parameters[3], 10);
                                const posEnd   = parseInt(msg.Parameters[4], 10);
                                this._output.appendLine(`✖ Error ${errCode} at pos ${posStart}-${posEnd}`);
                                this._output.appendLine(`  ${errMsg.replace(/\r\n/g, "\n  ")}`);
                                this._busy    = false;
                                _debugState   = "idle";
                                _isDebugging  = false;
                                endDebugSession();
                                setStatusDebug();
                                showErrorAt(posStart, posEnd);
                                refreshPanel();
                                restoreFocusToEditor();
                                break;
                            }
                            case PROTOCOL.PRG_PAUSE: {
                                this._output.appendLine(`⏸ Paused`);
                                _debugState = "paused";
                                setStatusDebug();
                                refreshPanel();
                                break;
                            }
                            case PROTOCOL.PRG_RESUME: {
                                this._output.appendLine(`▶ Resumed`);
                                _debugState = "running";
                                clearDebugDecorations();
                                setStatusDebug();
                                break;
                            }
                            case PROTOCOL.PRG_INFO: {
                                const filePath = msg.Parameters[0] ?? "";
                                const posStart = parseInt(msg.Parameters[3], 10);
                                const posEnd   = parseInt(msg.Parameters[4], 10);
                                this._lastInfo = { posStart, posEnd, filePath };
                                if (filePath && filePath.length > 0) {
                                    // fichier inclus : ouvrir si pas encore ouvert (TRON + pause)
                                    getOrOpenDebugEditor(filePath).then(editor => {
                                        if (editor && _debugState === "paused") {
                                            showDebugAtEditor(editor, posStart, posEnd, false);
                                        }
                                    });
                                } else if (_debugState === "paused") {
                                    // fichier principal : utiliser _mainFileUri pour éviter
                                    // que _activeEditor ne pointe vers un fichier inclus
                                    getMainFileEditor().then(editor => {
                                        if (editor) { showDebugAtEditor(editor, posStart, posEnd, false); }
                                    });
                                }
                                break;
                            }
                            case PROTOCOL.TRACE: {
                                if (this._lastInfo) {
                                    const { posStart, posEnd, filePath } = this._lastInfo;
                                    if (filePath && filePath.length > 0) {
                                        getOrOpenDebugEditor(filePath).then(editor => {
                                            if (editor) { showDebugAtEditor(editor, posStart, posEnd, true); }
                                        });
                                    } else {
                                        // fichier principal : utiliser _mainFileUri
                                        getMainFileEditor().then(editor => {
                                            if (editor) { showDebugAtEditor(editor, posStart, posEnd, true); }
                                        });
                                    }
                                }
                                refreshPanel();
                                break;
                            }
                            case "DEBUG MSG":
                                this._output.appendLine(`🔍 ${msg.Parameters[0] ?? ""}`);
                                break;
                            case "STACK":
                                _treeProvider?.updateStack(msg.Parameters);
                                break;
                            case "LVARS":
                                _treeProvider?.updateLocals(msg.Parameters);
                                break;
                            case "VARS":
                                _treeProvider?.updateGlobals(msg.Parameters);
                                break;
                            default:
                                // message non reconnu — ignoré silencieusement
                                break;
                        }
                    } else {
                        // texte brut (console.print, etc.)
                        this._output.appendLine(trimmed);
                    }
                }
            });

            socket.on("close", () => {
                if (this._socket) {
                    // fermeture inattendue (pas via disconnect())
                    this._output.appendLine("\n[MOGWAI] Runtime disconnected.");
                    this._socket = undefined;
                    this._busy   = false;
                    _debugState  = "idle";
                    _isDebugging = false;
                    this.onUnexpectedDisconnect?.();
                } else {
                    // fermeture normale via disconnect()
                    this._busy = false;
                }
            });

            socket.on("error", (err: Error) => {
                this._output.appendLine(`\n[MOGWAI] Connection lost: ${err.message}`);
                const wasConnected = this._socket !== undefined;
                this._socket = undefined;
                this._busy   = false;
                _debugState  = "idle";
                _isDebugging = false;
                if (wasConnected) {
                    // erreur sur une connexion établie → déconnexion inattendue
                    vscode.window.showWarningMessage(
                        `MOGWAI: Runtime disconnected — ${err.message}`
                    );
                    this.onUnexpectedDisconnect?.();
                } else {
                    // erreur à la connexion initiale
                    vscode.window.showErrorMessage(
                        `MOGWAI: Could not connect to runtime — ${err.message}`
                    );
                    reject(err);
                }
            });
        });
    }

    // ── Déconnexion ──────────────────────────────────────────────────────────
    public disconnect(): void {
        if (this._socket) {
            this._socket.destroy();
            this._socket = undefined;
        }
    }

    // ── Envoi d'une commande sur le socket persistant ────────────────────────
    public send(fn: string, ...params: string[]): void {
        if (!this._socket) {
            vscode.window.showErrorMessage("MOGWAI: Not connected to a runtime.");
            return;
        }
        const msg = makeMessage(fn, ...params);
        // WriteLineAsync côté C# : le runtime lit ligne par ligne, \n requis
        this._socket.write(serialize(msg).toString("utf8") + "\n");
    }

    // ── Exécution de code (RUN) ─────────────────────────────────────────────
    public run(code: string): void {
        _isDebugging = false;
        if (this._busy) {
            vscode.window.showWarningMessage("MOGWAI: Runtime is already executing code.");
            return;
        }
        this._busy = true;
        this._lastInfo = undefined;
        clearErrorDecoration();
        clearDebugDecorations();
        this._output.show(false);
        this._output.appendLine(
            `\n── RUN ──────────────────────── ${new Date().toLocaleTimeString()} ──`
        );
        this.send(PROTOCOL.TROFF);
        this.send(PROTOCOL.RUN, code);
    }

    // ── Exécution de code (DEBUG) ────────────────────────────────────────────
    public debug(code: string): void {
        _isDebugging = true;
        if (_activeEditor) { startDebugSession(_activeEditor); }
        if (this._busy) {
            vscode.window.showWarningMessage("MOGWAI: Runtime is already executing code.");
            return;
        }
        this._busy = true;
        this._lastInfo = undefined;
        clearErrorDecoration();
        clearDebugDecorations();
        this._output.show(false);
        this._output.appendLine(
            `\n── DEBUG ─────────────────────── ${new Date().toLocaleTimeString()} ──`
        );
        this.send(PROTOCOL.TROFF);
        this.send(PROTOCOL.DEBUG, code);
    }

    // ── Commandes debug ──────────────────────────────────────────────────────
    public pause():  void { this.send(PROTOCOL.PAUSE);  }
    public resume(): void { this.send(PROTOCOL.RESUME); }
    public step():   void { this.send(PROTOCOL.STEP);   }
    public halt():   void {
        this.send(PROTOCOL.HALT);
        this._busy    = false;
        _debugState   = "idle";
        _isDebugging  = false;
        endDebugSession();
        setStatusDebug();
        this._output.appendLine("■ Halted.");
        restoreFocusToEditor();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SEMANTIC TOKEN PROVIDER
// ─────────────────────────────────────────────────────────────────────────────

const GROUP_TOKEN_TYPE: Record<string, string> = {
    "GE": "function",  // General  → couleur fonction
    "MH": "number",    // Math     → couleur numérique
    "SK": "keyword",   // Stack    → couleur keyword
    "RT": "macro",     // Runtime  → couleur macro
    "ER": "type",      // Error    → couleur type
    "DG": "comment",   // Debug    → couleur commentaire (grisé)
};

const SEMANTIC_TOKENS_LEGEND = new vscode.SemanticTokensLegend(
    ["function", "number", "keyword", "macro", "type", "comment", "localFunction"],
    []
);

// Convertit des millisecondes en format TimeSpan .NET : hh:mm:ss.fffffff
function msToTimeSpan(msStr: string): string {
    const ms    = parseFloat(msStr.replace(",", "."));
    const totalMs = Math.round(ms * 10000); // en 100-nanosecondes
    const hns   = totalMs;
    const hours = Math.floor(hns / 36000000000);
    const mins  = Math.floor((hns % 36000000000) / 600000000);
    const secs  = Math.floor((hns % 600000000) / 10000000);
    const frac  = String(hns % 10000000).padStart(7, "0");
    return `${String(hours).padStart(2,"0")}:${String(mins).padStart(2,"0")}:${String(secs).padStart(2,"0")}.${frac}`;
}

function stripStrings(line: string): string {
    return line.replace(/"[^"]*"/g, (m) => " ".repeat(m.length));
}

class MogwaiSemanticTokenProvider
    implements vscode.DocumentSemanticTokensProvider {

    private _tokenMap = new Map<string, number>();

    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeSemanticTokens = this._onDidChange.event;

    public updatePrimitives(primitives: PrimitiveEntry[]): void {
        this._tokenMap.clear();
        for (const p of primitives) {
            const typeIndex = SEMANTIC_TOKENS_LEGEND.tokenTypes
                .indexOf(GROUP_TOKEN_TYPE[p.group] ?? "function");
            if (typeIndex >= 0) {
                this._tokenMap.set(p.name, typeIndex);
            }
        }
        this._onDidChange.fire();
    }

    public provideDocumentSemanticTokens(
        document: vscode.TextDocument
    ): vscode.SemanticTokens {

        const builder = new vscode.SemanticTokensBuilder(SEMANTIC_TOKENS_LEGEND);


        for (let lineIdx = 0; lineIdx < document.lineCount; lineIdx++) {
            const line = document.lineAt(lineIdx).text;

            if (line.trimStart().startsWith("#")) { continue; }

            const stripped   = stripStrings(line);
            const tokenRegex = /[^\s«»{}\[\]()]+/g;
            let match: RegExpExecArray | null;

            while ((match = tokenRegex.exec(stripped)) !== null) {
                const word         = match[0];
                const primitiveIndex = this._tokenMap.get(word);
                if (primitiveIndex !== undefined) {
                    builder.push(lineIdx, match.index, word.length, primitiveIndex, 0);
                }
            }
        }
        return builder.build();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MOGWAI TREE VIEW
// ─────────────────────────────────────────────────────────────────────────────

type SectionId = "stack" | "locals" | "globals";

class MogwaiTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label:    string,
        public readonly section:  SectionId | "root",
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly value?:   string,
        public readonly type?:    string
    ) {
        super(label, collapsibleState);
        if (value !== undefined) {
            this.description = type ? `${type}  ${value}` : value;
            this.tooltip     = this.description;
        }
    }
}

class MogwaiTreeProvider implements vscode.TreeDataProvider<MogwaiTreeItem> {

    private _stack:   string[] = [];
    private _locals:  string[] = [];
    private _globals: string[] = [];

    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData  = this._onDidChange.event;

    public updateStack(params: string[]): void {
        this._stack = params;
        this._onDidChange.fire();
    }

    public updateLocals(params: string[]): void {
        this._locals = params;
        this._onDidChange.fire();
    }

    public updateGlobals(params: string[]): void {
        this._globals = params;
        this._onDidChange.fire();
    }

    public clear(): void {
        this._stack   = [];
        this._locals  = [];
        this._globals = [];
        this._onDidChange.fire();
    }

    getTreeItem(element: MogwaiTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: MogwaiTreeItem): MogwaiTreeItem[] {
        if (!element) {
            // racine — les 3 sections
            return [
                new MogwaiTreeItem(
                    `Stack (${this._stack.length})`,
                    "stack", vscode.TreeItemCollapsibleState.Expanded
                ),
                new MogwaiTreeItem(
                    `Local Variables (${this._locals.length})`,
                    "locals", vscode.TreeItemCollapsibleState.Expanded
                ),
                new MogwaiTreeItem(
                    `Global Variables (${this._globals.length})`,
                    "globals", vscode.TreeItemCollapsibleState.Expanded
                ),
            ];
        }

        switch (element.section) {
            case "stack":
                return this._stack.map((v, i) =>
                    new MogwaiTreeItem(
                        `[${this._stack.length - i - 1}]`,
                        "stack",
                        vscode.TreeItemCollapsibleState.None,
                        v
                    )
                );
            case "locals":
                return this._parseVars(this._locals);
            case "globals":
                return this._parseVars(this._globals);
            default:
                return [];
        }
    }

    private _parseVars(params: string[]): MogwaiTreeItem[] {
        return params
            .filter(p => p.trim().length > 0)
            .map(p => {
                const parts = p.split("\t");
                const name  = parts[0] ?? p;
                const type  = parts[1] ?? "";
                const value = parts[2] ?? "";
                return new MogwaiTreeItem(
                    name, "locals",
                    vscode.TreeItemCollapsibleState.None,
                    value, type
                );
            });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPLETION PROVIDER
// ─────────────────────────────────────────────────────────────────────────────

const STATIC_KEYWORDS = [
    "if", "then", "else", "repeat", "while", "to", "with", "params", "do",
    "for", "step", "foreach", "timer", "every", "after", "guard", "trap",
    "onEvent", "forever", "switch", "during", "task", "send", "start",
    "returns", "transform", "filter", "class", "post", "true", "false", "null", "empty"
];

const GROUP_LABELS: Record<string, string> = {
    "GE": "General",
    "MH": "Math",
    "SK": "Stack",
    "RT": "Runtime",
    "ER": "Error",
    "DG": "Debug"
};

class MogwaiCompletionProvider implements vscode.CompletionItemProvider {

    private _primitives: PrimitiveEntry[] = [];

    public updatePrimitives(primitives: PrimitiveEntry[]): void {
        this._primitives = primitives;
    }

    public provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.CompletionItem[] {

        const linePrefix = document
            .lineAt(position)
            .text.substring(0, position.character);

        // ne pas proposer dans les commentaires
        if (linePrefix.trimStart().startsWith("#")) { return []; }

        // mot en cours de frappe
        const wordMatch = linePrefix.match(/[\w\->.!@&]+$/);
        const prefix    = wordMatch ? wordMatch[0].toLowerCase() : "";

        const items: vscode.CompletionItem[] = [];

        // keywords statiques
        for (const kw of STATIC_KEYWORDS) {
            if (prefix && !kw.toLowerCase().startsWith(prefix)) { continue; }
            const item = new vscode.CompletionItem(
                kw, vscode.CompletionItemKind.Keyword
            );
            item.detail = "MOGWAI keyword";
            items.push(item);
        }

        // primitives runtime
        for (const p of this._primitives) {
            if (prefix && !p.name.toLowerCase().startsWith(prefix)) { continue; }
            const kind = p.group === "MH"
                ? vscode.CompletionItemKind.Function
                : p.group === "SK"
                    ? vscode.CompletionItemKind.Operator
                    : vscode.CompletionItemKind.Method;
            const item  = new vscode.CompletionItem(p.name, kind);
            item.detail = GROUP_LABELS[p.group] ?? p.group;
            item.documentation = new vscode.MarkdownString(
                `**${p.name}** — ${GROUP_LABELS[p.group] ?? p.group} \`${p.group}\``
            );
            items.push(item);
        }

        return items;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENT SYMBOL PROVIDER
// ─────────────────────────────────────────────────────────────────────────────

class MogwaiDocumentSymbolProvider implements vscode.DocumentSymbolProvider {

    public provideDocumentSymbols(
        document: vscode.TextDocument
    ): vscode.DocumentSymbol[] {

        const symbols: vscode.DocumentSymbol[] = [];
        const text = document.getText();

        // Regex pour capturer les 3 formes de déclaration de fonction :
        // to 'foo' do { ... }
        // to 'foo' with [...] do { ... }
        // to 'foo' params [...] do { ... }
        const funcRegex = /to\s+'([^']+)'\s*((?:with|params)\s*\[[^\]]*\]\s*)?(?:returns\s*\([^)]*\)\s*)?do/g;

        let match: RegExpExecArray | null;
        while ((match = funcRegex.exec(text)) !== null) {
            const name      = match[1];
            const signature = match[0].replace(/\s+/g, " ").trim();
            const startPos  = document.positionAt(match.index);
            const endPos    = document.positionAt(match.index + match[0].length);
            const range     = new vscode.Range(startPos, endPos);

            const symbol = new vscode.DocumentSymbol(
                signature,                         // signature complète comme label
                "",                                // pas de détail séparé
                vscode.SymbolKind.Function,
                range,
                range
            );
            symbols.push(symbol);
        }

        return symbols;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// DEFINITION PROVIDER
// ─────────────────────────────────────────────────────────────────────────────

class MogwaiDefinitionProvider implements vscode.DefinitionProvider {

    public provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.Location | undefined {

        // Récupérer le mot sous le curseur
        const wordRange = document.getWordRangeAtPosition(position, /[^\s«»{}\[\]()']+/);
        if (!wordRange) { return undefined; }
        const word = document.getText(wordRange);
        if (!word) { return undefined; }

        // Chercher la déclaration to 'word' ... do dans le document
        const text     = document.getText();
        const declRegex = new RegExp(
            `to\\s+'${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'\\s*(?:(?:with|params)\\s*\\[[^\\]]*\\]\\s*)?(?:returns\\s*\\([^)]*\\)\\s*)?do`,
            "g"
        );

        const match = declRegex.exec(text);
        if (!match) { return undefined; }

        const pos = document.positionAt(match.index);
        return new vscode.Location(document.uri, pos);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ÉTAT GLOBAL
// ─────────────────────────────────────────────────────────────────────────────

let _client:      RuntimeClient               | undefined;
let _provider:    MogwaiSemanticTokenProvider | undefined;
let _output:      vscode.OutputChannel        | undefined;
let _status:        vscode.StatusBarItem | undefined;
let _statusRunning: vscode.StatusBarItem | undefined;  // spinner pendant exécution
let _statusStep:    vscode.StatusBarItem | undefined;  // bouton Step (pause only)
let _statusResume:  vscode.StatusBarItem | undefined;  // bouton Resume (pause only)
let _treeProvider:        MogwaiTreeProvider        | undefined;
let _completionProvider:  MogwaiCompletionProvider  | undefined;
let _activeEditor:        vscode.TextEditor          | undefined; // éditeur .mog actif (ref éphémère)
let _activeDocumentUri:   vscode.Uri                 | undefined; // URI stable du fichier .mog actif
let _mainFileUri:         vscode.Uri                 | undefined; // fichier principal du debug
let _debugEditors:        vscode.TextEditor[]        = [];        // éditeurs ouverts pendant le debug

// ── État debug ──────────────────────────────────────────────────────────────
type DebugState = "idle" | "running" | "paused";
let _debugState:   DebugState = "idle";
let _isDebugging:  boolean    = false;

// Décoration pour surligner les erreurs d'exécution
const _errorDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("inputValidation.errorBackground"),
    border:          "1px solid",
    borderColor:     new vscode.ThemeColor("inputValidation.errorBorder"),
    overviewRulerColor: new vscode.ThemeColor("inputValidation.errorBorder"),
    overviewRulerLane:  vscode.OverviewRulerLane.Right
});

function clearErrorDecoration(): void {
    _activeEditor?.setDecorations(_errorDecoration, []);
}

function restoreFocusToEditor(): void {
    if (_activeDocumentUri) {
        vscode.workspace.openTextDocument(_activeDocumentUri).then(doc => {
            vscode.window.showTextDocument(doc, { preserveFocus: false });
        });
    }
}

function updateLocalFunctionDecorations(
    editor: vscode.TextEditor,
    primitiveNames: Set<string>
): void {
    if (editor.document.languageId !== "mogwai") { return; }

    const text = editor.document.getText();
    const ranges: vscode.Range[] = [];

    // Extraire les noms de fonctions locales (hors primitives)
    const localNames = new Set<string>();
    const declRegex  = /to\s+'([^']+)'\s*(?:(?:with|params)\s*\[[^\]]*\]\s*)?(?:returns\s*\([^)]*\)\s*)?do/g;
    let m: RegExpExecArray | null;
    while ((m = declRegex.exec(text)) !== null) {
        const name = m[1];
        if (!primitiveNames.has(name)) { localNames.add(name); }
    }

    if (localNames.size === 0) {
        editor.setDecorations(_localFunctionDecoration, []);
        return;
    }

    // Colorier les appels (mots sans quotes)
    for (let lineIdx = 0; lineIdx < editor.document.lineCount; lineIdx++) {
        const line     = editor.document.lineAt(lineIdx).text;
        if (line.trimStart().startsWith("#")) { continue; }
        const stripped = stripStrings(line);
        const wordRe   = /[^\s«»{}\[\]()']+/g;
        let wm: RegExpExecArray | null;
        while ((wm = wordRe.exec(stripped)) !== null) {
            const word = wm[0];
            if (!localNames.has(word)) { continue; }
            // vérifier que le mot n'est pas précédé d'une quote dans la ligne originale
            if (line[wm.index - 1] === "'") { continue; }
            const start = editor.document.positionAt(
                editor.document.offsetAt(new vscode.Position(lineIdx, 0)) + wm.index
            );
            const end   = editor.document.positionAt(
                editor.document.offsetAt(new vscode.Position(lineIdx, 0)) + wm.index + word.length
            );
            ranges.push(new vscode.Range(start, end));
        }
    }
    editor.setDecorations(_localFunctionDecoration, ranges);
}

async function getMogwaiEditor(): Promise<vscode.TextEditor | undefined> {
    // Cherche uniquement les vrais fichiers .mog sur disque
    const mogDocs = vscode.workspace.textDocuments.filter(
        d => d.languageId === "mogwai" && d.uri.scheme === "file"
    );

    if (mogDocs.length === 0) {
        vscode.window.showWarningMessage(
            "MOGWAI: No .mog file open. Please open a MOGWAI script first."
        );
        return undefined;
    }

    // Préférer le dernier fichier utilisé
    if (_activeDocumentUri) {
        const preferred = mogDocs.find(d => d.uri.toString() === _activeDocumentUri!.toString());
        if (preferred) {
            const editor = await vscode.window.showTextDocument(preferred, { preserveFocus: false });
            _activeEditor = editor;
            return editor;
        }
    }

    if (mogDocs.length === 1) {
        const editor = await vscode.window.showTextDocument(mogDocs[0], { preserveFocus: false });
        _activeEditor      = editor;
        _activeDocumentUri = mogDocs[0].uri;
        return editor;
    }

    // plusieurs .mog ouverts → Quick Pick
    const items = mogDocs.map(d => ({
        label:       `$(file-code) ${d.fileName.split(/[\/]/).pop()}`,
        description: d.fileName,
        doc:         d
    }));
    const picked = await vscode.window.showQuickPick(items, {
        title:       "MOGWAI: Select the script to execute",
        placeHolder: "Choose a .mog file…"
    });
    if (!picked) { return undefined; }
    const editor = await vscode.window.showTextDocument(picked.doc, { preserveFocus: false });
    _activeEditor      = editor;
    _activeDocumentUri = picked.doc.uri;
    return editor;
}

async function setReadonly(editor: vscode.TextEditor, readonly: boolean): Promise<void> {
    await vscode.commands.executeCommand(
        readonly
            ? "workbench.action.files.setActiveEditorReadonlyInSession"
            : "workbench.action.files.setActiveEditorWriteableInSession",
        editor.document.uri
    );
}

async function startDebugSession(editor: vscode.TextEditor): Promise<void> {
    _mainFileUri  = editor.document.uri;
    _debugEditors = [];
    await setReadonly(editor, true);
}

async function endDebugSession(): Promise<void> {
    // repasser tous les éditeurs ouverts en éditable
    for (const editor of _debugEditors) {
        try { await setReadonly(editor, false); } catch { /* ignoré */ }
    }
    // repasser le fichier principal en éditable
    if (_activeEditor) {
        try { await setReadonly(_activeEditor, false); } catch { /* ignoré */ }
    }
    _debugEditors = [];
    _mainFileUri  = undefined;
    clearDebugDecorations();
}

async function getMainFileEditor(): Promise<vscode.TextEditor | undefined> {
    if (!_mainFileUri) { return _activeEditor; }
    try {
        const doc = await vscode.workspace.openTextDocument(_mainFileUri);
        // cherche un éditeur visible pour ce fichier
        const existing = vscode.window.visibleTextEditors.find(
            e => e.document.uri.fsPath === _mainFileUri!.fsPath
        );
        if (existing) { return existing; }
        // ouvrir si pas visible
        return await vscode.window.showTextDocument(doc, { preserveFocus: true });
    } catch {
        return _activeEditor;
    }
}

async function getOrOpenDebugEditor(filePath: string): Promise<vscode.TextEditor | undefined> {
    try {
        const uri = vscode.Uri.file(filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        // ouvrir côte à côte si pas déjà ouvert
        const existing = vscode.window.visibleTextEditors.find(
            e => e.document.uri.fsPath === uri.fsPath
        );
        if (existing) { return existing; }
        const editor = await vscode.window.showTextDocument(doc, {
            viewColumn:    vscode.ViewColumn.Beside,
            preserveFocus: true,
            preview:       false
        });
        await setReadonly(editor, true);
        _debugEditors.push(editor);
        return editor;
    } catch {
        return undefined;
    }
}

// Décoration pour les appels de fonctions déclarées localement
// Utilise charts.yellow qui est distinctement doré dans la plupart des thèmes sombres
const _localFunctionDecoration = vscode.window.createTextEditorDecorationType({
    color: new vscode.ThemeColor("charts.yellow"),
    fontStyle: "italic"
});

// Décoration pour l'instruction courante en debug (surligné en bleu)
const _debugCurrentDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("editor.stackFrameHighlightBackground"),
    border:          "1px solid",
    borderColor:     new vscode.ThemeColor("debugIcon.pauseForeground"),
    overviewRulerColor: new vscode.ThemeColor("debugIcon.pauseForeground"),
    overviewRulerLane:  vscode.OverviewRulerLane.Right
});

// Décoration TRACE (flash jaune — même zone mais couleur différente)
const _debugTraceDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("editor.focusedStackFrameHighlightBackground"),
    border:          "1px solid",
    borderColor:     new vscode.ThemeColor("debugIcon.stepOverForeground"),
    overviewRulerColor: new vscode.ThemeColor("debugIcon.stepOverForeground"),
    overviewRulerLane:  vscode.OverviewRulerLane.Right
});

function clearDebugDecorations(): void {
    _activeEditor?.setDecorations(_debugCurrentDecoration, []);
    _activeEditor?.setDecorations(_debugTraceDecoration, []);
}

function showDebugAt(startOffset: number, endOffset: number, trace: boolean = false): void {
    if (_activeEditor) { showDebugAtEditor(_activeEditor, startOffset, endOffset, trace); }
}

function showDebugAtEditor(editor: vscode.TextEditor, startOffset: number, endOffset: number, trace: boolean = false): void {
    const doc   = editor.document;
    const start = doc.positionAt(startOffset);
    const end   = doc.positionAt(endOffset + 1);
    const range = new vscode.Range(start, end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    if (trace) {
        editor.setDecorations(_debugTraceDecoration, [range]);
        editor.setDecorations(_debugCurrentDecoration, []);
    } else {
        editor.setDecorations(_debugCurrentDecoration, [range]);
        editor.setDecorations(_debugTraceDecoration, []);
    }
}

function showErrorAt(startOffset: number, endOffset: number): void {
    const editor = _activeEditor;
    if (!editor) { return; }
    const doc   = editor.document;
    const start = doc.positionAt(startOffset);
    const end   = doc.positionAt(endOffset + 1);
    const range = new vscode.Range(start, end);
    // positionne le curseur et révèle la zone
    editor.selection = new vscode.Selection(start, end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    // surligne en rouge
    editor.setDecorations(_errorDecoration, [range]);
}

function refreshPanel(): void {
    if (!_client || !_treeProvider) { return; }
    // Les réponses arrivent via le handler data du socket persistant
    _client.send("?STACK");
    _client.send("?LVARS");
    _client.send("?VARS");
}

function setStatus(state: "connected" | "disconnected", info?: RuntimeInfo): void {
    if (!_status) { return; }
    if (state === "connected" && info) {
        _status.text    = `$(plug) MOGWAI: ${info.name} v${info.version}`;
        _status.tooltip = `${info.ip}:${info.port} — ${info.os}`;
        _status.color   = new vscode.ThemeColor("statusBarItem.prominentForeground");
    } else {
        _status.text    = "$(debug-disconnect) MOGWAI: not connected";
        _status.tooltip = "Click to connect to a MOGWAI runtime";
        _status.color   = undefined;
    }
    setStatusDebug();
}

function setStatusDebug(): void {
    // expose l'état debug à VS Code pour les clauses when dans package.json
    vscode.commands.executeCommand("setContext", "mogwai.debugState", _debugState);
    vscode.commands.executeCommand("setContext", "mogwai.isDebugging", _isDebugging);
    vscode.commands.executeCommand("setContext", "mogwai.isConnected", _client !== undefined);

    if (!_client) {
        _statusRunning?.hide();
        _statusStep?.hide();
        _statusResume?.hide();
        return;
    }
    switch (_debugState) {
        case "running":
            if (_statusRunning) {
                _statusRunning.text    = "$(sync~spin) Running";
                _statusRunning.tooltip = "Click to pause execution";
                _statusRunning.command = "mogwai.pause";
                _statusRunning.show();
            }
            _statusStep?.hide();
            _statusResume?.hide();
            break;
        case "paused":
            _statusRunning?.hide();
            _statusStep?.hide();
            _statusResume?.hide();
            break;
        case "idle":
        default:
            _statusRunning?.hide();
            _statusStep?.hide();
            _statusResume?.hide();
            break;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVATE / DEACTIVATE
// ─────────────────────────────────────────────────────────────────────────────

export function activate(ctx: vscode.ExtensionContext): void {

    _output = vscode.window.createOutputChannel("MOGWAI");

    // Completion Provider
    _completionProvider = new MogwaiCompletionProvider();
    ctx.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: "mogwai" },
            _completionProvider,
            // triggers : lettres, -, >, ., !, @, &
        )
    );

    // Document Symbol Provider (Outline + Ctrl+Shift+O)
    ctx.subscriptions.push(
        vscode.languages.registerDocumentSymbolProvider(
            { language: "mogwai" },
            new MogwaiDocumentSymbolProvider()
        )
    );

    // Definition Provider (F12 / Go to Definition)
    ctx.subscriptions.push(
        vscode.languages.registerDefinitionProvider(
            { language: "mogwai" },
            new MogwaiDefinitionProvider()
        )
    );

    // Tree View
    _treeProvider = new MogwaiTreeProvider();
    const treeView = vscode.window.createTreeView("mogwaiRuntimeView", {
        treeDataProvider: _treeProvider,
        showCollapseAll:  true
    });
    ctx.subscriptions.push(treeView);

    _status = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left, 100
    );
    _status.command = "mogwai.connectRuntime";
    setStatus("disconnected");
    _status.show();

    vscode.commands.executeCommand("setContext", "mogwai.debugState", "idle");
    vscode.commands.executeCommand("setContext", "mogwai.isConnected", false);
    vscode.commands.executeCommand("setContext", "mogwai.isDebugging", false);
    _statusRunning = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    _statusRunning.hide();
    _statusStep    = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    _statusStep.hide();
    _statusResume  = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
    _statusResume.hide();


    _provider = new MogwaiSemanticTokenProvider();
    ctx.subscriptions.push(
        vscode.languages.registerDocumentSemanticTokensProvider(
            { language: "mogwai" },
            _provider,
            SEMANTIC_TOKENS_LEGEND
        )
    );

    // ── Connect / Disconnect (status bar) ───────────────────────────────────
    ctx.subscriptions.push(
        vscode.commands.registerCommand(
            "mogwai.connectRuntime",
            async () => {
                // si déjà connecté → proposer la déconnexion
                if (_client) {
                    const answer = await vscode.window.showInformationMessage(
                        `Disconnect from ${_client.info.name} (${_client.info.ip}:${_client.info.port}) ?`,
                        { modal: true },
                        "Disconnect"
                    );
                    if (answer === "Disconnect") {
                        _client.disconnect();
                        _client = undefined;
                        _provider!.updatePrimitives([]);
                        setStatus("disconnected");
                        _output!.appendLine("[MOGWAI] Disconnected.");
                    }
                    return;
                }

                // sinon → découverte UDP + Quick Pick
                const info = await selectRuntime();
                if (!info) { return; }

                _client = new RuntimeClient(info, _output!);
                _client.onUnexpectedDisconnect = () => {
                    _client = undefined;
                    _provider!.updatePrimitives([]);
                    _completionProvider?.updatePrimitives([]);
                    _treeProvider?.clear();
                    clearDebugDecorations();
                    setStatus("disconnected");
                    setStatusDebug();
                    vscode.commands.executeCommand("setContext", "mogwai.isConnected", false);
                    vscode.commands.executeCommand("setContext", "mogwai.debugState", "idle");
                    vscode.commands.executeCommand("setContext", "mogwai.isDebugging", false);
                };
                try {
                    await _client.connect();
                } catch {
                    _client = undefined;
                    return;
                }

                _provider!.updatePrimitives(_client.primitives);
                _completionProvider?.updatePrimitives(_client.primitives);
                setStatus("connected", info);
                vscode.commands.executeCommand("setContext", "mogwai.isConnected", true);
                // Mettre à jour le coloriage des fonctions locales avec les nouvelles primitives
                vscode.window.visibleTextEditors
                    .filter(ed => ed.document.languageId === "mogwai")
                    .forEach(ed => updateLocalFunctionDecorations(ed, getPrimitiveNames()));
                refreshPanel();

                _output!.appendLine(
                    `[MOGWAI] Connected to ${info.name} — `    +
                    `${info.ip}:${info.port} — `               +
                    `v${info.version} — `                       +
                    `${info.primitives.length + info.externals.length} primitives loaded`
                );
            }
        )
    );

    // ── Run Current File ─────────────────────────────────────────────────────
    ctx.subscriptions.push(
        vscode.commands.registerCommand(
            "mogwai.runFile",
            async () => {
                const editor = await getMogwaiEditor();
                if (!editor) { return; }

                // connexion automatique si pas encore connecté
                if (!_client) {
                    const info = await selectRuntime();
                    if (!info) { return; }
                    _client = new RuntimeClient(info, _output!);
                    _client.onUnexpectedDisconnect = () => {
                        _client = undefined;
                        _provider!.updatePrimitives([]);
                        _completionProvider?.updatePrimitives([]);
                        _treeProvider?.clear();
                        clearDebugDecorations();
                        setStatus("disconnected");
                        setStatusDebug();
                        vscode.commands.executeCommand("setContext", "mogwai.isConnected", false);
                        vscode.commands.executeCommand("setContext", "mogwai.debugState", "idle");
                        vscode.commands.executeCommand("setContext", "mogwai.isDebugging", false);
                    };
                    try {
                        await _client.connect();
                    } catch {
                        _client = undefined;
                        return;
                    }
                    _provider!.updatePrimitives(_client.primitives);
                    _completionProvider?.updatePrimitives(_client.primitives);
                    setStatus("connected", info);
                }

                _activeEditor      = editor;
                _activeDocumentUri = editor.document.uri;
                const code = editor.document.getText();
                _client.run(code);
            }
        )
    );

    // ── Disconnect ───────────────────────────────────────────────────────────
    ctx.subscriptions.push(
        vscode.commands.registerCommand(
            "mogwai.disconnectRuntime",
            () => {
                if (_client) {
                    _client.disconnect();
                    _client = undefined;
                }
                _provider!.updatePrimitives([]);
                _completionProvider?.updatePrimitives([]);
                _treeProvider?.clear();
                setStatus("disconnected");
                vscode.commands.executeCommand("setContext", "mogwai.isConnected", false);
                _output!.appendLine("[MOGWAI] Disconnected.");
            }
        )
    );

    // ── Refresh Panel ────────────────────────────────────────────────────────
    ctx.subscriptions.push(
        vscode.commands.registerCommand("mogwai.refreshPanel", async () => {
            await refreshPanel();
        })
    );

    // ── Insert Function Call ─────────────────────────────────────────────────
    ctx.subscriptions.push(
        vscode.commands.registerCommand("mogwai.insertFunction", async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== "mogwai") {
                vscode.window.showWarningMessage("MOGWAI: No active .mog file.");
                return;
            }

            // Extraire toutes les fonctions déclarées dans le document
            const text      = editor.document.getText();
            const funcRegex = /to\s+'([^']+)'\s*(?:(?:with|params)\s*\[[^\]]*\]\s*)?(?:returns\s*\([^)]*\)\s*)?do/g;
            const functions: { label: string; name: string }[] = [];
            let m: RegExpExecArray | null;
            while ((m = funcRegex.exec(text)) !== null) {
                const signature = m[0].replace(/\s+/g, " ").trim();
                functions.push({ label: signature, name: m[1] });
            }

            if (functions.length === 0) {
                vscode.window.showWarningMessage("MOGWAI: No functions declared in this file.");
                return;
            }

            // Quick Pick avec toutes les fonctions
            const picked = await vscode.window.showQuickPick(
                functions.map(f => ({
                    label:       `$(symbol-function) ${f.label}`,
                    description: f.name,
                    name:        f.name
                })),
                {
                    title:       "MOGWAI: Insert Function Call",
                    placeHolder: "Choose a function to insert…"
                }
            );
            if (!picked) { return; }

            // Insérer le nom de la fonction à la position du curseur
            await editor.edit(editBuilder => {
                for (const selection of editor.selections) {
                    editBuilder.replace(selection, picked.name);
                }
            });
        })
    );

    // ── Debug Current File ──────────────────────────────────────────────────
    ctx.subscriptions.push(
        vscode.commands.registerCommand("mogwai.debugFile", async () => {
            const editor = await getMogwaiEditor();
            if (!editor) { return; }

            if (!_client) {
                const info = await selectRuntime();
                if (!info) { return; }
                _client = new RuntimeClient(info, _output!);
                _client.onUnexpectedDisconnect = () => {
                    _client = undefined;
                    _provider!.updatePrimitives([]);
                    _completionProvider?.updatePrimitives([]);
                    _treeProvider?.clear();
                    clearDebugDecorations();
                    setStatus("disconnected");
                    setStatusDebug();
                    vscode.commands.executeCommand("setContext", "mogwai.isConnected", false);
                    vscode.commands.executeCommand("setContext", "mogwai.debugState", "idle");
                    vscode.commands.executeCommand("setContext", "mogwai.isDebugging", false);
                };
                try { await _client.connect(); } catch { _client = undefined; return; }
                _provider!.updatePrimitives(_client.primitives);
                _completionProvider?.updatePrimitives(_client.primitives);
                setStatus("connected", info);
            }
            _activeEditor      = editor;
            _activeDocumentUri = editor.document.uri;
            _client.debug(editor.document.getText());
        })
    );

    // ── Pause ────────────────────────────────────────────────────────────────
    ctx.subscriptions.push(
        vscode.commands.registerCommand("mogwai.pause", () => {
            _client?.pause();
        })
    );

    // ── Resume ───────────────────────────────────────────────────────────────
    ctx.subscriptions.push(
        vscode.commands.registerCommand("mogwai.resume", () => {
            _client?.resume();
        })
    );

    // ── Step ─────────────────────────────────────────────────────────────────
    ctx.subscriptions.push(
        vscode.commands.registerCommand("mogwai.step", () => {
            _client?.step();
        })
    );

    // ── Halt ─────────────────────────────────────────────────────────────────
    ctx.subscriptions.push(
        vscode.commands.registerCommand("mogwai.halt", () => {
            _client?.halt();
        })
    );

    // Helper pour obtenir les noms de primitives actuelles
    const getPrimitiveNames = (): Set<string> => {
        const names = new Set<string>();
        if (_client) {
            for (const p of _client.primitives) { names.add(p.name); }
        }
        return names;
    };

    // Maintenir _activeEditor à jour — ignore Output Channel et non-.mog
    ctx.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor && editor.document.languageId === "mogwai" && editor.document.uri.scheme === "file") {
                _activeEditor      = editor;
                _activeDocumentUri = editor.document.uri;
                updateLocalFunctionDecorations(editor, getPrimitiveNames());
            }
        })
    );

    // Colorier les fonctions locales dans les fichiers .mog déjà ouverts au démarrage
    vscode.window.visibleTextEditors
        .filter(ed => ed.document.languageId === "mogwai" && ed.document.uri.scheme === "file")
        .forEach(ed => updateLocalFunctionDecorations(ed, getPrimitiveNames()));

    // Effacer la décoration d'erreur dès que l'utilisateur modifie le fichier
    ctx.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document.languageId === "mogwai" && e.contentChanges.length > 0) {
                clearErrorDecoration();
                clearDebugDecorations();
                // Mettre à jour le coloriage des fonctions locales
                const editor = vscode.window.visibleTextEditors.find(
                    ed => ed.document === e.document
                );
                if (editor) { updateLocalFunctionDecorations(editor, getPrimitiveNames()); }
            }
        })
    );

    ctx.subscriptions.push(
        { dispose: () => {
            _output?.dispose();
            _status?.dispose();
            _statusRunning?.dispose();
            _statusStep?.dispose();
            _statusResume?.dispose();

        } }
    );
}

export function deactivate(): void {
    _client   = undefined;
    _provider = undefined;
}
