/**
 * supertest, with unbound servers bound to 127.0.0.1 (vitest aliases
 * `supertest` to this file).
 *
 * Stock supertest binds an unbound server with `listen(0)` (the wildcard
 * address) and then connects to 127.0.0.1:<port>. On macOS, SO_REUSEADDR lets
 * that wildcard bind share a port with another process listening on 127.0.0.1
 * only, so the request can reach that other process instead (seen as stray
 * 301s when other servers run on the host). Here such servers are bound to
 * 127.0.0.1 itself, right before the request is sent.
 */
import type { AddressInfo, Server } from "node:net";

import request from "supertest/index.js";

type PendingBind = { app: Server; path: string };
type SupertestTest = {
  url: string;
  _server?: Server;
  _loopbackBind?: PendingBind;
  end: (fn?: unknown) => unknown;
  serverAddress: (app: Server, path: string) => string;
};

const proto = (request as unknown as { Test: { prototype: SupertestTest } }).Test.prototype;
const originalServerAddress = proto.serverAddress;
const originalEnd = proto.end;

proto.serverAddress = function (this: SupertestTest, app: Server, path: string): string {
  if (app.address()) return originalServerAddress.call(this, app, path);
  this._loopbackBind = { app, path };
  return `http://127.0.0.1${path}`;
};

proto.end = function (this: SupertestTest, fn?: unknown): unknown {
  const pending = this._loopbackBind;
  if (!pending) return originalEnd.call(this, fn);
  this._loopbackBind = undefined;
  pending.app.listen(0, "127.0.0.1", () => {
    this._server = pending.app;
    this.url = `http://127.0.0.1:${(pending.app.address() as AddressInfo).port}${pending.path}`;
    originalEnd.call(this, fn);
  });
  return this;
};

export default request;
