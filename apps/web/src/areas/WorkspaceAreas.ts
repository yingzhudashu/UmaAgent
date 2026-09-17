import { lazy } from "react";

export const XianyuWorkspace = lazy(() =>
  import("./XianyuWorkspace.js").then((module) => ({ default: module.XianyuWorkspace })),
);
export const BackgroundTaskArea = lazy(() =>
  import("./BackgroundTaskArea.js").then((module) => ({ default: module.BackgroundTaskArea })),
);
export const DiagnosticsArea = lazy(() =>
  import("./DiagnosticsArea.js").then((module) => ({ default: module.DiagnosticsArea })),
);
export const EvaluationArea = lazy(() =>
  import("./EvaluationArea.js").then((module) => ({ default: module.EvaluationArea })),
);
export const MemoryArea = lazy(() =>
  import("./MemoryArea.js").then((module) => ({ default: module.MemoryArea })),
);
export const OptimizationArea = lazy(() =>
  import("./OptimizationArea.js").then((module) => ({ default: module.OptimizationArea })),
);
export const ResourceArea = lazy(() =>
  import("./ResourceArea.js").then((module) => ({ default: module.ResourceArea })),
);
export const ScheduleArea = lazy(() =>
  import("./ScheduleArea.js").then((module) => ({ default: module.ScheduleArea })),
);
