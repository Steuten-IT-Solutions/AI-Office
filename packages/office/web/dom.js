/**
 * Bausteine für das DOM des Webinterface (P10, plan.md Kap. 5.11).
 *
 * Schutz vor XSS (AK 9): Texte gehen nur als Textknoten ins DOM, nie als HTML. Attribute sind auf
 * eine feste Liste beschränkt; Ereignis-Attribute (`on…`), `style` und `href` gibt es nicht. Ein
 * Link entsteht nur über `externalLink` und nur zu `https:`. ESLint verbietet im Browser-Code
 * `innerHTML` und verwandte Wege (eslint.config.js).
 *
 * Alle Funktionen bekommen das `Document` übergeben, damit die Tests ohne Browser auskommen.
 */

/** Erlaubte Attribute. Alles andere ist ein Programmierfehler. */
const ATTRIBUTES = new Set([
  "class",
  "id",
  "title",
  "role",
  "aria-label",
  "aria-live",
  "datetime",
  "lang",
  "data-kind",
  "data-state",
]);

/**
 * @typedef {string | number | Node | null | undefined | false} Child
 */

/**
 * Element mit Attributen und Kindern. Zeichenketten und Zahlen werden Textknoten.
 *
 * @template {keyof HTMLElementTagNameMap} K
 * @param {Document} doc
 * @param {K} tag
 * @param {Record<string, string> | null} [attrs]
 * @param {...Child} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function h(doc, tag, attrs, ...children) {
  const element = doc.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (!ATTRIBUTES.has(name)) {
      throw new Error(`Attribut nicht erlaubt: ${name}`);
    }
    element.setAttribute(name, value);
  }
  append(doc, element, children);
  return element;
}

/**
 * @param {Document} doc
 * @param {Element} parent
 * @param {readonly Child[]} children
 */
export function append(doc, parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    parent.append(
      typeof child === "string" || typeof child === "number"
        ? doc.createTextNode(String(child))
        : child,
    );
  }
}

/**
 * Ersetzt den Inhalt eines Elements.
 *
 * @param {Document} doc
 * @param {Element} parent
 * @param {...Child} children
 */
export function replace(doc, parent, ...children) {
  parent.replaceChildren();
  append(doc, parent, children);
}

/**
 * Prüft eine URL für einen Link: nur `https:` ohne Zugangsdaten. Sonst `null`.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function safeHttpsUrl(value) {
  if (typeof value !== "string") {
    return null;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    return null;
  }
  return url.href;
}

/**
 * Link, der in einem neuen Tab öffnet, ohne `window.opener` und ohne Referrer. Ist die URL nicht
 * `https:`, entsteht nur der Text.
 *
 * @param {Document} doc
 * @param {unknown} url
 * @param {string} text
 * @param {Record<string, string>} [attrs]
 * @returns {HTMLElement}
 */
export function externalLink(doc, url, text, attrs) {
  const href = safeHttpsUrl(url);
  if (href === null) {
    return h(doc, "span", attrs ?? null, text);
  }
  const link = h(doc, "a", attrs ?? null, text);
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}
