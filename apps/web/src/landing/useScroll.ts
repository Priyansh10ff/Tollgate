import { useEffect, useState } from "react";

export interface ScrollState {
  /** Pixels scrolled from the top of the page. */
  top: number;
  /** Viewport height, capped at the hero stage's 900px. */
  vh: number;
  /** data-tone of the section crossing the middle of the screen. */
  tone: string;
  /** Viewport width. */
  vw: number;
}

/** Scroll position, viewport height and current section tone, updated once per frame. */
export function useScroll(): ScrollState {
  const [state, setState] = useState<ScrollState>({ top: 0, vh: 900, tone: "hero", vw: 1440 });

  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      const vh = window.innerHeight || 900;
      let tone = "hero";
      document.querySelectorAll<HTMLElement>("[data-tone]").forEach((node) => {
        if (node.getBoundingClientRect().top < vh * 0.5) tone = node.dataset.tone ?? tone;
      });
      setState({ top: window.scrollY, vh: Math.min(vh, 900), tone, vw: window.innerWidth });
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  return state;
}

/** Counts from 0 to `max`, one step every `ms`, starting on mount. */
export function useBoot(max: number, ms: number): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setN(max);
      return;
    }
    const timer = setInterval(() => setN((v) => (v >= max ? v : v + 1)), ms);
    return () => clearInterval(timer);
  }, [max, ms]);
  return n;
}

export const clamp = (v: number) => Math.max(0, Math.min(1, v));
