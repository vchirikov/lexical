/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {SerializedEditorState} from './LexicalEditorState';
import type {LexicalNode, SerializedLexicalNode} from './LexicalNode';

import invariant from 'shared/invariant';

import {
  $isElementNode,
  $isTextNode,
  SELECTION_CHANGE_COMMAND,
  SKIP_DOM_SELECTION_TAG,
} from '.';
import {FULL_RECONCILE, NO_DIRTY_NODES} from './LexicalConstants';
import {
  CommandPayloadType,
  EditorUpdateOptions,
  LexicalCommand,
  LexicalEditor,
  MutatedNodes,
  RegisteredNodes,
  resetEditor,
  SetListeners,
  Transform,
} from './LexicalEditor';
import {
  cloneEditorState,
  createEmptyEditorState,
  EditorState,
  editorStateHasDirtySelection,
} from './LexicalEditorState';
import {
  $garbageCollectDetachedDecorators,
  $garbageCollectDetachedNodes,
} from './LexicalGC';
import {initMutationObserver} from './LexicalMutations';
import {$normalizeTextNode} from './LexicalNormalization';
import {$reconcileRoot} from './LexicalReconciler';
import {
  $internalCreateSelection,
  $isNodeSelection,
  $isRangeSelection,
  applySelectionTransforms,
  updateDOMSelection,
} from './LexicalSelection';
import {
  $getCompositionKey,
  getDOMSelection,
  getEditorPropertyFromDOMNode,
  getEditorStateTextContent,
  getEditorsToPropagate,
  getRegisteredNodeOrThrow,
  getWindow,
  isLexicalEditor,
  removeDOMBlockCursorElement,
  scheduleMicroTask,
  setPendingNodeToClone,
  updateDOMBlockCursorElement,
} from './LexicalUtils';

let activeEditorState: null | EditorState = null;
let activeEditor: null | LexicalEditor = null;
let isReadOnlyMode = false;
let isAttemptingToRecoverFromReconcilerError = false;
let infiniteTransformCount = 0;

const observerOptions = {
  characterData: true,
  childList: true,
  subtree: true,
};

export function isCurrentlyReadOnlyMode(): boolean {
  return (
    isReadOnlyMode ||
    (activeEditorState !== null && activeEditorState._readOnly)
  );
}

export function errorOnReadOnly(): void {
  if (isReadOnlyMode) {
    invariant(false, 'Cannot use method in read-only mode.');
  }
}

export function errorOnInfiniteTransforms(): void {
  if (infiniteTransformCount > 99) {
    invariant(
      false,
      'One or more transforms are endlessly triggering additional transforms. May have encountered infinite recursion caused by transforms that have their preconditions too lose and/or conflict with each other.',
    );
  }
}

export function getActiveEditorState(): EditorState {
  if (activeEditorState === null) {
    invariant(
      false,
      'Unable to find an active editor state. ' +
        'State helpers or node methods can only be used ' +
        'synchronously during the callback of ' +
        'editor.update(), editor.read(), or editorState.read().%s',
      collectBuildInformation(),
    );
  }

  return activeEditorState;
}

export function getActiveEditor(): LexicalEditor {
  if (activeEditor === null) {
    invariant(
      false,
      'Unable to find an active editor. ' +
        'This method can only be used ' +
        'synchronously during the callback of ' +
        'editor.update() or editor.read().%s',
      collectBuildInformation(),
    );
  }
  return activeEditor;
}

function collectBuildInformation(): string {
  let compatibleEditors = 0;
  const incompatibleEditors = new Set<string>();
  const thisVersion = LexicalEditor.version;
  if (typeof window !== 'undefined') {
    for (const node of document.querySelectorAll('[contenteditable]')) {
      const editor = getEditorPropertyFromDOMNode(node);
      if (isLexicalEditor(editor)) {
        compatibleEditors++;
      } else if (editor) {
        let version = String(
          (
            editor.constructor as (typeof editor)['constructor'] &
              Record<string, unknown>
          ).version || '<0.17.1',
        );
        if (version === thisVersion) {
          version +=
            ' (separately built, likely a bundler configuration issue)';
        }
        incompatibleEditors.add(version);
      }
    }
  }
  let output = ` Detected on the page: ${compatibleEditors} compatible editor(s) with version ${thisVersion}`;
  if (incompatibleEditors.size) {
    output += ` and incompatible editors with versions ${Array.from(
      incompatibleEditors,
    ).join(', ')}`;
  }
  return output;
}

