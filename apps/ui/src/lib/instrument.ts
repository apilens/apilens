// "How do you want to instrument?" (#332): the languages, runtimes and methods the onboarding
// instrument step offers, and the method it recommends for a language and runtime. Pure, so the
// choices can be unit tested; the ids are what `PATCH /users/me/onboarding` saves as `language`,
// `runtime` and `method` (each fits the API's ChoicePattern).
import type { OnboardingAnswers } from "./identity";

export type Method = "sdk" | "otlp" | "url-check";

export interface Language {
  id: string;
  label: string;
  /** Simple Icons slug of its logo. */
  icon: string;
  /** The APILens SDK package for it, when there is one. */
  sdk?: string;
  /** Whether OpenTelemetry can send it over OTLP/HTTP (`/otlp/v1/traces`, `/otlp/v1/logs`). */
  otlp: boolean;
}

/**
 * Every language the step shows. Server languages with an APILens SDK (packages/sdk-*) or an
 * OpenTelemetry SDK that exports OTLP are enabled; client-side ones have neither path yet and
 * show as coming soon.
 */
export const LANGUAGES: readonly Language[] = [
  { id: "python", label: "Python", icon: "python", sdk: "apilenss", otlp: true },
  { id: "node", label: "Node.js", icon: "nodedotjs", sdk: "apilens-js-sdk", otlp: true },
  { id: "java", label: "Java", icon: "openjdk", sdk: "ai.apilens:apilens-java-sdk", otlp: true },
  { id: "go", label: "Go", icon: "go", otlp: true },
  { id: "dotnet", label: ".NET", icon: "dotnet", otlp: true },
  { id: "php", label: "PHP", icon: "php", otlp: true },
  { id: "ruby", label: "Ruby", icon: "ruby", otlp: true },
  { id: "browser", label: "Browser", icon: "javascript", otlp: false },
  { id: "ios", label: "iOS", icon: "apple", otlp: false },
  { id: "android", label: "Android", icon: "android", otlp: false },
];

export interface Runtime {
  id: string;
  label: string;
  hint: string;
}

export const RUNTIMES: readonly Runtime[] = [
  { id: "kubernetes", label: "Kubernetes", hint: "Pods, Helm" },
  { id: "docker", label: "Docker or VM", hint: "Containers, hosts" },
  { id: "serverless", label: "Serverless", hint: "Lambda, Cloud Run" },
  { id: "laptop", label: "My laptop", hint: "Trying it out" },
];

/** Every method in the order the step lists them; `url-check` is not available yet. */
export const METHODS: readonly Method[] = ["sdk", "otlp", "url-check"];

const byId = <T extends { id: string }>(list: readonly T[], id: string | undefined): T | undefined =>
  id === undefined ? undefined : list.find((x) => x.id === id);

export const languageOf = (id: string | undefined) => byId(LANGUAGES, id);
export const runtimeOf = (id: string | undefined) => byId(RUNTIMES, id);

/** Whether a language can be picked: it has an SDK or an OTLP path. */
export function languageEnabled(lang: Language): boolean {
  return Boolean(lang.sdk) || lang.otlp;
}

/** The methods a language can use today, best first. */
export function methodsFor(language: string | undefined): Method[] {
  const lang = languageOf(language);
  if (!lang) return [];
  const out: Method[] = [];
  if (lang.sdk) out.push("sdk");
  if (lang.otlp) out.push("otlp");
  return out;
}

/**
 * The method the step recommends: the APILens SDK when the language has one (requests, errors and
 * traces from one middleware), otherwise OpenTelemetry over OTLP. Undefined for a language with
 * neither, or an unknown one.
 */
export function recommend(language: string | undefined, _runtime?: string): Method | undefined {
  // Every runtime gets the same method today; `recommendReason` says why per runtime.
  return methodsFor(language)[0];
}

/** One sentence on why `method` suits `language` on `runtime`. */
export function recommendReason(method: Method, language: string | undefined, runtime: string | undefined): string {
  const lang = languageOf(language)?.label ?? "your service";
  if (method === "sdk") {
    switch (runtime) {
      case "laptop":
        return `The quickest way to see a request: install the ${lang} SDK, add the middleware, run your app.`;
      case "serverless":
        return "Wrap your handler with the middleware: no agent or sidecar to deploy.";
      default:
        return "One middleware captures every request, error and trace, grouped by endpoint.";
    }
  }
  if (method === "otlp") {
    return runtime === "kubernetes"
      ? "Point the OpenTelemetry Collector you already run at APILens, or export from each service."
      : `Use the OpenTelemetry SDK for ${lang} and export traces and logs over OTLP/HTTP.`;
  }
  return "Check a public URL from outside, without changing any code.";
}

export interface InstrumentChoice {
  language?: string;
  runtime?: string;
  /** What the user picked; undefined until they pick one (the recommendation applies). */
  method?: Method;
}

/** The saved answers (#327) the step starts from; ones it cannot offer any more are dropped. */
export function savedInstrument(answers: OnboardingAnswers): InstrumentChoice {
  const lang = languageOf(answers.language);
  const language = lang && languageEnabled(lang) ? lang.id : undefined;
  const runtime = runtimeOf(answers.runtime)?.id;
  const method = methodsFor(language).find((m) => m === answers.method);
  return { language, runtime, method };
}

/** The method in effect: the one picked while the language can still use it, else the recommendation. */
export function effectiveMethod(choice: InstrumentChoice): Method | undefined {
  if (choice.method && methodsFor(choice.language).includes(choice.method)) return choice.method;
  return recommend(choice.language, choice.runtime);
}
