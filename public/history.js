export function createHistory(limit = 50) {
  const past = [], future = [];
  return {
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    checkpoint(items) {
      past.push(structuredClone(items));
      if (past.length > limit) past.shift();
      future.length = 0;
    },
    undo(items) {
      if (!past.length) return null;
      future.push(structuredClone(items));
      return past.pop();
    },
    redo(items) {
      if (!future.length) return null;
      past.push(structuredClone(items));
      return future.pop();
    },
    clear() { past.length = future.length = 0; },
  };
}