export function internalGetActiveEditor(): LexicalEditor | null {
  return activeEditor;
}

export function internalGetActiveEditorState(): EditorState | null {
  return activeEditorState;
}

export function $applyTransforms(
  editor: LexicalEditor,
  node: LexicalNode,
  transformsCache: Map<string, Array<Transform<LexicalNode>>>,
) {
  const type = node.__type;
  const registeredNode = getRegisteredNodeOrThrow(editor, type);
  let transformsArr = transformsCache.get(type);

  if (transformsArr === undefined) {
    transformsArr = Array.from(registeredNode.transforms);
    transformsCache.set(type, transformsArr);
  }

  const transformsArrLength = transformsArr.length;

  for (let i = 0; i < transformsArrLength; i++) {
    transformsArr[i](node);

    if (!node.isAttached()) {
      break;
    }
  }
}

function $isNodeValidForTransform(
  node: LexicalNode,
  compositionKey: null | string,
): boolean {
  return (
    node !== undefined &&
    // We don't want to transform nodes being composed
    node.__key !== compositionKey &&
    node.isAttached()
  );
}

function $normalizeAllDirtyTextNodes(
  editorState: EditorState,
  editor: LexicalEditor,
): void {
  const dirtyLeaves = editor._dirtyLeaves;
  const nodeMap = editorState._nodeMap;

  for (const nodeKey of dirtyLeaves) {
    const node = nodeMap.get(nodeKey);

    if (
      $isTextNode(node) &&
      node.isAttached() &&
      node.isSimpleText() &&
      !node.isUnmergeable()
    ) {
      $normalizeTextNode(node);
    }
  }
}

function addTags(editor: LexicalEditor, tags: undefined | string | string[]) {
  if (!tags) {
    return;
  }
  const updateTags = editor._updateTags;
  let tags_ = tags;
  if (!Array.isArray(tags)) {
    tags_ = [tags];
  }
  for (const tag of tags_) {
    updateTags.add(tag);
  }
}

/**
 * Transform heuristic:
 * 1. We transform leaves first. If transforms generate additional dirty nodes we repeat step 1.
 * The reasoning behind this is that marking a leaf as dirty marks all its parent elements as dirty too.
 * 2. We transform elements. If element transforms generate additional dirty nodes we repeat step 1.
 * If element transforms only generate additional dirty elements we only repeat step 2.
 *
 * Note that to keep track of newly dirty nodes and subtrees we leverage the editor._dirtyNodes and
 * editor._subtrees which we reset in every loop.
 */
