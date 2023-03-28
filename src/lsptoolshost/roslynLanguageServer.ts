/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { registerCommands } from './commands';
import { UriConverter } from './uriConverter';

import {
    DidOpenTextDocumentNotification,
    DidChangeTextDocumentNotification,
    DidCloseTextDocumentNotification,
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    DidCloseTextDocumentParams,
    DidOpenTextDocumentParams,
    DidChangeTextDocumentParams,
    State,
    Trace,
} from 'vscode-languageclient/node';
import { PlatformInformation } from '../shared/platform';
import { DotnetResolver } from '../shared/DotnetResolver';
import { readConfigurations } from './configurationMiddleware';
import OptionProvider from '../shared/observers/OptionProvider';
import { DynamicFileInfoHandler } from '../razor/src/DynamicFile/DynamicFileInfoHandler';
import ShowInformationMessage from '../shared/observers/utils/ShowInformationMessage';

let _languageServer: RoslynLanguageServer;
let _channel: vscode.OutputChannel;
let _traceChannel: vscode.OutputChannel;

const csharpDevkitExtensionId = "ms-dotnettools.csdevkit";

export class RoslynLanguageServer {

    // These are commands that are invoked by the Razor extension, and are used to send LSP requests to the Roslyn LSP server
    // to update the text contents of Razor generated files.
    public static readonly roslynDidOpenCommand: string = 'roslyn.openRazorCSharp';
    public static readonly roslynDidChangeCommand: string = 'roslyn.changeRazorCSharp';
    public static readonly roslynDidCloseCommand: string = 'roslyn.closeRazorCSharp';

    // These are notifications we will get from the LSP server and will forward to the Razor extension.
    private static readonly provideRazorDynamicFileInfoMethodName: string = 'razor/provideDynamicFileInfo';
    private static readonly removeRazorDynamicFileInfoMethodName: string = 'razor/removeDynamicFileInfo';

    /**
     * The timeout for stopping the language server (in ms).
     */
    private static _stopTimeout: number = 10000;
    private _languageClient: LanguageClient | undefined;

    /**
     * Flag indicating if C# Devkit was installed the last time we activated.
     * Used to determine if we need to restart the server on extension changes.
     */
    private _wasActivatedWithCSharpDevkit: boolean | undefined;

    constructor(
        private platformInfo: PlatformInformation,
        private optionProvider: OptionProvider,
        private context: vscode.ExtensionContext,
    ) {
        // subscribe to extension change events so that we can get notified if C# Devkit is added/removed later.
        this.context.subscriptions.push(vscode.extensions.onDidChange(async () => {
            let csharpDevkitExtension = vscode.extensions.getExtension(csharpDevkitExtensionId);

            if (this._wasActivatedWithCSharpDevkit === undefined) {
                // Haven't activated yet.
                return;
            }

            const title = 'Restart Language Server';
            const command = 'dotnet.restartServer';
            if (csharpDevkitExtension && !this._wasActivatedWithCSharpDevkit) {
                // We previously started without C# Devkit and its now installed.
                // Offer a prompt to restart the server to use C# Devkit.
                _channel.appendLine(`Detected new installation of ${csharpDevkitExtensionId}`);
                let message = `Detected installation of ${csharpDevkitExtensionId}. Would you like to relaunch the language server for added features?`;
                ShowInformationMessage(vscode, message, { title, command });
            } else {
                // Any other change to extensions is irrelevant - an uninstall requires a reload of the window
                // which will automatically restart this extension too.
            }
        }));
    }

