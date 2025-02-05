import * as vscode from 'vscode';
import vm from 'vm';

import ActiveConnectionCodeLensProvider from './activeConnectionCodeLensProvider';
import CodeActionProvider from './codeActionProvider';
import ConnectionController, {
  DataServiceEventTypes
} from '../connectionController';
import { createLogger } from '../logging';
import { ExplorerController, ConnectionTreeItem, DatabaseTreeItem } from '../explorer';
import ExportToLanguageCodeLensProvider from './exportToLanguageCodeLensProvider';
import formatError from '../utils/formatError';
import { LanguageServerController } from '../language';
import { OutputChannel, ProgressLocation, TextEditor } from 'vscode';
import playgroundCreateIndexTemplate from '../templates/playgroundCreateIndexTemplate';
import playgroundCreateCollectionTemplate from '../templates/playgroundCreateCollectionTemplate';
import {
  PlaygroundResult,
  ShellExecuteAllResult,
  ExportToLanguageAddons,
  ExportToLanguageNamespace,
  ExportToLanguageMode
} from '../types/playgroundType';
import PlaygroundResultProvider, {
  PLAYGROUND_RESULT_SCHEME,
  PLAYGROUND_RESULT_URI
} from './playgroundResultProvider';
import playgroundSearchTemplate from '../templates/playgroundSearchTemplate';
import playgroundTemplate from '../templates/playgroundTemplate';
import { StatusView } from '../views';
import TelemetryService from '../telemetry/telemetryService';

const log = createLogger('playground controller');
const transpiler = require('bson-transpilers');

interface ToCompile {
  filter?: string;
  aggregation?: string;
  options: {
    collection: string|null;
    database: string|null;
    uri?: string;
  }
}

let dummySandbox;

// TODO: this function was copied from the compass-export-to-language module
// https://github.com/mongodb-js/compass/blob/7c4bc0789a7b66c01bb7ba63955b3b11ed40c094/packages/compass-export-to-language/src/modules/count-aggregation-stages-in-string.js
// and should be updated as well when the better solution for the problem will be found.
const countAggregationStagesInString = (str: string) => {
  if (!dummySandbox) {
    dummySandbox = vm.createContext(Object.create(null), {
      codeGeneration: { strings: false, wasm: false },
      microtaskMode: 'afterEvaluate'
    });
    vm.runInContext([
      'BSONRegExp', 'DBRef', 'Decimal128', 'Double', 'Int32',
      'Long', 'Int64', 'MaxKey', 'MinKey', 'ObjectID', 'ObjectId',
      'BSONSymbol', 'Timestamp', 'Code', 'Buffer', 'Binary'
    ].map(name => `function ${name}() {}`).join('\n'), dummySandbox);
  }

  return vm.runInContext(
    '(' + str + ')',
    dummySandbox,
    { timeout: 100 }).length;
};

/**
 * This controller manages playground.
 */
export default class PlaygroundController {
  _connectionController: ConnectionController;
  _activeTextEditor?: TextEditor;
  _playgroundResult?: PlaygroundResult;
  _languageServerController: LanguageServerController;
  _selectedText?: string;
  _exportToLanguageCodeLensProvider: ExportToLanguageCodeLensProvider;
  _codeActionProvider: CodeActionProvider;

  _isPartialRun = false;

  private _telemetryService: TelemetryService;
  private _activeConnectionCodeLensProvider: ActiveConnectionCodeLensProvider;
  private _outputChannel: OutputChannel;
  private _playgroundResultViewColumn?: vscode.ViewColumn;
  private _playgroundResultTextDocument?: vscode.TextDocument;
  private _statusView: StatusView;
  private _playgroundResultViewProvider: PlaygroundResultProvider;
  private _explorerController: ExplorerController;

  private _codeToEvaluate = '';