function $applyAllTransforms(
  editorState: EditorState,
  editor: LexicalEditor,
): void {
  const dirtyLeaves = editor._dirtyLeaves;
  const dirtyElements = editor._dirtyElements;
  const nodeMap = editorState._nodeMap;
  const compositionKey = $getCompositionKey();
  const transformsCache = new Map();

  let untransformedDirtyLeaves = dirtyLeaves;
  let untransformedDirtyLeavesLength = untransformedDirtyLeaves.size;
  let untransformedDirtyElements = dirtyElements;
  let untransformedDirtyElementsLength = untransformedDirtyElements.size;

  while (
    untransformedDirtyLeavesLength > 0 ||
    untransformedDirtyElementsLength > 0
  ) {
    if (untransformedDirtyLeavesLength > 0) {
      // We leverage editor._dirtyLeaves to track the new dirty leaves after the transforms
      editor._dirtyLeaves = new Set();

      for (const nodeKey of untransformedDirtyLeaves) {
        const node = nodeMap.get(nodeKey);

        if (
          $isTextNode(node) &&
          node.isAttached() &&
          node.isSimpleText() &&
          !node.isUnmergeable()
        ) {
          $normalizeTextNode(node);
        }

        if (
          node !== undefined &&
          $isNodeValidForTransform(node, compositionKey)
        ) {
          $applyTransforms(editor, node, transformsCache);
        }

        dirtyLeaves.add(nodeKey);
      }

      untransformedDirtyLeaves = editor._dirtyLeaves;
      untransformedDirtyLeavesLength = untransformedDirtyLeaves.size;

      // We want to prioritize node transforms over element transforms
      if (untransformedDirtyLeavesLength > 0) {
        infiniteTransformCount++;
        continue;
      }
    }

    // All dirty leaves have been processed. Let's do elements!
    // We have previously processed dirty leaves, so let's restart the editor leaves Set to track
    // new ones caused by element transforms
    editor._dirtyLeaves = new Set();
    editor._dirtyElements = new Map();

    // The root is always considered intentionally dirty if any attached node
    // is dirty and by deleting and re-inserting we will apply its transforms
    // last (e.g. its transform can be used as a sort of "update finalizer")
    const rootDirty = untransformedDirtyElements.delete('root');
    if (rootDirty) {
      untransformedDirtyElements.set('root', true);
    }
    for (const currentUntransformedDirtyElement of untransformedDirtyElements) {
      const nodeKey = currentUntransformedDirtyElement[0];
      const intentionallyMarkedAsDirty = currentUntransformedDirtyElement[1];
      dirtyElements.set(nodeKey, intentionallyMarkedAsDirty);
      if (!intentionallyMarkedAsDirty) {
        continue;
      }

      const node = nodeMap.get(nodeKey);

      if (
        node !== undefined &&
        $isNodeValidForTransform(node, compositionKey)
      ) {
        $applyTransforms(editor, node, transformsCache);
      }
    }

    untransformedDirtyLeaves = editor._dirtyLeaves;
    untransformedDirtyLeavesLength = untransformedDirtyLeaves.size;
    untransformedDirtyElements = editor._dirtyElements;
    untransformedDirtyElementsLength = untransformedDirtyElements.size;
    infiniteTransformCount++;
  }

  editor._dirtyLeaves = dirtyLeaves;
  editor._dirtyElements = dirtyElements;
}

type InternalSerializedNode = {
  children?: Array<InternalSerializedNode>;
  type: string;
  version: number;
};

export function $parseSerializedNode(
  serializedNode: SerializedLexicalNode,
): LexicalNode {
  const internalSerializedNode: InternalSerializedNode = serializedNode;
  return $parseSerializedNodeImpl(
    internalSerializedNode,
    getActiveEditor()._nodes,
  );
}

function $parseSerializedNodeImpl<
  SerializedNode extends InternalSerializedNode,
>(
  serializedNode: SerializedNode,
  registeredNodes: RegisteredNodes,
): LexicalNode {
  const type = serializedNode.type;
  const registeredNode = registeredNodes.get(type);

  if (registeredNode === undefined) {
    invariant(false, 'parseEditorState: type "%s" + not found', type);
  }

  const nodeClass = registeredNode.klass;

  if (serializedNode.type !== nodeClass.getType()) {
    invariant(
      false,
      'LexicalNode: Node %s does not implement .importJSON().',
      nodeClass.name,
    );
  }

  const node = nodeClass.importJSON(serializedNode);
  const children = serializedNode.children;

  if ($isElementNode(node) && Array.isArray(children)) {
    for (let i = 0; i < children.length; i++) {
      const serializedJSONChildNode = children[i];
      const childNode = $parseSerializedNodeImpl(
        serializedJSONChildNode,
        registeredNodes,
      );
      node.append(childNode);
    }
  }

  return node;
}

