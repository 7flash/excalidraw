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

export interface IStore {
  capture(scene: Scene, appState: AppState): void;
  updateSnapshot(
    scene: Scene,
    appState: AppState,
    isRemoteUpdate?: boolean,
  ): void;
  listen(
    callback: (
      elementsChange: ElementsChange,
      appStateChange: AppStateChange,
    ) => void,
  ): ReturnType<Emitter["on"]>;
  clear(): void;
}

/**
 * In the future, Store should coordinate the changes and maintain its increments cohesive between different instances.
 */
export class Store implements IStore {
  // TODO_UNDO: Add a specific increment type which could be a squash of multiple changes
  private readonly onStoreIncrementEmitter = new Emitter<
    [elementsChange: ElementsChange, appStateChange: AppStateChange]
  >();

  private capturingChanges: boolean = false;
  private updatingSnapshot: boolean = false;

  public snapshot = Snapshot.empty();

  public scheduleSnapshotting() {
    this.updatingSnapshot = true;
  }

  // Suspicious that this is called so many places. Seems error-prone.
  public resumeCapturing() {
    this.capturingChanges = true;
  }

  public listen(
    callback: (
      elementsChange: ElementsChange,
      appStateChange: AppStateChange,
    ) => void,
  ) {
    return this.onStoreIncrementEmitter.on(callback);
  }

  public capture(scene: Scene, appState: AppState): void {
    // Quick exit for irrelevant changes
    if (!this.capturingChanges && !this.updatingSnapshot) {
      return;
    }

    const nextSnapshot = this.updateSnapshot(scene, appState);

    // Optimisation, don't continue if nothing has changed
    if (this.snapshot !== nextSnapshot) {
      // Calculate and record the changes based on the previous and next snapshot
      if (
        this.capturingChanges &&
        !!this.snapshot.options.sceneVersionNonce // Special case when versionNonce is undefined, meaning it's first initialization of the Scene, which we don't want to record (is this invariant correct at all times?!)
      ) {
        const elementsChange = nextSnapshot.options.didElementsChange
          ? ElementsChange.calculate(
              this.snapshot.elements,
              nextSnapshot.elements,
            )
          : ElementsChange.empty();

        const appStateChange = nextSnapshot.options.didAppStateChange
          ? AppStateChange.calculate(
              this.snapshot.appState,
              nextSnapshot.appState,
            )
          : AppStateChange.empty();

        if (!elementsChange.isEmpty() || !appStateChange.isEmpty()) {
          this.onStoreIncrementEmitter.trigger(elementsChange, appStateChange);
        }
      }

      // Update the snapshot
      this.snapshot = nextSnapshot;
    }

    // Reset props
    this.updatingSnapshot = false;
    this.capturingChanges = false;
  }

  public updateSnapshot(
    scene: Scene,
    appState: AppState,
    isRemoteUpdate = false,
  ) {
    const nextElements = scene.getElementsMapIncludingDeleted();
    const snapshotOptions: SnapshotOptions = {
      isRemoteUpdate,
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

  public clear(): void {
    this.snapshot = Snapshot.empty();
  }

  public destroy(): void {
    this.clear();
    this.onStoreIncrementEmitter.destroy();
  }
}

type SnapshotOptions = {
  isRemoteUpdate?: boolean;
  sceneVersionNonce?: number;
};

class Snapshot {
  private constructor(
    public readonly elements: Map<string, ExcalidrawElement>,
    public readonly appState: ObservedAppState,
    public readonly options: {
      didElementsChange: boolean;
      didAppStateChange: boolean;
      sceneVersionNonce?: number;
    } = { didElementsChange: false, didAppStateChange: false },
  ) {}

  public static empty() {
    return new Snapshot(
      new Map(),
      getObservedAppState(getDefaultAppState() as AppState),
    );
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
    const didElementsChange =
      this.options.sceneVersionNonce !== sceneVersionNonce;

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
      nextElementsSnapshot = this.createElementsSnapshot(
        elements,
        appState,
        options,
      );
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
    options: SnapshotOptions,
  ) {
    const clonedElements = new Map();

    for (const [id, prevElement] of this.elements.entries()) {
      // clone previous elements, never delete, in case nextElements would be just a subset of previous elements
      // i.e. during collab, persist or whenenever get isDeleted elements cleaned
      clonedElements.set(id, prevElement);
    }

    for (const [id, nextElement] of nextElements.entries()) {
      const prevElement = clonedElements.get(id);

      if (
        !prevElement || // element was added
        (prevElement && prevElement.versionNonce !== nextElement.versionNonce) // element was updated
      ) {
        // TODO_UNDO: this is only necessary on remote updates, thus could be separated (and also tested independently)
        // Special case, when we don't want to capture editing element from remote, if it's currently being edited
        // If we would capture it, we would capture yet uncommited element, which would break undo
        if (
          !!options.isRemoteUpdate &&
          (id === appState.editingElement?.id || // TODO_UNDO: won't this cause some concurrency issues again? should we compare also version here?
            id === appState.resizingElement?.id ||
            id === appState.multiElement?.id ||
            id === appState.draggingElement?.id)
        ) {
          continue;
        }

        clonedElements.set(id, deepCopyElement(nextElement));
      }
    }

    return clonedElements;
  }
}
