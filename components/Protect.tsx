"use client";

import { useEffect } from "react";

/**
 * Anti-inspect layer: blocks right-click, devtools shortcuts, view-source,
 * and page saving. Source is still minified in production, but casual
 * "inspect element" / F12 / Ctrl+U attempts are dead.
 */
export function Protect() {
  useEffect(() => {
    const isDevtoolsKey = (e: KeyboardEvent) => {
      const k = e.key.toUpperCase();
      if (k === "F12") return true;
      if (e.ctrlKey && e.shiftKey && ["I", "J", "C", "K", "E"].includes(k)) return true;
      if (e.metaKey && e.altKey && ["I", "J", "C"].includes(k)) return true;
      if ((e.ctrlKey || e.metaKey) && k === "U") return true; // view-source
      if ((e.ctrlKey || e.metaKey) && k === "S") return true; // save page
      return false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (isDevtoolsKey(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onCtx = (e: MouseEvent) => e.preventDefault();
    const onDragStart = (e: DragEvent) => e.preventDefault();

    document.addEventListener("contextmenu", onCtx);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("dragstart", onDragStart);
    return () => {
      document.removeEventListener("contextmenu", onCtx);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("dragstart", onDragStart);
    };
  }, []);
  return null;
}