export function parseEditorState(
  serializedEditorState: SerializedEditorState,
  editor: LexicalEditor,
  updateFn: void | (() => void),
): EditorState {
  const editorState = createEmptyEditorState();
  const previousActiveEditorState = activeEditorState;
  const previousReadOnlyMode = isReadOnlyMode;
  const previousActiveEditor = activeEditor;
  const previousDirtyElements = editor._dirtyElements;
  const previousDirtyLeaves = editor._dirtyLeaves;
  const previousCloneNotNeeded = editor._cloneNotNeeded;
  const previousDirtyType = editor._dirtyType;
  editor._dirtyElements = new Map();
  editor._dirtyLeaves = new Set();
  editor._cloneNotNeeded = new Set();
  editor._dirtyType = 0;
  activeEditorState = editorState;
  isReadOnlyMode = false;
  activeEditor = editor;
  setPendingNodeToClone(null);

  try {
    const registeredNodes = editor._nodes;
    const serializedNode = serializedEditorState.root;
    $parseSerializedNodeImpl(serializedNode, registeredNodes);
    if (updateFn) {
      updateFn();
    }

    // Make the editorState immutable
    editorState._readOnly = true;

    if (__DEV__) {
      handleDEVOnlyPendingUpdateGuarantees(editorState);
    }
  } catch (error) {
    if (error instanceof Error) {
      editor._onError(error);
    }
  } finally {
    editor._dirtyElements = previousDirtyElements;
    editor._dirtyLeaves = previousDirtyLeaves;
    editor._cloneNotNeeded = previousCloneNotNeeded;
    editor._dirtyType = previousDirtyType;
    activeEditorState = previousActiveEditorState;
    isReadOnlyMode = previousReadOnlyMode;
    activeEditor = previousActiveEditor;
  }

  return editorState;
}

// This technically isn't an update but given we need
// exposure to the module's active bindings, we have this
// function here

export function readEditorState<V>(
  editor: LexicalEditor | null,
  editorState: EditorState,
  callbackFn: () => V,
): V {
  const previousActiveEditorState = activeEditorState;
  const previousReadOnlyMode = isReadOnlyMode;
  const previousActiveEditor = activeEditor;

  activeEditorState = editorState;
  isReadOnlyMode = true;
  activeEditor = editor;

  try {
    return callbackFn();
  } finally {
    activeEditorState = previousActiveEditorState;
    isReadOnlyMode = previousReadOnlyMode;
    activeEditor = previousActiveEditor;
  }
}

function handleDEVOnlyPendingUpdateGuarantees(
  pendingEditorState: EditorState,
): void {
  // Given we can't Object.freeze the nodeMap as it's a Map,
  // we instead replace its set, clear and delete methods.
  const nodeMap = pendingEditorState._nodeMap;

  nodeMap.set = () => {
    throw new Error('Cannot call set() on a frozen Lexical node map');
  };

  nodeMap.clear = () => {
    throw new Error('Cannot call clear() on a frozen Lexical node map');
  };

  nodeMap.delete = () => {
    throw new Error('Cannot call delete() on a frozen Lexical node map');
  };
}

