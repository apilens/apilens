// Recording deploys (#997): the SDK snippets that stamp a release and commit on every record, one
// tab per SDK the project's apps run (all three when none reported yet; picked with
// `pickConsumerSdks` from what each app's SDK reported), and where the setup lives in settings.
// Pure; safe in Client Components; unit-tested in release-setup.test.ts.
import { type ConsumerSdk, pickConsumerSdks } from "./consumer-setup";
import type { Snippet } from "./install";
import { projectHref } from "./routes";

export type ReleaseSdk = ConsumerSdk;

export interface ReleaseSdkTab {
  id: ReleaseSdk;
  label: string;
}

/** The SDKs, in onboarding's order. Release and commit are SDK options, not framework ones. */
export const RELEASE_SDKS: readonly ReleaseSdkTab[] = [
  { id: "python", label: "Python" },
  { id: "express", label: "Node.js" },
  { id: "spring", label: "Java" },
];

/** The tabs for the frameworks the project's apps reported; every SDK when none is known. */
export function pickReleaseSdks(frameworks: readonly string[]): ReleaseSdk[] {
  return pickConsumerSdks(frameworks);
}

const CODE: Record<ReleaseSdk, Snippet> = {
  python: {
    id: "release-python",
    title: "main.py",
    code: [
      "app.add_middleware(",
      "    ApiLensMiddleware,",
      '    api_key=os.environ["APILENS_API_KEY"],',
      '    release=os.environ.get("GIT_SHA", ""),  # the version you deployed',
      '    commit=os.environ.get("GIT_SHA", ""),   # the commit it was built from',
      ")",
    ].join("\n"),
  },
  express: {
    id: "release-node",
    title: "app.js",
    code: [
      "useApiLens(app, {",
      "  apiKey: process.env.APILENS_API_KEY,",
      "  release: process.env.GIT_SHA, // the version you deployed",
      "  commit: process.env.GIT_SHA, // the commit it was built from",
      "});",
    ].join("\n"),
  },
  spring: {
    id: "release-java",
    title: "application.properties",
    code: [
      "apilens.api-key=${APILENS_API_KEY}",
      "# The version you deployed, and the commit it was built from",
      "apilens.release=${GIT_SHA:}",
      "apilens.commit=${GIT_SHA:}",
    ].join("\n"),
  },
};

/** The same two values as environment variables, which every SDK reads when the code sets neither. */
export const RELEASE_ENV_SNIPPET: Snippet = {
  id: "release-env",
  title: "Or set them in the environment at deploy time",
  code: ["# GIT_SHA: the commit your CI built, e.g. $(git rev-parse HEAD)", "export APILENS_RELEASE=$GIT_SHA", "export APILENS_COMMIT=$GIT_SHA"].join("\n"),
};

/** The snippets that set the release and commit with `sdk`: its config, then the environment. */
export function releaseSnippets(sdk: ReleaseSdk): Snippet[] {
  return [CODE[sdk] ?? CODE.python, RELEASE_ENV_SNIPPET];
}

/** The id of the "Release and commit" step on Settings › SDK setup. */
export const RELEASE_STEP_ID = "release";

/** Settings › SDK setup, at its "Release and commit" step. */
export function sdkSetupReleaseHref(project: string): string {
  return `${projectHref(project, "settings", "sdk")}#${RELEASE_STEP_ID}`;
}

/** Settings › Integrations, where the repository link turns commits into links. */
export function integrationsHref(project: string): string {
  return projectHref(project, "settings", "integrations");
}
