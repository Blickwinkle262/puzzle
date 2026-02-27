import { useEffect, useState } from "react";

export function useImageSize(src: string): { width: number; height: number; loaded: boolean } {
  const [state, setState] = useState({ width: 0, height: 0, loaded: false });

  useEffect(() => {
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) {
        return;
      }
      setState({ width: image.naturalWidth, height: image.naturalHeight, loaded: true });
    };
    image.onerror = () => {
      if (cancelled) {
        return;
      }
      setState({ width: 0, height: 0, loaded: false });
    };
    image.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);

  return state;
}