export function $commitPendingUpdates(
  editor: LexicalEditor,
  recoveryEditorState?: EditorState,
): void {
  const pendingEditorState = editor._pendingEditorState;
  const rootElement = editor._rootElement;
  const shouldSkipDOM = editor._headless || rootElement === null;

  if (pendingEditorState === null) {
    return;
  }

  // ======
  // Reconciliation has started.
  // ======

  const currentEditorState = editor._editorState;
  const currentSelection = currentEditorState._selection;
  const pendingSelection = pendingEditorState._selection;
  const needsUpdate = editor._dirtyType !== NO_DIRTY_NODES;
  const previousActiveEditorState = activeEditorState;
  const previousReadOnlyMode = isReadOnlyMode;
  const previousActiveEditor = activeEditor;
  const previouslyUpdating = editor._updating;
  const observer = editor._observer;
  let mutatedNodes = null;
  editor._pendingEditorState = null;
  editor._editorState = pendingEditorState;

  if (!shouldSkipDOM && needsUpdate && observer !== null) {
    activeEditor = editor;
    activeEditorState = pendingEditorState;
    isReadOnlyMode = false;
    // We don't want updates to sync block the reconciliation.
    editor._updating = true;
    try {
      const dirtyType = editor._dirtyType;
      const dirtyElements = editor._dirtyElements;
      const dirtyLeaves = editor._dirtyLeaves;
      observer.disconnect();

      mutatedNodes = $reconcileRoot(
        currentEditorState,
        pendingEditorState,
        editor,
        dirtyType,
        dirtyElements,
        dirtyLeaves,
      );
    } catch (error) {
      // Report errors
      if (error instanceof Error) {
        editor._onError(error);
      }

      // Reset editor and restore incoming editor state to the DOM
      if (!isAttemptingToRecoverFromReconcilerError) {
        resetEditor(editor, null, rootElement, pendingEditorState);
        initMutationObserver(editor);
        editor._dirtyType = FULL_RECONCILE;
        isAttemptingToRecoverFromReconcilerError = true;
        $commitPendingUpdates(editor, currentEditorState);
        isAttemptingToRecoverFromReconcilerError = false;
      } else {
        // To avoid a possible situation of infinite loops, lets throw
        throw error;
      }

      return;
    } finally {
      observer.observe(rootElement, observerOptions);
      editor._updating = previouslyUpdating;
      activeEditorState = previousActiveEditorState;
      isReadOnlyMode = previousReadOnlyMode;
      activeEditor = previousActiveEditor;
    }
  }

  if (!pendingEditorState._readOnly) {
    pendingEditorState._readOnly = true;
    if (__DEV__) {
      handleDEVOnlyPendingUpdateGuarantees(pendingEditorState);
      if ($isRangeSelection(pendingSelection)) {
        Object.freeze(pendingSelection.anchor);
        Object.freeze(pendingSelection.focus);
      }
      Object.freeze(pendingSelection);
    }
  }

  const dirtyLeaves = editor._dirtyLeaves;
  const dirtyElements = editor._dirtyElements;
  const normalizedNodes = editor._normalizedNodes;
  const tags = editor._updateTags;
  const deferred = editor._deferred;
  const nodeCount = pendingEditorState._nodeMap.size;

  if (needsUpdate) {
    editor._dirtyType = NO_DIRTY_NODES;
    editor._cloneNotNeeded.clear();
    editor._dirtyLeaves = new Set();
    editor._dirtyElements = new Map();
    editor._normalizedNodes = new Set();
    editor._updateTags = new Set();
  }
  $garbageCollectDetachedDecorators(editor, pendingEditorState);

  // ======
  // Reconciliation has finished. Now update selection and trigger listeners.
  // ======

  const domSelection = shouldSkipDOM
    ? null
    : getDOMSelection(getWindow(editor));

  // Attempt to update the DOM selection, including focusing of the root element,
  // and scroll into view if needed.
  if (
    editor._editable &&
    // domSelection will be null in headless
    domSelection !== null &&
    (needsUpdate || pendingSelection === null || pendingSelection.dirty) &&
    rootElement !== null &&
    !tags.has(SKIP_DOM_SELECTION_TAG)
  ) {
    activeEditor = editor;
    activeEditorState = pendingEditorState;
    try {
      if (observer !== null) {
        observer.disconnect();
      }
      if (needsUpdate || pendingSelection === null || pendingSelection.dirty) {
        const blockCursorElement = editor._blockCursorElement;
        if (blockCursorElement !== null) {
          removeDOMBlockCursorElement(blockCursorElement, editor, rootElement);
        }
        updateDOMSelection(
          currentSelection,
          pendingSelection,
          editor,
          domSelection,
          tags,
          rootElement,
          nodeCount,
        );
      }
      updateDOMBlockCursorElement(editor, rootElement, pendingSelection);
    } finally {
      if (observer !== null) {
        observer.observe(rootElement, observerOptions);
      }
      activeEditor = previousActiveEditor;
      activeEditorState = previousActiveEditorState;
    }
  }

  if (mutatedNodes !== null) {
    triggerMutationListeners(
      editor,
      mutatedNodes,
      tags,
      dirtyLeaves,
      currentEditorState,
    );
  }
  if (
    !$isRangeSelection(pendingSelection) &&
    pendingSelection !== null &&
    (currentSelection === null || !currentSelection.is(pendingSelection))
  ) {
    editor.dispatchCommand(SELECTION_CHANGE_COMMAND, undefined);
  }
  /**
   * Capture pendingDecorators after garbage collecting detached decorators
   */
  const pendingDecorators = editor._pendingDecorators;
  if (pendingDecorators !== null) {
    editor._decorators = pendingDecorators;
    editor._pendingDecorators = null;
    triggerListeners('decorator', editor, true, pendingDecorators);
  }

  // If reconciler fails, we reset whole editor (so current editor state becomes empty)
  // and attempt to re-render pendingEditorState. If that goes through we trigger
  // listeners, but instead use recoverEditorState which is current editor state before reset
  // This specifically important for collab that relies on prevEditorState from update
  // listener to calculate delta of changed nodes/properties
  triggerTextContentListeners(
    editor,
    recoveryEditorState || currentEditorState,
    pendingEditorState,
  );
  triggerListeners('update', editor, true, {
    dirtyElements,
    dirtyLeaves,
    editorState: pendingEditorState,
    mutatedNodes,
    normalizedNodes,
    prevEditorState: recoveryEditorState || currentEditorState,
    tags,
  });
  triggerDeferredUpdateCallbacks(editor, deferred);
  $triggerEnqueuedUpdates(editor);
}

