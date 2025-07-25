/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {EditorState, SerializedEditorState} from './LexicalEditorState';
import type {
  DOMConversion,
  DOMConversionMap,
  DOMExportOutput,
  DOMExportOutputMap,
  NodeKey,
} from './LexicalNode';

import invariant from 'shared/invariant';

import {$getRoot, $getSelection, TextNode} from '.';
import {FULL_RECONCILE, NO_DIRTY_NODES} from './LexicalConstants';
import {cloneEditorState, createEmptyEditorState} from './LexicalEditorState';
import {addRootElementEvents, removeRootElementEvents} from './LexicalEvents';
import {flushRootMutations, initMutationObserver} from './LexicalMutations';
import {LexicalNode} from './LexicalNode';
import {createSharedNodeState, SharedNodeState} from './LexicalNodeState';
import {
  $commitPendingUpdates,
  internalGetActiveEditor,
  parseEditorState,
  triggerListeners,
  updateEditor,
  updateEditorSync,
} from './LexicalUpdates';
import {FOCUS_TAG, HISTORY_MERGE_TAG, UpdateTag} from './LexicalUpdateTags';
import {
  $addUpdateTag,
  $onUpdate,
  $setSelection,
  createUID,
  dispatchCommand,
  getCachedClassNameArray,
  getCachedTypeToNodeMap,
  getDefaultView,
  getDOMSelection,
  getStaticNodeConfig,
  hasOwnExportDOM,
  hasOwnStaticMethod,
  markNodesWithTypesAsDirty,
} from './LexicalUtils';
import {ArtificialNode__DO_NOT_USE} from './nodes/ArtificialNode';
import {$isDecoratorNode, DecoratorNode} from './nodes/LexicalDecoratorNode';
import {LineBreakNode} from './nodes/LexicalLineBreakNode';
import {ParagraphNode} from './nodes/LexicalParagraphNode';
import {RootNode} from './nodes/LexicalRootNode';
import {TabNode} from './nodes/LexicalTabNode';

export type Spread<T1, T2> = Omit<T2, keyof T1> & T1;

// https://github.com/microsoft/TypeScript/issues/3841
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type KlassConstructor<Cls extends GenericConstructor<any>> =
  GenericConstructor<InstanceType<Cls>> & {[k in keyof Cls]: Cls[k]};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GenericConstructor<T> = new (...args: any[]) => T;

export type Klass<T extends LexicalNode> = InstanceType<
  T['constructor']
> extends T
  ? T['constructor']
  : GenericConstructor<T> & T['constructor'];

export type EditorThemeClassName = string;

export type TextNodeThemeClasses = {
  base?: EditorThemeClassName;
  bold?: EditorThemeClassName;
  code?: EditorThemeClassName;
  highlight?: EditorThemeClassName;
  italic?: EditorThemeClassName;
  lowercase?: EditorThemeClassName;
  uppercase?: EditorThemeClassName;
  capitalize?: EditorThemeClassName;
  strikethrough?: EditorThemeClassName;
  subscript?: EditorThemeClassName;
  superscript?: EditorThemeClassName;
  underline?: EditorThemeClassName;
  underlineStrikethrough?: EditorThemeClassName;
  [key: string]: EditorThemeClassName | undefined;
};

export type EditorUpdateOptions = {
  /**
   * A function to run once the update is complete. See also {@link $onUpdate}.
   */
  onUpdate?: () => void;
  /**
   * Setting this to true will suppress all node
   * transforms for this update cycle.
   * Useful for synchronizing updates in some cases.
   */
  skipTransforms?: true;
  /**
   * A tag to identify this update, in an update listener, for instance.
   * See also {@link $addUpdateTag}.
   */
  tag?: UpdateTag | UpdateTag[];
  /**
   * If true, prevents this update from being batched, forcing it to
   * run synchronously.
   */
  discrete?: true;
  /** @internal */
  event?: undefined | UIEvent | Event | null;
};

export type EditorSetOptions = {
  tag?: string;
};

export interface EditorFocusOptions {
  /**
   * Where to move selection when the editor is
   * focused. Can be rootStart, rootEnd, or undefined. Defaults to rootEnd.
   */
  defaultSelection?: 'rootStart' | 'rootEnd';
}

