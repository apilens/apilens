"use client";

import Link from "next/link";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

type FrameworkId = "fastapi" | "flask" | "django" | "starlette";

const FRAMEWORK_OPTIONS: Record<FrameworkId, { label: string; installExtra: string }> = {
  fastapi: { label: "FastAPI", installExtra: "fastapi" },
  flask: { label: "Flask", installExtra: "flask" },
  django: { label: "Django / Django Ninja", installExtra: "django" },
  starlette: { label: "Starlette", installExtra: "starlette" },
};

const PYTHON_KEYWORDS = new Set(["from", "import", "app", "True", "False", "None"]);

function getDefaultBaseUrl(): string {
  if (typeof window !== "undefined" && window.location.hostname === "localhost") {
    return "http://localhost:8000/api/v1";
  }
  return "https://api.apilens.ai/api/v1";
}

function buildFrameworkSnippet(framework: FrameworkId, apiKey: string): string {
  const baseUrl = getDefaultBaseUrl();
  if (framework === "fastapi") {
    return `from fastapi import FastAPI
from apilens.fastapi import ApiLensGatewayMiddleware

app = FastAPI()

app.add_middleware(
    ApiLensGatewayMiddleware,
    api_key="${apiKey}",
    base_url="${baseUrl}",
    env="production",
    enable_request_logging=True,
    log_request_body=True,
    log_response_body=True,
)`;
  }
  if (framework === "flask") {
    return `from flask import Flask
from apilens import ApiLensClient, ApiLensConfig
from apilens.flask import instrument_app

app = Flask(__name__)

client = ApiLensClient(
    ApiLensConfig(
        api_key="${apiKey}",
        base_url="${baseUrl}",
        environment="production",
    )
)

instrument_app(app, client)`;
  }
  if (framework === "starlette") {
    return `from starlette.applications import Starlette
from apilens import ApiLensClient, ApiLensConfig
from apilens.starlette import instrument_app

app = Starlette()

client = ApiLensClient(
    ApiLensConfig(
        api_key="${apiKey}",
        base_url="${baseUrl}",
        environment="production",
    )
)

instrument_app(app, client)`;
  }
  return `# settings.py
MIDDLEWARE = [
    # ...
    "apilens.django.ApiLensDjangoMiddleware",
]

APILENS_API_KEY = "${apiKey}"
APILENS_BASE_URL = "${baseUrl}"
APILENS_ENVIRONMENT = "production"`;
}

function tokenClass(token: string): string {
  if (token.startsWith("#")) return "comment";
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) return "string";
  if (PYTHON_KEYWORDS.has(token)) return "keyword";
  if (/^[A-Z][A-Za-z0-9_]*$/.test(token)) return "class";
  if (/^\d+(\.\d+)?$/.test(token)) return "number";
  return "plain";
}

function renderPythonLine(line: string): ReactNode[] {
  const regex = /#[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b[A-Za-z_][A-Za-z0-9_]*\b|\d+(?:\.\d+)?/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null = regex.exec(line);

  while (match) {
    if (match.index > lastIndex) {
      nodes.push(<span key={`txt-${lastIndex}`} className="code-token plain">{line.slice(lastIndex, match.index)}</span>);
    }
    const token = match[0];
    nodes.push(<span key={`tok-${match.index}`} className={`code-token ${tokenClass(token)}`}>{token}</span>);
    lastIndex = match.index + token.length;
    match = regex.exec(line);
  }

  if (lastIndex < line.length) {
    nodes.push(<span key={`txt-end-${lastIndex}`} className="code-token plain">{line.slice(lastIndex)}</span>);
  }
  if (nodes.length === 0) nodes.push(<span key="empty" className="code-token plain">&nbsp;</span>);
  return nodes;
}

function renderShellCode(code: string): ReactNode {
  const firstQuote = code.indexOf('"');
  const lastQuote = code.lastIndexOf('"');
  if (firstQuote !== -1 && lastQuote > firstQuote) {
    return (
      <>
        <span className="code-token keyword">{code.slice(0, firstQuote)}</span>
        <span className="code-token string">{code.slice(firstQuote, lastQuote + 1)}</span>
      </>
    );
  }
  return <span className="code-token plain">{code}</span>;
}

function CodeBlock({
  language,
  code,
  copied,
  onCopy,
}: {
  language: "bash" | "python";
  code: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="create-app-codeblock">
      <div className="create-app-codeblock-head">
        <span>{language === "bash" ? "Terminal" : "Python"}</span>
        <button type="button" className="create-app-copy-btn" onClick={onCopy}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="create-app-code">
        {code.split("\n").map((line, idx) => (
          <div key={`${language}-${idx}`} className="code-line">
            <span className="code-gutter">{idx + 1}</span>
            <span className="code-content">
              {language === "python" ? renderPythonLine(line) : renderShellCode(line)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AppSetupGuide({
  appName,
  framework,
  apiKey,
  hasRawKey,
  appSlug,
}: {
  appName: string;
  framework: FrameworkId;
  apiKey: string;
  hasRawKey: boolean;
  appSlug: string;
}) {
  const [copiedItem, setCopiedItem] = useState<"install" | "snippet" | "">("");
  const frameworkOption = FRAMEWORK_OPTIONS[framework] || FRAMEWORK_OPTIONS.fastapi;
  const installCmd = `pip install "apilenss[${frameworkOption.installExtra}]"`;
  const snippet = buildFrameworkSnippet(framework, apiKey);

  const copyText = async (text: string, item: "install" | "snippet") => {
    await navigator.clipboard.writeText(text);
    setCopiedItem(item);
    window.setTimeout(() => setCopiedItem(""), 1400);
  };

  return (
    <div className="create-app-setup">
      <div className="create-app-setup-head">
        <p className="create-app-setup-kicker">Quickstart</p>
        <h3>{appName} is live</h3>
        <p>
          {frameworkOption.label} setup guide. {hasRawKey ? "Copy, paste, and start sending traffic." : "Paste, then replace masked API key with your active key."}
        </p>
      </div>

      <div className="create-app-doc-main create-app-doc-main-single">
        <div className="create-app-guide-step">
          <div className="create-app-guide-index">1</div>
          <div className="create-app-guide-body">
            <h4>Install package</h4>
            <p>Install API Lens SDK with the {frameworkOption.label} extra.</p>
            <CodeBlock language="bash" code={installCmd} copied={copiedItem === "install"} onCopy={() => copyText(installCmd, "install")} />
          </div>
        </div>

        <div className="create-app-guide-step">
          <div className="create-app-guide-index">2</div>
          <div className="create-app-guide-body">
            <h4>Add middleware in app bootstrap</h4>
            <p>Paste this snippet in your entry file and restart the app.</p>
            <CodeBlock language="python" code={snippet} copied={copiedItem === "snippet"} onCopy={() => copyText(snippet, "snippet")} />
          </div>
        </div>

        <div className="create-app-setup-footer">
          <p>After restarting your app, hit a few endpoints and open Endpoints to verify traffic.</p>
          <Link href={`/apps/${appSlug}/endpoints`} className="settings-btn settings-btn-primary">
            Continue to app
          </Link>
        </div>
      </div>
    </div>
  );
}
