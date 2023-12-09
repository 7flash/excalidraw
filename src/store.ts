import { getDefaultAppState } from "./appState";
import { AppStateChange, ElementsChange } from "./change";
import { deepCopyElement } from "./element/newElement";
import { ExcalidrawElement } from "./element/types";
import { Emitter } from "./emitter";
import Scene from "./scene/Scene";
import { AppState, ObservedAppState } from "./types";
import { isShallowEqual } from "./utils";

const getObservedAppState = (appState: AppState): ObservedAppState => {
  return {
    name: appState.name,
    editingGroupId: appState.editingGroupId,
    viewBackgroundColor: appState.viewBackgroundColor,
    selectedElementIds: appState.selectedElementIds,
    selectedGroupIds: appState.selectedGroupIds,
    editingLinearElement: appState.editingLinearElement,
    selectedLinearElement: appState.selectedLinearElement, // TODO_UNDO: Think about these two as one level shallow equal is not enough for them (they have new reference even though they shouldn't, sometimes their id does not correspond to selectedElementId)
  };
};

/**
 * Store which captures the observed changes and emits them as `StoreIncrementEvent` events.
 *
 * For the future:
 * - Store should coordinate the changes and maintain its increments cohesive between different instances.
 * - Store increments should be kept as append-only events log, with additional metadata, such as the logical timestamp for conflict-free resolution of increments.
 * - Store flow should be bi-directional, not only listening and capturing changes, but mainly receiving increments as commands and applying them to the state.
 *
 * @experimental this interface is experimental and subject to change.
 */
export interface IStore {
  /**
   * Capture changes to the @param scene and @param appState by diff calculation and emitting resulting changes as store increment.
   * In case the property `onlyUpdatingSnapshot` is set, it will only update the store snapshot, without calculating diffs.
   *
   * @emits StoreIncrementEvent
   */
  capture(scene: Scene, appState: AppState): void;

  /**
   * Listens to the store increments, emitted by the capture method.
   * Suitable for consuming store increments by various system components, such as History, Collab, Storage and etc.
   *
   * @listens StoreIncrementEvent
   */
  listen(
    callback: (
      elementsChange: ElementsChange,
      appStateChange: AppStateChange,
    ) => void,
  ): ReturnType<Emitter<StoreIncrementEvent>["on"]>;

  /**
   * Clears the store instance.
   */
  clear(): void;
}

/**
 * Represent an increment to the Store.
 */
type StoreIncrementEvent = [
  elementsChange: ElementsChange,
  appStateChange: AppStateChange,
];

export class Store implements IStore {
  private readonly onStoreIncrementEmitter = new Emitter<StoreIncrementEvent>();

  private capturingChanges: boolean = false;
  private updatingSnapshot: boolean = false;

  public snapshot = Snapshot.empty();

  public scheduleSnapshotUpdate() {
    this.updatingSnapshot = true;
  }

  // Suspicious that this is called so many places. Seems error-prone.
  public resumeCapturing() {
    this.capturingChanges = true;
  }

  public capture(scene: Scene, appState: AppState): void {
    // Quick exit for irrelevant changes
    if (!this.capturingChanges && !this.updatingSnapshot) {
      return;
    }

    try {
      const nextSnapshot = this.updateSnapshot(scene, appState);

      // Optimisation, don't continue if nothing has changed
      if (this.snapshot !== nextSnapshot) {
        // Calculate and record the changes based on the previous and next snapshot
        if (
          this.capturingChanges &&
          !this.snapshot.isEmpty() // Special case on first initialization of the Scene, which we don't want to record
        ) {
          const elementsChange = nextSnapshot.meta.didElementsChange
            ? ElementsChange.calculate(
                this.snapshot.elements,
                nextSnapshot.elements,
              )
            : ElementsChange.empty();

          const appStateChange = nextSnapshot.meta.didAppStateChange
            ? AppStateChange.calculate(
                this.snapshot.appState,
                nextSnapshot.appState,
              )
            : AppStateChange.empty();

          if (!elementsChange.isEmpty() || !appStateChange.isEmpty()) {
            this.onStoreIncrementEmitter.trigger(
              elementsChange,
              appStateChange,
            );
          }
        }

        // Update the snapshot
        this.snapshot = nextSnapshot;
      }
    } finally {
      // Reset props
      this.updatingSnapshot = false;
      this.capturingChanges = false;
    }
  }