function triggerTextContentListeners(
  editor: LexicalEditor,
  currentEditorState: EditorState,
  pendingEditorState: EditorState,
): void {
  const currentTextContent = getEditorStateTextContent(currentEditorState);
  const latestTextContent = getEditorStateTextContent(pendingEditorState);

  if (currentTextContent !== latestTextContent) {
    triggerListeners('textcontent', editor, true, latestTextContent);
  }
}

function triggerMutationListeners(
  editor: LexicalEditor,
  mutatedNodes: MutatedNodes,
  updateTags: Set<string>,
  dirtyLeaves: Set<string>,
  prevEditorState: EditorState,
): void {
  const listeners = Array.from(editor._listeners.mutation);
  const listenersLength = listeners.length;

  for (let i = 0; i < listenersLength; i++) {
    const [listener, klassSet] = listeners[i];
    for (const klass of klassSet) {
      const mutatedNodesByType = mutatedNodes.get(klass);
      if (mutatedNodesByType !== undefined) {
        listener(mutatedNodesByType, {
          dirtyLeaves,
          prevEditorState,
          updateTags,
        });
      }
    }
  }
}

export function triggerListeners<T extends keyof SetListeners>(
  type: T,
  editor: LexicalEditor,
  isCurrentlyEnqueuingUpdates: boolean,
  ...payload: SetListeners[T]
): void {
  const previouslyUpdating = editor._updating;
  editor._updating = isCurrentlyEnqueuingUpdates;

  try {
    const listeners = Array.from(
      editor._listeners[type] as Set<(...args: SetListeners[T]) => void>,
    );
    for (let i = 0; i < listeners.length; i++) {
      listeners[i].apply(null, payload);
    }
  } finally {
    editor._updating = previouslyUpdating;
  }
}

export function triggerCommandListeners<
  TCommand extends LexicalCommand<unknown>,
>(
  editor: LexicalEditor,
  type: TCommand,
  payload: CommandPayloadType<TCommand>,
): boolean {
  const editors = getEditorsToPropagate(editor);

  for (let i = 4; i >= 0; i--) {
    for (let e = 0; e < editors.length; e++) {
      const currentEditor = editors[e];
      const commandListeners = currentEditor._commands;
      const listenerInPriorityOrder = commandListeners.get(type);

      if (listenerInPriorityOrder !== undefined) {
        const listenersSet = listenerInPriorityOrder[i];

        if (listenersSet !== undefined) {
          const listeners = Array.from(listenersSet);
          const listenersLength = listeners.length;

          let returnVal = false;
          updateEditorSync(currentEditor, () => {
            for (let j = 0; j < listenersLength; j++) {
              if (listeners[j](payload, editor)) {
                returnVal = true;
                return;
              }
            }
          });
          if (returnVal) {
            return returnVal;
          }
        }
      }
    }
  }

  return false;
}

