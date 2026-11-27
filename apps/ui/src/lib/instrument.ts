// The languages with an APILens SDK (packages/sdk-*), for the SDK setup snippets.

export interface Language {
  id: string;
  label: string;
  /** Simple Icons slug of its logo. */
  icon: string;
  /** The APILens SDK package for it. */
  sdk: string;
}

/** Every language with an APILens SDK. */
export const LANGUAGES: readonly Language[] = [
  { id: "python", label: "Python", icon: "python", sdk: "apilenss" },
  { id: "node", label: "Node.js", icon: "nodedotjs", sdk: "apilens-js-sdk" },
  { id: "java", label: "Java", icon: "openjdk", sdk: "ai.apilens:apilens-java-sdk" },
];

export const languageOf = (id: string | undefined) => (id === undefined ? undefined : LANGUAGES.find((l) => l.id === id));
