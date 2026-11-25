/**
 * Kleines Ersatz-DOM für die Tests des Webinterface (P10), ohne neue Abhängigkeit. Es kann genau
 * das, was `dom.js` und `views.js` brauchen, und zeichnet jedes erzeugte Element und jedes
 * gesetzte Attribut auf. Damit prüfen die Tests, dass feindlicher Text nie zu Markup wird.
 */

export class FakeText {
  readonly nodeType = 3;
  readonly data: string;
  constructor(data: string) {
    this.data = data;
  }
  get textContent(): string {
    return this.data;
  }
}

export type FakeNode = FakeElement | FakeText;

export class FakeElement {
  readonly nodeType = 1;
  readonly attributes = new Map<string, string>();
  children: FakeNode[] = [];
  href = "";
  target = "";
  rel = "";
  value = "";
  type = "";
  readonly listeners = new Map<string, (() => void)[]>();

  readonly tagName: string;
  private readonly doc: FakeDocument;

  constructor(tagName: string, doc: FakeDocument) {
    this.tagName = tagName;
    this.doc = doc;
  }

  setAttribute(name: string, value: string): void {
    this.doc.attributeLog.push([name, value]);
    this.attributes.set(name, value);
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  /** Löst die Zuhörer für `click` aus, wie ein Klick im Browser. */
  click(): void {
    for (const listener of this.listeners.get("click") ?? []) {
      listener();
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  append(...nodes: unknown[]): void {
    for (const node of nodes) {
      if (!(node instanceof FakeElement || node instanceof FakeText)) {
        // Wie `append` im Browser: Zeichenketten würden Text. `dom.js` macht daraus aber selbst
        // Textknoten; kommt hier etwas anderes an, ist das ein Fehler im Code.
        throw new Error(`append mit ${typeof node}`);
      }
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: unknown[]): void {
    this.children = [];
    this.append(...nodes);
  }

  get textContent(): string {
    return this.children.map((child) => child.textContent).join("");
  }

  /** Alle Elemente im Teilbaum mit diesem Tag, das Element selbst eingeschlossen. */
  findAll(tag: string): FakeElement[] {
    const found: FakeElement[] = this.tagName === tag ? [this] : [];
    for (const child of this.children) {
      if (child instanceof FakeElement) {
        found.push(...child.findAll(tag));
      }
    }
    return found;
  }

  /** Alle Tags im Teilbaum. */
  tags(): string[] {
    return [
      this.tagName,
      ...this.children.flatMap((child) => (child instanceof FakeElement ? child.tags() : [])),
    ];
  }
}

export class FakeDocument {
  readonly created: string[] = [];
  readonly attributeLog: [string, string][] = [];

  createElement(tag: string): FakeElement {
    this.created.push(tag);
    return new FakeElement(tag, this);
  }

  createTextNode(text: string): FakeText {
    return new FakeText(text);
  }

  /** Für die Funktionen unter Test, die ein `Document` erwarten. */
  get asDocument(): Document {
    return this as unknown as Document;
  }
}

/** Für Rückgaben der Funktionen unter Test. */
export function fake(node: unknown): FakeElement {
  if (!(node instanceof FakeElement)) {
    throw new Error("kein FakeElement");
  }
  return node;
}
