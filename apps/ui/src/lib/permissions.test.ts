import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Action, Capabilities } from "./capabilities";
import { CapabilitiesProvider, DENIED_REASON, type Decision, Gated, useCan } from "./permissions";

const caps: Capabilities = {
  web: ["project.read", "api_keys.create", "members.invite", "future.action"],
  empty: [],
};

function decide(action: Action, capabilities: Capabilities | null | undefined, project: string | undefined): Decision {
  let out: Decision | undefined;
  const Probe = () => {
    out = useCan(action);
    return null;
  };
  renderToStaticMarkup(createElement(CapabilitiesProvider, { capabilities, project }, createElement(Probe)));
  if (!out) throw new Error("probe did not render");
  return out;
}

const html = (project: string | undefined, child: ReactNode) => renderToStaticMarkup(createElement(CapabilitiesProvider, { capabilities: caps, project }, child));

describe("useCan", () => {
  it("allows the actions the context lists for the project", () => {
    expect(decide("project.read", caps, "web")).toEqual({ allowed: true, reason: null });
    expect(decide("api_keys.create", caps, "web")).toEqual({ allowed: true, reason: null });
    expect(decide("members.invite", caps, "web")).toEqual({ allowed: true, reason: null });
  });

  it("denies unlisted actions with the admin reason", () => {
    expect(decide("api_keys.revoke", caps, "web")).toEqual({ allowed: false, reason: "Only admins can do this. Ask an admin for access." });
    expect(decide("members.remove", caps, "web").reason).toBe(DENIED_REASON);
    expect(decide("project.read", caps, "empty").allowed).toBe(false);
  });

  it("fails closed without a project, for unknown projects and without capabilities", () => {
    expect(decide("project.read", caps, undefined).allowed).toBe(false);
    expect(decide("project.read", caps, "missing").allowed).toBe(false);
    expect(decide("project.read", caps, "toString").allowed).toBe(false);
    expect(decide("project.read", null, "web").allowed).toBe(false);
    expect(decide("project.read", undefined, "web").allowed).toBe(false);
  });

  it("throws outside CapabilitiesProvider", () => {
    const Probe = () => {
      useCan("project.read");
      return null;
    };
    expect(() => renderToStaticMarkup(createElement(Probe))).toThrow(/CapabilitiesProvider/);
  });
});

describe("Gated", () => {
  const button = createElement("button", { type: "button" }, "Create API key");

  it("renders children untouched when allowed", () => {
    expect(html("web", createElement(Gated, { action: "api_keys.create", children: button }))).toBe('<button type="button">Create API key</button>');
  });

  it("disables children and shows the reason when denied", () => {
    const out = html("web", createElement(Gated, { action: "api_keys.revoke", children: button }));
    expect(out).toContain('class="gated"');
    expect(out).toContain(`title="${DENIED_REASON}"`);
    expect(out).toMatch(/<fieldset disabled="" aria-describedby="([^"]+)"><button type="button">Create API key<\/button><\/fieldset><span id="\1" class="gated-reason">/);
  });

  it("renders nothing when denied with hide", () => {
    expect(html("web", createElement(Gated, { action: "api_keys.revoke", hide: true, children: button }))).toBe("");
  });

  it("passes the decision to a function child", () => {
    const child = (d: Decision) => createElement("button", { type: "button", disabled: !d.allowed, title: d.reason ?? undefined }, "Remove");
    expect(html("web", createElement(Gated, { action: "members.remove", children: child }))).toBe(`<button type="button" disabled="" title="${DENIED_REASON}">Remove</button>`);
    expect(html("web", createElement(Gated, { action: "members.invite", children: child }))).toBe('<button type="button">Remove</button>');
  });
});
