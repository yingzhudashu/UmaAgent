import type { ReactNode } from "react";

export function InspectorContent({ children }: { children: ReactNode }) {
  return <div className="details">{children}</div>;
}
