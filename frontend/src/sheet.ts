/** Bottom-sheet gestures for the phone layout: drag the grabber (or the sheet, when it's scrolled to the top) down to
 * dismiss, up to fill the screen. While a sheet is open, touches never scroll the page behind it. */
import { RefObject, useEffect, useRef } from 'react';

export const isPhoneLayout = () => document.body.classList.contains('phone');

let openSheets = 0;

/** The element under the finger that can scroll vertically, up to and including the sheet. */
function scrollerOf(target: EventTarget | null, sheet: HTMLElement): HTMLElement | null {
  let n = target instanceof HTMLElement ? target : null;
  while (n) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1) return n;
    if (n === sheet) break;
    n = n.parentElement;
  }
  return null;
}

export function useSheetGestures(ref: RefObject<HTMLElement | null>, active: boolean, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    openSheets++;
    document.body.classList.add('sheet-open');

    let startY = 0;
    let lastY = 0;
    let lastT = 0;
    let velocity = 0;
    let startH = 0;
    /** The sheet's natural height, to come back to from full screen. */
    let halfH = 0;
    let full = false;
    let mode: 'idle' | 'drag' | 'scroll' = 'idle';
    let fromGrip = false;
    let scroller: HTMLElement | null = null;
    let settle = 0;
    const EASE = '0.28s cubic-bezier(0.22, 1, 0.36, 1)';
    const scrim = (el.previousElementSibling?.classList.contains('sheet-scrim') ? el.previousElementSibling : el.parentElement?.classList.contains('modal-backdrop') ? el.parentElement : null) as HTMLElement | null;
    const fullHeight = () => {
      const ws = document.querySelector('.phone-app .workspace');
      const top = ws ? parseFloat(getComputedStyle(ws).paddingTop) || 0 : 0;
      return window.innerHeight - top - 10;
    };
    const animate = (on: boolean) => {
      el.style.transition = on ? `transform ${EASE}, height ${EASE}` : 'none';
      if (scrim) scrim.style.transition = on ? `opacity ${EASE}` : 'none';
    };
    const setHeight = (h: number | null) => {
      if (h == null) {
        el.style.removeProperty('height');
        el.style.removeProperty('max-height');
      } else {
        el.style.setProperty('max-height', 'none', 'important');
        el.style.setProperty('height', `${Math.round(h)}px`, 'important');
      }
    };
    const setY = (y: number) => {
      el.style.transform = y ? `translateY(${y}px)` : '';
      if (scrim) scrim.style.opacity = y > 0 ? String(Math.max(0.1, 1 - y / Math.max(startH, 1))) : '';
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      clearTimeout(settle);
      startY = lastY = e.touches[0].clientY;
      lastT = e.timeStamp;
      velocity = 0;
      mode = 'idle';
      startH = el.offsetHeight;
      if (!full) halfH = startH;
      fromGrip = !!(e.target instanceof Element && e.target.closest('.sheet-grip'));
      scroller = fromGrip ? null : scrollerOf(e.target, el);
    };

    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      const dy = y - startY;
      if (e.timeStamp > lastT) velocity = (y - lastY) / (e.timeStamp - lastT);
      lastY = y;
      lastT = e.timeStamp;
      if (mode === 'idle') {
        const atTop = !scroller || scroller.scrollTop <= 0;
        const canScrollDown = !!scroller && scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1;
        mode = fromGrip || (dy > 0 && atTop) || (dy < 0 && !canScrollDown && !full) ? 'drag' : 'scroll';
        if (mode === 'drag') animate(false);
      }
      if (mode !== 'drag') return;
      e.preventDefault();
      if (dy >= 0) {
        // Down: the whole sheet follows the finger and the background lightens.
        setY(dy);
      } else if (!full) {
        // Up: the sheet grows with the finger, up to full screen.
        setY(0);
        setHeight(Math.min(fullHeight(), startH - dy));
      }
    };

    const onEnd = () => {
      if (mode !== 'drag') return;
      mode = 'idle';
      const dy = lastY - startY;
      animate(true);
      if (dy > 0) {
        if (full && dy > 60 && dy < startH * 0.5 && velocity < 1.2) {
          // From full screen, a short pull goes back to the natural height.
          full = false;
          setY(0);
          setHeight(halfH);
          settle = window.setTimeout(() => setHeight(null), 300);
        } else if (dy > Math.min(140, startH * 0.3) || velocity > 0.6) {
          // Dismiss: slide all the way down while the background fades, then close.
          el.style.transform = `translateY(${startH + 40}px)`;
          if (scrim) scrim.style.opacity = '0';
          settle = window.setTimeout(() => close.current(), 260);
        } else setY(0);
      } else if (dy < 0 && !full) {
        if (-dy > 50 || velocity < -0.5) {
          full = true;
          setHeight(fullHeight());
        } else {
          setHeight(startH);
          settle = window.setTimeout(() => setHeight(null), 300);
        }
      } else setY(0);
    };

    // Touches outside the sheet (the scrim) must not scroll the page underneath.
    const blockOutside = (e: TouchEvent) => {
      if (!(e.target instanceof Node) || !el.contains(e.target)) {
        const inOtherSheet = e.target instanceof Element && e.target.closest('.popover, .modal');
        if (!inOtherSheet) e.preventDefault();
      }
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    document.addEventListener('touchmove', blockOutside, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      document.removeEventListener('touchmove', blockOutside);
      clearTimeout(settle);
      if (--openSheets <= 0) {
        openSheets = 0;
        document.body.classList.remove('sheet-open');
      }
    };
  }, [active, ref]);
}
