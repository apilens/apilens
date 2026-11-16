// "How do you want to instrument?" (#332): the languages and runtimes the onboarding instrument
// step offers. Instrumentation is the APILens SDK only, so the step lists the languages with an
// SDK (packages/sdk-*). Pure, so the choices can be unit tested; the ids are what
// `PATCH /users/me/onboarding` saves as `language` and `runtime` (each fits the API's ChoicePattern).
import type { OnboardingAnswers } from "./identity";

/** What the step saves as `method`: the SDK is the only way in. */
export const SDK_METHOD = "sdk";

export interface Language {
  id: string;
  label: string;
  /** Simple Icons slug of its logo. */
  icon: string;
  /** The APILens SDK package for it. */
  sdk: string;
}

/** Every language with an APILens SDK, in the order the step shows them. */
export const LANGUAGES: readonly Language[] = [
  { id: "python", label: "Python", icon: "python", sdk: "apilenss" },
  { id: "node", label: "Node.js", icon: "nodedotjs", sdk: "apilens-js-sdk" },
  { id: "java", label: "Java", icon: "openjdk", sdk: "ai.apilens:apilens-java-sdk" },
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

const byId = <T extends { id: string }>(list: readonly T[], id: string | undefined): T | undefined =>
  id === undefined ? undefined : list.find((x) => x.id === id);

export const languageOf = (id: string | undefined) => byId(LANGUAGES, id);
export const runtimeOf = (id: string | undefined) => byId(RUNTIMES, id);

/** One sentence on how the SDK fits `language` on `runtime`. */
export function sdkReason(language: string | undefined, runtime: string | undefined): string {
  const lang = languageOf(language)?.label ?? "your service";
  switch (runtime) {
    case "laptop":
      return `The quickest way to see a request: install the ${lang} SDK, add the middleware, run your app.`;
    case "serverless":
      return "Wrap your handler with the middleware: no agent or sidecar to deploy.";
    default:
      return "One middleware captures every request, error and trace, grouped by endpoint.";
  }
}

export interface InstrumentChoice {
  language?: string;
  runtime?: string;
}

/** The saved answers (#327) the step starts from; ones it cannot offer any more are dropped. */
export function savedInstrument(answers: OnboardingAnswers): InstrumentChoice {
  return { language: languageOf(answers.language)?.id, runtime: runtimeOf(answers.runtime)?.id };
}
