export function $(selector, root = document) {
  const element = root.querySelector(selector);
  if (!element) {
    throw new Error(`Missing element ${selector}`);
  }
  return element;
}

export function $all(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}
