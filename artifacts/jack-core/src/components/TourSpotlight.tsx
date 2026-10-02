import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

function visibleRect(element: HTMLElement): DOMRect {
  const rect = element.getBoundingClientRect();
  let left = Math.max(0, rect.left);
  let top = Math.max(0, rect.top);
  let right = Math.min(window.innerWidth, rect.right);
  let bottom = Math.min(window.innerHeight, rect.bottom);
  for (
    let parent = element.parentElement;
    parent;
    parent = parent.parentElement
  ) {
    const style = window.getComputedStyle(parent);
    const bounds = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      left = Math.max(left, bounds.left);
      right = Math.min(right, bounds.right);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      top = Math.max(top, bounds.top);
      bottom = Math.min(bottom, bounds.bottom);
    }
  }
  return new DOMRect(
    left,
    top,
    Math.max(0, right - left),
    Math.max(0, bottom - top),
  );
}

/** A visual spotlight only: the actual controls retain their input/focus behavior. */
export function TourSpotlight({ targets }: { targets: string }) {
  const maskId = useId().replace(/:/g, "");
  const [rects, setRects] = useState<DOMRect[]>([]);

  useEffect(() => {
    let frame = 0;
    let last = "";
    const measure = () => {
      const next = Array.from(document.querySelectorAll<HTMLElement>(targets))
        .map(visibleRect)
        .filter((rect) => rect.width > 0 && rect.height > 0);
      const signature = next
        .map(({ x, y, width, height }) => [x, y, width, height].join(","))
        .join(";");
      if (signature !== last) {
        last = signature;
        setRects(next);
      }
      // Track drawer animation, keyboard/viewport changes, and async page layout.
      if (typeof window.requestAnimationFrame === "function")
        frame = window.requestAnimationFrame(measure);
    };
    measure();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [targets]);

  if (!rects.length) return null;
  return createPortal(
    <svg
      aria-hidden="true"
      data-tour-spotlight
      className="pointer-events-none fixed inset-0 z-[60] h-full w-full"
    >
      <defs>
        <mask id={maskId}>
          <rect width="100%" height="100%" fill="white" />
          {rects.map((rect, index) => (
            <rect
              key={index}
              x={rect.x - 4}
              y={rect.y - 4}
              width={rect.width + 8}
              height={rect.height + 8}
              rx="12"
              fill="black"
            />
          ))}
        </mask>
      </defs>
      <rect
        width="100%"
        height="100%"
        fill="black"
        fillOpacity="0.65"
        mask={`url(#${maskId})`}
      />
      {rects.map((rect, index) => (
        <rect
          key={index}
          x={rect.x - 3}
          y={rect.y - 3}
          width={rect.width + 6}
          height={rect.height + 6}
          rx="12"
          fill="none"
          stroke="#22d3ee"
          strokeWidth="2"
        />
      ))}
    </svg>,
    document.body,
  );
}
