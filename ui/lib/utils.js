// Utility helpers for the UI

/**
 * Debounce a function so it only runs after `wait` ms of inactivity.
 * Used to throttle rapid UI events like search input or button clicks.
 */
export function debounce(fn, wait) {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), wait);
  };
}