  public listen(
    callback: (
      elementsChange: ElementsChange,
      appStateChange: AppStateChange,
    ) => void,
  ) {
    return this.onStoreIncrementEmitter.on(callback);
  }

  public clear(): void {
    this.snapshot = Snapshot.empty();
  }

  public destroy(): void {
    this.clear();
    this.onStoreIncrementEmitter.destroy();
  }

  private updateSnapshot(scene: Scene, appState: AppState) {
    const nextElements = scene.getElementsMapIncludingDeleted();
    const snapshotOptions = {
      sceneVersionNonce: scene.getVersionNonce(),
    };

    // Efficiently clone the store snapshot
    const nextSnapshot = this.snapshot.clone(
      nextElements,
      appState,
      snapshotOptions,
    );

    return nextSnapshot;
  }
}

type SnapshotOptions = {
  sceneVersionNonce?: number;
};

class Snapshot {
  private constructor(
    public readonly elements: Map<string, ExcalidrawElement>,
    public readonly appState: ObservedAppState,
    public readonly meta: {
      didElementsChange: boolean;
      didAppStateChange: boolean;
      sceneVersionNonce?: number;
    } = {
      didElementsChange: false,
      didAppStateChange: false,
    },
  ) {}

  public static empty() {
    return new Snapshot(
      new Map(),
      getObservedAppState(getDefaultAppState() as AppState),
    );
  }

  public isEmpty() {
    return !this.meta.sceneVersionNonce;
  }

  /**
   * Efficiently clone the existing snapshot.
   *
   * @returns same instance if there are no changes detected, new Snapshot instance otherwise.
   */
  public clone(
    elements: Map<string, ExcalidrawElement>,
    appState: AppState,
    options: SnapshotOptions,
  ) {
    const { sceneVersionNonce } = options;
    // TODO_UNDO: think about a case when scene could be the same, even though versionNonce is different (might be worth checking individual elements - altough there is the same problem, but occuring with lower probability)
    // TODO_UNDO: coming to a scene after while, moving element, undo isn't possible
    const didElementsChange = this.meta.sceneVersionNonce !== sceneVersionNonce;

    // Not watching over everything from app state, just the relevant props
    const nextAppStateSnapshot = getObservedAppState(appState);
    const didAppStateChange = this.detectChangedAppState(nextAppStateSnapshot);

    // Nothing has changed, so there is no point of continuing further
    if (!didElementsChange && !didAppStateChange) {
      return this;
    }

    // Clone only if there was really a change
    let nextElementsSnapshot = this.elements;
    if (didElementsChange) {
      nextElementsSnapshot = this.createElementsSnapshot(elements, appState);
    }

    const snapshot = new Snapshot(nextElementsSnapshot, nextAppStateSnapshot, {
      didElementsChange,
      didAppStateChange,
      sceneVersionNonce,
    });

    return snapshot;
  }

  private detectChangedAppState(observedAppState: ObservedAppState) {
    // TODO_UNDO: Linear element?
    return !isShallowEqual(this.appState, observedAppState, {
      selectedElementIds: isShallowEqual,
      selectedGroupIds: isShallowEqual,
    });
  }

  /**
   * Perform structural clone, cloning only elements that changed.
   */
  private createElementsSnapshot(
    nextElements: Map<string, ExcalidrawElement>,
    appState: AppState,
  ) {
    const clonedElements = new Map();

    for (const [id, prevElement] of this.elements.entries()) {
      // clone previous elements, never delete, in case nextElements would be just a subset of previous elements
      // i.e. during collab, persist or whenenever get isDeleted elements cleaned
      clonedElements.set(id, prevElement);
    }

    for (const [id, nextElement] of nextElements.entries()) {
      const prevElement = clonedElements.get(id);

      // At this point our elements are reconcilled already, meaning the next element is always newer
      if (
        !prevElement || // element was added
        (prevElement && prevElement.versionNonce !== nextElement.versionNonce) // element was updated
      ) {
        // Special case, when we don't want to capture editing element from remote, if it's currently being edited
        // If we would capture it, we would capture yet uncommited element, which would break the diff calculation
        // TODO_UNDO: multiElement? async image transformation? other async actions?
        if (
          id === appState.editingElement?.id ||
          id === appState.resizingElement?.id ||
          id === appState.draggingElement?.id
        ) {
          continue;
        }

        clonedElements.set(id, deepCopyElement(nextElement));
      }
    }

    return clonedElements;
  }
}