  constructor(
    connectionController: ConnectionController,
    languageServerController: LanguageServerController,
    telemetryService: TelemetryService,
    statusView: StatusView,
    playgroundResultViewProvider: PlaygroundResultProvider,
    activeConnectionCodeLensProvider: ActiveConnectionCodeLensProvider,
    exportToLanguageCodeLensProvider: ExportToLanguageCodeLensProvider,
    codeActionProvider: CodeActionProvider,
    explorerController: ExplorerController
  ) {
    this._connectionController = connectionController;
    this._languageServerController = languageServerController;
    this._telemetryService = telemetryService;
    this._statusView = statusView;
    this._playgroundResultViewProvider = playgroundResultViewProvider;
    this._outputChannel = vscode.window.createOutputChannel(
      'Playground output'
    );
    this._activeConnectionCodeLensProvider = activeConnectionCodeLensProvider;
    this._exportToLanguageCodeLensProvider = exportToLanguageCodeLensProvider;
    this._codeActionProvider = codeActionProvider;
    this._explorerController = explorerController;

    this._connectionController.addEventListener(
      DataServiceEventTypes.ACTIVE_CONNECTION_CHANGED,
      () => {
        void this._connectToServiceProvider();
      }
    );

    const onDidChangeActiveTextEditor = (
      editor: vscode.TextEditor | undefined
    ) => {
      if (editor?.document.uri.scheme === PLAYGROUND_RESULT_SCHEME) {
        this._playgroundResultViewColumn = editor.viewColumn;
        this._playgroundResultTextDocument = editor?.document;
      }

      if (editor?.document.languageId !== 'Log') {
        this._activeTextEditor = editor;
        log.info('Active editor path', editor?.document.uri?.path);
      }
    };

    vscode.window.onDidChangeActiveTextEditor(onDidChangeActiveTextEditor);
    onDidChangeActiveTextEditor(vscode.window.activeTextEditor);

    vscode.window.onDidChangeTextEditorSelection(
      async (changeEvent: vscode.TextEditorSelectionChangeEvent) => {
        if (
          changeEvent?.textEditor?.document?.languageId === 'mongodb'
        ) {
          // Sort lines selected as the may be mis-ordered from alt+click.
          const sortedSelections = (changeEvent.selections as Array<vscode.Selection>)
            .sort((a, b) => (a.start.line > b.start.line ? 1 : -1));

          this._selectedText = sortedSelections
            .map((item) => this._getSelectedText(item))
            .join('\n');

          const mode = await this._languageServerController.getExportToLanguageMode({
            textFromEditor: this._getAllText(),
            selection: sortedSelections[0]
          });

          this._codeActionProvider.refresh({ selection: sortedSelections[0], mode });
        }
      }
    );
  }

  async _connectToServiceProvider(): Promise<void> {
    // Disconnect if already connected.
    await this._languageServerController.disconnectFromServiceProvider();

    const dataService = this._connectionController.getActiveDataService();
    const connectionId = this._connectionController.getActiveConnectionId();

    if (!dataService || !connectionId) {
      this._activeConnectionCodeLensProvider.refresh();

      return;
    }

    const mongoClientOption = this._connectionController.getMongoClientConnectionOptions();

    if (!mongoClientOption) {
      this._activeConnectionCodeLensProvider.refresh();

      return;
    }

    await this._languageServerController.connectToServiceProvider({
      connectionId,
      connectionString: mongoClientOption.url,
      connectionOptions: mongoClientOption.options
    });

    this._activeConnectionCodeLensProvider.refresh();
  }