function $triggerEnqueuedUpdates(editor: LexicalEditor): void {
  const queuedUpdates = editor._updates;

  if (queuedUpdates.length !== 0) {
    const queuedUpdate = queuedUpdates.shift();
    if (queuedUpdate) {
      const [updateFn, options] = queuedUpdate;
      $beginUpdate(editor, updateFn, options);
    }
  }
}

function triggerDeferredUpdateCallbacks(
  editor: LexicalEditor,
  deferred: Array<() => void>,
): void {
  editor._deferred = [];

  if (deferred.length !== 0) {
    const previouslyUpdating = editor._updating;
    editor._updating = true;

    try {
      for (let i = 0; i < deferred.length; i++) {
        deferred[i]();
      }
    } finally {
      editor._updating = previouslyUpdating;
    }
  }
}

function $processNestedUpdates(
  editor: LexicalEditor,
  initialSkipTransforms?: boolean,
): boolean {
  const queuedUpdates = editor._updates;
  let skipTransforms = initialSkipTransforms || false;

  // Updates might grow as we process them, we so we'll need
  // to handle each update as we go until the updates array is
  // empty.
  while (queuedUpdates.length !== 0) {
    const queuedUpdate = queuedUpdates.shift();
    if (queuedUpdate) {
      const [nextUpdateFn, options] = queuedUpdate;
      const pendingEditorState = editor._pendingEditorState;

      let onUpdate;

      if (options !== undefined) {
        onUpdate = options.onUpdate;

        if (options.skipTransforms) {
          skipTransforms = true;
        }
        if (options.discrete) {
          invariant(
            pendingEditorState !== null,
            'Unexpected empty pending editor state on discrete nested update',
          );
          pendingEditorState._flushSync = true;
        }

        if (onUpdate) {
          editor._deferred.push(onUpdate);
        }

        addTags(editor, options.tag);
      }

      if (pendingEditorState == null) {
        $beginUpdate(editor, nextUpdateFn, options);
      } else {
        nextUpdateFn();
      }
    }
  }

  return skipTransforms;
}