    /**
     * Resolves server options and starts the dotnet language server process.
     */
    public async start(): Promise<void> {
        const dotnetResolver = new DotnetResolver(this.platformInfo);

        let options = this.optionProvider.GetLatestOptions();
        let resolvedDotnet = await dotnetResolver.getHostExecutableInfo(options);
        _channel.appendLine("Dotnet version: " + resolvedDotnet.version);

        let solutions = await vscode.workspace.findFiles('*.sln', '**/node_modules/**', 1);
        let solutionPath: vscode.Uri | undefined = solutions[0];

        if (solutionPath) {
            _channel.appendLine(`Found solution ${solutionPath}`);
        }

        let logLevel = options.languageServerOptions.logLevel;
        const languageClientTraceLevel = this.GetTraceLevel(logLevel);

        let serverOptions: ServerOptions = async () => {
            return await this.startServer(solutionPath, logLevel);
        };

        let documentSelector = options.languageServerOptions.documentSelector;

        // Options to control the language client
        let clientOptions: LanguageClientOptions = {
            // Register the server for plain csharp documents
            documentSelector: documentSelector,
            synchronize: {
                // Notify the server about file changes to '.clientrc files contain in the workspace
                fileEvents: vscode.workspace.createFileSystemWatcher('**/*.*')
            },
            traceOutputChannel: _traceChannel,
            outputChannel: _channel,
            uriConverters: {
                // VSCode encodes the ":" as "%3A" in file paths, for example "file:///c%3A/Users/dabarbet/source/repos/ConsoleApp8/ConsoleApp8/Program.cs".
                // System.Uri does not decode the LocalPath property correctly into a valid windows path, instead you get something like
                // "/c:/Users/dabarbet/source/repos/ConsoleApp8/ConsoleApp8/Program.cs" (note the incorrect forward slashes and prepended "/").
                // Properly decoded, it would look something like "c:\Users\dabarbet\source\repos\ConsoleApp8\ConsoleApp8\Program.cs"
                // So instead we decode the URI here before sending to the server.
                code2Protocol: UriConverter.serialize,
                protocol2Code: UriConverter.deserialize,
            },
            middleware: {
                workspace: {
                    configuration: (params) => readConfigurations(params),
                }
            }
        };

        // Create the language client and start the client.
        let client = new LanguageClient(
            'microsoft-codeanalysis-languageserver',
            'Microsoft.CodeAnalysis.LanguageServer',
            serverOptions,
            clientOptions
        );

        client.registerProposedFeatures();

        this._languageClient = client;

        // Set the language client trace level based on the log level option.
        // setTrace only works after the client is already running.
        this._languageClient.onDidChangeState(async (state) => {
            if (state.newState === State.Running) {
                await this._languageClient!.setTrace(languageClientTraceLevel);
            }
        });

        // Start the client. This will also launch the server
        this._languageClient.start();

        // Register Razor dynamic file info handling
        this.registerRazor(this._languageClient);
    }

    public async stop(): Promise<void> {
        await this._languageClient?.stop(RoslynLanguageServer._stopTimeout);
        this._languageClient?.dispose(RoslynLanguageServer._stopTimeout);
        this._languageClient = undefined;
    }

    /**
     * Restarts the language server.
     * Note that since some options affect how the language server is initialized, we must
     * re-create the LanguageClient instance instead of just stopping/starting it.
     */
    public async restart(): Promise<void> {
        await this.stop();
        await this.start();
    }

    private async startServer(solutionPath: vscode.Uri | undefined, logLevel: string | undefined): Promise<cp.ChildProcess> {
        let clientRoot = __dirname;

        let serverPath = this.optionProvider.GetLatestOptions().commonOptions.serverPath;
        if (!serverPath) {
            // Option not set, use the path from the extension.
            serverPath = path.join(clientRoot, '..', '.roslyn', this.getServerFileName());
        }

        if (!fs.existsSync(serverPath)) {
            throw new Error(`Cannot find language server in path '${serverPath}''`);
        }

        // Get the brokered service pipe name from C# Devkit (if installed).
        // We explicitly call this in the LSP server start action instead of awaiting it
        // in our activation because C# Devkit depends on C# activation completing.
        let vsGreenExports = await this.waitForCSharpDevkitActivationAndGetExports();
        let brokeredServicePipeName = await this.getBrokeredServicePipeName(vsGreenExports);
        let starredCompletionComponentPath = this.getStarredCompletionComponentPath(vsGreenExports);

        let args: string[] = [ ];

        let options = this.optionProvider.GetLatestOptions();
        if (options.commonOptions.waitForDebugger) {
            args.push("--debug");
        }

        if (logLevel) {
            args.push("--logLevel", logLevel);
        }

        if (brokeredServicePipeName) {
            args.push("--brokeredServicePipeName", brokeredServicePipeName);
        }
        else if (solutionPath) {
            // We only add the solution path if we didn't have a pipe name; if we had a pipe name we won't be opening any solution right away but following
            // what the other process does.
            args.push("--solutionPath", solutionPath.fsPath);
        }

        if (starredCompletionComponentPath) {
            args.push("--starredCompletionComponentPath", starredCompletionComponentPath);
        }

        _channel.appendLine(`Starting server at ${serverPath}`);

        let childProcess: cp.ChildProcessWithoutNullStreams;
        if (serverPath.endsWith('.dll')) {
            // If we were given a path to a dll, launch that via dotnet.
            const argsWithPath = [ serverPath ].concat(args);
            childProcess = cp.spawn('dotnet', argsWithPath);
        } else {
            // Otherwise assume we were given a path to an executable.
            childProcess = cp.spawn(serverPath, args);
        }

        return childProcess;
    }

