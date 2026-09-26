import { createContext, useContext } from 'react';

/**
 * Every open tab keeps its page mounted (that is what preserves a half-filled form), so a page
 * can't assume it is the one on screen. Anything a page does that reaches outside itself — a
 * window-level key handler, setting the top-bar title — should check this first.
 */
export const TabActiveContext = createContext(true);
export const useTabActive = () => useContext(TabActiveContext);
