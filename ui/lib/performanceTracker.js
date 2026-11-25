// Performance tracker for UI paint events using PerformanceObserver

/**
 * Starts observing paint timing entries and stores the latest values in localStorage.
 * Keys:
 *   lg-paint-first-contentful (ms)
 *   lg-paint-first-paint (ms)
 */
export function startPaintObserver() {
  if (typeof PerformanceObserver === 'undefined') return;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name === 'first-contentful-paint') {
        localStorage.setItem('lg-paint-first-contentful', String(Math.round(entry.startTime)));
      } else if (entry.name === 'first-paint') {
        localStorage.setItem('lg-paint-first-paint', String(Math.round(entry.startTime)));
      }
    }
  });
  observer.observe({ type: 'paint', buffered: true });
}