function $beginUpdate(
  editor: LexicalEditor,
  updateFn: () => void,
  options?: EditorUpdateOptions,
): void {
  const updateTags = editor._updateTags;
  let onUpdate;
  let skipTransforms = false;
  let discrete = false;

  if (options !== undefined) {
    onUpdate = options.onUpdate;
    addTags(editor, options.tag);

    skipTransforms = options.skipTransforms || false;
    discrete = options.discrete || false;
  }

  if (onUpdate) {
    editor._deferred.push(onUpdate);
  }

  const currentEditorState = editor._editorState;
  let pendingEditorState = editor._pendingEditorState;
  let editorStateWasCloned = false;

  if (pendingEditorState === null || pendingEditorState._readOnly) {
    pendingEditorState = editor._pendingEditorState = cloneEditorState(
      pendingEditorState || currentEditorState,
    );
    editorStateWasCloned = true;
  }
  pendingEditorState._flushSync = discrete;

  const previousActiveEditorState = activeEditorState;
  const previousReadOnlyMode = isReadOnlyMode;
  const previousActiveEditor = activeEditor;
  const previouslyUpdating = editor._updating;
  activeEditorState = pendingEditorState;
  isReadOnlyMode = false;
  editor._updating = true;
  activeEditor = editor;
  const headless = editor._headless || editor.getRootElement() === null;
  setPendingNodeToClone(null);

  try {
    if (editorStateWasCloned) {
      if (headless) {
        if (currentEditorState._selection !== null) {
          pendingEditorState._selection = currentEditorState._selection.clone();
        }
      } else {
        pendingEditorState._selection = $internalCreateSelection(
          editor,
          (options && options.event) || null,
        );
      }
    }

    const startingCompositionKey = editor._compositionKey;
    updateFn();
    skipTransforms = $processNestedUpdates(editor, skipTransforms);
    applySelectionTransforms(pendingEditorState, editor);

    if (editor._dirtyType !== NO_DIRTY_NODES) {
      if (skipTransforms) {
        $normalizeAllDirtyTextNodes(pendingEditorState, editor);
      } else {
        $applyAllTransforms(pendingEditorState, editor);
      }

      $processNestedUpdates(editor);
      $garbageCollectDetachedNodes(
        currentEditorState,
        pendingEditorState,
        editor._dirtyLeaves,
        editor._dirtyElements,
      );
    }

    const endingCompositionKey = editor._compositionKey;

    if (startingCompositionKey !== endingCompositionKey) {
      pendingEditorState._flushSync = true;
    }

    const pendingSelection = pendingEditorState._selection;

    if ($isRangeSelection(pendingSelection)) {
      const pendingNodeMap = pendingEditorState._nodeMap;
      const anchorKey = pendingSelection.anchor.key;
      const focusKey = pendingSelection.focus.key;

      if (
        pendingNodeMap.get(anchorKey) === undefined ||
        pendingNodeMap.get(focusKey) === undefined
      ) {
        invariant(
          false,
          'updateEditor: selection has been lost because the previously selected nodes have been removed and ' +
            "selection wasn't moved to another node. Ensure selection changes after removing/replacing a selected node.",
        );
      }
    } else if ($isNodeSelection(pendingSelection)) {
      // TODO: we should also validate node selection?
      if (pendingSelection._nodes.size === 0) {
        pendingEditorState._selection = null;
      }
    }
  } catch (error) {
    // Report errors
    if (error instanceof Error) {
      editor._onError(error);
    }

    // Restore existing editor state to the DOM
    editor._pendingEditorState = currentEditorState;
    editor._dirtyType = FULL_RECONCILE;

    editor._cloneNotNeeded.clear();

    editor._dirtyLeaves = new Set();

    editor._dirtyElements.clear();

    $commitPendingUpdates(editor);
    return;
  } finally {
    activeEditorState = previousActiveEditorState;
    isReadOnlyMode = previousReadOnlyMode;
    activeEditor = previousActiveEditor;
    editor._updating = previouslyUpdating;
    infiniteTransformCount = 0;
  }

  const shouldUpdate =
    editor._dirtyType !== NO_DIRTY_NODES ||
    editor._deferred.length > 0 ||
    editorStateHasDirtySelection(pendingEditorState, editor);

  if (shouldUpdate) {
    if (pendingEditorState._flushSync) {
      pendingEditorState._flushSync = false;
      $commitPendingUpdates(editor);
    } else if (editorStateWasCloned) {
      scheduleMicroTask(() => {
        $commitPendingUpdates(editor);
      });
    }
  } else {
    pendingEditorState._flushSync = false;

    if (editorStateWasCloned) {
      updateTags.clear();
      editor._deferred = [];
      editor._pendingEditorState = null;
    }
  }
}

/**
 * A variant of updateEditor that will not defer if it is nested in an update
 * to the same editor, much like if it was an editor.dispatchCommand issued
 * within an update
 */
export function updateEditorSync(
  editor: LexicalEditor,
  updateFn: () => void,
  options?: EditorUpdateOptions,
): void {
  if (activeEditor === editor && options === undefined) {
    updateFn();
  } else {
    $beginUpdate(editor, updateFn, options);
  }
}

export function updateEditor(
  editor: LexicalEditor,
  updateFn: () => void,
  options?: EditorUpdateOptions,
): void {
  if (editor._updating) {
    editor._updates.push([updateFn, options]);
  } else {
    $beginUpdate(editor, updateFn, options);
  }
}