export type EditorThemeClasses = {
  blockCursor?: EditorThemeClassName;
  characterLimit?: EditorThemeClassName;
  code?: EditorThemeClassName;
  codeHighlight?: Record<string, EditorThemeClassName>;
  hashtag?: EditorThemeClassName;
  specialText?: EditorThemeClassName;
  heading?: {
    h1?: EditorThemeClassName;
    h2?: EditorThemeClassName;
    h3?: EditorThemeClassName;
    h4?: EditorThemeClassName;
    h5?: EditorThemeClassName;
    h6?: EditorThemeClassName;
  };
  hr?: EditorThemeClassName;
  hrSelected?: EditorThemeClassName;
  image?: EditorThemeClassName;
  link?: EditorThemeClassName;
  list?: {
    ul?: EditorThemeClassName;
    ulDepth?: Array<EditorThemeClassName>;
    ol?: EditorThemeClassName;
    olDepth?: Array<EditorThemeClassName>;
    checklist?: EditorThemeClassName;
    listitem?: EditorThemeClassName;
    listitemChecked?: EditorThemeClassName;
    listitemUnchecked?: EditorThemeClassName;
    nested?: {
      list?: EditorThemeClassName;
      listitem?: EditorThemeClassName;
    };
  };
  ltr?: EditorThemeClassName;
  mark?: EditorThemeClassName;
  markOverlap?: EditorThemeClassName;
  paragraph?: EditorThemeClassName;
  quote?: EditorThemeClassName;
  root?: EditorThemeClassName;
  rtl?: EditorThemeClassName;
  tab?: EditorThemeClassName;
  table?: EditorThemeClassName;
  tableAddColumns?: EditorThemeClassName;
  tableAddRows?: EditorThemeClassName;
  tableCellActionButton?: EditorThemeClassName;
  tableCellActionButtonContainer?: EditorThemeClassName;
  tableCellSelected?: EditorThemeClassName;
  tableCell?: EditorThemeClassName;
  tableCellHeader?: EditorThemeClassName;
  tableCellResizer?: EditorThemeClassName;
  tableRow?: EditorThemeClassName;
  tableScrollableWrapper?: EditorThemeClassName;
  tableSelected?: EditorThemeClassName;
  tableSelection?: EditorThemeClassName;
  text?: TextNodeThemeClasses;
  embedBlock?: {
    base?: EditorThemeClassName;
    focus?: EditorThemeClassName;
  };
  indent?: EditorThemeClassName;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

export type EditorConfig = {
  disableEvents?: boolean;
  namespace: string;
  theme: EditorThemeClasses;
};

export type LexicalNodeReplacement = {
  replace: Klass<LexicalNode>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  with: <T extends {new (...args: any): any}>(
    node: InstanceType<T>,
  ) => LexicalNode;
  withKlass?: Klass<LexicalNode>;
};

export type HTMLConfig = {
  export?: DOMExportOutputMap;
  import?: DOMConversionMap;
};

/**
 * A LexicalNode class or LexicalNodeReplacement configuration
 */
export type LexicalNodeConfig = Klass<LexicalNode> | LexicalNodeReplacement;

export type CreateEditorArgs = {
  disableEvents?: boolean;
  editorState?: EditorState;
  namespace?: string;
  nodes?: ReadonlyArray<LexicalNodeConfig>;
  onError?: ErrorHandler;
  parentEditor?: LexicalEditor;
  editable?: boolean;
  theme?: EditorThemeClasses;
  html?: HTMLConfig;
};

export type RegisteredNodes = Map<string, RegisteredNode>;

export type RegisteredNode = {
  klass: Klass<LexicalNode>;
  transforms: Set<Transform<LexicalNode>>;
  replace: null | ((node: LexicalNode) => LexicalNode);
  replaceWithKlass: null | Klass<LexicalNode>;
  exportDOM?: (
    editor: LexicalEditor,
    targetNode: LexicalNode,
  ) => DOMExportOutput;
  sharedNodeState: SharedNodeState;
};

export type Transform<T extends LexicalNode> = (node: T) => void;

export type ErrorHandler = (error: Error) => void;

export type MutationListeners = Map<MutationListener, Set<Klass<LexicalNode>>>;

export type MutatedNodes = Map<Klass<LexicalNode>, Map<NodeKey, NodeMutation>>;

export type NodeMutation = 'created' | 'updated' | 'destroyed';

export interface MutationListenerOptions {
  /**
   * Skip the initial call of the listener with pre-existing DOM nodes.
   *
   * The default was previously true for backwards compatibility with <= 0.16.1
   * but this default has been changed to false as of 0.21.0.
   */
  skipInitialization?: boolean;
}

const DEFAULT_SKIP_INITIALIZATION = false;

/**
 * The payload passed to an UpdateListener
 */
export interface UpdateListenerPayload {
  /**
   * A Map of NodeKeys of ElementNodes to a boolean that is true
   * if the node was intentionally mutated ('unintentional' mutations
   * are triggered when an indirect descendant is marked dirty)
   */
  dirtyElements: Map<NodeKey, IntentionallyMarkedAsDirtyElement>;
  /**
   * A Set of NodeKeys of all nodes that were marked dirty that
   * do not inherit from ElementNode.
   */
  dirtyLeaves: Set<NodeKey>;
  /**
   * The new EditorState after all updates have been processed,
   * equivalent to `editor.getEditorState()`
   */
  editorState: EditorState;
  /**
   * The Map of LexicalNode constructors to a `Map<NodeKey, NodeMutation>`,
   * this is useful when you have a mutation listener type use cases that
   * should apply to all or most nodes. Will be null if no DOM was mutated,
   * such as when only the selection changed. Note that this will be empty
   * unless at least one MutationListener is explicitly registered
   * (any MutationListener is sufficient to compute the mutatedNodes Map
   * for all nodes).
   *
   * Added in v0.28.0
   */
  mutatedNodes: null | MutatedNodes;
  /**
   * For advanced use cases only.
   *
   * Tracks the keys of TextNode descendants that have been merged
   * with their siblings by normalization. Note that these keys may
   * not exist in either editorState or prevEditorState and generally
   * this is only used for conflict resolution edge cases in collab.
   */
  normalizedNodes: Set<NodeKey>;
  /**
   * The previous EditorState that is being discarded
   */
  prevEditorState: EditorState;
  /**
   * The set of tags added with update options or {@link $addUpdateTag},
   * node that this includes all tags that were processed in this
   * reconciliation which may have been added by separate updates.
   */
  tags: Set<string>;
}

/**
 * A listener that gets called after the editor is updated
 */
export type UpdateListener = (payload: UpdateListenerPayload) => void;

export type DecoratorListener<T = never> = (
  decorator: Record<NodeKey, T>,
) => void;

export type RootListener = (
  rootElement: null | HTMLElement,
  prevRootElement: null | HTMLElement,
) => void;

export type TextContentListener = (text: string) => void;

export type MutationListener = (
  nodes: Map<NodeKey, NodeMutation>,
  payload: {
    updateTags: Set<string>;
    dirtyLeaves: Set<string>;
    prevEditorState: EditorState;
  },
) => void;

export type CommandListener<P> = (payload: P, editor: LexicalEditor) => boolean;

export type EditableListener = (editable: boolean) => void;

export type CommandListenerPriority = 0 | 1 | 2 | 3 | 4;

export const COMMAND_PRIORITY_EDITOR = 0;
export const COMMAND_PRIORITY_LOW = 1;
export const COMMAND_PRIORITY_NORMAL = 2;
export const COMMAND_PRIORITY_HIGH = 3;
export const COMMAND_PRIORITY_CRITICAL = 4;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type LexicalCommand<TPayload> = {
  type?: string;
};

/**
 * Type helper for extracting the payload type from a command.
 *
 * @example
 * ```ts
 * const MY_COMMAND = createCommand<SomeType>();
 *
 * // ...
 *
 * editor.registerCommand(MY_COMMAND, payload => {
 *   // Type of `payload` is inferred here. But lets say we want to extract a function to delegate to
 *   $handleMyCommand(editor, payload);
 *   return true;
 * });
 *
 * function $handleMyCommand(editor: LexicalEditor, payload: CommandPayloadType<typeof MY_COMMAND>) {
 *   // `payload` is of type `SomeType`, extracted from the command.
 * }
 * ```
 */
export type CommandPayloadType<TCommand extends LexicalCommand<unknown>> =
  TCommand extends LexicalCommand<infer TPayload> ? TPayload : never;

type Commands = Map<
  LexicalCommand<unknown>,
  Array<Set<CommandListener<unknown>>>
>;

export interface Listeners {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  decorator: Set<DecoratorListener<any>>;
  mutation: MutationListeners;
  editable: Set<EditableListener>;
  root: Set<RootListener>;
  textcontent: Set<TextContentListener>;
  update: Set<UpdateListener>;
}

export type SetListeners = {
  [K in keyof Listeners as Listeners[K] extends Set<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (...args: any[]) => void
  >
    ? K
    : never]: Listeners[K] extends Set<(...args: infer Args) => void>
    ? Args
    : never;
};

export type TransformerType = 'text' | 'decorator' | 'element' | 'root';

type IntentionallyMarkedAsDirtyElement = boolean;

type DOMConversionCache = Map<
  string,
  Array<(node: Node) => DOMConversion | null>
>;

export type SerializedEditor = {
  editorState: SerializedEditorState;
};

export function resetEditor(
  editor: LexicalEditor,
  prevRootElement: null | HTMLElement,
  nextRootElement: null | HTMLElement,
  pendingEditorState: EditorState,
): void {
  const keyNodeMap = editor._keyToDOMMap;
  keyNodeMap.clear();
  editor._editorState = createEmptyEditorState();
  editor._pendingEditorState = pendingEditorState;
  editor._compositionKey = null;
  editor._dirtyType = NO_DIRTY_NODES;
  editor._cloneNotNeeded.clear();
  editor._dirtyLeaves = new Set();
  editor._dirtyElements.clear();
  editor._normalizedNodes = new Set();
  editor._updateTags = new Set();
  editor._updates = [];
  editor._blockCursorElement = null;

  const observer = editor._observer;

  if (observer !== null) {
    observer.disconnect();
    editor._observer = null;
  }

  // Remove all the DOM nodes from the root element
  if (prevRootElement !== null) {
    prevRootElement.textContent = '';
  }

  if (nextRootElement !== null) {
    nextRootElement.textContent = '';
    keyNodeMap.set('root', nextRootElement);
  }
}

function initializeConversionCache(
  nodes: RegisteredNodes,
  additionalConversions?: DOMConversionMap,
): DOMConversionCache {
  const conversionCache = new Map();
  const handledConversions = new Set();
  const addConversionsToCache = (map: DOMConversionMap) => {
    Object.keys(map).forEach((key) => {
      let currentCache = conversionCache.get(key);

      if (currentCache === undefined) {
        currentCache = [];
        conversionCache.set(key, currentCache);
      }

      currentCache.push(map[key]);
    });
  };
  nodes.forEach((node) => {
    const importDOM = node.klass.importDOM;

    if (importDOM == null || handledConversions.has(importDOM)) {
      return;
    }

    handledConversions.add(importDOM);
    const map = importDOM.call(node.klass);

    if (map !== null) {
      addConversionsToCache(map);
    }
  });
  if (additionalConversions) {
    addConversionsToCache(additionalConversions);
  }
  return conversionCache;
}

/**
 * Creates a new LexicalEditor attached to a single contentEditable (provided in the config). This is
 * the lowest-level initialization API for a LexicalEditor. If you're using React or another framework,
 * consider using the appropriate abstractions, such as LexicalComposer
 * @param editorConfig - the editor configuration.
 * @returns a LexicalEditor instance
 */
export function createEditor(editorConfig?: CreateEditorArgs): LexicalEditor {
  const config = editorConfig || {};
  const activeEditor = internalGetActiveEditor();
  const theme = config.theme || {};
  const parentEditor =
    editorConfig === undefined ? activeEditor : config.parentEditor || null;
  const disableEvents = config.disableEvents || false;
  const editorState = createEmptyEditorState();
  const namespace =
    config.namespace ||
    (parentEditor !== null ? parentEditor._config.namespace : createUID());
  const initialEditorState = config.editorState;
  const nodes = [
    RootNode,
    TextNode,
    LineBreakNode,
    TabNode,
    ParagraphNode,
    ArtificialNode__DO_NOT_USE,
    ...(config.nodes || []),
  ];
  const {onError, html} = config;
  const isEditable = config.editable !== undefined ? config.editable : true;
  let registeredNodes: RegisteredNodes;

  if (editorConfig === undefined && activeEditor !== null) {
    registeredNodes = activeEditor._nodes;
  } else {
    registeredNodes = new Map();
    for (let i = 0; i < nodes.length; i++) {
      let klass = nodes[i];
      let replace: RegisteredNode['replace'] = null;
      let replaceWithKlass: RegisteredNode['replaceWithKlass'] = null;

      if (typeof klass !== 'function') {
        const options = klass;
        klass = options.replace;
        replace = options.with;
        replaceWithKlass = options.withKlass || null;
      }
      const {ownNodeConfig} = getStaticNodeConfig(klass);
      // Ensure custom nodes implement required methods and replaceWithKlass is instance of base klass.
      if (__DEV__) {
        // ArtificialNode__DO_NOT_USE can get renamed, so we use the type
        const name = klass.name;
        const nodeType =
          hasOwnStaticMethod(klass, 'getType') && klass.getType();

        if (replaceWithKlass) {
          invariant(
            replaceWithKlass.prototype instanceof klass,
            "%s doesn't extend the %s",
            replaceWithKlass.name,
            name,
          );
        } else if (replace) {
          console.warn(
            `Override for ${name} specifies 'replace' without 'withKlass'. 'withKlass' will be required in a future version.`,
          );
        }
        if (
          name !== 'RootNode' &&
          nodeType !== 'root' &&
          nodeType !== 'artificial' &&
          // This is mostly for the unit test suite which
          // uses LexicalNode in an otherwise incorrect way
          // by mocking its static getType
          klass !== LexicalNode
        ) {
          const proto = klass.prototype;
          (['getType', 'clone'] as const).forEach((method) => {
            if (!hasOwnStaticMethod(klass, method)) {
              console.warn(`${name} must implement static "${method}" method`);
            }
          });
          if (
            !hasOwnStaticMethod(klass, 'importDOM') &&
            hasOwnExportDOM(klass)
          ) {
            console.warn(
              `${name} should implement "importDOM" if using a custom "exportDOM" method to ensure HTML serialization (important for copy & paste) works as expected`,
            );
          }
          if ($isDecoratorNode(proto)) {
            if (proto.decorate === DecoratorNode.prototype.decorate) {
              console.warn(
                `${proto.constructor.name} must implement "decorate" method`,
              );
            }
          }
          if (!hasOwnStaticMethod(klass, 'importJSON')) {
            console.warn(
              `${name} should implement "importJSON" method to ensure JSON and default HTML serialization works as expected`,
            );
          }
        }
      }
      const type = klass.getType();
      const transform = klass.transform();
      const transforms = new Set<Transform<LexicalNode>>();
      if (ownNodeConfig && ownNodeConfig.$transform) {
        transforms.add(ownNodeConfig.$transform);
      }
      if (transform !== null) {
        transforms.add(transform);
      }
      registeredNodes.set(type, {
        exportDOM: html && html.export ? html.export.get(klass) : undefined,
        klass,
        replace,
        replaceWithKlass,
        sharedNodeState: createSharedNodeState(nodes[i]),
        transforms,
      });
    }
  }
  const editor = new LexicalEditor(
    editorState,
    parentEditor,
    registeredNodes,
    {
      disableEvents,
      namespace,
      theme,
    },
    onError ? onError : console.error,
    initializeConversionCache(registeredNodes, html ? html.import : undefined),
    isEditable,
    editorConfig,
  );

  if (initialEditorState !== undefined) {
    editor._pendingEditorState = initialEditorState;
    editor._dirtyType = FULL_RECONCILE;
  }

  return editor;
}

export class LexicalEditor {
  ['constructor']!: KlassConstructor<typeof LexicalEditor>;

  /** The version with build identifiers for this editor (since 0.17.1) */
  static version: string | undefined;

  /** @internal */
  _headless: boolean;
  /** @internal */
  _parentEditor: null | LexicalEditor;
  /** @internal */
  _rootElement: null | HTMLElement;
  /** @internal */
  _editorState: EditorState;
  /** @internal */
  _pendingEditorState: null | EditorState;
  /** @internal */
  _compositionKey: null | NodeKey;
  /** @internal */
  _deferred: Array<() => void>;
  /** @internal */
  _keyToDOMMap: Map<NodeKey, HTMLElement>;
  /** @internal */
  _updates: Array<[() => void, EditorUpdateOptions | undefined]>;
  /** @internal */
  _updating: boolean;
  /** @internal */
  _listeners: Listeners;
  /** @internal */
  _commands: Commands;
  /** @internal */
  _nodes: RegisteredNodes;
  /** @internal */
  _decorators: Record<NodeKey, unknown>;
  /** @internal */
  _pendingDecorators: null | Record<NodeKey, unknown>;
  /** @internal */
  _config: EditorConfig;
  /** @internal */
  _dirtyType: 0 | 1 | 2;
  /** @internal */
  _cloneNotNeeded: Set<NodeKey>;
  /** @internal */
  _dirtyLeaves: Set<NodeKey>;
  /** @internal */
  _dirtyElements: Map<NodeKey, IntentionallyMarkedAsDirtyElement>;
  /** @internal */
  _normalizedNodes: Set<NodeKey>;
  /** @internal */
  _updateTags: Set<UpdateTag>;
  /** @internal */
  _observer: null | MutationObserver;
  /** @internal */
  _key: string;
  /** @internal */
  _onError: ErrorHandler;
  /** @internal */
  _htmlConversions: DOMConversionCache;
  /** @internal */
  _window: null | Window;
  /** @internal */
  _editable: boolean;
  /** @internal */
  _blockCursorElement: null | HTMLDivElement;
  /** @internal */
  _createEditorArgs?: undefined | CreateEditorArgs;

  /** @internal */
  constructor(
    editorState: EditorState,
    parentEditor: null | LexicalEditor,
    nodes: RegisteredNodes,
    config: EditorConfig,
    onError: ErrorHandler,
    htmlConversions: DOMConversionCache,
    editable: boolean,
    createEditorArgs?: CreateEditorArgs,
  ) {
    this._createEditorArgs = createEditorArgs;
    this._parentEditor = parentEditor;
    // The root element associated with this editor
    this._rootElement = null;
    // The current editor state
    this._editorState = editorState;
    // Handling of drafts and updates
    this._pendingEditorState = null;
    // Used to help co-ordinate selection and events
    this._compositionKey = null;
    this._deferred = [];
    // Used during reconciliation
    this._keyToDOMMap = new Map();
    this._updates = [];
    this._updating = false;
    // Listeners
    this._listeners = {
      decorator: new Set(),
      editable: new Set(),
      mutation: new Map(),
      root: new Set(),
      textcontent: new Set(),
      update: new Set(),
    };
    // Commands
    this._commands = new Map();
    // Editor configuration for theme/context.
    this._config = config;
    // Mapping of types to their nodes
    this._nodes = nodes;
    // React node decorators for portals
    this._decorators = {};
    this._pendingDecorators = null;
    // Used to optimize reconciliation
    this._dirtyType = NO_DIRTY_NODES;
    this._cloneNotNeeded = new Set();
    this._dirtyLeaves = new Set();
    this._dirtyElements = new Map();
    this._normalizedNodes = new Set();
    this._updateTags = new Set();
    // Handling of DOM mutations
    this._observer = null;
    // Used for identifying owning editors
    this._key = createUID();

    this._onError = onError;
    this._htmlConversions = htmlConversions;
    this._editable = editable;
    this._headless = parentEditor !== null && parentEditor._headless;
    this._window = null;
    this._blockCursorElement = null;
  }

  /**
   *
   * @returns true if the editor is currently in "composition" mode due to receiving input
   * through an IME, or 3P extension, for example. Returns false otherwise.
   */
  isComposing(): boolean {
    return this._compositionKey != null;
  }
  /**
   * Registers a listener for Editor update event. Will trigger the provided callback
   * each time the editor goes through an update (via {@link LexicalEditor.update}) until the
   * teardown function is called.
   *
   * @returns a teardown function that can be used to cleanup the listener.
   */
  registerUpdateListener(listener: UpdateListener): () => void {
    const listenerSetOrMap = this._listeners.update;
    listenerSetOrMap.add(listener);
    return () => {
      listenerSetOrMap.delete(listener);
    };
  }
  /**
   * Registers a listener for for when the editor changes between editable and non-editable states.
   * Will trigger the provided callback each time the editor transitions between these states until the
   * teardown function is called.
   *
   * @returns a teardown function that can be used to cleanup the listener.
   */
  registerEditableListener(listener: EditableListener): () => void {
    const listenerSetOrMap = this._listeners.editable;
    listenerSetOrMap.add(listener);
    return () => {
      listenerSetOrMap.delete(listener);
    };
  }
  /**
   * Registers a listener for when the editor's decorator object changes. The decorator object contains
   * all DecoratorNode keys -> their decorated value. This is primarily used with external UI frameworks.
   *
   * Will trigger the provided callback each time the editor transitions between these states until the
   * teardown function is called.
   *
   * @returns a teardown function that can be used to cleanup the listener.
   */
  registerDecoratorListener<T>(listener: DecoratorListener<T>): () => void {
    const listenerSetOrMap = this._listeners.decorator;
    listenerSetOrMap.add(listener);
    return () => {
      listenerSetOrMap.delete(listener);
    };
  }
  /**
   * Registers a listener for when Lexical commits an update to the DOM and the text content of
   * the editor changes from the previous state of the editor. If the text content is the
   * same between updates, no notifications to the listeners will happen.
   *
   * Will trigger the provided callback each time the editor transitions between these states until the
   * teardown function is called.
   *
   * @returns a teardown function that can be used to cleanup the listener.
   */
  registerTextContentListener(listener: TextContentListener): () => void {
    const listenerSetOrMap = this._listeners.textcontent;
    listenerSetOrMap.add(listener);
    return () => {
      listenerSetOrMap.delete(listener);
    };
  }
  /**
   * Registers a listener for when the editor's root DOM element (the content editable
   * Lexical attaches to) changes. This is primarily used to attach event listeners to the root
   *  element. The root listener function is executed directly upon registration and then on
   * any subsequent update.
   *
   * Will trigger the provided callback each time the editor transitions between these states until the
   * teardown function is called.
   *
   * @returns a teardown function that can be used to cleanup the listener.
   */
  registerRootListener(listener: RootListener): () => void {
    const listenerSetOrMap = this._listeners.root;
    listener(this._rootElement, null);
    listenerSetOrMap.add(listener);
    return () => {
      listener(null, this._rootElement);
      listenerSetOrMap.delete(listener);
    };
  }
  /**
   * Registers a listener that will trigger anytime the provided command
   * is dispatched with {@link LexicalEditor.dispatch}, subject to priority.
   * Listeners that run at a higher priority can "intercept" commands and
   * prevent them from propagating to other handlers by returning true.
   *
   * Listeners are always invoked in an {@link LexicalEditor.update} and can
   * call dollar functions.
   *
   * Listeners registered at the same priority level will run
   * deterministically in the order of registration.
   *
   * @param command - the command that will trigger the callback.
   * @param listener - the function that will execute when the command is dispatched.
   * @param priority - the relative priority of the listener. 0 | 1 | 2 | 3 | 4
   *   (or {@link COMMAND_PRIORITY_EDITOR} |
   *     {@link COMMAND_PRIORITY_LOW} |
   *     {@link COMMAND_PRIORITY_NORMAL} |
   *     {@link COMMAND_PRIORITY_HIGH} |
   *     {@link COMMAND_PRIORITY_CRITICAL})
   * @returns a teardown function that can be used to cleanup the listener.
   */
  registerCommand<P>(
    command: LexicalCommand<P>,
    listener: CommandListener<P>,
    priority: CommandListenerPriority,
  ): () => void {
    if (priority === undefined) {
      invariant(false, 'Listener for type "command" requires a "priority".');
    }

    const commandsMap = this._commands;

    if (!commandsMap.has(command)) {
      commandsMap.set(command, [
        new Set(),
        new Set(),
        new Set(),
        new Set(),
        new Set(),
      ]);
    }

    const listenersInPriorityOrder = commandsMap.get(command);

    if (listenersInPriorityOrder === undefined) {
      invariant(
        false,
        'registerCommand: Command %s not found in command map',
        String(command),
      );
    }

    const listeners = listenersInPriorityOrder[priority];
    listeners.add(listener as CommandListener<unknown>);
    return () => {
      listeners.delete(listener as CommandListener<unknown>);

      if (
        listenersInPriorityOrder.every(
          (listenersSet) => listenersSet.size === 0,
        )
      ) {
        commandsMap.delete(command);
      }
    };
  }

  /**
   * Registers a listener that will run when a Lexical node of the provided class is
   * mutated. The listener will receive a list of nodes along with the type of mutation
   * that was performed on each: created, destroyed, or updated.
   *
   * One common use case for this is to attach DOM event listeners to the underlying DOM nodes as Lexical nodes are created.
   * {@link LexicalEditor.getElementByKey} can be used for this.
   *
   * If any existing nodes are in the DOM, and skipInitialization is not true, the listener
   * will be called immediately with an updateTag of 'registerMutationListener' where all
   * nodes have the 'created' NodeMutation. This can be controlled with the skipInitialization option
   * (whose default was previously true for backwards compatibility with &lt;=0.16.1 but has been changed to false as of 0.21.0).
   *
   * @param klass - The class of the node that you want to listen to mutations on.
   * @param listener - The logic you want to run when the node is mutated.
   * @param options - see {@link MutationListenerOptions}
   * @returns a teardown function that can be used to cleanup the listener.
   */
  registerMutationListener(
    klass: Klass<LexicalNode>,
    listener: MutationListener,
    options?: MutationListenerOptions,
  ): () => void {
    const klassToMutate = this.resolveRegisteredNodeAfterReplacements(
      this.getRegisteredNode(klass),
    ).klass;
    const mutations = this._listeners.mutation;
    let klassSet = mutations.get(listener);
    if (klassSet === undefined) {
      klassSet = new Set();
      mutations.set(listener, klassSet);
    }
    klassSet.add(klassToMutate);
    const skipInitialization = options && options.skipInitialization;
    if (
      !(skipInitialization === undefined
        ? DEFAULT_SKIP_INITIALIZATION
        : skipInitialization)
    ) {
      this.initializeMutationListener(listener, klassToMutate);
    }

    return () => {
      klassSet.delete(klassToMutate);
      if (klassSet.size === 0) {
        mutations.delete(listener);
      }
    };
  }

  /** @internal */
  getRegisteredNode(klass: Klass<LexicalNode>): RegisteredNode {
    const registeredNode = this._nodes.get(klass.getType());

    if (registeredNode === undefined) {
      invariant(
        false,
        'Node %s has not been registered. Ensure node has been passed to createEditor.',
        klass.name,
      );
    }

    return registeredNode;
  }

  /** @internal */
  resolveRegisteredNodeAfterReplacements(
    registeredNode: RegisteredNode,
  ): RegisteredNode {
    while (registeredNode.replaceWithKlass) {
      registeredNode = this.getRegisteredNode(registeredNode.replaceWithKlass);
    }
    return registeredNode;
  }

  /** @internal */
  private initializeMutationListener(
    listener: MutationListener,
    klass: Klass<LexicalNode>,
  ): void {
    const prevEditorState = this._editorState;
    const nodeMap = getCachedTypeToNodeMap(prevEditorState).get(
      klass.getType(),
    );
    if (!nodeMap) {
      return;
    }
    const nodeMutationMap = new Map<string, NodeMutation>();
    for (const k of nodeMap.keys()) {
      nodeMutationMap.set(k, 'created');
    }
    if (nodeMutationMap.size > 0) {
      listener(nodeMutationMap, {
        dirtyLeaves: new Set(),
        prevEditorState,
        updateTags: new Set(['registerMutationListener']),
      });
    }
  }

  /** @internal */
  private registerNodeTransformToKlass<T extends LexicalNode>(
    klass: Klass<T>,
    listener: Transform<T>,
  ): RegisteredNode {
    const registeredNode = this.getRegisteredNode(klass);
    registeredNode.transforms.add(listener as Transform<LexicalNode>);

    return registeredNode;
  }

  /**
   * Registers a listener that will run when a Lexical node of the provided class is
   * marked dirty during an update. The listener will continue to run as long as the node
   * is marked dirty. There are no guarantees around the order of transform execution!
   *
   * Watch out for infinite loops. See [Node Transforms](https://lexical.dev/docs/concepts/transforms)
   * @param klass - The class of the node that you want to run transforms on.
   * @param listener - The logic you want to run when the node is updated.
   * @returns a teardown function that can be used to cleanup the listener.
   */
  registerNodeTransform<T extends LexicalNode>(
    klass: Klass<T>,
    listener: Transform<T>,
  ): () => void {
    const registeredNode = this.registerNodeTransformToKlass(klass, listener);
    const registeredNodes = [registeredNode];

    const replaceWithKlass = registeredNode.replaceWithKlass;
    if (replaceWithKlass != null) {
      const registeredReplaceWithNode = this.registerNodeTransformToKlass(
        replaceWithKlass,
        listener as Transform<LexicalNode>,
      );
      registeredNodes.push(registeredReplaceWithNode);
    }

    markNodesWithTypesAsDirty(
      this,
      registeredNodes.map((node) => node.klass.getType()),
    );
    return () => {
      registeredNodes.forEach((node) =>
        node.transforms.delete(listener as Transform<LexicalNode>),
      );
    };
  }

  /**
   * Used to assert that a certain node is registered, usually by plugins to ensure nodes that they
   * depend on have been registered.
   * @returns True if the editor has registered the provided node type, false otherwise.
   */
  hasNode<T extends Klass<LexicalNode>>(node: T): boolean {
    return this._nodes.has(node.getType());
  }

  /**
   * Used to assert that certain nodes are registered, usually by plugins to ensure nodes that they
   * depend on have been registered.
   * @returns True if the editor has registered all of the provided node types, false otherwise.
   */
  hasNodes<T extends Klass<LexicalNode>>(nodes: Array<T>): boolean {
    return nodes.every(this.hasNode.bind(this));
  }

  /**
   * Dispatches a command of the specified type with the specified payload.
   * This triggers all command listeners (set by {@link LexicalEditor.registerCommand})
   * for this type, passing them the provided payload. The command listeners
   * will be triggered in an implicit {@link LexicalEditor.update}, unless
   * this was invoked from inside an update in which case that update context
   * will be re-used (as if this was a dollar function itself).
   * @param type - the type of command listeners to trigger.
   * @param payload - the data to pass as an argument to the command listeners.
   */
  dispatchCommand<TCommand extends LexicalCommand<unknown>>(
    type: TCommand,
    payload: CommandPayloadType<TCommand>,
  ): boolean {
    return dispatchCommand(this, type, payload);
  }

  /**
   * Gets a map of all decorators in the editor.
   * @returns A mapping of call decorator keys to their decorated content
   */
  getDecorators<T>(): Record<NodeKey, T> {
    return this._decorators as Record<NodeKey, T>;
  }

  /**
   *
   * @returns the current root element of the editor. If you want to register
   * an event listener, do it via {@link LexicalEditor.registerRootListener}, since
   * this reference may not be stable.
   */
  getRootElement(): null | HTMLElement {
    return this._rootElement;
  }

  /**
   * Gets the key of the editor
   * @returns The editor key
   */
  getKey(): string {
    return this._key;
  }

  /**
   * Imperatively set the root contenteditable element that Lexical listens
   * for events on.
   */
  setRootElement(nextRootElement: null | HTMLElement): void {
    const prevRootElement = this._rootElement;

    if (nextRootElement !== prevRootElement) {
      const classNames = getCachedClassNameArray(this._config.theme, 'root');
      const pendingEditorState = this._pendingEditorState || this._editorState;
      this._rootElement = nextRootElement;
      resetEditor(this, prevRootElement, nextRootElement, pendingEditorState);

      if (prevRootElement !== null) {
        // TODO: remove this flag once we no longer use UEv2 internally
        if (!this._config.disableEvents) {
          removeRootElementEvents(prevRootElement);
        }
        if (classNames != null) {
          prevRootElement.classList.remove(...classNames);
        }
      }

      if (nextRootElement !== null) {
        const windowObj = getDefaultView(nextRootElement);
        const style = nextRootElement.style;
        style.userSelect = 'text';
        style.whiteSpace = 'pre-wrap';
        style.wordBreak = 'break-word';
        nextRootElement.setAttribute('data-lexical-editor', 'true');
        this._window = windowObj;
        this._dirtyType = FULL_RECONCILE;
        initMutationObserver(this);

        this._updateTags.add(HISTORY_MERGE_TAG);

        $commitPendingUpdates(this);

        // TODO: remove this flag once we no longer use UEv2 internally
        if (!this._config.disableEvents) {
          addRootElementEvents(nextRootElement, this);
        }
        if (classNames != null) {
          nextRootElement.classList.add(...classNames);
        }
        if (__DEV__) {
          const nextRootElementParent = nextRootElement.parentElement;
          if (
            nextRootElementParent != null &&
            ['flex', 'inline-flex'].includes(
              getComputedStyle(nextRootElementParent).display,
            )
          ) {
            console.warn(
              `When using "display: flex" or "display: inline-flex" on an element containing content editable, Chrome may have unwanted focusing behavior when clicking outside of it. Consider wrapping the content editable within a non-flex element.`,
            );
          }
        }
      } else {
        // When the content editable is unmounted we will still trigger a
        // reconciliation so that any pending updates are flushed,
        // to match the previous state change when
        // `_editorState = pendingEditorState` was used, but by
        // using a commit we preserve the readOnly invariant
        // for editor.getEditorState().
        this._window = null;
        this._updateTags.add(HISTORY_MERGE_TAG);
        $commitPendingUpdates(this);
      }

      triggerListeners('root', this, false, nextRootElement, prevRootElement);
    }
  }

  /**
   * Gets the underlying HTMLElement associated with the LexicalNode for the given key.
   * @returns the HTMLElement rendered by the LexicalNode associated with the key.
   * @param key - the key of the LexicalNode.
   */
  getElementByKey(key: NodeKey): HTMLElement | null {
    return this._keyToDOMMap.get(key) || null;
  }

  /**
   * Gets the active editor state.
   * @returns The editor state
   */
  getEditorState(): EditorState {
    return this._editorState;
  }

  /**
   * Imperatively set the EditorState. Triggers reconciliation like an update.
   * @param editorState - the state to set the editor
   * @param options - options for the update.
   */
  setEditorState(editorState: EditorState, options?: EditorSetOptions): void {
    if (editorState.isEmpty()) {
      invariant(
        false,
        "setEditorState: the editor state is empty. Ensure the editor state's root node never becomes empty.",
      );
    }

    // Ensure that we have a writable EditorState so that transforms can run
    // during a historic operation
    let writableEditorState = editorState;
    if (writableEditorState._readOnly) {
      writableEditorState = cloneEditorState(editorState);
      writableEditorState._selection = editorState._selection
        ? editorState._selection.clone()
        : null;
    }

    flushRootMutations(this);
    const pendingEditorState = this._pendingEditorState;
    const tags = this._updateTags;
    const tag = options !== undefined ? options.tag : null;

    if (pendingEditorState !== null && !pendingEditorState.isEmpty()) {
      if (tag != null) {
        tags.add(tag);
      }
      $commitPendingUpdates(this);
    }

    this._pendingEditorState = writableEditorState;
    this._dirtyType = FULL_RECONCILE;
    this._dirtyElements.set('root', false);
    this._compositionKey = null;

    if (tag != null) {
      tags.add(tag);
    }

    // Only commit pending updates if not already in an editor.update
    // (e.g. dispatchCommand) otherwise this will cause a second commit
    // with an already read-only state and selection
    if (!this._updating) {
      $commitPendingUpdates(this);
    }
  }

  /**
   * Parses a SerializedEditorState (usually produced by {@link EditorState.toJSON}) and returns
   * and EditorState object that can be, for example, passed to {@link LexicalEditor.setEditorState}. Typically,
   * deserialization from JSON stored in a database uses this method.
   * @param maybeStringifiedEditorState
   * @param updateFn
   * @returns
   */
  parseEditorState(
    maybeStringifiedEditorState: string | SerializedEditorState,
    updateFn?: () => void,
  ): EditorState {
    const serializedEditorState =
      typeof maybeStringifiedEditorState === 'string'
        ? JSON.parse(maybeStringifiedEditorState)
        : maybeStringifiedEditorState;
    return parseEditorState(serializedEditorState, this, updateFn);
  }

  /**
   * Executes a read of the editor's state, with the
   * editor context available (useful for exporting and read-only DOM
   * operations). Much like update, but prevents any mutation of the
   * editor's state. Any pending updates will be flushed immediately before
   * the read.
   * @param callbackFn - A function that has access to read-only editor state.
   */
  read<T>(callbackFn: () => T): T {
    $commitPendingUpdates(this);
    return this.getEditorState().read(callbackFn, {editor: this});
  }

  /**
   * Executes an update to the editor state. The updateFn callback is the ONLY place
   * where Lexical editor state can be safely mutated.
   * @param updateFn - A function that has access to writable editor state.
   * @param options - A bag of options to control the behavior of the update.
   */
  update(updateFn: () => void, options?: EditorUpdateOptions): void {
    updateEditor(this, updateFn, options);
  }

  /**
   * Focuses the editor by marking the existing selection as dirty, or by
   * creating a new selection at `defaultSelection` if one does not already
   * exist. If you want to force a specific selection, you should call
   * `root.selectStart()` or `root.selectEnd()` in an update.
   *
   * @param callbackFn - A function to run after the editor is focused.
   * @param options - A bag of options
   */
  focus(callbackFn?: () => void, options: EditorFocusOptions = {}): void {
    const rootElement = this._rootElement;

    if (rootElement !== null) {
      // This ensures that iOS does not trigger caps lock upon focus
      rootElement.setAttribute('autocapitalize', 'off');
      updateEditorSync(this, () => {
        const selection = $getSelection();
        const root = $getRoot();

        if (selection !== null) {
          // Marking the selection dirty will force the selection back to it
          if (!selection.dirty) {
            $setSelection(selection.clone());
          }
        } else if (root.getChildrenSize() !== 0) {
          if (options.defaultSelection === 'rootStart') {
            root.selectStart();
          } else {
            root.selectEnd();
          }
        }
        $addUpdateTag(FOCUS_TAG);
        $onUpdate(() => {
          rootElement.removeAttribute('autocapitalize');
          if (callbackFn) {
            callbackFn();
          }
        });
      });
      // In the case where onUpdate doesn't fire (due to the focus update not
      // occurring).
      if (this._pendingEditorState === null) {
        rootElement.removeAttribute('autocapitalize');
      }
    }
  }

  /**
   * Removes focus from the editor.
   */
  blur(): void {
    const rootElement = this._rootElement;

    if (rootElement !== null) {
      rootElement.blur();
    }

    const domSelection = getDOMSelection(this._window);

    if (domSelection !== null) {
      domSelection.removeAllRanges();
    }
  }
  /**
   * Returns true if the editor is editable, false otherwise.
   * @returns True if the editor is editable, false otherwise.
   */
  isEditable(): boolean {
    return this._editable;
  }
  /**
   * Sets the editable property of the editor. When false, the
   * editor will not listen for user events on the underling contenteditable.
   * @param editable - the value to set the editable mode to.
   */
  setEditable(editable: boolean): void {
    if (this._editable !== editable) {
      this._editable = editable;
      triggerListeners('editable', this, true, editable);
    }
  }
  /**
   * Returns a JSON-serializable javascript object NOT a JSON string.
   * You still must call JSON.stringify (or something else) to turn the
   * state into a string you can transfer over the wire and store in a database.
   *
   * See {@link LexicalNode.exportJSON}
   *
   * @returns A JSON-serializable javascript object
   */
  toJSON(): SerializedEditor {
    return {
      editorState: this._editorState.toJSON(),
    };
  }
}

LexicalEditor.version = process.env.LEXICAL_VERSION;
