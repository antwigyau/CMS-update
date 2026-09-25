/**
 * DOM construction helpers.
 *
 * These exist so that no application code needs innerHTML — which is banned by
 * an ESLint rule, because it is the shortest path from "a member typed a name"
 * to "arbitrary script ran in an administrator's browser".
 *
 * Text always arrives via textContent, which cannot execute anything.
 */

/** URL schemes permitted in href/src. Blocks javascript: and data: URLs. */
const SAFE_URL = /^(?:https?:\/\/|mailto:|tel:|\/|\.\/|\.\.\/|#|\?)/i;

function assertSafeUrl(attribute, value) {
  if (SAFE_URL.test(value)) return value;
  throw new Error(`Refusing to set ${attribute} to an unsafe URL: ${value.slice(0, 32)}`);
}

/**
 * Create an element.
 *
 *   el('p', { class: 'lead', text: member.fullName })
 *   el('a', { href: '/members', text: 'Members' })
 *   el('div', { class: 'row' }, [el('span', { text: 'a' }), 'plain text'])
 *
 * @param {string} tag
 * @param {object} [attributes]  `text` sets textContent; `dataset` sets data-*;
 *                               `onclick`-style keys attach listeners.
 * @param {Array<Node|string>} [children]
 */
export function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'style') {
      // The CSP sets `style-src 'self'` with no 'unsafe-inline', which blocks
      // style="" attributes. Failing here is better than a silently unstyled UI.
      throw new Error('Inline style attributes are blocked by the CSP — add a class instead.');
    }

    if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'class') {
      node.className = String(value);
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'href' || key === 'src' || key === 'action') {
      node.setAttribute(key, assertSafeUrl(key, String(value)));
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }

  append(node, children);
  return node;
}

export function append(parent, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

/** Replace a node's contents in one operation — no intermediate empty state. */
export function render(node, children) {
  const list = Array.isArray(children) ? children : [children];
  node.replaceChildren(
    ...list
      .filter((child) => child !== null && child !== undefined && child !== false)
      .map((child) => (child instanceof Node ? child : document.createTextNode(String(child)))),
  );
  return node;
}

export const qs = (selector, scope = document) => scope.querySelector(selector);
export const qsa = (selector, scope = document) => [...scope.querySelectorAll(selector)];

/** A Bootstrap icon span. Decorative by default, so hidden from screen readers. */
export function icon(name, { label } = {}) {
  return el('i', {
    class: `bi bi-${name}`,
    'aria-hidden': label ? null : 'true',
    'aria-label': label ?? null,
    role: label ? 'img' : null,
  });
}

/** Standard empty / error / loading block. */
export function stateBlock({ variant = 'empty', iconName, title, message, action }) {
  return el(
    'div',
    { class: `state state--${variant}`, role: variant === 'error' ? 'alert' : null },
    [
      el('div', { class: 'state__icon' }, [
        icon(iconName ?? (variant === 'error' ? 'exclamation-triangle' : 'inbox')),
      ]),
      el('h2', { class: 'state__title', text: title }),
      message ? el('p', { class: 'state__message', text: message }) : null,
      action ?? null,
    ],
  );
}

export function skeletonLines(count = 3) {
  // Widths come from :nth-child rules in app.css, not inline styles.
  return el(
    'div',
    { 'aria-hidden': 'true' },
    Array.from({ length: count }, () => el('div', { class: 'skeleton skeleton--text' })),
  );
}