    private registerRazor(client: LanguageClient) {
        // When the Roslyn language server sends a request for Razor dynamic file info, we forward that request along to Razor via
        // a command.
        client.onRequest(
            RoslynLanguageServer.provideRazorDynamicFileInfoMethodName,
            async request => vscode.commands.executeCommand(DynamicFileInfoHandler.provideDynamicFileInfoCommand, request));
        client.onNotification(
            RoslynLanguageServer.removeRazorDynamicFileInfoMethodName,
            async notification => vscode.commands.executeCommand(DynamicFileInfoHandler.removeDynamicFileInfoCommand, notification));

        // Razor will call into us (via command) for generated file didOpen/didChange/didClose notifications. We'll then forward these
        // notifications along to Roslyn.
        vscode.commands.registerCommand(RoslynLanguageServer.roslynDidOpenCommand, (notification: DidOpenTextDocumentParams) => {
            client.sendNotification(DidOpenTextDocumentNotification.method, notification);
        });
        vscode.commands.registerCommand(RoslynLanguageServer.roslynDidChangeCommand, (notification: DidChangeTextDocumentParams) => {
            client.sendNotification(DidChangeTextDocumentNotification.method, notification);
        });
        vscode.commands.registerCommand(RoslynLanguageServer.roslynDidCloseCommand, (notification: DidCloseTextDocumentParams) => {
            client.sendNotification(DidCloseTextDocumentNotification.method, notification);
        });
    }

    private getServerFileName() {
        const serverFileName = 'Microsoft.CodeAnalysis.LanguageServer';
        let extension = '';
        if (this.platformInfo.isWindows()) {
            extension = '.exe';
        }

        if (this.platformInfo.isMacOS()) {
            // MacOS executables must be signed with codesign.  Currently all Roslyn server executables are built on windows
            // and therefore dotnet publish does not automatically sign them.
            // Tracking bug - https://devdiv.visualstudio.com/DevDiv/_workitems/edit/1767519/
            extension = '.dll';
        }

        return `${serverFileName}${extension}`;
    }

    private async waitForCSharpDevkitActivationAndGetExports(): Promise<any | undefined> {
        let csharpDevkitExtension = vscode.extensions.getExtension(csharpDevkitExtensionId);
        if (!csharpDevkitExtension) {
            // C# Devkit is not installed - continue C#-only activation.
            _channel.appendLine("Activating C# standalone...");
            this._wasActivatedWithCSharpDevkit = false;
            return undefined;
        }

        _channel.appendLine("Activating C# + Devkit...");
        this._wasActivatedWithCSharpDevkit = true;
        return await csharpDevkitExtension.activate();
    }

    private async getBrokeredServicePipeName(csharpDevkitExports: any | undefined): Promise<string | undefined> {
        if (!this._wasActivatedWithCSharpDevkit || !csharpDevkitExports) {
            return undefined; // C# Devkit is not installed - continue activation without pipe name
        }
        if (!('getBrokeredServiceServerPipeName' in csharpDevkitExports)) {
            throw new Error("C# Devkit is installed but missing expected export getBrokeredServiceServerPipeName");
        }

        let brokeredServicePipeName = await csharpDevkitExports.getBrokeredServiceServerPipeName();
        return brokeredServicePipeName;
    }
    
    private getStarredCompletionComponentPath(csharpDevkitExports: any | undefined): string | undefined {
        if (!this._wasActivatedWithCSharpDevkit || !csharpDevkitExports || !csharpDevkitExports.components ||
            !csharpDevkitExports.components["@vsintellicode/starred-suggestions-csharp"]) {
            return undefined;
        }
        return csharpDevkitExports.components["@vsintellicode/starred-suggestions-csharp"];
    }

    private GetTraceLevel(logLevel: string): Trace {
        switch (logLevel) {
            case "Trace":
                return Trace.Verbose;
            case "Debug":
                return Trace.Messages;
            case "Information":
                return Trace.Off;
            case "Warning":
                return Trace.Off;
            case "Error":
                return Trace.Off;
            case "Critical":
                return Trace.Off;
            case "None":
                return Trace.Off;
            default:
                _channel.appendLine(`Invalid log level ${logLevel}, server will not start. Please set the 'dotnet.server.trace' configuration to a valid value`);
                throw new Error(`Invalid log level ${logLevel}`);
        }
    }
}

export async function activateRoslynLanguageServer(context: vscode.ExtensionContext, platformInfo: PlatformInformation, optionsProvider: OptionProvider, outputChannel: vscode.OutputChannel) {

    // Create a channel for outputting general logs from the language server.
    _channel = outputChannel;
    // Create a separate channel for outputting trace logs - these are incredibly verbose and make other logs very difficult to see.
    _traceChannel = vscode.window.createOutputChannel("C# LSP Trace Logs");

    _languageServer = new RoslynLanguageServer(platformInfo, optionsProvider, context);

    // Register any commands that need to be handled by the extension.
    registerCommands(context, _languageServer);

    // Start the language server.
    await _languageServer.start();
}

// this method is called when your extension is deactivated
export async function deactivate() {
    if (!_languageServer) {
        return undefined;
    }
    return _languageServer.stop();
}