  async _createPlaygroundFileWithContent(
    content: string | undefined
  ): Promise<boolean> {
    try {
      const document = await vscode.workspace.openTextDocument({
        language: 'mongodb',
        content
      });

      await vscode.window.showTextDocument(document);

      return true;
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Unable to create a playground: ${formatError(error).message}`
      );

      return false;
    }
  }

  createPlaygroundForSearch(
    databaseName: string,
    collectionName: string
  ): Promise<boolean> {
    const content = playgroundSearchTemplate
      .replace('CURRENT_DATABASE', databaseName)
      .replace('CURRENT_COLLECTION', collectionName);

    return this._createPlaygroundFileWithContent(content);
  }

  async createPlaygroundForCreateCollection(
    element: ConnectionTreeItem | DatabaseTreeItem
  ): Promise<boolean> {
    let content = playgroundCreateCollectionTemplate;

    element.cacheIsUpToDate = false;

    if (element instanceof DatabaseTreeItem) {
      content = content
        .replace('NEW_DATABASE_NAME', element.databaseName)
        .replace('Create a new database', 'The current database to use');
    }

    return this._createPlaygroundFileWithContent(content);
  }

  createPlaygroundForNewIndex(
    databaseName: string,
    collectionName: string
  ): Promise<boolean> {
    const content = playgroundCreateIndexTemplate
      .replace('CURRENT_DATABASE', databaseName)
      .replace('CURRENT_COLLECTION', collectionName);

    return this._createPlaygroundFileWithContent(content);
  }

  async createPlayground(): Promise<boolean> {
    const useDefaultTemplate = !!vscode.workspace
      .getConfiguration('mdb')
      .get('useDefaultTemplateForPlayground');

    try {
      const document = await vscode.workspace.openTextDocument({
        language: 'mongodb',
        content: useDefaultTemplate ? playgroundTemplate : ''
      });

      await vscode.window.showTextDocument(document);

      return true;
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Unable to create a playground: ${formatError(error).message}`
      );

      return false;
    }
  }

  async _evaluate(codeToEvaluate: string): Promise<ShellExecuteAllResult> {
    const connectionId = this._connectionController.getActiveConnectionId();

    if (!connectionId) {
      throw new Error('Please connect to a database before running a playground.');
    }

    this._statusView.showMessage('Getting results...');

    // Send a request to the language server to execute scripts from a playground.
    const result: ShellExecuteAllResult = await this._languageServerController.executeAll({
      codeToEvaluate,
      connectionId
    });

    this._statusView.hideMessage();
    this._telemetryService.trackPlaygroundCodeExecuted(
      result,
      this._isPartialRun,
      result ? false : true
    );

    return result;
  }

  _getAllText(): string {
    return this._activeTextEditor?.document.getText().trim() || '';
  }

  _getSelectedText(selection: vscode.Range): string {
    return this._activeTextEditor?.document.getText(selection) || '';
  }

  async _evaluateWithCancelModal(): Promise<ShellExecuteAllResult> {
    if (!this._connectionController.isCurrentlyConnected()) {
      throw new Error('Please connect to a database before running a playground.');
    }

    try {
      const progressResult = await vscode.window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: 'Running MongoDB playground...',
          cancellable: true
        },
        async (progress, token) => {
          token.onCancellationRequested(() => {
            // If a user clicked the cancel button terminate all playground scripts.
            this._languageServerController.cancelAll();

            return { outputLines: undefined, result: undefined };
          });

          // Run all playground scripts.
          const result: ShellExecuteAllResult = await this._evaluate(
            this._codeToEvaluate
          );

          return result;
        }
      );

      return progressResult;
    } catch (error) {
      log.error('Evaluate playground with cancel modal error', error);

      return {
        outputLines: undefined,
        result: undefined
      };
    }
  }

  async _openPlaygroundResult(): Promise<void> {
    this._playgroundResultViewProvider.setPlaygroundResult(
      this._playgroundResult
    );

    if (!this._playgroundResultTextDocument) {
      await this._openResultAsVirtualDocument();
    } else {
      this._refreshResultAsVirtualDocument();
    }

    await this._showResultAsVirtualDocument();

    if (this._playgroundResultTextDocument) {
      const language = this._playgroundResult?.language || 'plaintext';

      await vscode.languages.setTextDocumentLanguage(
        this._playgroundResultTextDocument,
        language
      );
    }
  }

  _refreshResultAsVirtualDocument(): void {
    this._playgroundResultViewProvider.refresh();
  }

  async _showResultAsVirtualDocument(): Promise<void> {
    await vscode.window.showTextDocument(PLAYGROUND_RESULT_URI, {
      preview: false,
      preserveFocus: true,
      viewColumn: this._playgroundResultViewColumn || vscode.ViewColumn.Beside
    });
  }

  async _openResultAsVirtualDocument(): Promise<void> {
    try {
      this._playgroundResultTextDocument = await vscode.workspace.openTextDocument(
        PLAYGROUND_RESULT_URI
      );
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Unable to open a result document: ${formatError(error).message}`
      );
    }
  }

  async _evaluatePlayground(): Promise<boolean> {
    const shouldConfirmRunAll = vscode.workspace
      .getConfiguration('mdb')
      .get('confirmRunAll');

    if (!this._connectionController.isCurrentlyConnected()) {
      void vscode.window.showErrorMessage(
        'Please connect to a database before running a playground.'
      );

      return false;
    }

    if (shouldConfirmRunAll === true) {
      const name = this._connectionController.getActiveConnectionName();
      const confirmRunAll = await vscode.window.showInformationMessage(
        `Are you sure you want to run this playground against ${name}? This confirmation can be disabled in the extension settings.`,
        { modal: true },
        'Yes'
      );

      if (confirmRunAll !== 'Yes') {
        return false;
      }
    }

    this._outputChannel.clear();

    const evaluateResponse: ShellExecuteAllResult = await this._evaluateWithCancelModal();

    if (evaluateResponse?.outputLines?.length) {
      for (const line of evaluateResponse.outputLines) {
        this._outputChannel.appendLine(line.content);
      }

      this._outputChannel.show(true);
    }

    if (
      !evaluateResponse ||
      (!evaluateResponse.outputLines && !evaluateResponse.result)
    ) {
      return false;
    }

    this._playgroundResult = evaluateResponse.result;

    this._explorerController.refresh();

    await this._openPlaygroundResult();

    return true;
  }

  runSelectedPlaygroundBlocks(): Promise<boolean> {
    if (!this._selectedText) {
      void vscode.window.showInformationMessage(
        'Please select one or more lines in the playground.'
      );

      return Promise.resolve(true);
    }

    this._isPartialRun = true;
    this._codeToEvaluate = this._selectedText;

    return this._evaluatePlayground();
  }

  runAllPlaygroundBlocks(): Promise<boolean> {
    if (
      !this._activeTextEditor ||
      this._activeTextEditor.document.languageId !== 'mongodb'
    ) {
      void vscode.window.showErrorMessage(
        "Please open a '.mongodb' playground file before running it."
      );

      return Promise.resolve(false);
    }

    this._isPartialRun = false;
    this._codeToEvaluate = this._getAllText();

    return this._evaluatePlayground();
  }

  runAllOrSelectedPlaygroundBlocks(): Promise<boolean> {
    if (
      !this._activeTextEditor ||
      this._activeTextEditor.document.languageId !== 'mongodb'
    ) {
      void vscode.window.showErrorMessage(
        "Please open a '.mongodb' playground file before running it."
      );

      return Promise.resolve(false);
    }

    const selections = this._activeTextEditor.selections;

    if (
      !selections ||
      !Array.isArray(selections) ||
      (selections.length === 1 && this._getSelectedText(selections[0]) === '')
    ) {
      this._isPartialRun = false;
      this._codeToEvaluate = this._getAllText();
    } else if (this._selectedText) {
      this._isPartialRun = true;
      this._codeToEvaluate = this._selectedText;
    }

    return this._evaluatePlayground();
  }

  async openPlayground(filePath: string): Promise<boolean> {
    try {
      const document = await vscode.workspace.openTextDocument(filePath);

      await vscode.window.showTextDocument(document);

      return true;
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Unable to open a playground: ${formatError(error).message}`
      );

      return false;
    }
  }

  changeExportToLanguageAddons(exportToLanguageAddons: ExportToLanguageAddons): Promise<boolean> {
    this._exportToLanguageCodeLensProvider.refresh(exportToLanguageAddons);

    return this._transpile();
  }

  async exportToLanguage(language: string): Promise<boolean> {
    this._exportToLanguageCodeLensProvider.refresh({
      ...this._exportToLanguageCodeLensProvider._exportToLanguageAddons,
      textFromEditor: this._getAllText(),
      selectedText: this._selectedText,
      selection: this._codeActionProvider.selection,
      language,
      mode: this._codeActionProvider.mode
    });

    return this._transpile();
  }

  async getTranspiledContent(): Promise<{ namespace: ExportToLanguageNamespace, expression: string } | undefined> {
    const {
      textFromEditor,
      selectedText,
      selection,
      driverSyntax,
      builders,
      language
    } = this._exportToLanguageCodeLensProvider._exportToLanguageAddons;
    let namespace: ExportToLanguageNamespace = {
      databaseName: 'DATABASE_NAME',
      collectionName: 'COLLECTION_NAME'
    };
    let expression = '';

    if (!textFromEditor || !selection) {
      return;
    }

    if (driverSyntax) {
      const connectionId = this._connectionController.getActiveConnectionId();
      let driverUrl = 'mongodb://localhost:27017';

      if (connectionId) {
        namespace = await this._languageServerController.getNamespaceForSelection({
          textFromEditor,
          selection
        });

        const mongoClientOptions = this._connectionController.getMongoClientConnectionOptions();
        driverUrl = mongoClientOptions?.url || '';
      }

      const toCompile: ToCompile = {
        options: {
          collection: namespace.collectionName,
          database: namespace.databaseName,
          uri: driverUrl
        }
      };

      if (this._codeActionProvider.mode === ExportToLanguageMode.AGGREGATION) {
        toCompile.aggregation = selectedText;
      } else if (this._codeActionProvider.mode === ExportToLanguageMode.QUERY) {
        toCompile.filter = selectedText;
      }

      expression = transpiler.shell[language].compileWithDriver(toCompile, builders);
    } else {
      expression = transpiler.shell[language].compile(selectedText, builders, false);
    }

    return { namespace, expression };
  }

  async _transpile(): Promise<boolean> {
    const {
      selectedText,
      importStatements,
      driverSyntax,
      builders,
      language
    } = this._exportToLanguageCodeLensProvider._exportToLanguageAddons;

    log.info(`Start export to ${language} language`);

    try {
      const transpiledContent = await this.getTranspiledContent();

      if (!transpiledContent) {
        void vscode.window.showInformationMessage(
          'Please select one or more lines in the playground.'
        );
        return true;
      }

      const { namespace, expression } = transpiledContent;

      let imports = '';

      if (importStatements) {
        imports = transpiler.shell[language].getImports(driverSyntax);
      }

      this._playgroundResult = {
        namespace: namespace.databaseName && namespace.collectionName
          ? `${namespace.databaseName}.${namespace.collectionName}`
          : null,
        type: null,
        content: imports ? `${imports}\n\n${expression}` : expression,
        language
      };

      log.info(`Export to ${language} language result`, this._playgroundResult);

      /* eslint-disable camelcase */
      if (this._codeActionProvider.mode === ExportToLanguageMode.AGGREGATION) {
        const aggExportedProps = {
          language,
          num_stages: selectedText ? countAggregationStagesInString(selectedText) : null,
          with_import_statements: importStatements,
          with_builders: builders,
          with_driver_syntax: driverSyntax
        };

        this._telemetryService.trackAggregationExported(aggExportedProps);
      } else if (this._codeActionProvider.mode === ExportToLanguageMode.QUERY) {
        const queryExportedProps = {
          language,
          with_import_statements: importStatements,
          with_builders: builders,
          with_driver_syntax: driverSyntax
        };

        this._telemetryService.trackQueryExported(queryExportedProps);
      }
      /* eslint-enable camelcase */

      await this._openPlaygroundResult();
    } catch (error) {
      const printableError = formatError(error);
      log.error(`Export to ${language} language error`, printableError);
      void vscode.window.showErrorMessage(
        `Unable to export to ${language} language: ${printableError.message}`
      );
    }

    return true;
  }

  deactivate(): void {
    this._connectionController.removeEventListener(
      DataServiceEventTypes.ACTIVE_CONNECTION_CHANGED,
      () => {
        // No action is required after removing the listener.
      }
    );
  }
}
